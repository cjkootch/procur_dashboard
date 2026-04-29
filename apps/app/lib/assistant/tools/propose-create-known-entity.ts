import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineTool } from '@procur/ai';
import { db, knownEntities } from '@procur/db';
import { eq } from 'drizzle-orm';

/**
 * Add a new entity to procur's curated rolodex (known_entities).
 *
 * Use when the user mentions an entity that lookup_known_entities
 * returned zero for — e.g., a regional refiner the analyst rolodex
 * hasn't picked up yet, a trader they ran into off-platform, a
 * counterparty surfaced via news. Lets the chat persist the
 * discovery so it shows up in future queries (and in the Contacts
 * section on the entity profile once a vex enrichment fires).
 *
 * Slug is auto-generated `chat-{country-iso2}-{name-slug}` so the
 * row is distinguishable from ft-/osm-/curated- seeded rows.
 *
 * If the slug already exists this returns an error in the proposal
 * preview rather than overwriting — operators should land on the
 * existing entity and edit there. v2 adds an explicit
 * `propose_update_known_entity` tool for that path.
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

const inputSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(200)
    .describe(
      'Legal or commonly-used name. Used as the canonical display ' +
        'name AND seeds the slug.',
    ),
  country: z
    .string()
    .length(2)
    .describe('ISO-3166-1 alpha-2. For multinationals use HQ country.'),
  role: z
    .enum(ROLE_VALUES)
    .describe(
      'Best-fit role. Multiple roles are common (NOC = producer + ' +
        'state-buyer); pick the dominant one for filtering. Fall ' +
        'back to "other" if none fit.',
    ),
  categories: z
    .array(z.string())
    .min(1)
    .max(10)
    .describe(
      'Category tags from the existing vocabulary (crude-oil, ' +
        'diesel, gasoline, jet-fuel, kerosene, food-commodities, ' +
        'lpg, fuel-oil, marine-bunker, etc). At least one required.',
    ),
  notes: z
    .string()
    .max(4000)
    .optional()
    .describe(
      'Multi-paragraph analyst-style notes — capability, recent ' +
        'activity, outreach angle. Markdown-friendly. Include ' +
        'whatever the user said about the entity verbatim.',
    ),
  websiteUrl: z
    .string()
    .url()
    .optional()
    .describe('Corporate website URL if known.'),
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
      'Free-form tags: "regional-refiner", "private", "sweet-crude-' +
        'runner", "libya-historic", etc. The system will append ' +
        '"chat-curated" automatically so origin is searchable.',
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

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export const proposeCreateKnownEntityTool = defineTool({
  name: 'propose_create_known_entity',
  description:
    'Add a new entity (refiner, trader, NOC, terminal, etc.) to ' +
    "procur's curated rolodex. Use when the user mentions an entity " +
    'that lookup_known_entities returned zero hits for and wants it ' +
    'tracked going forward. Always include name + country + role + ' +
    'categories. Capture whatever capability / location / activity ' +
    'context the user provided in the notes field — verbatim, not ' +
    'paraphrased. The chat surface renders a confirm card with the ' +
    'full row; user clicks Apply to actually insert. After creation, ' +
    'a follow-up call to lookup_customs_flows / get_market_snapshot ' +
    "/ search for the entity's name in entity_news_events is a good " +
    'next step to gather more data on the freshly-added entity.',
  kind: 'write',
  schema: inputSchema,
  handler: async (_ctx, args) => {
    const slug = `chat-${args.country.toLowerCase()}-${slugify(args.name)}`;

    const existing = await db.query.knownEntities.findFirst({
      where: eq(knownEntities.slug, slug),
      columns: { slug: true, name: true, country: true, role: true },
    });

    if (existing) {
      return {
        error: 'entity_already_exists',
        message:
          `An entity with slug "${slug}" already exists in the rolodex ` +
          `(${existing.name}, ${existing.country}, role=${existing.role}). ` +
          `View it at /entities/${slug}, or surface it via ` +
          `lookup_known_entities to confirm it's the same entity.`,
        existing: {
          slug: existing.slug,
          name: existing.name,
          country: existing.country,
          role: existing.role,
          profileUrl: `/entities/${slug}`,
        },
      };
    }

    const tags = Array.from(
      new Set([...(args.tags ?? []), 'chat-curated', `role:${args.role}`]),
    );

    const metadata: Record<string, unknown> = {
      source: 'chat-curated',
    };
    if (args.websiteUrl) metadata.website_url = args.websiteUrl;

    return {
      proposalId: randomUUID(),
      toolName: 'propose_create_known_entity',
      title: `Add "${args.name}" to the rolodex`,
      description:
        `Create a new known_entities row for ${args.name} ` +
        `(${args.country}, ${args.role}). Future lookup_known_entities ` +
        `calls will surface it; the entity profile page will be ` +
        `available at /entities/${slug}.`,
      preview: {
        identity: {
          slug,
          name: args.name,
          country: args.country,
          role: args.role,
        },
        classification: {
          categories: args.categories,
          tags,
        },
        notes: args.notes ?? null,
        contact: {
          websiteUrl: args.websiteUrl ?? null,
        },
        location:
          args.latitude != null && args.longitude != null
            ? { latitude: args.latitude, longitude: args.longitude }
            : null,
        aliases: args.aliases ?? [],
        profileUrl: `/entities/${slug}`,
      },
      applyPayload: {
        slug,
        name: args.name,
        country: args.country.toUpperCase(),
        role: args.role,
        categories: args.categories,
        notes: args.notes ?? null,
        aliases: args.aliases ?? [],
        tags,
        metadata,
        latitude: args.latitude ?? null,
        longitude: args.longitude ?? null,
      },
    };
  },
});
