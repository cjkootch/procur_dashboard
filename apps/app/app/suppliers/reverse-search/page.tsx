'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import type { CandidateBuyer, CommodityOfferSpec } from '@procur/catalog';

/**
 * Minimal v1 UI for reverse-search. Single form → table render.
 *
 * The conversational interface (find_buyers_for_offer assistant tool)
 * is the more important surface; this page exists to give Cole a
 * deterministic way to inspect the underlying query without Claude in
 * the loop, and to support eventual CSV export.
 *
 * No fancy state management — useState + fetch. The page is gated by
 * the app's middleware, so requireCompany() in the API route always
 * has a session.
 */

const CATEGORIES = [
  'crude-oil',
  'diesel',
  'gasoline',
  'jet-fuel',
  'lpg',
  'marine-bunker',
  'heating-oil',
  'heavy-fuel-oil',
  'food-commodities',
  'vehicles',
] as const;

type Category = (typeof CATEGORIES)[number];

const PRESET_REGIONS: Record<string, string[]> = {
  Mediterranean: ['IT', 'ES', 'FR', 'GR', 'TR', 'CY', 'MT', 'HR', 'SI', 'AL'],
  'Asia-Pacific': ['JP', 'KR', 'CN', 'TH', 'VN', 'SG', 'PH', 'ID', 'MY', 'AU', 'NZ'],
  Caribbean: ['DO', 'JM', 'TT', 'BB', 'BS', 'GY', 'HT', 'CU', 'KY', 'AG'],
};

export default function ReverseSearchPage() {
  const [categoryTag, setCategoryTag] = useState<Category>('diesel');
  const [keywordsInput, setKeywordsInput] = useState('');
  const [countriesInput, setCountriesInput] = useState('');
  const [yearsLookback, setYearsLookback] = useState(5);
  const [minAwards, setMinAwards] = useState(2);

  const [results, setResults] = useState<CandidateBuyer[] | null>(null);
  const [submittedSpec, setSubmittedSpec] = useState<CommodityOfferSpec | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyRegionPreset = useCallback((region: string) => {
    const codes = PRESET_REGIONS[region];
    if (codes) setCountriesInput(codes.join(', '));
  }, []);

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setLoading(true);
      setError(null);

      const spec: CommodityOfferSpec = {
        categoryTag,
        descriptionKeywords: keywordsInput
          .split(',')
          .map((k) => k.trim())
          .filter((k) => k.length > 0),
        buyerCountries: countriesInput
          .split(',')
          .map((c) => c.trim().toUpperCase())
          .filter((c) => c.length === 2),
        yearsLookback,
        minAwards,
      };

      try {
        const res = await fetch('/api/suppliers/reverse-search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(spec),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `request failed: ${res.status}`);
        }
        const json = (await res.json()) as { buyers: CandidateBuyer[] };
        setResults(json.buyers);
        setSubmittedSpec(spec);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [categoryTag, keywordsInput, countriesInput, yearsLookback, minAwards],
  );

  const downloadCsv = useCallback(() => {
    if (!results || results.length === 0) return;
    const header = [
      'buyer_name',
      'buyer_country',
      'awards_count',
      'total_value_usd',
      'most_recent_award_date',
      'agencies',
      'sample_commodities',
      'beneficiary_countries',
    ];
    const rows = results.map((b) => [
      JSON.stringify(b.buyerName),
      b.buyerCountry,
      String(b.awardsCount),
      b.totalValueUsd != null ? String(b.totalValueUsd) : '',
      b.mostRecentAwardDate,
      JSON.stringify((b.agencies ?? []).join(' | ')),
      JSON.stringify((b.commoditiesBought ?? []).slice(0, 3).join(' | ')),
      JSON.stringify((b.beneficiaryCountries ?? []).join(' | ')),
    ]);
    const csv = [header.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reverse-search-${categoryTag}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [results, categoryTag]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Reverse search — buyers for an offer</h1>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          Find public buyers who have demonstrably purchased a commodity in recent history.
          Use this when a supplier brings VTC a cargo position and you need to know
          who in the public-procurement universe is plausibly a buyer.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="mb-6 grid gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5 md:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Category
          </span>
          <select
            value={categoryTag}
            onChange={(e) => setCategoryTag(e.target.value as Category)}
            className="w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-3 py-2 text-sm"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Description keywords (comma-separated)
          </span>
          <input
            type="text"
            value={keywordsInput}
            onChange={(e) => setKeywordsInput(e.target.value)}
            placeholder="e.g. azeri, light sweet"
            className="w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-3 py-2 text-sm"
          />
        </label>

        <label className="block md:col-span-2">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Buyer countries — ISO-2 codes, comma-separated
          </span>
          <input
            type="text"
            value={countriesInput}
            onChange={(e) => setCountriesInput(e.target.value)}
            placeholder="e.g. IT, ES, GR, TR"
            className="w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-3 py-2 text-sm"
          />
          <div className="mt-2 flex gap-2 text-xs">
            <span className="text-[color:var(--color-muted-foreground)]">Presets:</span>
            {Object.keys(PRESET_REGIONS).map((region) => (
              <button
                key={region}
                type="button"
                onClick={() => applyRegionPreset(region)}
                className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 hover:border-[color:var(--color-foreground)]"
              >
                {region}
              </button>
            ))}
          </div>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Years lookback ({yearsLookback})
          </span>
          <input
            type="range"
            min={1}
            max={10}
            value={yearsLookback}
            onChange={(e) => setYearsLookback(Number.parseInt(e.target.value, 10))}
            className="w-full"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Minimum awards ({minAwards})
          </span>
          <input
            type="range"
            min={1}
            max={10}
            value={minAwards}
            onChange={(e) => setMinAwards(Number.parseInt(e.target.value, 10))}
            className="w-full"
          />
        </label>

        <div className="md:col-span-2 flex items-center gap-3">
          <button
            type="submit"
            disabled={loading}
            className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)] disabled:opacity-50"
          >
            {loading ? 'Searching…' : 'Search'}
          </button>
          {results && results.length > 0 && (
            <button
              type="button"
              onClick={downloadCsv}
              className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-4 py-2 text-sm hover:border-[color:var(--color-foreground)]"
            >
              Export CSV
            </button>
          )}
          {error && <span className="text-sm text-red-700">{error}</span>}
        </div>
      </form>

      {results && (
        <section>
          <p className="mb-3 text-sm text-[color:var(--color-muted-foreground)]">
            {results.length} buyer{results.length === 1 ? '' : 's'} found
            {submittedSpec ? ` for ${submittedSpec.categoryTag}` : ''}.
          </p>
          {results.length === 0 ? (
            <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-8 text-center text-sm text-[color:var(--color-muted-foreground)]">
              No buyers matched. Try widening the lookback, dropping the country filter, or
              lowering the minimum-awards threshold.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-[var(--radius-lg)] border border-[color:var(--color-border)]">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-[color:var(--color-border)] bg-[color:var(--color-muted)]/30">
                  <tr>
                    <Th>Buyer</Th>
                    <Th>Country</Th>
                    <Th>Awards</Th>
                    <Th>Total $USD</Th>
                    <Th>Most recent</Th>
                    <Th>Agencies</Th>
                    <Th>Sample commodities</Th>
                    <Th>Beneficiaries</Th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((b) => (
                    <tr
                      key={`${b.buyerName}-${b.buyerCountry}`}
                      className="border-b border-[color:var(--color-border)] last:border-b-0 hover:bg-[color:var(--color-muted)]/20"
                    >
                      <Td>
                        <Link
                          href={`/suppliers/reverse-search/buyer?name=${encodeURIComponent(
                            b.buyerName,
                          )}&country=${encodeURIComponent(
                            b.buyerCountry,
                          )}&category=${encodeURIComponent(submittedSpec?.categoryTag ?? '')}`}
                          className="font-medium hover:underline"
                        >
                          {b.buyerName}
                        </Link>
                      </Td>
                      <Td>{b.buyerCountry}</Td>
                      <Td>{b.awardsCount}</Td>
                      <Td>{b.totalValueUsd != null ? `$${Math.round(b.totalValueUsd).toLocaleString()}` : '—'}</Td>
                      <Td>{b.mostRecentAwardDate}</Td>
                      <Td className="max-w-xs truncate" title={(b.agencies ?? []).join(' • ')}>
                        {(b.agencies ?? []).slice(0, 2).join(' • ') || '—'}
                      </Td>
                      <Td className="max-w-xs truncate" title={(b.commoditiesBought ?? []).join(' • ')}>
                        {(b.commoditiesBought ?? []).slice(0, 2).join(' • ') || '—'}
                      </Td>
                      <Td>{(b.beneficiaryCountries ?? []).join(', ') || '—'}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
      {children}
    </th>
  );
}

function Td({ children, className, title }: { children: React.ReactNode; className?: string; title?: string }) {
  return (
    <td className={`px-3 py-2 align-top ${className ?? ''}`} title={title}>
      {children}
    </td>
  );
}
