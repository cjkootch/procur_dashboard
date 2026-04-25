import 'server-only';
import { ilike, or, sql, eq } from 'drizzle-orm';
import {
  companies,
  contracts,
  db,
  opportunities,
  pursuits,
  users,
} from '@procur/db';

/**
 * Cross-tenant search for the admin app. Single string lights up
 * matches across companies, users, pursuits, contracts, and
 * opportunities. ILIKE-based — fine at v1 scale (10s-100s of tenants,
 * thousands of rows). Revisit if/when we need real full-text or fuzzy
 * matching.
 *
 * Each per-entity query is capped at 10 hits so a generic word like
 * "Ministry" doesn't return thousands of opportunities and explode
 * the page render. The UI shows "+N more" when capped.
 */

const MAX_PER_BUCKET = 10;

export type SearchHit =
  | {
      kind: 'company';
      id: string;
      title: string;
      subtitle: string;
      href: string;
    }
  | {
      kind: 'user';
      id: string;
      title: string;
      subtitle: string;
      href: string;
    }
  | {
      kind: 'pursuit';
      id: string;
      title: string;
      subtitle: string;
      href: string;
      tenantHref: string;
    }
  | {
      kind: 'contract';
      id: string;
      title: string;
      subtitle: string;
      href: string;
      tenantHref: string;
    }
  | {
      kind: 'opportunity';
      id: string;
      title: string;
      subtitle: string;
    };

export type SearchResults = {
  query: string;
  companies: { hits: SearchHit[]; truncated: boolean };
  users: { hits: SearchHit[]; truncated: boolean };
  pursuits: { hits: SearchHit[]; truncated: boolean };
  contracts: { hits: SearchHit[]; truncated: boolean };
  opportunities: { hits: SearchHit[]; truncated: boolean };
  totalHits: number;
};

export async function searchEverything(rawQuery: string): Promise<SearchResults> {
  const query = rawQuery.trim();
  const empty: SearchResults = {
    query,
    companies: { hits: [], truncated: false },
    users: { hits: [], truncated: false },
    pursuits: { hits: [], truncated: false },
    contracts: { hits: [], truncated: false },
    opportunities: { hits: [], truncated: false },
    totalHits: 0,
  };
  if (query.length < 2) return empty;

  const wild = `%${query}%`;
  // For id-shaped queries (UUIDs), an exact match is also useful — try
  // both ILIKE on text columns and an exact UUID lookup on id columns.
  const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    query,
  );

  const [companyRows, userRows, pursuitRows, contractRows, oppRows] = await Promise.all([
    db
      .select({
        id: companies.id,
        name: companies.name,
        slug: companies.slug,
        country: companies.country,
        clerkOrgId: companies.clerkOrgId,
        stripeCustomerId: companies.stripeCustomerId,
      })
      .from(companies)
      .where(
        or(
          ilike(companies.name, wild),
          ilike(companies.slug, wild),
          ilike(companies.clerkOrgId, wild),
          ilike(companies.stripeCustomerId, wild),
          looksLikeUuid ? eq(companies.id, query) : sql`false`,
        ),
      )
      .limit(MAX_PER_BUCKET + 1),
    db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        clerkId: users.clerkId,
        companyId: users.companyId,
      })
      .from(users)
      .where(
        or(
          ilike(users.email, wild),
          ilike(users.firstName, wild),
          ilike(users.lastName, wild),
          ilike(users.clerkId, wild),
          looksLikeUuid ? eq(users.id, query) : sql`false`,
        ),
      )
      .limit(MAX_PER_BUCKET + 1),
    db
      .select({
        id: pursuits.id,
        companyId: pursuits.companyId,
        opportunityTitle: opportunities.title,
        stage: pursuits.stage,
      })
      .from(pursuits)
      .innerJoin(opportunities, eq(opportunities.id, pursuits.opportunityId))
      .where(
        or(
          ilike(opportunities.title, wild),
          ilike(opportunities.referenceNumber, wild),
          looksLikeUuid ? eq(pursuits.id, query) : sql`false`,
        ),
      )
      .limit(MAX_PER_BUCKET + 1),
    db
      .select({
        id: contracts.id,
        companyId: contracts.companyId,
        awardTitle: contracts.awardTitle,
        contractNumber: contracts.contractNumber,
        status: contracts.status,
      })
      .from(contracts)
      .where(
        or(
          ilike(contracts.awardTitle, wild),
          ilike(contracts.contractNumber, wild),
          ilike(contracts.parentContractNumber, wild),
          ilike(contracts.taskOrderNumber, wild),
          looksLikeUuid ? eq(contracts.id, query) : sql`false`,
        ),
      )
      .limit(MAX_PER_BUCKET + 1),
    db
      .select({
        id: opportunities.id,
        title: opportunities.title,
        referenceNumber: opportunities.referenceNumber,
        slug: opportunities.slug,
      })
      .from(opportunities)
      .where(
        or(
          ilike(opportunities.title, wild),
          ilike(opportunities.referenceNumber, wild),
          ilike(opportunities.slug, wild),
          looksLikeUuid ? eq(opportunities.id, query) : sql`false`,
        ),
      )
      .limit(MAX_PER_BUCKET + 1),
  ]);

  const companiesBucket = bucketize(companyRows, (c) => ({
    kind: 'company' as const,
    id: c.id,
    title: c.name,
    subtitle: [c.country, c.slug, c.stripeCustomerId, c.clerkOrgId]
      .filter(Boolean)
      .join(' · '),
    href: `/tenants/${c.id}`,
  }));

  const usersBucket = bucketize(userRows, (u) => ({
    kind: 'user' as const,
    id: u.id,
    title: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email,
    subtitle: [u.email, u.clerkId].filter(Boolean).join(' · '),
    href: u.companyId ? `/tenants/${u.companyId}` : '/tenants',
  }));

  const pursuitsBucket = bucketize(pursuitRows, (p) => ({
    kind: 'pursuit' as const,
    id: p.id,
    title: p.opportunityTitle,
    subtitle: `${p.stage} · ${p.id}`,
    href: `/audit?companyId=${p.companyId}&entityType=pursuit`,
    tenantHref: `/tenants/${p.companyId}`,
  }));

  const contractsBucket = bucketize(contractRows, (c) => ({
    kind: 'contract' as const,
    id: c.id,
    title: c.awardTitle,
    subtitle: [c.contractNumber, c.status].filter(Boolean).join(' · '),
    href: `/tenants/${c.companyId}`,
    tenantHref: `/tenants/${c.companyId}`,
  }));

  const oppsBucket = bucketize(oppRows, (o) => ({
    kind: 'opportunity' as const,
    id: o.id,
    title: o.title,
    subtitle: [o.referenceNumber, o.slug].filter(Boolean).join(' · '),
  }));

  const totalHits =
    companiesBucket.hits.length +
    usersBucket.hits.length +
    pursuitsBucket.hits.length +
    contractsBucket.hits.length +
    oppsBucket.hits.length;

  return {
    query,
    companies: companiesBucket,
    users: usersBucket,
    pursuits: pursuitsBucket,
    contracts: contractsBucket,
    opportunities: oppsBucket,
    totalHits,
  };
}

function bucketize<T, H extends SearchHit>(
  rows: T[],
  toHit: (r: T) => H,
): { hits: SearchHit[]; truncated: boolean } {
  const truncated = rows.length > MAX_PER_BUCKET;
  return {
    hits: rows.slice(0, MAX_PER_BUCKET).map(toHit),
    truncated,
  };
}
