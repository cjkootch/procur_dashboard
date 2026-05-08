import 'server-only';
import { eq } from 'drizzle-orm';
import { db, knownEntities, marketProbeTargets } from '@procur/db';
import {
  enrichOrgFromApollo,
  searchOrgs,
  searchPeople,
  type ApolloOrgFull,
  type ApolloSearchFilters,
  type ApolloDegradeResult,
} from '@procur/apollo';
import { upsertProbeTargets, getProbe } from './market-probes';
import { createId } from '@procur/ai';

/**
 * Apollo-driven lookalike discovery for a Market Probe.
 *
 * Given a seed entity (an existing rolodex row the operator wants to
 * "find more like"), pull its Apollo snapshot, derive lookalike
 * filters (industry keywords + country + employee-range bucket),
 * and run `searchOrgs` to surface similar companies. Results are
 * resolved against `known_entities` by primary_domain — matched
 * orgs reuse the existing slug; unmatched orgs land as stub
 * known_entities rows so the probe target list points at real
 * entity profiles.
 *
 * Three orthogonal seeding paths in the probe:
 *   1. Graph similarity (Phase 1) — `recommendCommunicationTargets`
 *      via GraphSAGE embeddings.
 *   2. Apollo lookalikes (this) — attribute-based via Apollo's
 *      mixed_companies/search endpoint.
 *   3. Customs-led seeding (Phase 2B) — HS-code importers in
 *      probe.country.
 *
 * Combining all three gives stronger ranking than any single source.
 */

export type AddLookalikesResult =
  | {
      ok: true;
      seedApolloOrgId: string;
      candidatesFound: number;
      targetsCreated: number;
      stubsCreated: number;
    }
  | { ok: false; error: string; degrade?: ApolloDegradeResult };

export async function addApolloLookalikesToProbe(input: {
  probeId: string;
  seedSlug: string;
  limit?: number;
}): Promise<AddLookalikesResult> {
  const probe = await getProbe(input.probeId);
  if (!probe) return { ok: false, error: `probe ${input.probeId} not found` };

  // Seed must be a rolodex row with apollo_org_id already populated.
  // The "Enrich from Apollo" button on the entity profile populates
  // this; if it's null the operator hasn't run that yet. Phase 2B
  // will auto-trigger enrichment when missing; Phase 2A surfaces a
  // clear message instead.
  const [seed] = await db
    .select({
      slug: knownEntities.slug,
      name: knownEntities.name,
      country: knownEntities.country,
      primaryDomain: knownEntities.primaryDomain,
      apolloOrgId: knownEntities.apolloOrgId,
    })
    .from(knownEntities)
    .where(eq(knownEntities.slug, input.seedSlug))
    .limit(1);
  if (!seed) {
    return {
      ok: false,
      error: `seed entity "${input.seedSlug}" not found in rolodex`,
    };
  }
  // Auto-enrich on demand when the seed has no apollo_org_id. Phase
  // 2A surfaced a "run Enrich from Apollo first" error; Phase 2B
  // resolves the apollo id by searching by primary_domain so the
  // operator's two-step "enrich → find lookalikes" collapses into
  // one click. Falls back to the same clear error when the seed has
  // no domain to search by.
  let apolloOrgId: string | null = seed.apolloOrgId;
  if (!apolloOrgId) {
    if (!seed.primaryDomain) {
      return {
        ok: false,
        error: `seed entity "${seed.name}" has no Apollo enrichment AND no primary_domain — set the domain on the entity profile, then retry`,
      };
    }
    const lookup = await searchOrgs(
      { organizationDomainsList: [seed.primaryDomain] },
      { perPage: 1 },
    );
    if (!('organizations' in lookup) || lookup.organizations.length === 0) {
      return {
        ok: false,
        error: `Apollo had no record for domain "${seed.primaryDomain}" — verify the domain or pick a different seed`,
        ...(!('organizations' in lookup) ? { degrade: lookup } : {}),
      };
    }
    apolloOrgId = lookup.organizations[0]!.id;
    // Backfill on the rolodex row so future runs skip the lookup.
    await db
      .update(knownEntities)
      .set({ apolloOrgId, updatedAt: new Date() })
      .where(eq(knownEntities.slug, seed.slug));
  }

  // Pull seed's full snapshot. Cached after first fetch (default 30d
  // freshness in apollo/config.ts).
  const seedEnrich = await enrichOrgFromApollo({
    apolloOrgId,
    target: { table: 'known_entities', id: seed.slug },
  });
  if (!seedEnrich.ok) {
    return {
      ok: false,
      error: `apollo enrichment failed: ${seedEnrich.reason}`,
      degrade: seedEnrich,
    };
  }
  const seedFull = seedEnrich.snapshot.full;

  const filters = buildLookalikeFilters(seedFull, probe.country);
  const limit = Math.min(input.limit ?? 25, 50);

  const search = await searchOrgs(filters, { perPage: limit });
  if (!('organizations' in search)) {
    // ApolloDegradeResult — pass it through so the UI can show why.
    return {
      ok: false,
      error: `apollo search failed: ${search.reason}`,
      degrade: search,
    };
  }

  // Drop the seed itself if it came back in results.
  const candidates = search.organizations.filter((o) => o.id !== apolloOrgId);
  if (candidates.length === 0) {
    return {
      ok: true,
      seedApolloOrgId: apolloOrgId,
      candidatesFound: 0,
      targetsCreated: 0,
      stubsCreated: 0,
    };
  }

  // Resolve each Apollo org to a known_entities slug. Match by
  // primary_domain when present; create a stub row when no match —
  // every probe_target.entity_slug needs to point at SOMETHING the
  // entity-profile route can render.
  let stubsCreated = 0;
  const targets: Array<{
    id: string;
    entitySlug: string;
    contactId: null;
    segment: null;
    fitTier: 'A' | 'B' | 'C' | 'D';
    confidence: number;
    evidenceJson: Record<string, unknown>;
  }> = [];

  for (const org of candidates) {
    const slug = await resolveOrCreateRolodexStubFromApollo({
      apolloOrgId: org.id,
      name: org.name,
      primaryDomain: org.primaryDomain,
      probeCountry: probe.country,
    });
    if (!slug) continue;
    if (slug.created) stubsCreated += 1;
    targets.push({
      id: createId(),
      entitySlug: slug.slug,
      contactId: null,
      segment: null,
      // Apollo lookalikes default to fit tier B — they share
      // attributes with the seed but aren't yet validated by graph
      // similarity or operator review. Tier A is reserved for
      // recommender-marked outreach_ready candidates.
      fitTier: 'B',
      confidence: 0.6,
      evidenceJson: {
        source: 'apollo_lookalike',
        apolloOrgId: org.id,
        seedSlug: seed.slug,
        seedName: seed.name,
        entityName: org.name,
        primaryDomain: org.primaryDomain,
        websiteUrl: org.websiteUrl,
        linkedinUrl: org.linkedinUrl,
        foundedYear: org.foundedYear,
        recommendedChannel: 'email',
        evidenceItems: [
          {
            label: `Lookalike of ${seed.name} (Apollo attribute match)`,
          },
        ],
      },
    });
  }

  const inserted = await upsertProbeTargets(input.probeId, targets);
  return {
    ok: true,
    seedApolloOrgId: apolloOrgId,
    candidatesFound: candidates.length,
    targetsCreated: inserted,
    stubsCreated,
  };
}

/**
 * Build Apollo search filters that approximate "more like the seed."
 * Industry keywords + country + employee-range bucket. Conservative
 * by design — too many filters narrows results too aggressively.
 *
 * Discipline: we ALWAYS pin country to probe.country (or the seed's
 * country if no probe country) so lookalikes don't drift outside the
 * market fence.
 */
function buildLookalikeFilters(
  seed: ApolloOrgFull,
  probeCountry: string | null,
): ApolloSearchFilters {
  const filters: ApolloSearchFilters = {};

  // Top keywords (Apollo seeds these from industry, descriptions,
  // technologies). Cap at 3 so the AND-logic doesn't over-narrow.
  const keywords =
    seed.keywords && seed.keywords.length > 0
      ? seed.keywords.slice(0, 3)
      : seed.industries && seed.industries.length > 0
        ? seed.industries.slice(0, 3)
        : seed.industry
          ? [seed.industry]
          : [];
  if (keywords.length > 0) {
    filters.organizationKeywordTags = keywords;
  }

  // Country fence — probe takes precedence over seed's. Apollo
  // accepts country names (or ISO via location). We pass the
  // probe.country when set; otherwise the seed's.
  const country = probeCountry ?? seed.country ?? null;
  if (country) {
    filters.organizationLocations = [country];
  }

  // Employee range — pick a bucket containing the seed's count
  // (Apollo expects strings like "1,10", "11,20", "21,50",
  // "51,100", "101,200", "201,500", "501,1000", "1001,5000",
  // "5001,10000", "10001"+).
  if (seed.estimatedNumEmployees != null) {
    const range = bucketEmployees(seed.estimatedNumEmployees);
    if (range) filters.organizationNumEmployeesRanges = [range];
  }

  return filters;
}

function bucketEmployees(n: number): string | null {
  if (n < 1) return null;
  if (n <= 10) return '1,10';
  if (n <= 20) return '11,20';
  if (n <= 50) return '21,50';
  if (n <= 100) return '51,100';
  if (n <= 200) return '101,200';
  if (n <= 500) return '201,500';
  if (n <= 1000) return '501,1000';
  if (n <= 5000) return '1001,5000';
  if (n <= 10000) return '5001,10000';
  return '10001';
}

/**
 * Find an existing known_entities row by primary_domain or
 * apollo_org_id; create a minimal stub when neither matches so the
 * probe_target.entity_slug points at a profile the UI can render.
 *
 * Stub rows carry role='unknown' and an empty categories[] — operator
 * promotes them to first-class via the entity profile if the lookalike
 * pans out. apollo_org_id + primary_domain land on the row so future
 * lookups dedupe.
 */
async function resolveOrCreateRolodexStubFromApollo(input: {
  apolloOrgId: string;
  name: string;
  primaryDomain: string | null;
  probeCountry: string | null;
}): Promise<{ slug: string; created: boolean } | null> {
  // Prefer apollo_org_id match (strongest), then primary_domain.
  // Phase 2G: scout_protection=true entities are off-limits to
  // autonomous scouting — return null so the caller skips them.
  const [byApollo] = await db
    .select({
      slug: knownEntities.slug,
      scoutProtection: knownEntities.scoutProtection,
    })
    .from(knownEntities)
    .where(eq(knownEntities.apolloOrgId, input.apolloOrgId))
    .limit(1);
  if (byApollo) {
    if (byApollo.scoutProtection) return null;
    return { slug: byApollo.slug, created: false };
  }

  if (input.primaryDomain) {
    const [byDomain] = await db
      .select({
        slug: knownEntities.slug,
        scoutProtection: knownEntities.scoutProtection,
      })
      .from(knownEntities)
      .where(eq(knownEntities.primaryDomain, input.primaryDomain))
      .limit(1);
    if (byDomain) {
      if (byDomain.scoutProtection) return null;
      // Backfill apollo_org_id on this row so future lookalike runs
      // skip the domain-match path and use the strong apollo_org_id
      // index instead. Cheap maintenance write.
      await db
        .update(knownEntities)
        .set({ apolloOrgId: input.apolloOrgId, updatedAt: new Date() })
        .where(eq(knownEntities.slug, byDomain.slug));
      return { slug: byDomain.slug, created: false };
    }
  }

  // No match — create a stub. Slug derives from the apollo id so it's
  // deterministic and collision-free; operator can rename later via
  // the entity profile. role='unknown' signals "not yet curated"
  // both to operators (rolodex filters can hide it) and to the chat
  // tools (lookup_known_entities filters by role default).
  const slug = `apollo-${input.apolloOrgId}`;
  try {
    await db.insert(knownEntities).values({
      slug,
      name: input.name,
      country: (input.probeCountry ?? 'XX').toUpperCase(),
      role: 'unknown',
      categories: [],
      primaryDomain: input.primaryDomain ?? null,
      apolloOrgId: input.apolloOrgId,
    });
    return { slug, created: true };
  } catch (err) {
    // Race condition: another concurrent lookalike fetch created the
    // same stub. Re-read. The unique constraint is on `slug`, which
    // is deterministic from the apollo id, so this should resolve.
    const [existing] = await db
      .select({ slug: knownEntities.slug })
      .from(knownEntities)
      .where(eq(knownEntities.slug, slug))
      .limit(1);
    if (existing) return { slug: existing.slug, created: false };
    console.error(
      '[market-probes] failed to create rolodex stub from apollo',
      err,
    );
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────
// Decision-maker discovery — Apollo searchPeople per target
// ──────────────────────────────────────────────────────────────────

export type FindDecisionMakersResult =
  | {
      ok: true;
      entitySlug: string;
      candidatesFound: number;
    }
  | { ok: false; error: string; degrade?: ApolloDegradeResult };

/**
 * For a probe target, run Apollo `searchPeople` scoped to the target's
 * org and decision-maker seniorities. Results auto-persist to
 * `entity_contact_enrichments` (Apollo's own searchPeople wrapper does
 * this when `entitySlug` is supplied), so the entity-profile
 * Decision-makers panel reflects the new candidates and Phase 2C's
 * draft-per-target step has names + titles to address.
 *
 * `searchPeople` is the FREE endpoint — no credit consumption. Names
 * + titles only; emails are obfuscated. The `enrichPerson` follow-up
 * (paid, daily-capped) resolves emails when the operator picks a
 * specific person to draft for.
 */
export async function findDecisionMakersForTarget(input: {
  targetId: string;
  companyId: string;
  perPage?: number;
}): Promise<FindDecisionMakersResult> {
  const [target] = await db
    .select({
      id: marketProbeTargets.id,
      entitySlug: marketProbeTargets.entitySlug,
    })
    .from(marketProbeTargets)
    .where(eq(marketProbeTargets.id, input.targetId))
    .limit(1);
  if (!target) {
    return { ok: false, error: `target ${input.targetId} not found` };
  }

  const [entity] = await db
    .select({
      slug: knownEntities.slug,
      name: knownEntities.name,
      apolloOrgId: knownEntities.apolloOrgId,
      primaryDomain: knownEntities.primaryDomain,
    })
    .from(knownEntities)
    .where(eq(knownEntities.slug, target.entitySlug))
    .limit(1);
  if (!entity) {
    return {
      ok: false,
      error: `entity "${target.entitySlug}" not found — target may be stale`,
    };
  }

  // Prefer apollo_org_id (strong) over domain (fuzzy) — Apollo's
  // people search returns drastically better matches when scoped by
  // org id. Fall back to domain when the rolodex stub doesn't have
  // an apollo id yet (older stubs from before the lookalike pass).
  const orgFilter = entity.apolloOrgId
    ? { organizationIds: [entity.apolloOrgId] }
    : entity.primaryDomain
      ? { organizationDomainsList: [entity.primaryDomain] }
      : null;
  if (!orgFilter) {
    return {
      ok: false,
      error: `entity "${entity.name}" has no Apollo id and no primary_domain — Apollo people search needs at least one`,
    };
  }

  const result = await searchPeople({
    filters: {
      ...orgFilter,
      personSeniorities: [
        // Procurement / commercial-supply decision-makers: tighter
        // than "everyone." Includes manager so smaller companies
        // (where the manager IS the decision-maker) aren't excluded.
        'owner',
        'founder',
        'c_suite',
        'partner',
        'vp',
        'head',
        'director',
        'manager',
      ],
      // 'verified' only — drafting against an unverified address
      // burns sender reputation. Phase 2C's draft step requires
      // verified email anyway; filtering here saves a round-trip.
      contactEmailStatus: ['verified'],
    },
    entitySlug: entity.slug,
    companyId: input.companyId,
    opts: { perPage: input.perPage ?? 25 },
  });

  if (!('people' in result)) {
    return {
      ok: false,
      error: `apollo people search failed: ${result.reason}`,
      degrade: result,
    };
  }

  return {
    ok: true,
    entitySlug: entity.slug,
    candidatesFound: result.people.length,
  };
}

// ──────────────────────────────────────────────────────────────────
// Thesis-driven Apollo search — seed-free org discovery
// ──────────────────────────────────────────────────────────────────

export type AddThesisOrgsResult =
  | {
      ok: true;
      candidatesFound: number;
      targetsCreated: number;
      stubsCreated: number;
    }
  | { ok: false; error: string; degrade?: ApolloDegradeResult };

/**
 * Seed-free Apollo org discovery for a probe. Operator supplies a few
 * keyword tags ("hotel procurement", "fuel distributor") + the probe's
 * country fence already constrains the geography. Useful when the
 * probe has no rolodex seed yet — graph similarity + lookalikes both
 * need a seed; this path doesn't.
 *
 * Same stub-creation flow as `addApolloLookalikesToProbe`: orgs match
 * via apollo_org_id or primary_domain reuse the existing slug; new
 * orgs land as `apollo-<id>` stubs with role='unknown'.
 */
export async function addThesisDrivenApolloOrgsToProbe(input: {
  probeId: string;
  keywords: string[];
  limit?: number;
}): Promise<AddThesisOrgsResult> {
  const probe = await getProbe(input.probeId);
  if (!probe) return { ok: false, error: `probe ${input.probeId} not found` };
  if (!probe.country) {
    return {
      ok: false,
      error: 'probe.country required for thesis search — set it on the probe and retry',
    };
  }
  const keywords = input.keywords.map((k) => k.trim()).filter(Boolean).slice(0, 5);
  if (keywords.length === 0) {
    return { ok: false, error: 'at least one keyword required' };
  }

  const filters: ApolloSearchFilters = {
    organizationKeywordTags: keywords,
    organizationLocations: [probe.country],
  };
  const limit = Math.min(input.limit ?? 25, 50);

  const search = await searchOrgs(filters, { perPage: limit });
  if (!('organizations' in search)) {
    return {
      ok: false,
      error: `apollo search failed: ${search.reason}`,
      degrade: search,
    };
  }

  const candidates = search.organizations;
  if (candidates.length === 0) {
    return {
      ok: true,
      candidatesFound: 0,
      targetsCreated: 0,
      stubsCreated: 0,
    };
  }

  let stubsCreated = 0;
  const targets: Array<{
    id: string;
    entitySlug: string;
    contactId: null;
    segment: null;
    fitTier: 'A' | 'B' | 'C' | 'D';
    confidence: number;
    evidenceJson: Record<string, unknown>;
  }> = [];

  for (const org of candidates) {
    const slug = await resolveOrCreateRolodexStubFromApollo({
      apolloOrgId: org.id,
      name: org.name,
      primaryDomain: org.primaryDomain,
      probeCountry: probe.country,
    });
    if (!slug) continue;
    if (slug.created) stubsCreated += 1;
    targets.push({
      id: createId(),
      entitySlug: slug.slug,
      contactId: null,
      segment: null,
      // Thesis-driven matches are weaker than lookalikes — they
      // share the operator's keyword guess + country, not a measured
      // attribute profile. Default fit C; operator promotes to B/A
      // after review.
      fitTier: 'C',
      confidence: 0.4,
      evidenceJson: {
        source: 'apollo_thesis_search',
        apolloOrgId: org.id,
        keywords,
        country: probe.country,
        entityName: org.name,
        primaryDomain: org.primaryDomain,
        websiteUrl: org.websiteUrl,
        linkedinUrl: org.linkedinUrl,
        foundedYear: org.foundedYear,
        recommendedChannel: 'email',
        evidenceItems: [
          {
            label: `Apollo thesis match: keywords=[${keywords.join(', ')}], country=${probe.country}`,
          },
        ],
      },
    });
  }

  const inserted = await upsertProbeTargets(input.probeId, targets);
  return {
    ok: true,
    candidatesFound: candidates.length,
    targetsCreated: inserted,
    stubsCreated,
  };
}
