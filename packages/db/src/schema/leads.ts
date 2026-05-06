import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { leadStatusEnum } from './enums';
import { organizations } from './organizations';
import { contacts } from './contacts';
import type { ExternalKeys } from './organizations';

/**
 * Per docs/vex-into-procur-merge-brief.md Phase 4. Procur sidecar
 * context attached to a lead at push time. Persisted verbatim so the
 * lead UI + chat agent can render KYC state, datasheet specs, source
 * documents, market snapshot, and the pushing desk's trading defaults
 * without re-querying procur. Every sub-field is optional — an old-
 * version push lands as `{}`.
 */
export interface LeadProcurMetadata {
  procurApproval?: {
    status:
      | 'pending'
      | 'kyc_in_progress'
      | 'approved_without_kyc'
      | 'approved_with_kyc'
      | 'rejected'
      | 'expired';
    approvedAt?: string | null | undefined;
    expiresAt?: string | null | undefined;
    notes?: string | null | undefined;
  };
  productSpecs?: Array<{
    property: string;
    astmMethod?: string | null | undefined;
    units?: string | null | undefined;
    min?: string | null | undefined;
    max?: string | null | undefined;
    typical?: string | null | undefined;
  }>;
  sourceDocuments?: Array<{
    url: string;
    contentType: string;
    filename: string;
  }>;
  marketContext?: {
    benchmarkAsOf?: string | null | undefined;
    brentSpotUsdPerBbl?: number | null | undefined;
    nyhDieselSpotUsdPerGal?: number | null | undefined;
    nyhGasolineSpotUsdPerGal?: number | null | undefined;
  };
  procurTradingDefaults?: {
    defaultSourcingRegion?: string | null | undefined;
    targetGrossMarginPct?: number | null | undefined;
    targetNetMarginPerUsg?: number | null | undefined;
    monthlyFixedOverheadUsdDefault?: number | null | undefined;
  };
  pushReason?: string | undefined;
  signals?: Array<ProcurSignal> | undefined;
  matchQueue?:
    | {
        score: number;
        reasons: string[];
        relatedOpportunities?: string[] | undefined;
      }
    | undefined;
  ownership?:
    | {
        parents?: Array<ProcurOwnershipEdge> | undefined;
        subsidiaries?: Array<ProcurOwnershipEdge> | undefined;
      }
    | undefined;
}

export interface ProcurSignal {
  kind:
    | 'rfq'
    | 'tender_award'
    | 'vessel_clearance'
    | 'customs_event'
    | 'news'
    | 'other';
  occurredAt: string;
  source: string;
  narrative: string;
  weight?: number | undefined;
}

export interface ProcurOwnershipEdge {
  orgKey: string;
  legalName?: string | undefined;
  role?: string | undefined;
  distance: number;
}

export const leads = pgTable(
  'leads',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    contactId: text('contact_id').references(() => contacts.id, {
      onDelete: 'set null',
    }),
    /** Procur user id (text). No FK because procur users.id is uuid. */
    ownerId: text('owner_id'),
    status: leadStatusEnum('status').notNull().default('new'),
    stage: text('stage'),
    qualificationSummary: text('qualification_summary'),
    externalKeys: jsonb('external_keys')
      .$type<ExternalKeys>()
      .notNull()
      .default({}),
    procurMetadata: jsonb('procur_metadata')
      .$type<LeadProcurMetadata>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgIdx: index('leads_org_idx').on(t.orgId),
    contactIdx: index('leads_contact_idx').on(t.contactId),
    statusIdx: index('leads_status_idx').on(t.status),
    externalKeysGinIdx: index('leads_external_keys_gin_idx').using(
      'gin',
      t.externalKeys,
    ),
  }),
);

export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
