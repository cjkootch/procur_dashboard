import 'server-only';
import { z } from 'zod';
import { defineTool } from '@procur/ai';
import { KNOWN_ENTITY_CATEGORIES } from '@procur/catalog';
import {
  insertKnownEntityRow,
  type KnownEntityInsertPayload,
} from '../apply';

/**
 * Auto-add a batch of new entities to the rolodex WITHOUT operator
 * approval. Designed for the search→add workflow per operator
 * direction: the chat assistant discovers entities, runs the necessary
 * checks (country, role, categories, dedup), and persists them
 * directly. Operator audits / deletes later via the rolodex UI.
 *
 * Why no approval gate:
 *   - The rolodex is the lowest-risk write surface in procur (a CRUD
 *     row; reversible by delete; doesn't trigger outreach or financial
 *     commitments).
 *   - The per-entity propose flow with N approval clicks for a
 *     "found 5 candidates" workflow was the friction the operator
 *     called out.
 *   - Downstream tier-2/tier-3 actions (outreach, deal-composition)
 *     still have their own approval gates — auto-adding to the
 *     rolodex doesn't bypass those.
 *
 * Categorization discipline (per operator: "categorization is very
 * important to reduce noise and improve accuracy"):
 *   - `categories` uses the strict KNOWN_ENTITY_CATEGORIES enum, NOT
 *     free-form strings. Pick from the listed slugs; do not invent
 *     variants. Drift like "Diesel" / "diesel" / "DIESEL FUEL" hurts
 *     both downstream filtering AND operator search.
 *   - `role` reuses the existing role enum (8 buckets + 'other').
 *     Avoid 'other' unless no listed role fits; the model is asked
 *     to justify 'other' in notes.
 *   - Every auto-added row gets metadata.source='chat-auto' AND a
 *     'chat-auto-curated' tag for filtering. Cole can run
 *     `SELECT * FROM known_entities WHERE 'chat-auto-curated' = ANY(tags)`
 *     to audit / mass-delete the auto-added set.
 *
 * Return shape includes `added`, `skippedDuplicates` (slug collisions
 * with existing rows), and `errors` (per-row failures). The model
 * surfaces this back to the operator: "Added 4, skipped 1 (already
 * in rolodex)."
 *
 * Use `propose_create_known_entity` (singular, approval-gated) only
 * when the operator explicitly asks for a review step.
 */

const ROLE_VALUES = [
  'refiner',
  'trader',
  'producer',
  'state-buyer',
  'port',
  'terminal',
  'shipper',
  'broker',
  'other',
] as const;

const entitySchema = z.object({
  name: z
    .string()
    .min(2)
    .max(200)
    .describe(
      'Legal or commonly-used name. Used as the canonical display name ' +
        'AND seeds the slug.',
    ),
  country: z
    .string()
    .length(2)
    .describe('ISO-3166-1 alpha-2. For multinationals use HQ country.'),
  role: z
    .enum(ROLE_VALUES)
    .describe(
      'Best-fit role bucket. Multi-role entities (e.g. NOC = producer + ' +
        'state-buyer) get the dominant role for filtering; capture the ' +
        'second role in notes. Use "other" only when NO listed role fits ' +
        '— if "other", explain why in notes.',
    ),
  categories: z
    .array(z.enum(KNOWN_ENTITY_CATEGORIES))
    .min(1)
    .max(8)
    .describe(
      'Required. At least one, max 8. STRICT enum — pick from the listed ' +
        'slugs only; never invent variants. Examples: crude-oil, diesel, ' +
        'gasoline, jet-fuel, lpg, food-commodities, wheat, corn, beef, ' +
        'mining, environmental-services. The full enum is the source of ' +
        'truth; the operator extends it explicitly when a new sector ' +
        'surfaces (do NOT pre-emptively use unlisted variants).',
    ),
  notes: z
    .string()
    .max(4000)
    .optional()
    .describe(
      'Analyst notes — capability, recent activity, outreach angle, why ' +
        'this entity matters. Markdown-friendly. Include whatever the ' +
        'user said about the entity verbatim. REQUIRED when role="other" ' +
        '(explain what category the entity actually fits).',
    ),
  websiteUrl: z
    .string()
    .url()
    .optional()
    .describe(
      'Corporate website. Domain-derived from this triggers Apollo ' +
        'enrichment on insert — providing the URL improves enrichment ' +
        'success rate significantly.',
    ),
  aliases: z
    .array(z.string())
    .max(10)
    .optional()
    .describe('Alt names / portal-spellings — used for fuzzy match later.'),
  tags: z
    .array(z.string())
    .max(15)
    .optional()
    .describe(
      'Free-form tags. The system auto-appends "chat-auto-curated" + ' +
        '"role:<role>" so the auto-added set is filterable.',
    ),
  latitude: z
    .number()
    .gte(-90)
    .lte(90)
    .optional()
    .describe('WGS84 decimal degrees. Populate for physical assets.'),
  longitude: z
    .number()
    .gte(-180)
    .lte(180)
    .optional()
    .describe('WGS84 decimal degrees. Populate for physical assets.'),
});

const inputSchema = z.object({
  entities: z
    .array(entitySchema)
    .min(1)
    .max(25)
    .describe(
      'Batch of entities to auto-add. Max 25 per call. Each entity ' +
        'follows the same validation as propose_create_known_entity but ' +
        'with strict-enum categories.',
    ),
});

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export const addKnownEntitiesTool = defineTool({
  name: 'add_known_entities',
  description:
    'AUTO-ADD a batch of new entities (refiner, trader, NOC, terminal, ' +
    'distributor, etc.) directly to the rolodex — no approval card, no ' +
    "click. Use for the search→add workflow: when you've discovered " +
    'candidates via lookup_known_entities / apollo / web_search and the ' +
    "operator wants them tracked. Each entity needs name + country + " +
    'role + categories (strict enum). The operator audits via the ' +
    "rolodex UI and deletes anything they don't want.\n\n" +
    'PREFER THIS over propose_create_known_entity for routine adds. ' +
    'Reserve propose_create_known_entity for cases where the operator ' +
    'explicitly says they want a review step before persisting.\n\n' +
    'Returns { added, skippedDuplicates, errors }. Surface this back to ' +
    'the operator: "Added 4, skipped 1 already in rolodex."',
  kind: 'read',
  schema: inputSchema,
  handler: async (_ctx, args) => {
    const added: Array<{ slug: string; name: string; profileUrl: string }> = [];
    const skippedDuplicates: Array<{ slug: string; name: string; profileUrl: string }> = [];
    const errors: Array<{ name: string; error: string; message?: string }> = [];

    for (const entity of args.entities) {
      const slug = `chat-${entity.country.toLowerCase()}-${slugify(entity.name)}`;
      const tags = Array.from(
        new Set([
          ...(entity.tags ?? []),
          'chat-auto-curated',
          `role:${entity.role}`,
        ]),
      );
      const metadata: Record<string, unknown> = { source: 'chat-auto' };
      if (entity.websiteUrl) metadata.website_url = entity.websiteUrl;

      const payload: KnownEntityInsertPayload = {
        slug,
        name: entity.name,
        country: entity.country,
        role: entity.role,
        categories: entity.categories,
        notes: entity.notes ?? null,
        aliases: entity.aliases ?? [],
        tags,
        metadata,
        latitude: entity.latitude ?? null,
        longitude: entity.longitude ?? null,
      };

      const result = await insertKnownEntityRow(payload);
      if (!result.ok) {
        errors.push({
          name: entity.name,
          error: result.error,
          ...(result.message ? { message: result.message } : {}),
        });
        continue;
      }
      const profileUrl = `/entities/${result.slug}`;
      if (result.dedupedAgainstExisting) {
        skippedDuplicates.push({ slug: result.slug, name: entity.name, profileUrl });
      } else {
        added.push({ slug: result.slug, name: entity.name, profileUrl });
      }
    }

    return {
      added,
      skippedDuplicates,
      errors,
      summary: {
        addedCount: added.length,
        skippedCount: skippedDuplicates.length,
        errorCount: errors.length,
      },
    };
  },
});
