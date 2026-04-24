import 'server-only';
import { and, desc, eq, ilike, or } from 'drizzle-orm';
import {
  agencies,
  contentLibrary,
  contracts,
  db,
  jurisdictions,
  opportunities,
  pastPerformance,
  pursuits,
} from '@procur/db';
import { embedText } from '@procur/ai';
import { semanticSearchLibrary } from './library-queries';
import { semanticSearchPastPerformance } from './past-performance-queries';

export type SearchHitKind =
  | 'opportunity'
  | 'pursuit'
  | 'contract'
  | 'past_performance'
  | 'library';

export type SearchHit = {
  kind: SearchHitKind;
  id: string;
  title: string;
  subtitle: string | null;
  meta?: string | null;
  href: string;
  updatedAt: Date;
};

export type SearchResults = {
  opportunities: SearchHit[];
  pursuits: SearchHit[];
  contracts: SearchHit[];
  pastPerformance: SearchHit[];
  library: SearchHit[];
  totalCount: number;
};

const PER_GROUP_LIMIT = 8;

export async function runGlobalSearch(
  companyId: string,
  rawQuery: string,
): Promise<SearchResults> {
  const query = rawQuery.trim();
  if (query.length === 0) {
    return emptyResults();
  }
  const like = `%${query}%`;
  const discoverBase = process.env.NEXT_PUBLIC_DISCOVER_URL ?? 'https://discover.procur.app';

  const [pursuitRows, oppRows, contractRows, ppRows, libRows] = await Promise.all([
    // Pursuits owned by this company that match on opportunity title / notes / referenceNumber
    db
      .select({
        id: pursuits.id,
        title: opportunities.title,
        referenceNumber: opportunities.referenceNumber,
        stage: pursuits.stage,
        agencyName: agencies.name,
        jurisdictionName: jurisdictions.name,
        updatedAt: pursuits.updatedAt,
      })
      .from(pursuits)
      .innerJoin(opportunities, eq(opportunities.id, pursuits.opportunityId))
      .innerJoin(jurisdictions, eq(jurisdictions.id, opportunities.jurisdictionId))
      .leftJoin(agencies, eq(agencies.id, opportunities.agencyId))
      .where(
        and(
          eq(pursuits.companyId, companyId),
          or(
            ilike(opportunities.title, like),
            ilike(opportunities.referenceNumber, like),
            ilike(opportunities.description, like),
          ),
        ),
      )
      .orderBy(desc(pursuits.updatedAt))
      .limit(PER_GROUP_LIMIT),

    // Active opportunities regardless of pursuit state — link out to discover
    db
      .select({
        id: opportunities.id,
        slug: opportunities.slug,
        title: opportunities.title,
        referenceNumber: opportunities.referenceNumber,
        category: opportunities.category,
        jurisdictionName: jurisdictions.name,
        agencyName: agencies.name,
        updatedAt: opportunities.updatedAt,
      })
      .from(opportunities)
      .innerJoin(jurisdictions, eq(jurisdictions.id, opportunities.jurisdictionId))
      .leftJoin(agencies, eq(agencies.id, opportunities.agencyId))
      .where(
        and(
          eq(opportunities.status, 'active'),
          or(
            ilike(opportunities.title, like),
            ilike(opportunities.referenceNumber, like),
            ilike(opportunities.description, like),
          ),
        ),
      )
      .orderBy(desc(opportunities.publishedAt))
      .limit(PER_GROUP_LIMIT),

    db
      .select({
        id: contracts.id,
        title: contracts.awardTitle,
        contractNumber: contracts.contractNumber,
        agency: contracts.awardingAgency,
        status: contracts.status,
        updatedAt: contracts.updatedAt,
      })
      .from(contracts)
      .where(
        and(
          eq(contracts.companyId, companyId),
          or(
            ilike(contracts.awardTitle, like),
            ilike(contracts.contractNumber, like),
            ilike(contracts.awardingAgency, like),
            ilike(contracts.notes, like),
          ),
        ),
      )
      .orderBy(desc(contracts.updatedAt))
      .limit(PER_GROUP_LIMIT),

    db
      .select({
        id: pastPerformance.id,
        projectName: pastPerformance.projectName,
        customerName: pastPerformance.customerName,
        scopeDescription: pastPerformance.scopeDescription,
        updatedAt: pastPerformance.updatedAt,
      })
      .from(pastPerformance)
      .where(
        and(
          eq(pastPerformance.companyId, companyId),
          or(
            ilike(pastPerformance.projectName, like),
            ilike(pastPerformance.customerName, like),
            ilike(pastPerformance.scopeDescription, like),
            ilike(pastPerformance.outcomes, like),
          ),
        ),
      )
      .orderBy(desc(pastPerformance.updatedAt))
      .limit(PER_GROUP_LIMIT),

    db
      .select({
        id: contentLibrary.id,
        title: contentLibrary.title,
        type: contentLibrary.type,
        content: contentLibrary.content,
        updatedAt: contentLibrary.updatedAt,
      })
      .from(contentLibrary)
      .where(
        and(
          eq(contentLibrary.companyId, companyId),
          or(
            ilike(contentLibrary.title, like),
            ilike(contentLibrary.content, like),
          ),
        ),
      )
      .orderBy(desc(contentLibrary.updatedAt))
      .limit(PER_GROUP_LIMIT),
  ]);

  const pursuitsHits: SearchHit[] = pursuitRows.map((r) => ({
    kind: 'pursuit',
    id: r.id,
    title: r.title,
    subtitle: [r.agencyName ?? r.jurisdictionName, r.referenceNumber]
      .filter(Boolean)
      .join(' · '),
    meta: r.stage,
    href: `/capture/pursuits/${r.id}`,
    updatedAt: r.updatedAt,
  }));

  const oppHits: SearchHit[] = oppRows.map((r) => ({
    kind: 'opportunity',
    id: r.id,
    title: r.title,
    subtitle: [r.agencyName ?? r.jurisdictionName, r.referenceNumber]
      .filter(Boolean)
      .join(' · '),
    meta: r.category ?? undefined,
    href: r.slug ? `${discoverBase}/opportunities/${r.slug}` : `/capture/new?opportunityId=${r.id}`,
    updatedAt: r.updatedAt,
  }));

  const contractHits: SearchHit[] = contractRows.map((r) => ({
    kind: 'contract',
    id: r.id,
    title: r.title,
    subtitle: [r.agency, r.contractNumber].filter(Boolean).join(' · ') || null,
    meta: r.status,
    href: `/contract/${r.id}`,
    updatedAt: r.updatedAt,
  }));

  const ppHits: SearchHit[] = ppRows.map((r) => ({
    kind: 'past_performance',
    id: r.id,
    title: r.projectName,
    subtitle: r.customerName,
    meta: r.scopeDescription?.slice(0, 120) ?? null,
    href: `/past-performance/${r.id}`,
    updatedAt: r.updatedAt,
  }));

  const libHits: SearchHit[] = libRows.map((r) => ({
    kind: 'library',
    id: r.id,
    title: r.title,
    subtitle: r.type,
    meta: r.content.slice(0, 140),
    href: `/library/${r.id}`,
    updatedAt: r.updatedAt,
  }));

  // Blend semantic hits for past performance + library when embeddings are
  // configured. Deduped by id so a row found by both ILIKE and semantic
  // search keeps its ILIKE position. Gracefully no-ops without OpenAI.
  if (process.env.OPENAI_API_KEY) {
    try {
      const emb = await embedText(query);
      const [semanticPP, semanticLib] = await Promise.all([
        semanticSearchPastPerformance(companyId, emb, 5),
        semanticSearchLibrary(companyId, emb, 5),
      ]);

      const ppIds = new Set(ppHits.map((h) => h.id));
      for (const p of semanticPP) {
        if (ppIds.has(p.id)) continue;
        if (ppHits.length >= PER_GROUP_LIMIT) break;
        ppHits.push({
          kind: 'past_performance',
          id: p.id,
          title: p.projectName,
          subtitle: p.customerName,
          meta: p.scopeDescription?.slice(0, 120) ?? null,
          href: `/past-performance/${p.id}`,
          updatedAt: new Date(),
        });
      }

      const libIds = new Set(libHits.map((h) => h.id));
      for (const l of semanticLib) {
        if (libIds.has(l.id)) continue;
        if (libHits.length >= PER_GROUP_LIMIT) break;
        libHits.push({
          kind: 'library',
          id: l.id,
          title: l.title,
          subtitle: l.type,
          meta: l.content.slice(0, 140),
          href: `/library/${l.id}`,
          updatedAt: new Date(),
        });
      }
    } catch (err) {
      console.warn('semantic search blend skipped:', err);
    }
  }

  return {
    opportunities: oppHits,
    pursuits: pursuitsHits,
    contracts: contractHits,
    pastPerformance: ppHits,
    library: libHits,
    totalCount:
      oppHits.length +
      pursuitsHits.length +
      contractHits.length +
      ppHits.length +
      libHits.length,
  };
}



function emptyResults(): SearchResults {
  return {
    opportunities: [],
    pursuits: [],
    contracts: [],
    pastPerformance: [],
    library: [],
    totalCount: 0,
  };
}
