import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineTool } from '@procur/ai';
import { getEntityProfile } from '@procur/catalog';

/**
 * Bulk variant of propose_push_to_vex_contact. Pushes a SET of
 * entities to vex in one user-confirmed action — e.g. "send all
 * Colombian refineries to vex" after the user has narrowed a list
 * via lookup_known_entities / analyze_supplier / etc.
 *
 * Why this is a separate tool rather than calling the single tool
 * N times: each call to propose_* renders a confirm card, and we
 * don't want the user to click Apply 12 times. One bulk proposal,
 * one Apply, fan-out at apply time.
 *
 * Resolution happens at PROPOSAL time, not apply time, so the user
 * sees exactly what will be pushed (and any not-found warnings)
 * before confirming. Resolution failures do NOT block the proposal
 * — the user can confirm a partial set and a note explains what
 * was skipped.
 *
 * Each resolved entity gets the same per-entity chatSummary
 * augmentation as the single-push flow: signal source / role /
 * country / categories. The user-supplied chatSummary applies to
 * the whole batch (the "why are we pushing this set" rationale),
 * and is concatenated into each per-entity origination context.
 */
const inputSchema = z.object({
  entitySlugs: z
    .array(z.string())
    .min(1)
    .max(50)
    .describe(
      'List of procur known_entities.slug or external_suppliers.id values to ' +
        'push. Cap of 50 per call so a runaway query doesn\'t fan out 500 ' +
        'pushes. Get these from a prior tool call: lookup_known_entities, ' +
        'analyze_supplier, find_competing_sellers, find_buyers_for_offer, ' +
        'etc. all return profileUrl=/entities/{slug} — strip the /entities/ ' +
        'prefix.',
    ),
  chatSummary: z
    .string()
    .max(2000)
    .describe(
      'REQUIRED. 1-2 sentences explaining why we\'re pushing THIS SET (e.g. ' +
        '"User asked to forward all Colombian refineries for outreach on the ' +
        'upcoming Libyan crude cargo"). Goes into every entity\'s origination ' +
        'context in vex so the AI on that side knows the batch reason.',
    ),
  userNote: z
    .string()
    .max(2000)
    .optional()
    .describe(
      'Optional free-text rationale from the user. Goes verbatim onto every ' +
        'entity in the batch.',
    ),
});

type ResolvedEntry = {
  ok: true;
  entitySlug: string;
  legalName: string;
  country: string;
  role: string;
  categories: string[];
  awardCount: number;
  awardTotalUsd: number | null;
  daysSinceLastAward: number | null;
  notes: string | null;
  profileUrl: string;
  canonicalKey: string;
};
type FailedEntry = { ok: false; entitySlug: string; reason: string };

export const proposePushManyToVexTool = defineTool({
  name: 'propose_push_many_to_vex_contacts',
  description:
    'Bulk-push a set of counterparties (refineries / traders / buyers / ' +
    'suppliers) to vex in a single user-confirmed action. Use when the user ' +
    'asks for batch outreach: "send all Colombian refineries to vex", "push ' +
    'these 8 contacts to vex", "forward every Caribbean buyer", etc. The ' +
    'chat surface renders a confirm card listing every resolved entity (and ' +
    'any not-found warnings); user clicks Apply once and every entity is ' +
    'pushed. Cap of 50 entities per call. Always include a chatSummary that ' +
    'captures the BATCH reason — that gets attached to every entity\'s ' +
    'origination context. If the user only wants ONE contact pushed, use ' +
    'propose_push_to_vex_contact instead — its preview is richer.',
  kind: 'write',
  schema: inputSchema,
  handler: async (_ctx, args) => {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.procur.app';

    const resolutions: Array<ResolvedEntry | FailedEntry> = await Promise.all(
      args.entitySlugs.map(async (raw) => {
        const slug = decodeURIComponent(raw);
        try {
          const profile = await getEntityProfile(slug);
          if (profile.primarySource === 'not_found') {
            return { ok: false, entitySlug: slug, reason: 'not_found' };
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
          return {
            ok: true,
            entitySlug: slug,
            canonicalKey: profile.canonicalKey,
            legalName: profile.name,
            country: profile.country ?? 'XX',
            role: profile.role ?? 'other',
            categories: profile.categories,
            awardCount: profile.publicTenderActivity?.totalAwards ?? 0,
            awardTotalUsd: profile.publicTenderActivity?.totalValueUsd ?? null,
            daysSinceLastAward,
            notes: profile.notes,
            profileUrl: `${appUrl}/entities/${profile.canonicalKey}`,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { ok: false, entitySlug: slug, reason: `lookup_failed: ${message}` };
        }
      }),
    );

    const resolved = resolutions.filter((r): r is ResolvedEntry => r.ok);
    const failed = resolutions.filter((r): r is FailedEntry => !r.ok);

    if (resolved.length === 0) {
      return {
        error: 'all_entities_unresolved',
        message:
          `None of the ${args.entitySlugs.length} requested entit${args.entitySlugs.length === 1 ? 'y' : 'ies'} ` +
          `resolved. Verify the slugs returned by your prior tool call.`,
        unresolved: failed,
      };
    }

    // Apply payload: one fully-resolved push per entity. Each carries
    // the batch chatSummary + userNote so vex's AI sees the same
    // origination story per contact.
    const pushes = resolved.map((r) => ({
      sourceRef: `bulk-push:${r.canonicalKey}`,
      entitySlug: r.entitySlug,
      legalName: r.legalName,
      country: r.country,
      role: r.role,
      contactName: null,
      contactEmail: null,
      contactPhone: null,
      commercialContext: {
        categories: r.categories,
        awardCount: r.awardCount,
        awardTotalUsd: r.awardTotalUsd,
        daysSinceLastAward: r.daysSinceLastAward,
        distressSignals: [] as Array<{
          kind: string;
          detail: string;
          observedAt: string | null;
        }>,
        notes: r.notes,
        procurEntityProfileUrl: r.profileUrl,
      },
      originationContext: {
        chatSummary: args.chatSummary,
        userNote: args.userNote ?? null,
      },
    }));

    return {
      proposalId: randomUUID(),
      toolName: 'propose_push_many_to_vex_contacts',
      title: `Push ${resolved.length} ${resolved.length === 1 ? 'entity' : 'entities'} to vex`,
      description:
        `Send ${resolved.length} counterpart${resolved.length === 1 ? 'y' : 'ies'} ` +
        `to vex as new contacts in one batch. Vex's AI ingests each payload to ` +
        `seed the contacts' origination stories.` +
        (failed.length > 0
          ? ` ${failed.length} requested entit${failed.length === 1 ? 'y was' : 'ies were'} ` +
            `skipped (see preview).`
          : ''),
      preview: {
        batch: {
          totalRequested: args.entitySlugs.length,
          resolved: resolved.length,
          skipped: failed.length,
          chatSummary: args.chatSummary,
          userNote: args.userNote ?? null,
        },
        entities: resolved.map((r) => ({
          legalName: r.legalName,
          country: r.country,
          role: r.role,
          categories: r.categories,
          awardCount: r.awardCount,
          procurProfileUrl: r.profileUrl,
        })),
        skipped: failed.map((f) => ({
          entitySlug: f.entitySlug,
          reason: f.reason,
        })),
      },
      applyPayload: {
        pushes,
        chatSummary: args.chatSummary,
        userNote: args.userNote ?? null,
      },
    };
  },
});
