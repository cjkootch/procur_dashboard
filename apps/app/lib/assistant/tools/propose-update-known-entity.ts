import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineTool } from '@procur/ai';
import { db, knownEntities } from '@procur/db';
import { eq } from 'drizzle-orm';

/**
 * Refine an existing entity in procur's curated rolodex.
 *
 * Sister of propose_create_known_entity. Use when the user (or
 * web_search results, or vex enrichment) surfaces new facts about
 * an entity that's already in the rolodex — capacity numbers,
 * additional aliases, lat/lng, a new tag, or revised notes.
 *
 * Merge semantics:
 *   - notes: REPLACE (or use appendNotes for additive)
 *   - country / role: REPLACE (only if provided)
 *   - categories / aliases / tags: MERGE (set-union with existing,
 *     deduped). The 'chat-curated' tag is always preserved.
 *   - latitude / longitude: REPLACE (only if both provided together)
 *   - websiteUrl: REPLACE on metadata.website_url
 *
 * Removing an alias / category / tag is intentionally NOT supported
 * here — that's a destructive operation we'd want a separate tool
 * for (with stronger confirmation copy). Add-only here.
 */
const inputSchema = z.object({
  slug: z
    .string()
    .min(3)
    .describe(
      'The entity slug to update — same value lookup_known_entities ' +
        'returns as profileUrl=/entities/{slug}, or the canonical key ' +
        'an earlier propose_create_known_entity proposal produced.',
    ),
  notes: z
    .string()
    .max(4000)
    .optional()
    .describe(
      'REPLACE the existing notes. Use this when the prior notes ' +
        'are stale or wrong. To add to notes without nuking what ' +
        'was there, use appendNotes instead.',
    ),
  appendNotes: z
    .string()
    .max(4000)
    .optional()
    .describe(
      'APPEND to the existing notes (separated by a blank line). ' +
        'Preferred when adding a new fact without disturbing prior ' +
        'analyst commentary. Mutually exclusive with notes.',
    ),
  country: z
    .string()
    .length(2)
    .optional()
    .describe('Replace country (ISO-2). Use only when the existing value is wrong.'),
  role: z
    .enum([
      'refiner',
      'trader',
      'producer',
      'state-buyer',
      'port',
      'terminal',
      'shipper',
      'broker',
      'other',
    ])
    .optional()
    .describe('Replace role. Use only when the existing role is wrong.'),
  addCategories: z
    .array(z.string())
    .max(10)
    .optional()
    .describe('Categories to MERGE into the existing set. Existing categories preserved.'),
  addAliases: z
    .array(z.string())
    .max(10)
    .optional()
    .describe(
      'Alt names / portal-spellings to MERGE in. Useful when a new ' +
        'data source surfaces the entity under a different name.',
    ),
  addTags: z
    .array(z.string())
    .max(15)
    .optional()
    .describe('Free-form tags to MERGE in. Existing tags preserved.'),
  latitude: z
    .number()
    .gte(-90)
    .lte(90)
    .optional()
    .describe('WGS84 decimal degrees. Pair with longitude — both required together.'),
  longitude: z
    .number()
    .gte(-180)
    .lte(180)
    .optional()
    .describe('WGS84 decimal degrees. Pair with latitude — both required together.'),
  websiteUrl: z
    .string()
    .url()
    .optional()
    .describe('Replace metadata.website_url.'),
});

export const proposeUpdateKnownEntityTool = defineTool({
  name: 'propose_update_known_entity',
  description:
    "Refine an existing entity in procur's rolodex with new facts. " +
    'Use when the user supplies new info OR after a web_search / ' +
    'lookup_customs_flows / get_market_snapshot call surfaces facts ' +
    'worth persisting (capacity numbers, aliases, capability notes, ' +
    'lat/lng for a physical asset, website URL). Arrays merge ' +
    '(categories / aliases / tags), scalars replace, notes either ' +
    'replaces (notes) or appends (appendNotes — preferred when ' +
    'adding without nuking prior analyst commentary). The chat ' +
    'surface renders a confirm card showing the merged-vs-existing ' +
    'diff; user clicks Apply to persist. Slug must already exist — ' +
    "for new entities use propose_create_known_entity instead.",
  kind: 'write',
  schema: inputSchema,
  handler: async (_ctx, args) => {
    const slug = decodeURIComponent(args.slug);

    if (args.notes && args.appendNotes) {
      return {
        error: 'conflicting_notes',
        message:
          'Pass either notes (replace) or appendNotes (append), not both. ' +
          'Use notes when the prior content is wrong, appendNotes when ' +
          'adding without disturbing existing commentary.',
      };
    }
    if (
      (args.latitude == null) !== (args.longitude == null) &&
      !(args.latitude == null && args.longitude == null)
    ) {
      return {
        error: 'incomplete_location',
        message: 'latitude and longitude must be provided together.',
      };
    }

    const existing = await db.query.knownEntities.findFirst({
      where: eq(knownEntities.slug, slug),
    });
    if (!existing) {
      return {
        error: 'entity_not_found',
        message:
          `No entity with slug "${slug}" in the rolodex. Use ` +
          `propose_create_known_entity for new entities, or run ` +
          `lookup_known_entities to find the right slug first.`,
      };
    }

    // Compute the merged values.
    const mergedCategories = mergeArray(existing.categories ?? [], args.addCategories);
    const mergedAliases = mergeArray(existing.aliases ?? [], args.addAliases);
    const mergedTags = mergeArray(existing.tags ?? [], args.addTags);

    const nextNotes =
      args.notes != null
        ? args.notes
        : args.appendNotes != null
          ? joinNotes(existing.notes, args.appendNotes)
          : existing.notes;

    const nextCountry = args.country?.toUpperCase() ?? existing.country;
    const nextRole = args.role ?? existing.role;
    const nextLat = args.latitude != null ? args.latitude.toString() : existing.latitude;
    const nextLng = args.longitude != null ? args.longitude.toString() : existing.longitude;

    const nextMetadata: Record<string, unknown> = {
      ...((existing.metadata as Record<string, unknown> | null) ?? {}),
    };
    if (args.websiteUrl) nextMetadata.website_url = args.websiteUrl;

    // Compute the diff for the preview — operators see exactly what
    // changes before they confirm.
    const changes = diff(existing, {
      notes: nextNotes,
      country: nextCountry,
      role: nextRole,
      categories: mergedCategories,
      aliases: mergedAliases,
      tags: mergedTags,
      latitude: nextLat,
      longitude: nextLng,
      websiteUrl: args.websiteUrl ?? null,
    });

    if (changes.length === 0) {
      return {
        error: 'no_changes',
        message:
          'Every field you provided was equal to or already a subset of ' +
          'the existing values — nothing to update. Check the entity ' +
          `at /entities/${slug} to see the current state.`,
      };
    }

    return {
      proposalId: randomUUID(),
      toolName: 'propose_update_known_entity',
      title: `Refine "${existing.name}" in the rolodex`,
      description:
        `Apply ${changes.length} change${changes.length === 1 ? '' : 's'} ` +
        `to the rolodex entry for ${existing.name} (${existing.country}). ` +
        `View the entity at /entities/${slug}.`,
      preview: {
        identity: {
          slug,
          name: existing.name,
          profileUrl: `/entities/${slug}`,
        },
        changes,
      },
      applyPayload: {
        slug,
        notes: nextNotes,
        country: nextCountry,
        role: nextRole,
        categories: mergedCategories,
        aliases: mergedAliases,
        tags: mergedTags,
        metadata: nextMetadata,
        latitude: nextLat,
        longitude: nextLng,
      },
    };
  },
});

function mergeArray(existing: string[], incoming: string[] | undefined): string[] {
  if (!incoming || incoming.length === 0) return existing;
  return Array.from(new Set([...existing, ...incoming]));
}

function joinNotes(existing: string | null, appendix: string): string {
  if (!existing || existing.trim().length === 0) return appendix;
  return `${existing.trimEnd()}\n\n${appendix}`;
}

type Change = { field: string; from: unknown; to: unknown };

function diff(
  existing: typeof knownEntities.$inferSelect,
  next: {
    notes: string | null;
    country: string;
    role: string;
    categories: string[];
    aliases: string[];
    tags: string[];
    latitude: string | null;
    longitude: string | null;
    websiteUrl: string | null;
  },
): Change[] {
  const out: Change[] = [];
  if (next.notes !== existing.notes) {
    out.push({ field: 'notes', from: existing.notes, to: next.notes });
  }
  if (next.country !== existing.country) {
    out.push({ field: 'country', from: existing.country, to: next.country });
  }
  if (next.role !== existing.role) {
    out.push({ field: 'role', from: existing.role, to: next.role });
  }
  if (!sameSet(existing.categories ?? [], next.categories)) {
    out.push({ field: 'categories', from: existing.categories ?? [], to: next.categories });
  }
  if (!sameSet(existing.aliases ?? [], next.aliases)) {
    out.push({ field: 'aliases', from: existing.aliases ?? [], to: next.aliases });
  }
  if (!sameSet(existing.tags ?? [], next.tags)) {
    out.push({ field: 'tags', from: existing.tags ?? [], to: next.tags });
  }
  if (next.latitude !== existing.latitude || next.longitude !== existing.longitude) {
    out.push({
      field: 'location',
      from: { latitude: existing.latitude, longitude: existing.longitude },
      to: { latitude: next.latitude, longitude: next.longitude },
    });
  }
  const existingMeta = (existing.metadata as Record<string, unknown> | null) ?? {};
  if (next.websiteUrl && next.websiteUrl !== existingMeta.website_url) {
    out.push({
      field: 'metadata.website_url',
      from: existingMeta.website_url ?? null,
      to: next.websiteUrl,
    });
  }
  return out;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}
