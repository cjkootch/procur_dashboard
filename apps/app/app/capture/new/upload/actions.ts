'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { tasks } from '@trigger.dev/sdk/v3';
import { requireCompany } from '@procur/auth';
import {
  db,
  documents,
  opportunities,
  pursuits,
  type NewOpportunity,
  type NewPursuit,
} from '@procur/db';
import { getActivePursuitCount } from '../../../../lib/capture-queries';
import { FREE_TIER_ACTIVE_PURSUIT_CAP } from '../../../../lib/plan-limits';

const VERCEL_BLOB_HOST_RE = /\.public\.blob\.vercel-storage\.com$/;
const MAX_DOCUMENTS_PER_UPLOAD = 20;

/**
 * Creates a private opportunity + documents + pursuit from a set of
 * pre-uploaded Vercel Blob URLs (the client uses
 * `@vercel/blob/client.upload()` so files bypass the 4.5MB serverless
 * function body limit).
 *
 * Sets:
 *   - opportunities.source = 'uploaded'
 *   - opportunities.companyId = current tenant (privacy boundary; never
 *     leaks to Discover thanks to isNull(companyId) filters there)
 *   - opportunities.uploadedByUserId = current user
 *   - one documents row per blob URL with processingStatus='pending'
 *
 * Then triggers `opportunity.enrich`, which fans out to processDocument,
 * detectLanguage, classify, summarize, extractRequirements — same
 * pipeline scraped opportunities go through. By the time the user
 * lands on the pursuit page, files are already downloading and being
 * extracted; AI summary populates within ~30-90 seconds.
 */
export async function createPrivatePursuitFromUploadAction(formData: FormData): Promise<void> {
  const { user, company } = await requireCompany();

  // Plan-limit check (uploads count against the same active-pursuit cap
  // as Discover-tracked pursuits; confirmed in the design doc).
  if (company.planTier === 'free') {
    const active = await getActivePursuitCount(company.id);
    if (active >= FREE_TIER_ACTIVE_PURSUIT_CAP) {
      redirect('/billing?reason=pursuit-cap&source=upload');
    }
  }

  const title = (formData.get('title') as string | null)?.trim() ?? '';
  const agency = (formData.get('agency') as string | null)?.trim() ?? '';
  const deadline = (formData.get('deadline') as string | null)?.trim() ?? '';
  const blobUrls = formData.getAll('blobUrls').map((v) => String(v));
  const blobNames = formData.getAll('blobNames').map((v) => String(v));

  if (title.length === 0) throw new Error('Title is required.');
  if (blobUrls.length === 0) throw new Error('Upload at least one document.');
  if (blobUrls.length > MAX_DOCUMENTS_PER_UPLOAD) {
    throw new Error(`Max ${MAX_DOCUMENTS_PER_UPLOAD} documents per upload.`);
  }
  for (const url of blobUrls) {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      throw new Error('A document URL was malformed.');
    }
    // Reject anything that didn't come from our Blob store. Defense in
    // depth: the client uses upload() which only writes to our store,
    // but we don't trust client-supplied URLs blindly.
    if (!VERCEL_BLOB_HOST_RE.test(host)) {
      throw new Error('Document URLs must be Vercel Blob URLs.');
    }
  }

  const deadlineDate = deadline.length > 0 ? new Date(`${deadline}T23:59:59Z`) : null;

  const sourceReferenceId = `upload:${randomUUID()}`;
  const slug = `private-${slugify(title).slice(0, 60)}-${sourceReferenceId.slice(-8)}`;

  const oppRow: NewOpportunity = {
    sourceReferenceId,
    sourceUrl: null,
    jurisdictionId: null,
    agencyId: null,
    source: 'uploaded',
    companyId: company.id,
    uploadedByUserId: user.id,
    title: title.slice(0, 500),
    description: null,
    referenceNumber: null,
    type: null,
    publishedAt: new Date(),
    deadlineAt: deadlineDate,
    status: 'active',
    rawContent: { agency: agency || null, uploadedFilenames: blobNames },
    slug,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
  };

  const [createdOpp] = await db
    .insert(opportunities)
    .values(oppRow)
    .returning({ id: opportunities.id });
  if (!createdOpp) throw new Error('Failed to create opportunity row.');

  await db.insert(documents).values(
    blobUrls.map((url, i) => ({
      opportunityId: createdOpp.id,
      documentType: 'tender_document',
      title: blobNames[i] ?? `Uploaded document ${i + 1}`,
      // We pass the Vercel Blob URL as originalUrl. process-document
      // detects this and skips the re-upload step (download from URL,
      // extract text, mark completed — using the same URL as r2Url).
      originalUrl: url,
      processingStatus: 'pending' as const,
    })),
  );

  const pursuitRow: NewPursuit = {
    companyId: company.id,
    opportunityId: createdOpp.id,
    stage: 'identification',
    assignedUserId: user.id,
  };
  const [createdPursuit] = await db
    .insert(pursuits)
    .values(pursuitRow)
    .returning({ id: pursuits.id });
  if (!createdPursuit) throw new Error('Failed to create pursuit row.');

  // Fire and forget — enrich runs asynchronously on trigger.dev.
  // Failures here shouldn't block the redirect; the scheduled
  // process-pending-documents sweep will catch anything that drops.
  await tasks
    .trigger('opportunity.enrich', { opportunityId: createdOpp.id })
    .catch(() => {
      /* sweep will retry */
    });

  redirect(`/capture/pursuits/${createdPursuit.id}`);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
