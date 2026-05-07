import 'server-only';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  approvals,
  assistantThreads,
  contacts,
  db,
  events,
  fuelDealCostStack,
  fuelDealDocuments,
  fuelDealMarketContext,
  fuelDealParticipants,
  fuelDealScenarios,
  fuelDeals,
  messages,
  organizations,
  revenueAssumptions,
  threads,
  touchpoints,
  type RevenueAssumption,
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

// ----------------------------------------------------------------------------
// getDealRoomContext — single aggregator for /deals/[id] (the deal room)
// ----------------------------------------------------------------------------

/**
 * Counterparty entry — every org/contact attached to the deal,
 * sourced from both the named columns on fuel_deals (buyer, seller,
 * brokers, intermediary) and the fuel_deal_participants join.
 */
export interface DealRoomCounterparty {
  /** Role: buyer | seller | buyer_broker | seller_broker | intermediary | participant */
  role: string;
  orgId: string | null;
  legalName: string | null;
  contactId: string | null;
  contactName: string | null;
  /** True for the named columns; false for participants-table rows. */
  isPrimary: boolean;
  /** Optional commission terms (only set for participants-table rows). */
  commissionType?: string | null;
  commissionValue?: number | null;
  notes?: string | null;
}

export interface DealRoomCommunicationRow {
  id: string;
  channel: string;
  direction: 'inbound' | 'outbound' | 'system';
  occurredAt: Date;
  subject: string | null;
  preview: string | null;
  contactId: string | null;
  orgId: string | null;
  /** When this row is a touchpoint that came from an approval, the
   *  approval id rides through so the room can pivot to the audit. */
  sourceApprovalId: string | null;
}

export interface DealRoomAssistantThread {
  id: string;
  title: string;
  lastMessageAt: Date;
  createdAt: Date;
}

export interface DealRoomActivityRow {
  id: string;
  verb: string;
  occurredAt: Date;
  actorType: string | null;
  actorId: string | null;
  metadata: Record<string, unknown>;
}

export interface DealRoomDocument {
  id: string;
  documentType: string;
  filename: string;
  storageKey: string;
  uploadedAt: Date;
  uploadedBy: string | null;
  notes: string | null;
}

export interface DealRoomCompliance {
  ofacScreeningStatus: string;
  bisLicenseRequired: boolean;
  bisLicenseNumber: string | null;
  bisLicenseExpiry: string | null;
  eeiFilingRequired: boolean;
  eeiItn: string | null;
  complianceHold: boolean;
  complianceNotes: string | null;
  ndaSignedAt: Date | null;
  ndaCounterpartyOrgId: string | null;
  feeProtectionStatus: string | null;
  feeProtectionProviderOrgId: string | null;
  /** Hard gate. False = chat tools must refuse to disclose buyer/
   *  seller identity or share documents until protection is in place. */
  disclosureAllowed: boolean;
}

export interface DealRoomContext {
  deal: typeof fuelDeals.$inferSelect;
  buyer: { id: string; legalName: string } | null;
  activeScenario: typeof fuelDealScenarios.$inferSelect | null;
  scenarios: Array<typeof fuelDealScenarios.$inferSelect>;
  costStack: typeof fuelDealCostStack.$inferSelect | null;
  marketContext: typeof fuelDealMarketContext.$inferSelect | null;
  counterparties: DealRoomCounterparty[];
  communications: DealRoomCommunicationRow[];
  assistantThreads: DealRoomAssistantThread[];
  documents: DealRoomDocument[];
  compliance: DealRoomCompliance;
  activity: DealRoomActivityRow[];
  /** Revenue Assumption Map rows (the "Counterfactual Deal Simulator").
   *  Empty when no map has been generated/saved yet — the UI prompts
   *  the operator to call `generate_assumption_map` from chat. */
  assumptions: RevenueAssumption[];
}

/**
 * Single-call aggregator for /deals/[id]. Pivots every related
 * surface around the deal id so the deal-room UI can render tabs
 * (Counterparties / Communications / Assistant chats / Documents /
 * Structure / Compliance / Activity) from one server-component
 * fetch.
 *
 * Cost: ~10 queries against indexed columns. All small result sets
 * (deal-scoped) — adds <200ms on Neon HTTP for a typical deal with
 * tens of touchpoints + a handful of documents.
 *
 * Returns null when the deal id doesn't exist.
 */
export async function getDealRoomContext(
  dealId: string,
): Promise<DealRoomContext | null> {
  const dealRows = await db
    .select()
    .from(fuelDeals)
    .where(eq(fuelDeals.id, dealId))
    .limit(1);
  const deal = dealRows[0];
  if (!deal) return null;

  // Build the org-id set we need to look up legal names for.
  const orgIds = [
    deal.buyerOrgId,
    deal.sellerOrgId,
    deal.intermediaryOrgId,
    deal.buySideBrokerOrgId,
    deal.sellSideBrokerOrgId,
    deal.ndaCounterpartyOrgId,
    deal.feeProtectionProviderOrgId,
  ].filter((id): id is string => Boolean(id));

  const [
    participantsRows,
    scenarios,
    stackRows,
    ctxRows,
    documents,
    touchpointRows,
    threadDealRows,
    assistantRows,
    activityRows,
    assumptionRows,
  ] = await Promise.all([
    db
      .select()
      .from(fuelDealParticipants)
      .where(eq(fuelDealParticipants.dealId, dealId)),
    db
      .select()
      .from(fuelDealScenarios)
      .where(eq(fuelDealScenarios.dealId, dealId))
      .orderBy(desc(fuelDealScenarios.updatedAt)),
    db
      .select()
      .from(fuelDealCostStack)
      .where(eq(fuelDealCostStack.dealId, dealId))
      .limit(1),
    db
      .select()
      .from(fuelDealMarketContext)
      .where(eq(fuelDealMarketContext.dealId, dealId))
      .limit(1),
    db
      .select()
      .from(fuelDealDocuments)
      .where(eq(fuelDealDocuments.dealId, dealId))
      .orderBy(desc(fuelDealDocuments.uploadedAt)),
    db
      .select()
      .from(touchpoints)
      .where(eq(touchpoints.dealId, dealId))
      .orderBy(desc(touchpoints.occurredAt))
      .limit(50),
    // Threads: there's no direct deal_id on threads, but assistant_
    // threads has one. Email threads attach indirectly via touchpoints
    // (a touchpoint with channel='email.sent'/'email.received' carries
    // thread_id in metadata). The communications row builder below
    // surfaces both kinds.
    db
      .select()
      .from(threads)
      .where(
        sql`${threads.id} IN (
          SELECT DISTINCT (metadata->>'thread_id')::text
          FROM touchpoints
          WHERE deal_id = ${dealId}
            AND metadata->>'thread_id' IS NOT NULL
        )`,
      ),
    db
      .select()
      .from(assistantThreads)
      .where(eq(assistantThreads.dealId, dealId))
      .orderBy(desc(assistantThreads.lastMessageAt))
      .limit(20),
    // Activity: deal lifecycle events (fuel_deal.*) + every approval
    // event (approval.approved / rejected) where the approval payload
    // references this deal. Last 100, ordered desc.
    db
      .select({
        id: events.id,
        verb: events.verb,
        occurredAt: events.occurredAt,
        actorType: events.actorType,
        actorId: events.actorId,
        metadata: events.metadata,
      })
      .from(events)
      .where(
        sql`${events.subjectId} = ${dealId}
            OR ${events.objectId} = ${dealId}
            OR ${events.metadata}->>'deal_id' = ${dealId}
            OR ${events.metadata}->>'dealId' = ${dealId}`,
      )
      .orderBy(desc(events.occurredAt))
      .limit(100),
    db
      .select()
      .from(revenueAssumptions)
      .where(
        and(
          eq(revenueAssumptions.subjectType, 'fuel_deal'),
          eq(revenueAssumptions.subjectId, dealId),
        ),
      )
      .orderBy(
        asc(revenueAssumptions.status),
        asc(revenueAssumptions.assumptionType),
      ),
  ]);

  // Collect contact ids from participants.
  const contactIds = participantsRows
    .map((p) => p.contactId)
    .filter((id): id is string => Boolean(id));
  if (deal.buyerContactId) contactIds.push(deal.buyerContactId);

  // Hydrate org legal names + contact full names in one fan-out batch.
  const [orgRows, contactRows] = await Promise.all([
    orgIds.length > 0
      ? db
          .select({ id: organizations.id, legalName: organizations.legalName })
          .from(organizations)
          .where(inArray(organizations.id, orgIds))
      : Promise.resolve([] as Array<{ id: string; legalName: string }>),
    contactIds.length > 0
      ? db
          .select({ id: contacts.id, fullName: contacts.fullName })
          .from(contacts)
          .where(inArray(contacts.id, contactIds))
      : Promise.resolve([] as Array<{ id: string; fullName: string | null }>),
  ]);
  const orgById = new Map(orgRows.map((o) => [o.id, o.legalName]));
  const contactById = new Map(contactRows.map((c) => [c.id, c.fullName]));

  // Build the unified counterparty list. Named columns first (primary
  // = true); then participants-table rows (primary = false).
  const counterparties: DealRoomCounterparty[] = [];
  function pushNamed(
    role: string,
    orgId: string | null | undefined,
    contactId: string | null | undefined,
  ) {
    if (!orgId && !contactId) return;
    counterparties.push({
      role,
      orgId: orgId ?? null,
      legalName: orgId ? orgById.get(orgId) ?? null : null,
      contactId: contactId ?? null,
      contactName: contactId ? contactById.get(contactId) ?? null : null,
      isPrimary: true,
    });
  }
  pushNamed('buyer', deal.buyerOrgId, deal.buyerContactId);
  pushNamed('seller', deal.sellerOrgId, null);
  pushNamed('intermediary', deal.intermediaryOrgId, null);
  pushNamed('buyer_broker', deal.buySideBrokerOrgId, null);
  pushNamed('seller_broker', deal.sellSideBrokerOrgId, null);
  for (const p of participantsRows) {
    counterparties.push({
      role: p.partyType,
      orgId: p.orgId,
      legalName: p.orgId ? orgById.get(p.orgId) ?? null : null,
      contactId: p.contactId,
      contactName: p.contactId ? contactById.get(p.contactId) ?? null : null,
      isPrimary: false,
      commissionType: p.commissionType,
      commissionValue: p.commissionValue,
      notes: p.notes,
    });
  }

  // Communications: project the deal-scoped touchpoints into the
  // unified row shape; pull message direction + subject from the
  // related thread when the touchpoint metadata carried a thread_id.
  const threadById = new Map(threadDealRows.map((t) => [t.id, t]));
  const communications: DealRoomCommunicationRow[] = touchpointRows.map((t) => {
    const meta = (t.metadata ?? {}) as Record<string, unknown>;
    const direction: DealRoomCommunicationRow['direction'] =
      t.channel.endsWith('.received')
        ? 'inbound'
        : t.channel.endsWith('.sent') || t.channel.endsWith('.initiated')
          ? 'outbound'
          : 'system';
    const threadId =
      typeof meta['thread_id'] === 'string'
        ? (meta['thread_id'] as string)
        : null;
    const thread = threadId ? threadById.get(threadId) : null;
    const subject =
      thread?.subject ??
      (typeof meta['subject'] === 'string' ? (meta['subject'] as string) : null);
    const preview =
      typeof meta['body_preview'] === 'string'
        ? (meta['body_preview'] as string)
        : typeof meta['preview'] === 'string'
          ? (meta['preview'] as string)
          : typeof meta['body_text'] === 'string'
            ? ((meta['body_text'] as string).slice(0, 240) ?? null)
            : null;
    const sourceApprovalId =
      t.actor && t.actor.startsWith('approval:')
        ? t.actor.slice('approval:'.length)
        : null;
    return {
      id: t.id,
      channel: t.channel,
      direction,
      occurredAt: t.occurredAt,
      subject,
      preview,
      contactId: t.contactId ?? null,
      orgId: t.orgId ?? null,
      sourceApprovalId,
    };
  });

  // Helper variable so the activity-row build below has access to
  // `messages` import without an unused-import lint error.
  void messages;
  void approvals;

  return {
    deal,
    buyer:
      deal.buyerOrgId && orgById.has(deal.buyerOrgId)
        ? { id: deal.buyerOrgId, legalName: orgById.get(deal.buyerOrgId)! }
        : null,
    activeScenario: scenarios.find((s) => s.isActive) ?? null,
    scenarios,
    costStack: stackRows[0] ?? null,
    marketContext: ctxRows[0] ?? null,
    counterparties,
    communications,
    assistantThreads: assistantRows.map((a) => ({
      id: a.id,
      title: a.title,
      lastMessageAt: a.lastMessageAt,
      createdAt: a.createdAt,
    })),
    documents: documents.map((d) => ({
      id: d.id,
      documentType: d.documentType,
      filename: d.filename,
      storageKey: d.storageKey,
      uploadedAt: d.uploadedAt,
      uploadedBy: d.uploadedBy ?? null,
      notes: d.notes ?? null,
    })),
    compliance: {
      ofacScreeningStatus: deal.ofacScreeningStatus,
      bisLicenseRequired: deal.bisLicenseRequired,
      bisLicenseNumber: deal.bisLicenseNumber ?? null,
      // bisLicenseExpiry is a `date` column — drizzle typed as string.
      bisLicenseExpiry: deal.bisLicenseExpiry ?? null,
      eeiFilingRequired: deal.eeiFilingRequired,
      eeiItn: deal.eeiItn ?? null,
      complianceHold: deal.complianceHold,
      complianceNotes: deal.complianceNotes ?? null,
      ndaSignedAt: deal.ndaSignedAt ?? null,
      ndaCounterpartyOrgId: deal.ndaCounterpartyOrgId ?? null,
      feeProtectionStatus: deal.feeProtectionStatus ?? null,
      feeProtectionProviderOrgId: deal.feeProtectionProviderOrgId ?? null,
      disclosureAllowed: deal.disclosureAllowed,
    },
    activity: activityRows.map((e) => ({
      id: e.id,
      verb: e.verb,
      occurredAt: e.occurredAt,
      actorType: e.actorType ?? null,
      actorId: e.actorId ?? null,
      metadata: (e.metadata ?? {}) as Record<string, unknown>,
    })),
    assumptions: assumptionRows,
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
