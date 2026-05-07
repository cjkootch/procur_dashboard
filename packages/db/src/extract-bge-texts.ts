import { writeFileSync } from 'node:fs';
import { isNotNull } from 'drizzle-orm';
import { db } from './client';
import { knownEntities } from './schema/known-entities';
import { entityWebSummaries } from './schema/entity-web-intelligence';

/**
 * Extract candidate texts for BGE-M3 embedding into a JSON file
 * the Python module reads. Each record has the shape:
 *
 *   {
 *     owner_type: 'entity' | 'web_summary' | …,
 *     owner_id: '<slug or uuid>',
 *     embedding_kind: 'name' | 'name_plus_aliases' | 'web_summary_overview' | …,
 *     text: '<source>',
 *     language?: 'en' | 'es' | …
 *   }
 *
 * Workflow:
 *   pnpm extract-bge-texts --output texts.json
 *   python -m procur_ml.bge_m3 embed --input texts.json --output embeddings.json
 *   pnpm upsert-bge-embeddings --input embeddings.json
 *
 * v1 ships two extractors: known_entities (name + aliases + name+
 * categories composite) and entity_web_summaries (each section_kind
 * separately). New extractors slot in additively — add a function
 * here, dispatch in `main()`, no schema migration needed.
 */

interface BgeRecord {
  owner_type: string;
  owner_id: string;
  embedding_kind: string;
  text: string;
  language?: string;
}

function parseArgs(): { output: string; only?: string } {
  const args = process.argv.slice(2);
  let output = 'bge-texts.json';
  let only: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--output' && args[i + 1]) {
      output = args[++i] as string;
    } else if (a === '--only' && args[i + 1]) {
      only = args[++i];
    }
  }
  return { output, only };
}

async function extractKnownEntities(): Promise<BgeRecord[]> {
  const rows = await db
    .select({
      slug: knownEntities.slug,
      name: knownEntities.name,
      aliases: knownEntities.aliases,
      categories: knownEntities.categories,
      country: knownEntities.country,
      role: knownEntities.role,
    })
    .from(knownEntities);

  const out: BgeRecord[] = [];
  for (const r of rows) {
    const aliases = (r.aliases as string[] | null) ?? [];
    const categories = (r.categories as string[] | null) ?? [];

    out.push({
      owner_type: 'entity',
      owner_id: r.slug,
      embedding_kind: 'name',
      text: r.name,
    });

    if (aliases.length > 0) {
      out.push({
        owner_type: 'entity',
        owner_id: r.slug,
        embedding_kind: 'name_plus_aliases',
        text: [r.name, ...aliases].join(' · '),
      });
    }

    const compositeParts = [
      r.name,
      r.role ?? null,
      r.country ?? null,
      categories.length > 0 ? categories.join(', ') : null,
    ].filter(Boolean) as string[];
    if (compositeParts.length > 1) {
      out.push({
        owner_type: 'entity',
        owner_id: r.slug,
        embedding_kind: 'combined_v1',
        text: compositeParts.join(' · '),
      });
    }
  }
  return out;
}

async function extractWebSummaries(): Promise<BgeRecord[]> {
  const rows = await db
    .select({
      entitySlug: entityWebSummaries.entitySlug,
      sectionKind: entityWebSummaries.sectionKind,
      content: entityWebSummaries.content,
    })
    .from(entityWebSummaries)
    .where(isNotNull(entityWebSummaries.content));

  return rows
    .filter((r) => r.content && r.content.trim().length > 0)
    .map((r) => ({
      owner_type: 'web_summary',
      owner_id: `${r.entitySlug}:${r.sectionKind}`,
      embedding_kind: r.sectionKind,
      text: r.content,
    }));
}

async function main(): Promise<void> {
  const { output, only } = parseArgs();
  const records: BgeRecord[] = [];

  if (!only || only === 'entities') {
    console.log('extracting known_entities…');
    const entityRows = await extractKnownEntities();
    console.log(`  ${entityRows.length} entity records`);
    records.push(...entityRows);
  }
  if (!only || only === 'web_summaries') {
    console.log('extracting entity_web_summaries…');
    const wsRows = await extractWebSummaries();
    console.log(`  ${wsRows.length} web-summary records`);
    records.push(...wsRows);
  }

  writeFileSync(output, JSON.stringify(records, null, 2), 'utf-8');
  console.log(`wrote ${records.length} records → ${output}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
