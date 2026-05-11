import type { EntityWebIntelligenceRow } from '@procur/catalog';
import { TriggerCrawlButton } from './TriggerCrawlButton';

/**
 * Read-only "Website intelligence" panel — surfaces facts +
 * summaries extracted by the @procur/ai crawler. The Trigger Crawl
 * button on the header runs `crawlSingleEntity` synchronously
 * (page sets maxDuration=300; capped at 5 pages). Trigger.dev v4
 * migration is the long-term home for the crawl path; this is the
 * pragmatic bridge so operators don't have to drop to CLI for a
 * one-off refresh.
 *
 * Confidence framing per the website-metadata-layer scope: marketing
 * self-presentation, defaults 0.4-0.6. Confidence badges color-code
 * so analysts read the dossier with the right calibration.
 */
export function WebsiteIntelligencePanel({
  intel,
  entityName,
  entitySlug,
}: {
  intel: EntityWebIntelligenceRow | null;
  entityName: string;
  entitySlug: string;
}) {
  if (!intel) {
    return (
      <section className="mb-6">
        <div className="flex items-start justify-between gap-3">
          <SectionHeader title="Website intelligence" />
          <TriggerCrawlButton entitySlug={entitySlug} />
        </div>
        <p className="text-xs text-[color:var(--color-muted-foreground)]">
          Not yet crawled. If this entity has a primary_domain set, click
          Trigger crawl above (or run{' '}
          <code className="rounded bg-[color:var(--color-muted)] px-1">
            pnpm --filter @procur/ai crawl-entity-website --slug=...
          </code>{' '}
          from CLI).
        </p>
      </section>
    );
  }

  const stale = isStaleDays(intel.lastCrawledAt, 90);
  const factsByType = groupFactsByType(intel.topFacts);
  const sectionLabels: Array<[string, string]> = [
    ['company_overview', 'Company overview'],
    ['products_services', 'Products & services'],
    ['operations', 'Operations'],
    ['fuel_relevance', 'Fuel relevance'],
    ['crude_relevance', 'Crude relevance'],
    ['logistics_relevance', 'Logistics relevance'],
    ['contact_path', 'Contact path'],
  ];

  return (
    <section className="mb-6">
      <SectionHeader
        title="Website intelligence"
        right={
          <div className="flex items-center gap-3 text-xs text-[color:var(--color-muted-foreground)]">
            <span>{intel.pagesCrawled} page{intel.pagesCrawled === 1 ? '' : 's'}</span>
            <span>·</span>
            <span>{intel.factsCount} fact{intel.factsCount === 1 ? '' : 's'}</span>
            <span>·</span>
            <span className={stale ? 'text-amber-600' : ''}>
              last crawled {formatRelative(intel.lastCrawledAt)}{stale ? ' (stale)' : ''}
            </span>
            <TriggerCrawlButton entitySlug={entitySlug} />
          </div>
        }
      />

      {/* Section summaries — one accordion-style block per kind that
          has content. Empty kinds skipped. */}
      {sectionLabels.map(([kind, label]) => {
        const content = intel.summaries[kind];
        if (!content) return null;
        return (
          <details
            key={kind}
            className="mb-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-muted)] p-3"
            open={kind === 'company_overview'}
          >
            <summary className="cursor-pointer text-sm font-medium">{label}</summary>
            <p className="mt-2 whitespace-pre-wrap text-sm text-[color:var(--color-foreground)]">
              {content}
            </p>
          </details>
        );
      })}

      {/* Facts grouped by type. Confidence badges color-code calibration. */}
      {factsByType.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Extracted facts
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {factsByType.map(([factType, facts]) => (
              <div
                key={factType}
                className="rounded-md border border-[color:var(--color-border)] p-2"
              >
                <div className="mb-1 text-xs font-medium text-[color:var(--color-muted-foreground)]">
                  {factTypeLabel(factType)}
                </div>
                <ul className="space-y-1">
                  {facts.slice(0, 6).map((f, i) => (
                    <li
                      key={`${f.value}-${i}`}
                      className="flex items-center justify-between gap-2 text-sm"
                    >
                      <span title={f.sourceUrl ?? undefined}>{f.value}</span>
                      {f.confidence != null && (
                        <ConfidenceBadge value={f.confidence} />
                      )}
                    </li>
                  ))}
                  {facts.length > 6 && (
                    <li className="text-xs text-[color:var(--color-muted-foreground)]">
                      + {facts.length - 6} more
                    </li>
                  )}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="mt-3 text-xs text-[color:var(--color-muted-foreground)]">
        Source: {entityName}&apos;s primary website. Confidence capped at
        0.85 — website data is marketing self-presentation, treat as soft signal.
      </p>
    </section>
  );
}

function SectionHeader({
  title,
  right,
}: {
  title: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-[color:var(--color-foreground)]">
        {title}
      </h2>
      {right}
    </div>
  );
}

function ConfidenceBadge({ value }: { value: number }) {
  const tier = value >= 0.7 ? 'high' : value >= 0.5 ? 'mid' : 'low';
  const cls =
    tier === 'high'
      ? 'bg-green-100 text-green-800'
      : tier === 'mid'
      ? 'bg-yellow-100 text-yellow-800'
      : 'bg-red-100 text-red-800';
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-mono ${cls}`}>
      {value.toFixed(2)}
    </span>
  );
}

function isStaleDays(iso: string | null, days: number): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t > days * 86400 * 1000;
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function groupFactsByType(
  facts: EntityWebIntelligenceRow['topFacts'],
): Array<[string, EntityWebIntelligenceRow['topFacts']]> {
  const map = new Map<string, EntityWebIntelligenceRow['topFacts']>();
  for (const f of facts) {
    const list = map.get(f.factType) ?? [];
    list.push(f);
    map.set(f.factType, list);
  }
  // Order: roles + products first, then geography + assets, then contacts/certs.
  const order = [
    'commercial_role',
    'product',
    'service',
    'country_served',
    'port',
    'terminal',
    'refinery',
    'mine',
    'power_plant',
    'decision_maker_role',
    'contact_email',
    'contact_phone',
    'certification',
    'license',
  ];
  return [...map.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
}

function factTypeLabel(factType: string): string {
  switch (factType) {
    case 'commercial_role':
      return 'Commercial role';
    case 'product':
      return 'Products';
    case 'service':
      return 'Services';
    case 'country_served':
      return 'Countries served';
    case 'port':
      return 'Ports';
    case 'terminal':
      return 'Terminals';
    case 'refinery':
      return 'Refineries';
    case 'mine':
      return 'Mines';
    case 'power_plant':
      return 'Power plants';
    case 'decision_maker_role':
      return 'Decision-maker roles';
    case 'contact_email':
      return 'Contact emails';
    case 'contact_phone':
      return 'Contact phones';
    case 'certification':
      return 'Certifications';
    case 'license':
      return 'Licenses';
    default:
      return factType;
  }
}
