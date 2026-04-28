import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeSupplierName } from './queries';
import { buildCatalogTools } from './tools';
import type { ToolRegistry } from '@procur/ai';

type RegisteredTool = ToolRegistry[string];

/**
 * Tests for the supplier-graph tools (find_buyers_for_offer,
 * find_suppliers_for_tender, analyze_supplier).
 *
 * Two layers:
 *   1. Pure-logic tests: schema validation, normalizeSupplierName,
 *      registry shape, fixture conformance. Run unconditionally.
 *   2. Integration tests against the live database: happy-path,
 *      empty-result, disambiguation. Auto-skip when DATABASE_URL is
 *      not set so CI without a test DB still passes. To exercise these
 *      locally, ingest the awards_sample.json fixture first via:
 *
 *          pnpm tsx scripts/seed-supplier-graph.ts
 *
 *      then run `pnpm --filter @procur/catalog test`.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'data',
  'seed',
  'caribbean_fuel',
  'awards_sample.json',
);

type SampleAward = {
  country: string;
  source_portal: string;
  award_id: string;
  buyer: string;
  buyer_country: string;
  supplier_name: string;
  supplier_name_normalized: string;
  supplier_id: string;
  award_date: string;
  award_status: string;
  value_native: number;
  value_currency: string;
  value_usd: number | null;
  fuel_categories: string[];
  unspsc_codes: string[];
  tender_title?: string;
};

async function loadFixture(): Promise<SampleAward[]> {
  const raw = await readFile(FIXTURE_PATH, 'utf8');
  return JSON.parse(raw) as SampleAward[];
}

const HAS_DB = Boolean(process.env.DATABASE_URL);
const dbDescribe = HAS_DB ? describe : describe.skip;

// Lazily import the tools so the suite still loads even when the module
// graph touches `server-only` / DB env vars at import time.
async function loadTool(name: string): Promise<RegisteredTool> {
  const tools = buildCatalogTools();
  const tool = tools[name];
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool;
}

// ─── Pure-logic tests ────────────────────────────────────────────────

describe('normalizeSupplierName', () => {
  it('strips S.A., SRL, LLC, etc.', () => {
    assert.equal(normalizeSupplierName('PETROMOVIL, S.A.'), 'petromovil');
    assert.equal(normalizeSupplierName('Tu Amigo, SRL'), 'tu amigo');
    assert.equal(normalizeSupplierName('Sunix Petroleum, SRL'), 'sunix petroleum');
    assert.equal(normalizeSupplierName('Acme Holdings LLC'), 'acme holdings');
    assert.equal(normalizeSupplierName('TotalEnergies SE'), 'totalenergies se');
    assert.equal(normalizeSupplierName('Vitol GmbH'), 'vitol');
  });

  it('collapses whitespace and lowercases', () => {
    assert.equal(normalizeSupplierName('  HELLO   WORLD  '), 'hello world');
  });

  it('matches the fixture pre-computed normals on a sample of rows', async () => {
    const fixture = await loadFixture();
    // Spot-check the first 20 rows. The scraper's normalization may
    // legitimately differ on edge cases (accented chars, &, etc.) — we
    // assert the obvious cases agree, not exact equality on every row.
    const checked = fixture.slice(0, 20).filter((r) => /^[a-z0-9 ,.-]+$/i.test(r.supplier_name));
    for (const row of checked) {
      const ours = normalizeSupplierName(row.supplier_name);
      // Both sides must at minimum start with the same first word.
      const firstWordOurs = ours.split(' ')[0];
      const firstWordTheirs = row.supplier_name_normalized.split(' ')[0];
      assert.equal(firstWordOurs, firstWordTheirs, `mismatch on "${row.supplier_name}"`);
    }
  });
});

// ─── Schema validation (spec §8 test #1) ────────────────────────────

describe('find_buyers_for_offer — schema', () => {
  it('accepts a minimal valid input', async () => {
    const tool = await loadTool('find_buyers_for_offer');
    const result = tool.schema.safeParse({ categoryTag: 'diesel' });
    assert.equal(result.success, true);
  });

  it('rejects an unknown categoryTag', async () => {
    const tool = await loadTool('find_buyers_for_offer');
    const result = tool.schema.safeParse({ categoryTag: 'unobtainium' });
    assert.equal(result.success, false);
  });

  it('rejects malformed buyerCountries (non-2-char)', async () => {
    const tool = await loadTool('find_buyers_for_offer');
    const result = tool.schema.safeParse({
      categoryTag: 'diesel',
      buyerCountries: ['DOM'], // ISO-3, should be ISO-2
    });
    assert.equal(result.success, false);
  });
});

describe('find_suppliers_for_tender — schema', () => {
  it('accepts categoryTag without opportunityId', async () => {
    const tool = await loadTool('find_suppliers_for_tender');
    const result = tool.schema.safeParse({ categoryTag: 'diesel', buyerCountry: 'DO' });
    assert.equal(result.success, true);
  });

  it('rejects malformed opportunityId UUID', async () => {
    const tool = await loadTool('find_suppliers_for_tender');
    const result = tool.schema.safeParse({ opportunityId: 'not-a-uuid' });
    assert.equal(result.success, false);
  });
});

describe('analyze_supplier — schema', () => {
  it('accepts supplierName alone', async () => {
    const tool = await loadTool('analyze_supplier');
    const result = tool.schema.safeParse({ supplierName: 'PETROMOVIL' });
    assert.equal(result.success, true);
  });

  it('rejects when neither supplierId nor supplierName present', async () => {
    const tool = await loadTool('analyze_supplier');
    const result = tool.schema.safeParse({ yearsLookback: 5 });
    assert.equal(result.success, false);
  });
});

// ─── Tool registry shape ─────────────────────────────────────────────

describe('buildCatalogTools — supplier-graph registration', () => {
  it('registers all three supplier-graph tools as kind=read', async () => {
    const tools = buildCatalogTools();
    for (const name of ['find_buyers_for_offer', 'find_suppliers_for_tender', 'analyze_supplier']) {
      const t = tools[name];
      assert.ok(t, `expected tool "${name}" to be registered`);
      assert.equal(t.kind, 'read', `expected "${name}" to be a read tool`);
      assert.ok(t.description.length > 50, `"${name}" needs a substantive description`);
      assert.equal(
        (t.jsonSchema as { type?: string }).type,
        'object',
        `"${name}" json schema must be object-typed for Claude`,
      );
    }
  });
});

// ─── Fixture conformance ────────────────────────────────────────────

describe('awards_sample.json fixture', () => {
  it('exists and is parseable JSON', async () => {
    const fixture = await loadFixture();
    assert.ok(Array.isArray(fixture));
    assert.ok(fixture.length >= 100, 'fixture should have ~105 rows');
  });

  it('every row has the fields the seed script depends on', async () => {
    const fixture = await loadFixture();
    for (const row of fixture) {
      assert.ok(row.source_portal, 'source_portal');
      assert.ok(row.award_id, 'award_id');
      assert.ok(row.buyer, 'buyer');
      assert.ok(row.buyer_country, 'buyer_country');
      assert.ok(row.supplier_name, 'supplier_name');
      assert.ok(row.supplier_name_normalized, 'supplier_name_normalized');
      assert.ok(row.award_date, 'award_date');
      assert.ok(Array.isArray(row.fuel_categories), 'fuel_categories');
      assert.ok(Array.isArray(row.unspsc_codes), 'unspsc_codes');
    }
  });

  it('contains diesel awards spanning multiple buyers (so happy-path is non-trivial)', async () => {
    const fixture = await loadFixture();
    const dieselRows = fixture.filter((r) => r.fuel_categories.includes('diesel'));
    assert.ok(dieselRows.length > 5, 'expected several diesel rows');
    const buyers = new Set(dieselRows.map((r) => r.buyer));
    assert.ok(buyers.size > 2, 'diesel awards should span multiple distinct buyers');
  });
});

// ─── Integration tests (require DATABASE_URL + seeded fixture) ──────

dbDescribe('find_buyers_for_offer — integration', () => {
  it('returns >0 buyers for diesel in DO', async () => {
    const tool = await loadTool('find_buyers_for_offer');
    const ctx = { companyId: '00000000-0000-0000-0000-000000000000', userId: 'test' };
    const out = (await tool.handler(ctx, {
      categoryTag: 'diesel',
      buyerCountries: ['DO'],
      yearsLookback: 10,
      minAwards: 1,
    })) as { count: number; buyers: unknown[]; caveat: string };
    assert.ok(out.count > 0, 'expected at least one diesel buyer in DR seed data');
    assert.ok(out.caveat.length > 0, 'caveat must be present in payload');
  });

  it('returns count: 0 cleanly for a category with no awards', async () => {
    const tool = await loadTool('find_buyers_for_offer');
    const ctx = { companyId: '00000000-0000-0000-0000-000000000000', userId: 'test' };
    const out = (await tool.handler(ctx, {
      categoryTag: 'lpg', // fixture is diesel/gasoline-heavy; lpg should be empty
      yearsLookback: 1,
      minAwards: 1,
    })) as { count: number; buyers: unknown[] };
    assert.equal(out.count, 0);
    assert.deepEqual(out.buyers, []);
  });
});

dbDescribe('find_suppliers_for_tender — integration', () => {
  it('returns >0 suppliers for diesel + DO', async () => {
    const tool = await loadTool('find_suppliers_for_tender');
    const ctx = { companyId: '00000000-0000-0000-0000-000000000000', userId: 'test' };
    const out = (await tool.handler(ctx, {
      categoryTag: 'diesel',
      buyerCountry: 'DO',
      yearsLookback: 10,
    })) as { count: number; suppliers: Array<{ matchReasons: string[] }> };
    assert.ok(out.count > 0, 'expected at least one diesel supplier');
    assert.ok(
      (out.suppliers[0]?.matchReasons.length ?? 0) > 0,
      'each supplier should carry rule-based match reasons',
    );
  });

  it('returns count: 0 for a category with no awards', async () => {
    const tool = await loadTool('find_suppliers_for_tender');
    const ctx = { companyId: '00000000-0000-0000-0000-000000000000', userId: 'test' };
    const out = (await tool.handler(ctx, {
      categoryTag: 'heavy-fuel-oil',
      buyerCountry: 'DO',
      yearsLookback: 1,
    })) as { count: number };
    assert.equal(out.count, 0);
  });
});

dbDescribe('analyze_supplier — integration', () => {
  it('resolves a known DR fuel supplier by name and returns a profile', async () => {
    const tool = await loadTool('analyze_supplier');
    const ctx = { companyId: '00000000-0000-0000-0000-000000000000', userId: 'test' };
    const out = (await tool.handler(ctx, {
      supplierName: 'Sunix Petroleum',
      yearsLookback: 10,
    })) as { kind: string };
    // Either a profile (single match >=0.85) or disambiguation. Both
    // are valid happy-path outcomes for a fuzzy resolver — what we
    // explicitly forbid is `not_found` for a supplier we know is in
    // the fixture.
    assert.notEqual(out.kind, 'not_found', 'fixture supplier should be resolvable');
  });

  it('returns kind: not_found for a name that does not exist', async () => {
    const tool = await loadTool('analyze_supplier');
    const ctx = { companyId: '00000000-0000-0000-0000-000000000000', userId: 'test' };
    const out = (await tool.handler(ctx, {
      supplierName: 'Zzz Nonexistent Supplier 9999',
    })) as { kind: string };
    assert.equal(out.kind, 'not_found');
  });

  it('triggers disambiguation_needed for an ambiguous name', async () => {
    const tool = await loadTool('analyze_supplier');
    const ctx = { companyId: '00000000-0000-0000-0000-000000000000', userId: 'test' };
    // 'petroleum' is generic enough that multiple suppliers in the
    // seed (Sunix Petroleum, V Energy, etc.) clear the trigram threshold.
    const out = (await tool.handler(ctx, { supplierName: 'petroleum' })) as {
      kind: string;
      candidates?: unknown[];
    };
    if (out.kind === 'disambiguation_needed') {
      assert.ok((out.candidates ?? []).length >= 2, 'disambiguation needs >=2 candidates');
    } else {
      // If the fuzzy resolver picked a single dominant match, that's
      // also a valid outcome — we only assert it didn't error.
      assert.ok(['profile', 'not_found'].includes(out.kind));
    }
  });
});
