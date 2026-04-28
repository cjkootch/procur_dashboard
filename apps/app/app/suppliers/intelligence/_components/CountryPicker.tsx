/**
 * Region-grouped country picker driven by a native <details>/<summary>
 * disclosure — JS-free, accessible, server-rendered.
 *
 * The summary shows the current filter (or "all") and pivots the
 * disclosure on click. Inside, countries are bucketed into broad
 * regional groups so the analyst can scan instead of search through
 * a 70-item flat list. Each country shows its full name + ISO2 +
 * award count.
 */
import Link from 'next/link';
import { type ReactNode } from 'react';

const REGION_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });
function fmtCountry(iso2: string): string {
  try {
    return REGION_NAMES.of(iso2) ?? iso2;
  } catch {
    return iso2;
  }
}

/** Map ISO-2 codes to a coarse region used for grouping in the picker. */
const REGION_OF: Record<string, string> = {
  // Caribbean
  DO: 'Caribbean', JM: 'Caribbean', TT: 'Caribbean', BS: 'Caribbean',
  BB: 'Caribbean', HT: 'Caribbean', CU: 'Caribbean', PR: 'Caribbean',
  DM: 'Caribbean', GD: 'Caribbean', LC: 'Caribbean', VC: 'Caribbean',
  AG: 'Caribbean', KN: 'Caribbean', SR: 'Caribbean', GY: 'Caribbean',
  // North America
  US: 'North America', CA: 'North America', MX: 'North America',
  // Latin America
  AR: 'Latin America', BR: 'Latin America', CL: 'Latin America',
  CO: 'Latin America', EC: 'Latin America', PE: 'Latin America',
  VE: 'Latin America', UY: 'Latin America', PY: 'Latin America',
  BO: 'Latin America', GT: 'Latin America', HN: 'Latin America',
  SV: 'Latin America', NI: 'Latin America', CR: 'Latin America',
  PA: 'Latin America',
  // Europe / Mediterranean
  GB: 'Europe', DE: 'Europe', FR: 'Europe', IT: 'Europe', ES: 'Europe',
  PT: 'Europe', NL: 'Europe', BE: 'Europe', GR: 'Europe', TR: 'Europe',
  RO: 'Europe', PL: 'Europe', CZ: 'Europe', HU: 'Europe', BG: 'Europe',
  HR: 'Europe', SE: 'Europe', NO: 'Europe', FI: 'Europe', DK: 'Europe',
  IE: 'Europe', AT: 'Europe', CH: 'Europe', UA: 'Europe', RU: 'Europe',
  CY: 'Europe', MT: 'Europe',
  // Middle East
  IL: 'Middle East', SA: 'Middle East', AE: 'Middle East', QA: 'Middle East',
  KW: 'Middle East', OM: 'Middle East', BH: 'Middle East', IR: 'Middle East',
  IQ: 'Middle East', JO: 'Middle East', LB: 'Middle East', SY: 'Middle East',
  YE: 'Middle East', EG: 'Middle East',
  // Africa
  NG: 'Africa', GH: 'Africa', SN: 'Africa', ZA: 'Africa', KE: 'Africa',
  MA: 'Africa', DZ: 'Africa', TN: 'Africa', LY: 'Africa', AO: 'Africa',
  CI: 'Africa', ET: 'Africa', UG: 'Africa', TZ: 'Africa', SD: 'Africa',
  // Asia
  IN: 'Asia', CN: 'Asia', JP: 'Asia', KR: 'Asia', SG: 'Asia',
  TH: 'Asia', VN: 'Asia', MY: 'Asia', ID: 'Asia', PH: 'Asia',
  PK: 'Asia', BD: 'Asia', LK: 'Asia',
  // Oceania
  AU: 'Oceania', NZ: 'Oceania',
};

const REGION_ORDER = [
  'Caribbean',
  'Latin America',
  'North America',
  'Europe',
  'Middle East',
  'Africa',
  'Asia',
  'Oceania',
  'Other',
];

type Country = { country: string; awardCount: number };

export function CountryPicker({
  countries,
  selected,
  buildHref,
}: {
  countries: Country[];
  selected: string | undefined;
  buildHref: (country: string | null) => string;
}): ReactNode {
  const groups = new Map<string, Country[]>();
  for (const c of countries) {
    const region = REGION_OF[c.country] ?? 'Other';
    if (!groups.has(region)) groups.set(region, []);
    groups.get(region)!.push(c);
  }

  const summaryLabel = selected
    ? `${fmtCountry(selected)} (${selected})`
    : 'All countries';

  return (
    <details className="group/picker relative">
      <summary
        className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2.5 py-1 text-xs font-medium hover:border-[color:var(--color-foreground)] [&::-webkit-details-marker]:hidden"
      >
        <span>{summaryLabel}</span>
        <span className="text-[10px] text-[color:var(--color-muted-foreground)] transition-transform group-open/picker:rotate-180">
          ▾
        </span>
      </summary>
      <div className="absolute left-0 top-full z-30 mt-2 max-h-[60vh] w-[min(640px,90vw)] overflow-y-auto rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-3 shadow-lg">
        <div className="mb-2 flex items-center justify-between text-[11px] text-[color:var(--color-muted-foreground)]">
          <span>
            {countries.length} countries · {countries.reduce((s, c) => s + c.awardCount, 0).toLocaleString()} awards
          </span>
          {selected && (
            <Link
              href={buildHref(null)}
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 text-[10px] hover:border-[color:var(--color-foreground)]"
            >
              Clear
            </Link>
          )}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {REGION_ORDER.filter((r) => groups.has(r)).map((region) => {
            const list = groups.get(region)!;
            return (
              <div key={region}>
                <div className="mb-1 text-[10px] font-medium uppercase tracking-widest text-[color:var(--color-muted-foreground)]">
                  {region}
                </div>
                <div className="flex flex-wrap gap-1">
                  {list.map((c) => {
                    const isSelected = selected === c.country;
                    return (
                      <Link
                        key={c.country}
                        href={buildHref(c.country)}
                        className={`group/cell inline-flex items-baseline gap-1 rounded-[var(--radius-sm)] border px-1.5 py-0.5 text-[11px] hover:border-[color:var(--color-foreground)] ${
                          isSelected
                            ? 'border-[color:var(--color-foreground)] bg-[color:var(--color-muted)]/40'
                            : 'border-[color:var(--color-border)]'
                        }`}
                        title={`${fmtCountry(c.country)} — ${c.awardCount.toLocaleString()} awards`}
                      >
                        <span className="font-mono text-[10px]">{c.country}</span>
                        <span className="text-[10px] tabular-nums text-[color:var(--color-muted-foreground)]">
                          {c.awardCount >= 1000
                            ? `${(c.awardCount / 1000).toFixed(0)}k`
                            : c.awardCount}
                        </span>
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </details>
  );
}
