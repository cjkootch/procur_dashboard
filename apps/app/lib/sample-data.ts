import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import {
  agencies,
  contentLibrary,
  contracts,
  db,
  jurisdictions,
  opportunities,
  pastPerformance,
  pursuits,
  type Company,
} from '@procur/db';

/**
 * Seed a small "Try Procur" sample data set into a company so brand-new
 * tenants don't bounce off an empty dashboard. Everything inserted is
 * clearly labeled `[Sample]` so users can find + delete it later.
 *
 * Idempotent: re-running is a no-op if the company already has any
 * pursuits — we don't want to re-seed once a tenant has real data.
 *
 * Safe across tenants: the shared `sample` jurisdiction + agency rows
 * are upserted by slug, but the opportunities + pursuits + contracts
 * + library + past performance are scoped to (companyId | userId).
 */

const SAMPLE_JURISDICTION_SLUG = 'sample';
const SAMPLE_AGENCY_SLUG = 'sample-agency';

export type SeedResult = {
  pursuitsCreated: number;
  contractsCreated: number;
  libraryItemsCreated: number;
  pastPerformanceCreated: number;
  alreadyHadData: boolean;
};

export async function seedSampleDataForCompany(
  company: Company,
  userId: string,
): Promise<SeedResult> {
  // Bail if the company has any existing pursuits — assume that means
  // they have real data and we shouldn't re-seed.
  const [{ n: existingPursuits } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pursuits)
    .where(eq(pursuits.companyId, company.id));
  if (existingPursuits > 0) {
    return {
      pursuitsCreated: 0,
      contractsCreated: 0,
      libraryItemsCreated: 0,
      pastPerformanceCreated: 0,
      alreadyHadData: true,
    };
  }

  // Upsert the shared sample jurisdiction.
  let [jurisdiction] = await db
    .select()
    .from(jurisdictions)
    .where(eq(jurisdictions.slug, SAMPLE_JURISDICTION_SLUG))
    .limit(1);
  if (!jurisdiction) {
    [jurisdiction] = await db
      .insert(jurisdictions)
      .values({
        name: 'Sample Jurisdiction',
        slug: SAMPLE_JURISDICTION_SLUG,
        countryCode: 'XX',
        region: 'global',
        portalName: 'Sample portal',
        currency: 'USD',
        active: false, // hide from the discover index
      })
      .returning();
    if (!jurisdiction) throw new Error('failed to create sample jurisdiction');
  }

  let [agency] = await db
    .select()
    .from(agencies)
    .where(
      and(
        eq(agencies.jurisdictionId, jurisdiction.id),
        eq(agencies.slug, SAMPLE_AGENCY_SLUG),
      ),
    )
    .limit(1);
  if (!agency) {
    [agency] = await db
      .insert(agencies)
      .values({
        jurisdictionId: jurisdiction.id,
        name: 'Sample Ministry of Procurement',
        slug: SAMPLE_AGENCY_SLUG,
      })
      .returning();
    if (!agency) throw new Error('failed to create sample agency');
  }

  // Two opportunities → two pursuits at different stages.
  const [opp1, opp2] = await db
    .insert(opportunities)
    .values([
      {
        sourceReferenceId: `sample-${company.id}-opp1`,
        jurisdictionId: jurisdiction.id,
        agencyId: agency.id,
        sourceUrl: 'https://procur.app/sample',
        slug: `sample-${company.id}-opp1`,
        title: '[Sample] National e-Procurement Modernization',
        description:
          'Pilot project to modernize the e-procurement platform: migrate to a cloud-native architecture, integrate with the national ID system, and provide bilingual support. Vendor must demonstrate experience with multi-tenant SaaS, public-sector security compliance, and ISO 27001 certification.',
        valueEstimate: '4500000',
        valueEstimateUsd: '4500000',
        currency: 'USD',
        deadlineAt: new Date(Date.now() + 21 * 24 * 60 * 60 * 1000),
        status: 'active',
      },
      {
        sourceReferenceId: `sample-${company.id}-opp2`,
        jurisdictionId: jurisdiction.id,
        agencyId: agency.id,
        sourceUrl: 'https://procur.app/sample',
        slug: `sample-${company.id}-opp2`,
        title: '[Sample] Health Records Interoperability Framework',
        description:
          'Design and roll out an HL7 FHIR-based interoperability layer connecting the public hospital network. Scope includes data mapping, an integration sandbox, and 18 months of operations support. Bidder must have prior FHIR work and a local presence for on-site change management.',
        valueEstimate: '1800000',
        valueEstimateUsd: '1800000',
        currency: 'USD',
        deadlineAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
        status: 'active',
      },
    ])
    .returning();
  if (!opp1 || !opp2) throw new Error('failed to insert sample opportunities');

  const [pursuit1, pursuit2] = await db
    .insert(pursuits)
    .values([
      {
        companyId: company.id,
        opportunityId: opp1.id,
        stage: 'capture_planning',
        assignedUserId: userId,
        pWin: '0.65',
        notes:
          '[Sample] Mid-capture: incumbent identified, win themes drafted, awaiting partner LOA.',
      },
      {
        companyId: company.id,
        opportunityId: opp2.id,
        stage: 'qualification',
        assignedUserId: userId,
        pWin: '0.45',
        notes: '[Sample] Early qualification: confirming budget + clarifying FHIR scope.',
      },
    ])
    .returning({ id: pursuits.id });

  // One contract — separate from pursuits (no pursuit linkage required).
  const [contract] = await db
    .insert(contracts)
    .values({
      companyId: company.id,
      awardTitle: '[Sample] National Civic Identity API — Phase 1',
      tier: 'prime',
      contractNumber: 'SAMPLE-001',
      awardingAgency: 'Sample Ministry of Civic Identity',
      awardDate: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10),
      startDate: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10),
      endDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      totalValue: '850000',
      currency: 'USD',
      totalValueUsd: '850000',
      status: 'active',
      notes: '[Sample] Active contract for a digital identity API integration.',
    })
    .returning({ id: contracts.id });

  // One library item to seed retrieval.
  const [libItem] = await db
    .insert(contentLibrary)
    .values({
      companyId: company.id,
      type: 'boilerplate',
      title: '[Sample] About Our Firm',
      content:
        'Our firm specializes in delivering modernization programs for ministries across emerging markets. We bring 8+ years of public-sector experience, ISO 27001 certification, and a hybrid onshore/offshore delivery model that has consistently come in under budget.',
      tags: ['boilerplate', 'company-overview', 'sample'],
    })
    .returning({ id: contentLibrary.id });

  // One past performance for proposal retrieval.
  const [pp] = await db
    .insert(pastPerformance)
    .values({
      companyId: company.id,
      projectName: '[Sample] Tax Authority Citizen Portal',
      customerName: 'Sample Revenue Authority',
      customerType: 'central_government',
      periodStart: new Date(Date.now() - 730 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10),
      periodEnd: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      totalValue: '1200000',
      currency: 'USD',
      scopeDescription:
        'Designed and delivered a citizen-facing tax-filing portal serving ~2M filers/year. Includes ID-linked authentication, payment integrations with 4 commercial banks, and full WCAG 2.1 AA compliance.',
      keyAccomplishments: [
        'Reduced average filing time from 32 to 9 minutes',
        'Zero unscheduled downtime during the first 12 months',
        'Onboarded 380 internal staff with custom training program',
      ],
      outcomes:
        'Tax-filing compliance rose 14 pp year-over-year; the portal won the regional govtech innovation award.',
    })
    .returning({ id: pastPerformance.id });

  return {
    pursuitsCreated: [pursuit1, pursuit2].filter(Boolean).length,
    contractsCreated: contract ? 1 : 0,
    libraryItemsCreated: libItem ? 1 : 0,
    pastPerformanceCreated: pp ? 1 : 0,
    alreadyHadData: false,
  };
}
