import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import {
  db,
  entityContactEnrichments,
  type EntityContactEnrichmentRow,
} from '@procur/db';

/**
 * Operator-driven contact entry — used when Apollo can't match the
 * entity (no Apollo org, no primary domain set, or the person isn't
 * in Apollo's index) but the operator has the email / phone /
 * LinkedIn from another source.
 *
 * Lands in entity_contact_enrichments with source='manual', confidence
 * 1.0 on every populated field (operator-asserted = highest authority).
 * Idempotent on (entity_slug, source, contact_name_normalized) via
 * the existing upsert path used by the discovery flow.
 */

function normalizeContactName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

export interface AddManualContactInput {
  entitySlug: string;
  fullName: string;
  email?: string | null;
  title?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  notes?: string | null;
}

export async function addManualContactEnrichment(
  input: AddManualContactInput,
): Promise<EntityContactEnrichmentRow> {
  const fullName = input.fullName.trim();
  if (!fullName) throw new Error('fullName required');

  const enrichedAt = new Date();
  const normalized = normalizeContactName(fullName);

  await db
    .insert(entityContactEnrichments)
    .values({
      entitySlug: input.entitySlug,
      contactName: fullName,
      contactNameNormalized: normalized,
      email: input.email?.trim() || null,
      emailConfidence: input.email ? '1.00' : null,
      emailSourceUrl: null,
      title: input.title?.trim() || null,
      titleConfidence: input.title ? '1.00' : null,
      phone: input.phone?.trim() || null,
      phoneConfidence: input.phone ? '1.00' : null,
      linkedinUrl: input.linkedinUrl?.trim() || null,
      linkedinConfidence: input.linkedinUrl ? '1.00' : null,
      source: 'manual',
      enrichedAt,
    })
    .onConflictDoUpdate({
      target: [
        entityContactEnrichments.entitySlug,
        entityContactEnrichments.source,
        entityContactEnrichments.contactNameNormalized,
      ],
      set: {
        // Operator entry trumps prior manual rows on the same name —
        // they're updating, not creating a duplicate.
        email: sql`COALESCE(EXCLUDED.email, ${entityContactEnrichments.email})`,
        emailConfidence: sql`COALESCE(EXCLUDED.email_confidence, ${entityContactEnrichments.emailConfidence})`,
        title: sql`COALESCE(EXCLUDED.title, ${entityContactEnrichments.title})`,
        titleConfidence: sql`COALESCE(EXCLUDED.title_confidence, ${entityContactEnrichments.titleConfidence})`,
        phone: sql`COALESCE(EXCLUDED.phone, ${entityContactEnrichments.phone})`,
        phoneConfidence: sql`COALESCE(EXCLUDED.phone_confidence, ${entityContactEnrichments.phoneConfidence})`,
        linkedinUrl: sql`COALESCE(EXCLUDED.linkedin_url, ${entityContactEnrichments.linkedinUrl})`,
        linkedinConfidence: sql`COALESCE(EXCLUDED.linkedin_confidence, ${entityContactEnrichments.linkedinConfidence})`,
        contactName: sql`EXCLUDED.contact_name`,
        enrichedAt: sql`EXCLUDED.enriched_at`,
        updatedAt: enrichedAt,
      },
    });

  // Re-fetch the row so the caller sees the merged result regardless
  // of whether this was insert or update. The filter mirrors the
  // unique index on (entity_slug, source, contact_name_normalized).
  const [row] = await db
    .select()
    .from(entityContactEnrichments)
    .where(
      and(
        eq(entityContactEnrichments.entitySlug, input.entitySlug),
        eq(entityContactEnrichments.source, 'manual'),
        eq(entityContactEnrichments.contactNameNormalized, normalized),
      ),
    )
    .limit(1);
  if (!row) throw new Error('addManualContactEnrichment: no row after upsert');
  return row;
}
