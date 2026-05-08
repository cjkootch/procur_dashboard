import { notFound } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import {
  computeProbeScorecard,
  getProbe,
  listRvmAudioAssetsForProbe,
  listVariants,
} from '@procur/catalog';
import { RvmAudioPanel } from '../../_components/RvmAudioPanel';
import {
  addApolloLookalikesAction,
  addThesisOrgsAction,
  approveFallbackPlanAction,
  discoverTargetsAction,
  autopilotSendBatchAction,
  generatePlanAction,
  setProbeAllowPaidEnrichmentAction,
  setProbeDrafterSteeringAction,
  setProbeIdentityAction,
  setProbeKillCriteriaAction,
  setProbeModeAction,
  setProbeTierAction,
  setProbeStatusAction,
} from '../../actions';

export const dynamic = 'force-dynamic';

// STATUS_TONE moved to layout.tsx; FIT_TONE moved to /targets;
// TASK_STATUS_TONE moved to /plan.

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function MarketProbeDetailPage({ params }: PageProps) {
  await requireCompany();
  const { id } = await params;
  const probe = await getProbe(id);
  if (!probe) notFound();
  const [scorecard, variants, rvmAudioAssets] = await Promise.all([
    computeProbeScorecard(id),
    listVariants(id),
    listRvmAudioAssetsForProbe(id, { activeOnly: false }),
  ]);

  // ladder stage controls live in layout.tsx now.

  const plan = probe.planJson ?? {};

  return (
    <>
      {/* Scorecard — composite metrics. Computed on every page load
          (cheap; reads + a refreshSegmentCounts pass). */}
      {plan.generationStatus && plan.generationStatus !== 'ok' && (
        <section className="mb-6 rounded-[var(--radius-lg)] border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <div className="mb-2 font-semibold">
            Plan generation fell back to a deterministic skeleton.
          </div>
          <div className="mb-3">
            {plan.generationStatus === 'fallback_no_api_key'
              ? 'ANTHROPIC_API_KEY is not set in this environment — the Sonnet pass was skipped.'
              : 'Sonnet returned malformed JSON and the parser fell through.'}{' '}
            The probe is held at <code>planning</code> and autopilot is
            blocked until the plan is regenerated or you explicitly
            approve the hollow plan.
          </div>
          {plan.generationError && (
            <div className="mb-3 max-h-24 overflow-auto rounded-[var(--radius-sm)] bg-white/60 px-2 py-1.5 font-mono text-[11px] text-amber-900/80">
              {plan.generationError}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <form action={generatePlanAction}>
              <input type="hidden" name="probeId" value={probe.id} />
              <button
                type="submit"
                className="rounded-[var(--radius-md)] bg-amber-900 px-3 py-1.5 text-xs font-medium text-amber-50"
              >
                Retry plan generation
              </button>
            </form>
            <form action={approveFallbackPlanAction}>
              <input type="hidden" name="probeId" value={probe.id} />
              <button
                type="submit"
                className="rounded-[var(--radius-md)] border border-amber-700 px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100"
              >
                Approve hollow plan anyway
              </button>
            </form>
          </div>
        </section>
      )}

      {scorecard && (
        <section className="mb-6 grid grid-cols-2 gap-3 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4 md:grid-cols-5">
          <ScoreCell label="Reply rate" value={`${Math.round(scorecard.replyRate * 100)}%`} sub={`${scorecard.repliedCount} / ${scorecard.sentCount}`} />
          <ScoreCell
            label="Routing rate"
            value={`${Math.round(scorecard.routingRate * 100)}%`}
            sub="positive + routing replies"
          />
          <ScoreCell
            label="Bounce rate"
            value={`${Math.round(scorecard.bounceRate * 100)}%`}
            sub={`${scorecard.bouncedCount} bounced`}
            warn={scorecard.bounceRate > 0.08}
          />
          <ScoreCell
            label="Atlas facts"
            value={String(scorecard.atlasFactsCount)}
            sub={`${scorecard.atlasNegativeRulesCount} negative rules`}
          />
          <ScoreCell
            label="Overall learning"
            value={String(scorecard.scores.overallLearning)}
            sub="composite (0-100)"
          />
        </section>
      )}

        {/* Controls */}
        <aside className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Controls
          </h2>
          <div className="space-y-3">
            <form action={discoverTargetsAction}>
              <input type="hidden" name="probeId" value={probe.id} />
              <button
                type="submit"
                disabled={!probe.country}
                className="w-full rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-2 text-sm font-medium text-[color:var(--color-background)] disabled:opacity-40"
              >
                Discover targets
              </button>
              <p className="mt-1 text-[11px] text-[color:var(--color-muted-foreground)]">
                {probe.country
                  ? 'Graph similarity + customs + web + Apollo presence + recency. Country-fenced.'
                  : 'Set country (ISO-2) to enable discovery.'}
              </p>
            </form>

            <form
              action={addApolloLookalikesAction}
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] p-2"
            >
              <input type="hidden" name="probeId" value={probe.id} />
              <label className="block text-[11px] font-medium uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                Apollo lookalikes
              </label>
              <input
                type="text"
                name="seedSlug"
                placeholder="seed entity slug (e.g. caribbean-importers:wibisco)"
                required
                className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-xs focus:border-[color:var(--color-foreground)] focus:outline-none"
              />
              <button
                type="submit"
                className="mt-2 w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[color:var(--color-muted)]/40"
              >
                Find lookalikes
              </button>
              <p className="mt-1 text-[10px] text-[color:var(--color-muted-foreground)]">
                Seed must be in the rolodex (Apollo enrichment auto-runs
                if missing). Pulls 25 attribute-similar orgs (industry /
                size / country), creates rolodex stubs for those not yet
                on file.
              </p>
            </form>

            <form
              action={addThesisOrgsAction}
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] p-2"
            >
              <input type="hidden" name="probeId" value={probe.id} />
              <label className="block text-[11px] font-medium uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                Apollo thesis search
              </label>
              <input
                type="text"
                name="keywords"
                placeholder="keywords (comma-separated)"
                required
                className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-xs focus:border-[color:var(--color-foreground)] focus:outline-none"
              />
              <button
                type="submit"
                disabled={!probe.country}
                className="mt-2 w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[color:var(--color-muted)]/40 disabled:opacity-40"
              >
                Search by thesis
              </button>
              <p className="mt-1 text-[10px] text-[color:var(--color-muted-foreground)]">
                Seed-free. Country-fenced. Useful before you have a
                seed entity. Results land at fit-tier C (weaker than
                lookalikes — keyword guess vs measured similarity).
              </p>
            </form>

            {probe.status === 'active' && (
              <form action={setProbeStatusAction}>
                <input type="hidden" name="probeId" value={probe.id} />
                <input type="hidden" name="status" value="paused" />
                <button
                  type="submit"
                  className="w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-2 text-sm hover:bg-[color:var(--color-muted)]/40"
                >
                  Pause probe
                </button>
              </form>
            )}
            {probe.status === 'paused' && (
              <form action={setProbeStatusAction}>
                <input type="hidden" name="probeId" value={probe.id} />
                <input type="hidden" name="status" value="active" />
                <button
                  type="submit"
                  className="w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-2 text-sm hover:bg-[color:var(--color-muted)]/40"
                >
                  Resume probe
                </button>
              </form>
            )}
            {(probe.status === 'active' || probe.status === 'paused') && (
              <form action={setProbeStatusAction}>
                <input type="hidden" name="probeId" value={probe.id} />
                <input type="hidden" name="status" value="completed" />
                <button
                  type="submit"
                  className="w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-2 text-sm hover:bg-[color:var(--color-muted)]/40"
                >
                  Mark completed
                </button>
              </form>
            )}
          </div>

          <div className="mt-5 space-y-3 text-xs text-[color:var(--color-muted-foreground)]">
            <div>
              <span className="text-[10px] font-semibold uppercase tracking-wider">
                Mode
              </span>
              <form action={setProbeModeAction} className="mt-1 flex gap-1">
                <input type="hidden" name="probeId" value={probe.id} />
                <select
                  name="mode"
                  defaultValue={probe.mode}
                  className="flex-1 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-xs"
                >
                  <option value="experiment">experiment (autopilot eligible)</option>
                  <option value="relationship">relationship (manual only)</option>
                </select>
                <button
                  type="submit"
                  className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 text-xs hover:bg-[color:var(--color-muted)]/40"
                >
                  Set
                </button>
              </form>
            </div>

            <details>
              <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider hover:text-[color:var(--color-foreground)]">
                Kill criteria
              </summary>
              <form
                action={setProbeKillCriteriaAction}
                className="mt-2 grid gap-1.5"
              >
                <input type="hidden" name="probeId" value={probe.id} />
                <label className="flex items-center justify-between gap-2">
                  <span>max bounce rate %</span>
                  <input
                    type="number"
                    step="0.1"
                    name="maxBounceRatePct"
                    defaultValue={Number(probe.maxBounceRatePct)}
                    className="w-16 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-0.5 text-xs"
                  />
                </label>
                <label className="flex items-center justify-between gap-2">
                  <span>max complaint rate %</span>
                  <input
                    type="number"
                    step="0.1"
                    name="maxComplaintRatePct"
                    defaultValue={Number(probe.maxComplaintRatePct)}
                    className="w-16 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-0.5 text-xs"
                  />
                </label>
                <label className="flex items-center justify-between gap-2">
                  <span>no-reply / segment pause</span>
                  <input
                    type="number"
                    name="maxNoReplyBeforeSegmentPause"
                    defaultValue={probe.maxNoReplyBeforeSegmentPause}
                    className="w-16 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-0.5 text-xs"
                  />
                </label>
                <label className="flex items-center justify-between gap-2">
                  <span>no-signal / probe pause</span>
                  <input
                    type="number"
                    name="maxTotalNoSignalBeforeProbePause"
                    defaultValue={probe.maxTotalNoSignalBeforeProbePause}
                    className="w-16 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-0.5 text-xs"
                  />
                </label>
                <button
                  type="submit"
                  className="self-end rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 text-xs hover:bg-[color:var(--color-muted)]/40"
                >
                  Save
                </button>
              </form>
            </details>

            <details>
              <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider hover:text-[color:var(--color-foreground)]">
                Outreach identity
              </summary>
              <form
                action={setProbeIdentityAction}
                className="mt-2 grid gap-1.5"
              >
                <input type="hidden" name="probeId" value={probe.id} />
                <p className="text-[10px] text-[color:var(--color-muted-foreground)]">
                  Per-probe alias + signature override the company defaults
                  at /settings/email for autopilot dispatch and
                  submit_lead_form. Leave blank to fall back.
                </p>
                <label className="grid gap-1">
                  <span>Alias (sender display name)</span>
                  <input
                    type="text"
                    name="alias"
                    defaultValue={probe.alias ?? ''}
                    placeholder="e.g. Ana Martinez or Procurement Desk"
                    maxLength={120}
                    className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-0.5 text-xs"
                  />
                </label>
                <label className="grid gap-1">
                  <span>Email signature (text)</span>
                  <textarea
                    name="emailSignatureText"
                    defaultValue={probe.emailSignatureText ?? ''}
                    rows={4}
                    maxLength={2000}
                    placeholder={'Ana Martinez\nProcur • +1 555 0100'}
                    className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-1 text-xs font-mono"
                  />
                </label>
                <label className="grid gap-1">
                  <span>Email signature (HTML, optional)</span>
                  <textarea
                    name="emailSignatureHtml"
                    defaultValue={probe.emailSignatureHtml ?? ''}
                    rows={3}
                    maxLength={4000}
                    placeholder="<div>Ana Martinez<br>Procur</div>"
                    className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-1 text-xs font-mono"
                  />
                </label>
                <button
                  type="submit"
                  className="self-end rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 text-xs hover:bg-[color:var(--color-muted)]/40"
                >
                  Save
                </button>
              </form>
            </details>

            <details>
              <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider hover:text-[color:var(--color-foreground)]">
                Drafter steering
              </summary>
              <form
                action={setProbeDrafterSteeringAction}
                className="mt-2 grid gap-1.5"
              >
                <input type="hidden" name="probeId" value={probe.id} />
                <p className="text-[10px] text-[color:var(--color-muted-foreground)]">
                  Per-probe formality + domain framing. Threaded into both
                  email and lead-form drafter prompts. Use when the probe
                  is operating outside the default professional-procurement
                  shape (cross-border M&A, succession outreach, warm-market
                  follow-ups).
                </p>
                <label className="grid gap-1">
                  <span>Formality</span>
                  <select
                    name="formalityLevel"
                    defaultValue={probe.formalityLevel ?? ''}
                    className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-0.5 text-xs"
                  >
                    <option value="">(default — professional)</option>
                    <option value="high">
                      High — deferential, indirect, honorifics
                    </option>
                    <option value="professional">
                      Professional — direct but courteous
                    </option>
                    <option value="casual">
                      Casual — warm-market, conversational
                    </option>
                  </select>
                </label>
                <label className="grid gap-1">
                  <span>Outreach language (ISO 639-1)</span>
                  <input
                    type="text"
                    name="outreachLanguage"
                    defaultValue={probe.outreachLanguage ?? ''}
                    placeholder="e.g. ja, fr, ko, es (blank = English)"
                    maxLength={2}
                    pattern="[a-zA-Z]{2}"
                    className="w-24 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-0.5 text-xs"
                  />
                  <span className="text-[10px] text-[color:var(--color-muted-foreground)]">
                    When set, both drafters write first-touch in this
                    language and the reply path stays in language across
                    the thread (the inbox auto-translates inbound to
                    English on display either way). Blank = English.
                  </span>
                </label>
                <label className="grid gap-1">
                  <span>Domain hint (optional, max 1000 chars)</span>
                  <textarea
                    name="domainHint"
                    defaultValue={probe.domainHint ?? ''}
                    rows={5}
                    maxLength={1000}
                    placeholder={
                      "e.g. \"Exploratory M&A conversation with a succession-stage business owner. Lead with respect for what they've built; do NOT lead with valuation; goal of first contact is to learn whether succession is on their mind, not to make an offer.\""
                    }
                    className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-1 text-xs"
                  />
                </label>
                <button
                  type="submit"
                  className="self-end rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 text-xs hover:bg-[color:var(--color-muted)]/40"
                >
                  Save
                </button>
              </form>
            </details>

            {probe.allowedChannels.includes('rvm') && (
              <details>
                <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider hover:text-[color:var(--color-foreground)]">
                  RVM phone enrichment
                </summary>
                <form
                  action={setProbeAllowPaidEnrichmentAction}
                  className="mt-2 grid gap-1.5"
                >
                  <input type="hidden" name="probeId" value={probe.id} />
                  <p className="text-[10px] text-[color:var(--color-muted-foreground)]">
                    When the autopilot picks the RVM channel and the
                    target&apos;s phone isn&apos;t already on file
                    (rolodex / Apollo cache / external supplier), allow
                    a paid Apollo <code>enrichPerson</code> call to
                    resolve it. Counts against the tenant&apos;s daily
                    enrichment cap. Off = skip the target on RVM
                    rather than spend.
                  </p>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      name="allowPaidEnrichment"
                      defaultChecked={probe.allowPaidEnrichment}
                    />
                    <span>Allow paid Apollo phone enrichment</span>
                  </label>
                  <button
                    type="submit"
                    className="self-end rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 text-xs hover:bg-[color:var(--color-muted)]/40"
                  >
                    Save
                  </button>
                </form>
              </details>
            )}

            <div className="border-t border-[color:var(--color-border)] pt-3">
              <span className="text-[10px] font-semibold uppercase tracking-wider">
                Autopilot (Tier 1)
              </span>
              <p className="mt-1 text-[10px]">
                Tier {probe.tier} —{' '}
                {probe.tier === 0
                  ? 'research-only; every send is operator-approved.'
                  : `autopilot drafts + sends within caps. Mode: ${probe.mode}.`}
              </p>
              <div className="mt-2 flex flex-col gap-1.5">
                {probe.tier === 0 && probe.mode === 'experiment' && (
                  <form action={setProbeTierAction}>
                    <input type="hidden" name="probeId" value={probe.id} />
                    <input type="hidden" name="tier" value="1" />
                    <button
                      type="submit"
                      className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-xs hover:bg-[color:var(--color-muted)]/40"
                      title="Graduate to Tier 1 — autopilot drafts + sends to A/B-tier justified targets within daily caps."
                    >
                      Graduate to Tier 1
                    </button>
                  </form>
                )}
                {probe.tier >= 1 && (
                  <>
                    <form action={autopilotSendBatchAction}>
                      <input type="hidden" name="probeId" value={probe.id} />
                      <button
                        type="submit"
                        disabled={probe.mode !== 'experiment' || probe.status !== 'active'}
                        className="w-full rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-background)] disabled:opacity-40"
                        title="Drafts + dispatches the next eligible batch (justified A/B targets, scout-protection cleared, kill criteria not breached, within daily cap)."
                      >
                        Run autopilot batch
                      </button>
                    </form>
                    <form action={setProbeTierAction}>
                      <input type="hidden" name="probeId" value={probe.id} />
                      <input type="hidden" name="tier" value="0" />
                      <button
                        type="submit"
                        className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-[10px] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
                      >
                        Demote to Tier 0
                      </button>
                    </form>
                  </>
                )}
              </div>
            </div>
            <p className="pt-1">
              Phase 1 = manual approval; Tier 1 graduates to autopilot
              (Phase 2H).
            </p>
            {probe.allowedChannels.length > 0 && (
              <p>Channels: {probe.allowedChannels.join(', ')}</p>
            )}
            {probe.blockedTerms.length > 0 && (
              <p>Blocked terms: {probe.blockedTerms.join(', ')}</p>
            )}
          </div>
        </aside>


      <RvmAudioPanel
        probeId={probe.id}
        probeOutreachLanguage={probe.outreachLanguage}
        variants={variants.map((v) => ({ id: v.id, name: v.variantName }))}
        assets={rvmAudioAssets}
      />
    </>
  );
}
function ScoreCell({
  label,
  value,
  sub,
  warn,
}: {
  label: string;
  value: string;
  sub?: string;
  warn?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </span>
      <span
        className={`text-xl font-semibold ${warn ? 'text-red-700' : ''}`}
      >
        {value}
      </span>
      {sub && (
        <span className="text-[10px] text-[color:var(--color-muted-foreground)]">
          {sub}
        </span>
      )}
    </div>
  );
}
