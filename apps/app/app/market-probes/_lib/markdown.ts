import type { MarketProbe } from '@procur/db';

/**
 * Per-tab snapshot helpers for the probe profile pages. Each tab
 * builds a markdown blob describing what's currently rendered;
 * <CopyMarkdownToolbar> copies it to the clipboard so operators
 * can paste into chat / issues / debugging sessions instead of
 * taking screenshots.
 *
 * Header preamble is shared across tabs (always tells the reader
 * which probe the snapshot belongs to). Each tab adds its own
 * section.
 */

export function formatProbeHeaderMarkdown(probe: MarketProbe): string {
  const lines: string[] = [];
  lines.push(
    `# ${probe.marketName}${probe.country ? ` (${probe.country.toUpperCase()})` : ''}`,
  );
  lines.push('');
  lines.push(`- **Status:** ${probe.status}`);
  lines.push(`- **Tier:** ${probe.tier}`);
  lines.push(`- **Stage:** ${probe.ladderStage}`);
  lines.push(`- **Mode:** ${probe.mode}`);
  lines.push(
    `- **Caps:** ${probe.dailySendLimit}/day, ${probe.totalSendLimit} total`,
  );
  if (probe.allowedChannels && probe.allowedChannels.length > 0) {
    lines.push(`- **Channels:** ${probe.allowedChannels.join(', ')}`);
  }
  if (probe.outreachLanguage) {
    lines.push(`- **Outreach language:** ${probe.outreachLanguage}`);
  }
  if (probe.alias) {
    lines.push(`- **Alias:** ${probe.alias}`);
  }
  if (probe.formalityLevel) {
    lines.push(`- **Formality:** ${probe.formalityLevel}`);
  }
  if (probe.domainHint) {
    lines.push(`- **Domain hint:** ${probe.domainHint}`);
  }
  lines.push('');
  lines.push(`> ${probe.productThesis}`);
  if (probe.objective) {
    lines.push('');
    lines.push(`**Objective:** ${probe.objective}`);
  }
  lines.push('');
  return lines.join('\n');
}

interface TargetSnapshotInput {
  id: string;
  entitySlug: string;
  fitTier: string;
  sendStatus: string;
  justificationState: string;
  evidenceJson: unknown;
  whyThisCompany?: string | null;
  whyThisPerson?: string | null;
  whyNow?: string | null;
  safestFirstAsk?: string | null;
}

export function formatTargetsMarkdown(
  probe: MarketProbe,
  targets: TargetSnapshotInput[],
  counts: { justified: number; pending: number; research_only: number },
  feedbackByTargetId: Map<string, Set<string>>,
): string {
  const out: string[] = [formatProbeHeaderMarkdown(probe)];
  out.push(`## Targets (${targets.length})`);
  out.push('');
  out.push(
    `${counts.justified} justified · ${counts.pending} pending · ${counts.research_only} research-only`,
  );
  out.push('');
  if (targets.length === 0) {
    out.push('_No targets._');
    return out.join('\n');
  }
  out.push('| Entity | Tier | Score | Status | Justification | Feedback |');
  out.push('|---|---|---|---|---|---|');
  for (const t of targets) {
    const ev = (t.evidenceJson ?? {}) as Record<string, unknown>;
    const entityName =
      typeof ev['entityName'] === 'string'
        ? (ev['entityName'] as string)
        : t.entitySlug;
    const score =
      typeof ev['score'] === 'number'
        ? (ev['score'] as number).toFixed(0)
        : '—';
    const feedback = feedbackByTargetId.get(t.id);
    const feedbackText =
      feedback && feedback.size > 0 ? [...feedback].join(', ') : '—';
    out.push(
      `| ${entityName} | ${t.fitTier} | ${score} | ${t.sendStatus} | ${t.justificationState} | ${feedbackText} |`,
    );
  }
  return out.join('\n');
}

interface ConversationSnapshotInput {
  channel: string;
  conversationKey: string;
  entityName: string | null;
  approvalMode: string;
  lastActivityAt: Date;
}

export function formatConversationsMarkdown(
  probe: MarketProbe,
  conversations: ConversationSnapshotInput[],
): string {
  const out: string[] = [formatProbeHeaderMarkdown(probe)];
  out.push(`## Conversations (${conversations.length})`);
  out.push('');
  if (conversations.length === 0) {
    out.push('_No conversations linked to this probe yet._');
    return out.join('\n');
  }
  out.push(
    '| Channel | Recipient | Entity | Last activity | Approval mode |',
  );
  out.push('|---|---|---|---|---|');
  for (const c of conversations) {
    out.push(
      `| ${c.channel} | ${c.conversationKey} | ${c.entityName ?? '—'} | ${c.lastActivityAt.toISOString()} | ${c.approvalMode} |`,
    );
  }
  return out.join('\n');
}

interface OverviewSnapshotInput {
  scorecard: {
    replyRate: number;
    routingRate: number;
    bounceRate: number;
    repliedCount: number;
    sentCount: number;
    bouncedCount: number;
    atlasFactsCount: number;
    atlasNegativeRulesCount: number;
    scores: { overallLearning: number };
  } | null;
  planGenerationStatus: string | undefined;
  planGenerationError: string | undefined;
}

export function formatOverviewMarkdown(
  probe: MarketProbe,
  input: OverviewSnapshotInput,
): string {
  const out: string[] = [formatProbeHeaderMarkdown(probe)];
  out.push('## Overview');
  out.push('');
  if (input.planGenerationStatus && input.planGenerationStatus !== 'ok') {
    out.push(`### ⚠ Plan generation: ${input.planGenerationStatus}`);
    if (input.planGenerationError) {
      out.push('');
      out.push(`> ${input.planGenerationError}`);
    }
    out.push('');
  }
  if (input.scorecard) {
    const s = input.scorecard;
    out.push('### KPIs');
    out.push('');
    out.push('| Metric | Value | Detail |');
    out.push('|---|---|---|');
    out.push(
      `| Reply rate | ${Math.round(s.replyRate * 100)}% | ${s.repliedCount} / ${s.sentCount} |`,
    );
    out.push(
      `| Routing rate | ${Math.round(s.routingRate * 100)}% | positive + routing replies |`,
    );
    out.push(
      `| Bounce rate | ${Math.round(s.bounceRate * 100)}% | ${s.bouncedCount} bounced |`,
    );
    out.push(
      `| Atlas facts | ${s.atlasFactsCount} | ${s.atlasNegativeRulesCount} negative rules |`,
    );
    out.push(`| Overall learning | ${s.scores.overallLearning} | composite (0-100) |`);
  }
  return out.join('\n');
}

interface PlanSnapshotInput {
  hypothesis: string | undefined;
  segments: string[] | undefined;
  outreachAngle: string | undefined;
  successCriteria: string[] | undefined;
  hypothesesCount: number;
  hypothesesActive: number;
  hypothesesConfirmed: number;
  hypothesesRefuted: number;
  variantsCount: number;
  strategyProposalsPending: number;
  atlasFactsCount: number;
  hasLearningReport: boolean;
}

export function formatPlanMarkdown(
  probe: MarketProbe,
  input: PlanSnapshotInput,
): string {
  const out: string[] = [formatProbeHeaderMarkdown(probe)];
  out.push('## Plan');
  out.push('');
  if (input.hypothesis) {
    out.push(`**Hypothesis:** ${input.hypothesis}`);
    out.push('');
  }
  if (input.segments && input.segments.length > 0) {
    out.push(`**Segments:** ${input.segments.join(', ')}`);
    out.push('');
  }
  if (input.outreachAngle) {
    out.push(`**Outreach angle:** ${input.outreachAngle}`);
    out.push('');
  }
  if (input.successCriteria && input.successCriteria.length > 0) {
    out.push('**Success criteria:**');
    for (const c of input.successCriteria) out.push(`- ${c}`);
    out.push('');
  }
  out.push('### Counts');
  out.push('');
  out.push(
    `- Hypotheses: ${input.hypothesesCount} (${input.hypothesesActive} active, ${input.hypothesesConfirmed} confirmed, ${input.hypothesesRefuted} refuted)`,
  );
  out.push(`- Variants: ${input.variantsCount}`);
  out.push(`- Strategy proposals (pending): ${input.strategyProposalsPending}`);
  out.push(`- Atlas facts: ${input.atlasFactsCount}`);
  out.push(`- Learning report: ${input.hasLearningReport ? 'yes' : 'no'}`);
  return out.join('\n');
}

interface SettingsSnapshotInput {
  emailSignatureText: string | null;
  maxBounceRatePct: string;
  maxComplaintRatePct: string;
  maxNoReplyBeforeSegmentPause: number;
  maxTotalNoSignalBeforeProbePause: number;
  blockedTerms: string[];
  allowPaidEnrichment: boolean;
  rvmAudioAssetCount: number;
  rvmAudioAssetActiveCount: number;
}

export function formatSettingsMarkdown(
  probe: MarketProbe,
  input: SettingsSnapshotInput,
): string {
  const out: string[] = [formatProbeHeaderMarkdown(probe)];
  out.push('## Settings');
  out.push('');
  out.push('### Identity');
  out.push(`- Alias: ${probe.alias ?? '(company default)'}`);
  out.push(
    `- Email signature: ${input.emailSignatureText ? 'set' : '(company default)'}`,
  );
  out.push('');
  out.push('### Drafter steering');
  out.push(`- Formality: ${probe.formalityLevel ?? '(default)'}`);
  out.push(`- Domain hint: ${probe.domainHint ?? '(none)'}`);
  out.push(`- Outreach language: ${probe.outreachLanguage ?? 'auto'}`);
  out.push('');
  out.push('### Kill criteria');
  out.push(`- Max bounce rate: ${input.maxBounceRatePct}%`);
  out.push(`- Max complaint rate: ${input.maxComplaintRatePct}%`);
  out.push(
    `- Max no-reply before segment pause: ${input.maxNoReplyBeforeSegmentPause}`,
  );
  out.push(
    `- Max total no-signal before probe pause: ${input.maxTotalNoSignalBeforeProbePause}`,
  );
  out.push('');
  out.push('### Autopilot');
  out.push(`- Tier: ${probe.tier}`);
  out.push(`- Mode: ${probe.mode}`);
  out.push(
    `- Allow paid Apollo phone enrichment: ${input.allowPaidEnrichment ? 'yes' : 'no'}`,
  );
  out.push('');
  out.push('### RVM audio');
  out.push(
    `- ${input.rvmAudioAssetCount} asset(s) total, ${input.rvmAudioAssetActiveCount} active`,
  );
  if (input.blockedTerms.length > 0) {
    out.push('');
    out.push('### Blocked terms');
    out.push(input.blockedTerms.join(', '));
  }
  return out.join('\n');
}
