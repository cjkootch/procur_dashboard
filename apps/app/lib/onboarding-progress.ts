import 'server-only';
import { eq, sql } from 'drizzle-orm';
import {
  alertProfiles,
  contentLibrary,
  db,
  pastPerformance,
  pursuits,
  type Company,
} from '@procur/db';

export type OnboardingStep = {
  id:
    | 'company_profile'
    | 'first_alert'
    | 'first_pursuit'
    | 'first_library_or_pp'
    | 'invite_team';
  /** Imperative copy shown in the checklist row. */
  title: string;
  /** Plain-language sentence shown when the row is collapsed. */
  hint: string;
  /** Where the user goes when they click the row. */
  href: string;
  /** Computed by computeOnboardingProgress(). */
  done: boolean;
};

export type OnboardingProgress = {
  steps: OnboardingStep[];
  doneCount: number;
  totalCount: number;
  percent: number;
};

/**
 * Compute setup-checklist state from existing data. Five tiny COUNT
 * queries scoped to the company. Renders on the home page when not at
 * 100% so new tenants get a clear path out of the empty-state cliff.
 *
 * "Done" means the user has actually completed something meaningful,
 * not just visited a page:
 *   - company_profile: industry filled in AND capabilities array non-empty
 *   - first_alert: at least one row in alert_profiles for the user
 *   - first_pursuit: at least one row in pursuits for the company
 *   - first_library_or_pp: at least one library item OR past_performance row
 *   - invite_team: teammateCount > 1 (caller passes in the count)
 */
export async function computeOnboardingProgress(
  company: Company,
  userId: string,
  teammateCount: number,
): Promise<OnboardingProgress> {
  const profileDone =
    !!company.industry &&
    company.industry.trim().length > 0 &&
    Array.isArray(company.capabilities) &&
    (company.capabilities ?? []).length > 0;

  const [alertRow, pursuitRow, libRow, ppRow] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(alertProfiles)
      .where(eq(alertProfiles.userId, userId)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(pursuits)
      .where(eq(pursuits.companyId, company.id)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(contentLibrary)
      .where(eq(contentLibrary.companyId, company.id)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(pastPerformance)
      .where(eq(pastPerformance.companyId, company.id)),
  ]);

  const alertCount = alertRow[0]?.n ?? 0;
  const pursuitCount = pursuitRow[0]?.n ?? 0;
  const libCount = libRow[0]?.n ?? 0;
  const ppCount = ppRow[0]?.n ?? 0;

  const steps: OnboardingStep[] = [
    {
      id: 'company_profile',
      title: 'Complete your company profile',
      hint: 'Add your industry + capabilities so AI suggestions land in the right register.',
      href: '/settings',
      done: profileDone,
    },
    {
      id: 'first_pursuit',
      title: 'Track your first opportunity',
      hint: 'Browse Discover for tenders in your jurisdictions, then click "Track" to start a pursuit.',
      href: 'https://discover.procur.app',
      done: pursuitCount > 0,
    },
    {
      id: 'first_alert',
      title: 'Set up an alert profile',
      hint: 'Get a daily or weekly digest of new tenders matching your industry + capability filters.',
      href: '/alerts/new',
      done: alertCount > 0,
    },
    {
      id: 'first_library_or_pp',
      title: 'Seed the library or past performance',
      hint: 'Upload boilerplate content or a recent project so AI section drafts have something to cite.',
      href: '/library',
      done: libCount > 0 || ppCount > 0,
    },
    {
      id: 'invite_team',
      title: 'Invite a teammate',
      hint: 'Comments, gate reviews, and notifications shine when more than one person is on the team.',
      href: '/settings',
      done: teammateCount > 1,
    },
  ];

  const doneCount = steps.filter((s) => s.done).length;
  return {
    steps,
    doneCount,
    totalCount: steps.length,
    percent: Math.round((doneCount / steps.length) * 100),
  };
}
