import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractGainReport, normalizeCompanyName } from './extractor';
import type { ParsedGainReport, GainSection } from './parser';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Negative-case regression test per docs/gain-extraction-brief.md §4.3.
 *
 * The fixture VE2026-0002 is a USDA Caracas trade summary rich in
 * macro tables (origin shares, top commodities, price trends) but
 * names NO Venezuelan importers, distributors, or retailers. A
 * correct extraction returns zero importer mentions; any non-empty
 * output is a hallucination regression and must fail CI.
 *
 * Skips when ANTHROPIC_API_KEY is not set (local dev without keys
 * + PR-build environments). The brief calls for this to gate CI;
 * wire ANTHROPIC_API_KEY into the test job when ready.
 */

const FIXTURE_PATH = resolve(
  __dirname,
  '../../../../data/gain-reference-samples/VE2026-0002_US-Venezuelan-Agricultural-Trade-Summary-2025.md',
);

function syntheticParsed(text: string): ParsedGainReport {
  // The macro-statistics text fills one synthetic candidate section.
  // The extractor only sends candidate sections to the LLM, so this
  // exercises the full extraction path.
  const section: GainSection = {
    title: 'Agricultural imports by origin',
    kind: 'candidate',
    startPage: 1,
    endPage: 5,
    text,
  };
  return {
    pageCount: 5,
    pageTexts: [text],
    sections: [section],
  };
}

const skipReason = process.env.ANTHROPIC_API_KEY
  ? null
  : 'ANTHROPIC_API_KEY not set — skipping LLM-backed regression test';

describe('extractGainReport — negative fixture (macro statistics only)', () => {
  it('returns zero importers for the VE2026-0002 fixture', { skip: skipReason ?? false }, async () => {
    const fixture = await readFile(FIXTURE_PATH, 'utf8');
    const parsed = syntheticParsed(fixture);

    const result = await extractGainReport({
      parsed,
      reportTitle: 'US-Venezuelan Agricultural Trade Summary for 2025',
      reportType: 'Agricultural Situation',
      countryCode: 'VE',
    });

    // The whole pipeline output (after within-report dedup) must be empty.
    assert.equal(
      result.importers.length,
      0,
      `expected zero importers for negative fixture, got: ${result.importers.map((i) => i.companyName).join(', ')}`,
    );

    // Every per-section call should explicitly flag noNamedImporters.
    for (const { output } of result.perSection) {
      assert.equal(
        output.importers.length,
        0,
        `section returned non-empty importers: ${output.importers.map((i) => i.companyName).join(', ')}`,
      );
      assert.equal(
        output.noNamedImporters,
        true,
        'section should set noNamedImporters=true on macro-statistics content',
      );
    }
  });
});

describe('normalizeCompanyName', () => {
  it('strips common corporate suffixes', () => {
    assert.equal(normalizeCompanyName('Empresas Polar, C.A.'), 'empresas polar,');
    assert.equal(normalizeCompanyName('PriceSmart Inc.'), 'pricesmart');
    assert.equal(normalizeCompanyName('Molinos Nacionales (MONACA)'), 'molinos nacionales (monaca)');
    assert.equal(normalizeCompanyName('Centro Cuesta S.A.'), 'centro cuesta');
  });
  it('preserves accents (Day 4 resolver handles those)', () => {
    assert.equal(normalizeCompanyName('Compañía Azucarera'), 'compañía azucarera');
  });
});
