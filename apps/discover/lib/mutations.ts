import 'server-only';
import { db, alertProfiles } from '@procur/db';

/**
 * Discover-side mutations for the AI assistant write tools.
 *
 * Kept separate from queries.ts so the read/write surfaces are easy to
 * audit. Every function here implies a user took an action via the
 * assistant — log accordingly upstream if we want activity tracking.
 *
 * All mutations are scoped by AssistantContext.userId / companyId,
 * which the agent loop guarantees comes from the authenticated
 * handshake token (never user-supplied at the tool layer).
 */

export type CreateAlertProfileInput = {
  userId: string;
  companyId: string;
  name: string;
  jurisdictions?: string[];
  categories?: string[];
  keywords?: string[];
  excludeKeywords?: string[];
  minValueUsd?: number;
  maxValueUsd?: number;
  frequency?: 'instant' | 'daily' | 'weekly';
};

export type CreateAlertProfileResult = {
  id: string;
  name: string;
  frequency: string;
  active: boolean;
  manageUrl: string;
};

/**
 * Create a new alert profile for the user. Profile is active +
 * email-enabled by default; the user can toggle either off in the
 * main app's alerts settings page after creation.
 *
 * The alerts cron task (in @procur/email-digest) reads alert_profiles
 * once per cycle and matches against new opportunities — this row
 * becomes effective on the next run (instant: ~5 min, daily: next
 * morning, weekly: next Monday).
 */
export async function createAlertProfile(
  input: CreateAlertProfileInput,
): Promise<CreateAlertProfileResult> {
  const trimmedName = input.name.trim();
  if (!trimmedName) throw new Error('alert profile name is required');

  const [row] = await db
    .insert(alertProfiles)
    .values({
      userId: input.userId,
      companyId: input.companyId,
      name: trimmedName.slice(0, 200),
      jurisdictions: input.jurisdictions && input.jurisdictions.length > 0
        ? input.jurisdictions
        : null,
      categories: input.categories && input.categories.length > 0
        ? input.categories
        : null,
      keywords: input.keywords && input.keywords.length > 0 ? input.keywords : null,
      excludeKeywords:
        input.excludeKeywords && input.excludeKeywords.length > 0
          ? input.excludeKeywords
          : null,
      minValue: input.minValueUsd != null ? String(input.minValueUsd) : null,
      maxValue: input.maxValueUsd != null ? String(input.maxValueUsd) : null,
      frequency: input.frequency ?? 'daily',
      emailEnabled: true,
      active: true,
    })
    .returning({
      id: alertProfiles.id,
      name: alertProfiles.name,
      frequency: alertProfiles.frequency,
      active: alertProfiles.active,
    });
  if (!row) throw new Error('alert profile insert returned no row');

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.procur.app';
  return {
    id: row.id,
    name: row.name,
    frequency: row.frequency,
    active: row.active,
    manageUrl: `${appUrl}/alerts`,
  };
}
