import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import {
  db,
  fuelDealCostStack,
  fuelDealMarketContext,
  fuelDealScenarios,
  fuelDeals,
  organizations,
} from '@procur/db';

/**
 * Read helpers for /deals (vex-into-procur merge Phase 5). The
 * underlying tables landed in Phase 1; the calculator already lives
 * in @procur/pricing; the DealEvaluatorAgent is in @procur/ai.
 */

export interface DealListRow {
  id: string;
  dealRef: string;
  status:
    | 'draft'
    | 'negotiating'
    | 'pending_approval'
    | 'approved'
    | 'loading'
    | 'in_transit'
    | 'delivered'
    | 'settled'
    | 'cancelled'
    | 'failed';
  product: string;
  lineOfBusiness: string;
  volumeUsg: number;
  buyerOrgId: string;
  buyerLegalName: string | null;
  destinationPort: string | null;
  laycanStart: string | null;
  complianceHold: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export async function listDeals(
  options: {
    status?: DealListRow['status'];
    limit?: number;
  } = {},
): Promise<DealListRow[]> {
  const limit = options.limit ?? 50;
  const rows = await db
    .select({
      id: fuelDeals.id,
      dealRef: fuelDeals.dealRef,
      status: fuelDeals.status,
      product: fuelDeals.product,
      lineOfBusiness: fuelDeals.lineOfBusiness,
      volumeUsg: fuelDeals.volumeUsg,
      buyerOrgId: fuelDeals.buyerOrgId,
      buyerLegalName: organizations.legalName,
      destinationPort: fuelDeals.destinationPort,
      laycanStart: fuelDeals.laycanStart,
      complianceHold: fuelDeals.complianceHold,
      createdAt: fuelDeals.createdAt,
      updatedAt: fuelDeals.updatedAt,
    })
    .from(fuelDeals)
    .leftJoin(organizations, eq(organizations.id, fuelDeals.buyerOrgId))
    .where(options.status ? eq(fuelDeals.status, options.status) : undefined)
    .orderBy(desc(fuelDeals.createdAt))
    .limit(limit);
  return rows as DealListRow[];
}

export interface DealDetail {
  deal: typeof fuelDeals.$inferSelect;
  buyer: { id: string; legalName: string } | null;
  activeScenario: typeof fuelDealScenarios.$inferSelect | null;
  costStack: typeof fuelDealCostStack.$inferSelect | null;
  marketContext: typeof fuelDealMarketContext.$inferSelect | null;
}

export async function getDealDetail(id: string): Promise<DealDetail | null> {
  const dealRows = await db
    .select()
    .from(fuelDeals)
    .where(eq(fuelDeals.id, id))
    .limit(1);
  const deal = dealRows[0];
  if (!deal) return null;

  const buyerRows = await db
    .select({
      id: organizations.id,
      legalName: organizations.legalName,
    })
    .from(organizations)
    .where(eq(organizations.id, deal.buyerOrgId))
    .limit(1);

  const scenarioRows = await db
    .select()
    .from(fuelDealScenarios)
    .where(
      and(
        eq(fuelDealScenarios.dealId, id),
        eq(fuelDealScenarios.isActive, true),
      ),
    )
    .orderBy(desc(fuelDealScenarios.updatedAt))
    .limit(1);

  const stackRows = await db
    .select()
    .from(fuelDealCostStack)
    .where(eq(fuelDealCostStack.dealId, id))
    .limit(1);

  const ctxRows = await db
    .select()
    .from(fuelDealMarketContext)
    .where(eq(fuelDealMarketContext.dealId, id))
    .limit(1);

  return {
    deal,
    buyer: buyerRows[0] ?? null,
    activeScenario: scenarioRows[0] ?? null,
    costStack: stackRows[0] ?? null,
    marketContext: ctxRows[0] ?? null,
  };
}

/**
 * Set the active scenario for a deal — used by the deal-edit UI
 * before running the evaluator. Idempotent: clears `is_active` on
 * all sibling scenarios and sets it on the named one.
 */
export async function setActiveScenario(
  dealId: string,
  scenarioId: string,
): Promise<{ ok: boolean }> {
  await db
    .update(fuelDealScenarios)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(fuelDealScenarios.dealId, dealId));
  const updated = await db
    .update(fuelDealScenarios)
    .set({ isActive: true, updatedAt: new Date() })
    .where(
      and(
        eq(fuelDealScenarios.id, scenarioId),
        eq(fuelDealScenarios.dealId, dealId),
      ),
    )
    .returning({ id: fuelDealScenarios.id });
  return { ok: updated.length > 0 };
}
