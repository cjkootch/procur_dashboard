import type { PortfolioRow } from '@procur/catalog';

/**
 * Markdown export for /market-portfolio. Mirrors the table the page
 * renders so an operator can paste the cross-probe state into chat /
 * issue / debugging session without screenshots.
 */
export function formatPortfolioMarkdown(rows: PortfolioRow[]): string {
  const out: string[] = [];
  out.push(`# Market Portfolio`);
  out.push('');
  out.push(`${rows.length} active / planning probe${rows.length === 1 ? '' : 's'}`);
  out.push('');

  const needsCole = rows.filter((r) => r.needsColeReasons.length > 0);
  if (needsCole.length > 0) {
    out.push(`## Needs Cole (${needsCole.length})`);
    out.push('');
    for (const r of needsCole) {
      out.push(`- **${r.marketName}** — ${r.needsColeReasons.join('; ')}`);
    }
    out.push('');
  }

  out.push(`## Probes`);
  out.push('');
  out.push(
    '| Market | Country | Domain | Status | Tier | Stage | Signal | Sent today | Total | Replies | Pos | Routing | Bounced | Unsub | Learning | Risk |',
  );
  out.push(
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const r of rows) {
    out.push(
      `| ${r.marketName} | ${r.country ?? '—'} | ${r.domain ?? '—'} | ${r.status} | ${r.tier} | ${r.ladderStage} | ${r.signalLevel} | ${r.sentToday}/${r.dailySendLimit} | ${r.totalSent}/${r.totalSendLimit} | ${r.replies} | ${r.positiveReplies} | ${r.routingReplies} | ${r.bounced} | ${r.unsubscribed} | ${r.overallLearningScore} | ${r.riskCleanlinessScore} |`,
    );
  }

  out.push('');
  out.push(`## Channel breakdown (attempts)`);
  out.push('');
  out.push('| Market | email | lead_form | rvm |');
  out.push('|---|---|---|---|');
  for (const r of rows) {
    out.push(
      `| ${r.marketName} | ${r.emailSent} | ${r.leadFormsSubmitted} | ${r.rvmDispatched} |`,
    );
  }
  out.push('');

  out.push(`## Recommendations`);
  out.push('');
  for (const r of rows) {
    out.push(`- **${r.marketName}** (${r.signalLevel}): ${r.recommendation}`);
  }
  out.push('');
  return out.join('\n');
}
