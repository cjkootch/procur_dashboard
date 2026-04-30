import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineTool } from '@procur/ai';
import { getEntityProfile } from '@procur/catalog';

/**
 * Propose pushing an entity (refinery / trader / buyer / supplier)
 * into vex as a contact, with full procur-side commercial context
 * so vex's origination AI understands who they are on landing.
 *
 * Two input modes:
 *
 *   1. `entitySlug` — preferred. Resolves the procur known_entities
 *      slug (or external_suppliers UUID) and pulls every available
 *      field (legalName, country, role, categories, public-tender
 *      activity, distress signals, notes). Used when the assistant
 *      surfaced an entity via a tool call (lookup_known_entities,
 *      analyze_supplier, find_buyers_for_offer, etc.) and the user
 *      says "push this to vex".
 *
 *   2. Ad-hoc fields — fallback. The user names a counterparty that
 *      isn't in our rolodex yet (e.g., a contact they got from an
 *      offline conversation). Required: legalName, country.
 *
 * Optional richer context the user can supply inline:
 *   - contactName / contactEmail / contactPhone (if they have them)
 *   - userNote — free-text "why this matters" for vex's AI
 *   - chatSummary — a 1-2 sentence summary of the chat thread that
 *     surfaced this entity, so vex sees the origination story.
 *     The model composes this from the conversation context.
 *
 * The handler returns a ProposalShape — the chat surface renders a
 * confirm card with the full preview. On confirm, the apply step
 * (apply.ts → propose_push_to_vex_contact) POSTs to vex's
 * `/api/intelligence-inbound/contact` and returns the new vex
 * record URL for the user to click through.
 */
const inputSchema = z
  .object({
    entitySlug: z
      .string()
      .optional()
      .describe(
        'Procur known_entities.slug or external_suppliers.id. Preferred when ' +
          'available — pulls full profile + tender activity. The chat surface ' +
          'returns this on every entity lookup as profileUrl=/entities/{slug}.',
      ),
    legalName: z
      .string()
      .optional()
      .describe(
        'Required ONLY when entitySlug is omitted. The counterparty\'s legal ' +
          'or commonly-used name. Vex uses this for dedup against existing contacts.',
      ),
    country: z
      .string()
      .length(2)
      .optional()
      .describe(
        'ISO-2 country code. Required when entitySlug is omitted; pulled ' +
          'from the entity profile when slug is provided.',
      ),
    role: z
      .enum(['refiner', 'trader', 'producer', 'state-buyer', 'port', 'other'])
      .optional()
      .describe('Best-fit role. Pulled from the entity profile when slug is provided.'),
    contactName: z
      .string()
      .optional()
      .describe('Specific person at the counterparty, if known.'),
    contactEmail: z.string().email().optional(),
    contactPhone: z.string().optional(),
    contactTitle: z
      .string()
      .max(200)
      .optional()
      .describe(
        'Contact job title, if extracted from a document or website ' +
          '(e.g. "Board Member", "Trading Director").',
      ),
    contactLinkedinUrl: z
      .string()
      .url()
      .optional()
      .describe('LinkedIn profile URL when surfaced from a document.'),
    userNote: z
      .string()
      .max(2000)
      .optional()
      .describe(
        'User\'s free-text rationale — why we\'re pushing this contact. Goes ' +
          'verbatim into vex as origination context for their AI to read.',
      ),
    chatSummary: z
      .string()
      .max(2000)
      .optional()
      .describe(
        'Compose a 1-2 sentence summary of the chat thread that led to this push. ' +
          'Include: what the user was looking for, why this entity surfaced, ' +
          'any pricing/volume context discussed. Vex\'s AI uses this to seed ' +
          'the contact\'s origination story.',
      ),
    sourceDocuments: z
      .array(
        z.object({
          url: z.string().url(),
          contentType: z.string(),
          filename: z.string(),
        }),
      )
      .optional()
      .describe(
        'When the push originated from a user-uploaded document ' +
          '(proforma recap, datasheet, screenshot), list the source files ' +
          'so vex can reference the original. Include every doc that ' +
          'informed this push.',
      ),
    productSpecs: z
      .array(
        z.object({
          property: z.string(),
          astmMethod: z.string().nullable(),
          units: z.string().nullable(),
          min: z.string().nullable(),
          max: z.string().nullable(),
          typical: z.string().nullable(),
        }),
      )
      .optional()
      .describe(
        'Structured product spec rows extracted from a datasheet ' +
          '(typical: ASTM table on a refinery datasheet). Capture ' +
          'numbers VERBATIM — vex stores them as-is and any rounding ' +
          'here is material to deal acceptance.',
      ),
  })
  .refine((v) => v.entitySlug || (v.legalName && v.country), {
    message:
      'Either entitySlug OR (legalName + country) is required. Prefer entitySlug ' +
      'when the entity surfaced from a procur tool call.',
  });

export const proposePushToVexTool = defineTool({
  name: 'propose_push_to_vex_contact',
  description:
    'Propose pushing a counterparty (refinery / trader / buyer / supplier) ' +
    'into vex as a contact, with full commercial context. Use when the user ' +
    'says: "push this to vex", "send to vex", "add this contact to vex", ' +
    '"forward to vex CRM", or similar after surfacing an entity in conversation. ' +
    'Always include a chatSummary that captures the origination story (what ' +
    'the user was looking for + why this entity matched + any pricing/volume ' +
    'context) — vex\'s AI relies on this. The chat surface renders a confirm ' +
    'card with the full payload preview; user clicks Apply to actually push. ' +
    'On success, vex returns a record URL the user can follow.',
  kind: 'write',
  schema: inputSchema,
  handler: async (_ctx, args) => {
    const slug = args.entitySlug;
    let resolved: {
      legalName: string;
      country: string;
      role: string;
      categories: string[];
      awardCount: number;
      awardTotalUsd: number | null;
      daysSinceLastAward: number | null;
      distressSignals: Array<{
        kind: string;
        detail: string;
        observedAt: string | null;
      }>;
      notes: string | null;
      profileUrl: string;
    };

    if (slug) {
      const profile = await getEntityProfile(decodeURIComponent(slug));
      if (profile.primarySource === 'not_found') {
        return {
          error: 'entity_not_found',
          message: `No procur entity matched '${slug}'.`,
        };
      }
      const last = profile.publicTenderActivity?.mostRecentAwardDate ?? null;
      const daysSinceLastAward =
        last != null
          ? Math.max(
              0,
              Math.floor(
                (Date.now() - new Date(last).getTime()) /
                  (24 * 60 * 60 * 1000),
              ),
            )
          : null;
      const appUrl =
        process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.procur.app';
      resolved = {
        legalName: args.legalName ?? profile.name,
        country: args.country ?? profile.country ?? 'XX',
        role: args.role ?? profile.role ?? 'other',
        categories: profile.categories,
        awardCount: profile.publicTenderActivity?.totalAwards ?? 0,
        awardTotalUsd: profile.publicTenderActivity?.totalValueUsd ?? null,
        daysSinceLastAward,
        // Pre-existing supplier_signals would surface here, but
        // getEntityProfile doesn't currently pull them — leaving
        // empty for now and noting the gap.
        distressSignals: [],
        notes: profile.notes,
        profileUrl: `${appUrl}/entities/${profile.canonicalKey}`,
      };
    } else {
      // Ad-hoc path — minimum viable record, no procur enrichment.
      resolved = {
        legalName: args.legalName!,
        country: args.country!,
        role: args.role ?? 'other',
        categories: [],
        awardCount: 0,
        awardTotalUsd: null,
        daysSinceLastAward: null,
        distressSignals: [],
        notes: null,
        profileUrl: '',
      };
    }

    const sourceRef = slug ?? `adhoc:${resolved.legalName}:${resolved.country}`;

    return {
      proposalId: randomUUID(),
      toolName: 'propose_push_to_vex_contact',
      title: `Push ${resolved.legalName} to vex`,
      description:
        `Send this counterparty to vex as a new contact with full procur ` +
        `commercial context. Vex's AI ingests the payload to seed the contact's ` +
        `origination story.`,
      preview: {
        identity: {
          legalName: resolved.legalName,
          country: resolved.country,
          role: resolved.role,
        },
        commercialContext: {
          categories: resolved.categories,
          awardCount: resolved.awardCount,
          awardTotalUsd: resolved.awardTotalUsd,
          daysSinceLastAward: resolved.daysSinceLastAward,
          notes: resolved.notes ? `${resolved.notes.slice(0, 240)}…` : null,
          procurProfileUrl: resolved.profileUrl,
        },
        contact: {
          name: args.contactName ?? null,
          email: args.contactEmail ?? null,
          phone: args.contactPhone ?? null,
        },
        originationContext: {
          chatSummary: args.chatSummary ?? null,
          userNote: args.userNote ?? null,
        },
      },
      applyPayload: {
        sourceRef,
        legalName: resolved.legalName,
        country: resolved.country,
        role: resolved.role,
        contactName: args.contactName ?? null,
        contactEmail: args.contactEmail ?? null,
        contactPhone: args.contactPhone ?? null,
        contactTitle: args.contactTitle ?? null,
        contactLinkedinUrl: args.contactLinkedinUrl ?? null,
        commercialContext: {
          categories: resolved.categories,
          awardCount: resolved.awardCount,
          awardTotalUsd: resolved.awardTotalUsd,
          daysSinceLastAward: resolved.daysSinceLastAward,
          distressSignals: resolved.distressSignals,
          notes: resolved.notes,
          procurEntityProfileUrl: resolved.profileUrl,
        },
        originationContext: {
          chatSummary: args.chatSummary ?? null,
          userNote: args.userNote ?? null,
        },
        // Optional richer context — populated when the push
        // originated from a doc upload. apply.ts will fall back to
        // resolving approval / market / trading defaults itself.
        sourceDocuments: args.sourceDocuments ?? [],
        productSpecs: args.productSpecs ?? [],
      },
    };
  },
});
