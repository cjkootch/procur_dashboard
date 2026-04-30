import { evaluateTargetPrice, type ProductSlug } from '@procur/catalog';

/**
 * Quote-anchors widget on a refiner entity profile. Shows the
 * realistic CIF mid (per MT and per bbl) for a default product into
 * the desk's most-active destination ports — Tema, Lomé, Mombasa.
 *
 * Anchors are computed live from Brent + per-product crack spread +
 * freight (the same ex-refinery cost model evaluate_target_price
 * uses for plausibility verdicts). When the user lands on a refiner
 * page, this answers "what could we quote out of THIS supplier into
 * West / East Africa today" without a chat round-trip.
 *
 * The default product is en590-ulsd because that's the highest-
 * volume product in VTC's deal flow; future iteration can let the
 * user pick.
 */
export type QuoteAnchorsPanelProps = {
  /** Free-text country code from known_entities — used as a soft
   *  origin hint for the freight leg (e.g. CO → usgc routing). */
  entityCountry: string | null;
};

const DEFAULT_PRODUCT: ProductSlug = 'en590-ulsd';

const DEFAULT_DESTINATIONS: Array<{ slug: string; label: string }> = [
  { slug: 'tema-port', label: 'Tema (GH)' },
  { slug: 'lome-port', label: 'Lomé (TG)' },
  { slug: 'mombasa-port', label: 'Mombasa (KE)' },
];

/** Map ISO-2 origin country → FreightOriginRegion bucket. The
 *  cheapest-route fallback in evaluateTargetPrice handles unknowns
 *  fine, but seeding the right region produces a tighter anchor. */
function freightOriginFor(country: string | null) {
  if (!country) return undefined;
  const map: Record<string, string> = {
    // USGC / Caribbean adjacent
    US: 'usgc',
    CO: 'usgc',
    VE: 'usgc',
    MX: 'usgc',
    // Med refining hubs
    IT: 'med',
    ES: 'med',
    GR: 'med',
    TR: 'med',
    DZ: 'med',
    EG: 'med',
    // NWE
    NL: 'nwe',
    BE: 'nwe',
    GB: 'nwe',
    DE: 'nwe',
    // Mideast
    AE: 'mideast',
    SA: 'mideast',
    KW: 'mideast',
    BH: 'mideast',
    // India / Singapore
    IN: 'india',
    SG: 'singapore',
    // Black Sea
    RU: 'black-sea',
    RO: 'black-sea',
    BG: 'black-sea',
  };
  return map[country] as
    | 'usgc'
    | 'med'
    | 'nwe'
    | 'mideast'
    | 'india'
    | 'singapore'
    | 'black-sea'
    | undefined;
}

export async function QuoteAnchorsPanel({ entityCountry }: QuoteAnchorsPanelProps) {
  const originRegion = freightOriginFor(entityCountry);

  const results = await Promise.all(
    DEFAULT_DESTINATIONS.map((d) =>
      evaluateTargetPrice({
        product: DEFAULT_PRODUCT,
        destPortSlug: d.slug,
        originRegion,
      }).catch(() => null),
    ),
  );

  // If nothing came back (no benchmark, no freight) — render nothing
  // rather than a broken empty state. Refiner without quote anchors
  // means we don't have data, not that the user did something wrong.
  const usable = results
    .map((r, i) => ({ result: r, dest: DEFAULT_DESTINATIONS[i]! }))
    .filter(
      (x): x is { result: NonNullable<typeof x.result>; dest: typeof x.dest } =>
        x.result != null && x.result.realisticCifUsdPerMt != null,
    );
  if (usable.length === 0) return null;

  const benchmarkAsOf = usable[0]?.result.benchmarkAsOf ?? null;

  return (
    <section className="mb-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Quote anchors — EN590 ULSD CIF
        </h2>
        {benchmarkAsOf && (
          <span className="text-[11px] text-[color:var(--color-muted-foreground)]">
            Realistic mid · Brent + crack + freight · as of {benchmarkAsOf}
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {usable.map(({ result, dest }) => {
          const mt = result.realisticCifUsdPerMt!;
          const bbl = result.realisticCifUsdPerBbl!;
          return (
            <div
              key={dest.slug}
              className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/20 p-3"
            >
              <div className="text-xs font-medium text-[color:var(--color-muted-foreground)]">
                {dest.label}
              </div>
              <div className="mt-1 text-lg font-semibold tabular-nums">
                ${mt.mid.toFixed(0)}
                <span className="ml-1 text-xs font-normal text-[color:var(--color-muted-foreground)]">
                  /MT
                </span>
              </div>
              <div className="text-[11px] text-[color:var(--color-muted-foreground)] tabular-nums">
                ${bbl.mid.toFixed(2)}/bbl · range ${mt.low.toFixed(0)}–
                {mt.high.toFixed(0)}
              </div>
              <div className="mt-1 text-[10px] text-[color:var(--color-muted-foreground)]">
                Freight: {result.freight.originRegion ?? '—'}{' '}
                {result.freight.usdPerMtLow != null
                  ? `($${result.freight.usdPerMtLow}–${result.freight.usdPerMtHigh}/MT)`
                  : ''}
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-[11px] text-[color:var(--color-muted-foreground)]">
        Anchor is a benchmark + crack mid, not a live quote. Use as a sanity
        check when sizing offers from this supplier.
      </p>
    </section>
  );
}
