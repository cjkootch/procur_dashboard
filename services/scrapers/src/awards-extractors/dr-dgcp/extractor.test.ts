import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink, mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { DrDgcpAwardsExtractor } from './extractor';

/**
 * Tests that exercise the streaming + classification path without
 * touching the DB. The base class's run() method (which does the
 * upserts) is covered by integration tests against a seeded neon
 * database in the supplier-graph PR.
 */

let tmpDir: string;
let fixturePath: string;

const RELEASES = [
  // Fuel award — single supplier, diesel UNSPSC
  {
    ocid: 'ocds-fuel-1',
    buyer: { id: 'BUYER-1', name: 'Ministerio de Defensa' },
    tender: {
      id: 'T-1',
      title: 'Adquisición de Diésel para Flota',
      items: [{ classification: { id: '15101505', scheme: 'UNSPSC' } }],
    },
    awards: [
      {
        id: 'AWD-FUEL-1',
        date: '2024-06-15',
        status: 'active',
        value: { amount: 5000000, currency: 'DOP' },
        items: [{ classification: { id: '15101505', scheme: 'UNSPSC' } }],
        suppliers: [{ id: 'S-1', name: 'PETROMOVIL, S.A.' }],
      },
    ],
  },
  // Food award — different supplier
  {
    ocid: 'ocds-food-1',
    buyer: { id: 'BUYER-2', name: 'Hospital Materno Infantil' },
    tender: {
      id: 'T-2',
      title: 'Compra de Alimentos para Pacientes',
      items: [{ classification: { id: '50121500', scheme: 'UNSPSC' } }],
    },
    awards: [
      {
        id: 'AWD-FOOD-1',
        date: '2024-07-20',
        status: 'active',
        value: { amount: 800000, currency: 'DOP' },
        items: [{ classification: { id: '50121500', scheme: 'UNSPSC' } }],
        suppliers: [{ id: 'S-2', name: 'Distribuidora Alimentos SRL' }],
      },
    ],
  },
  // Services award — should be skipped (not in target categories)
  {
    ocid: 'ocds-services-1',
    buyer: { id: 'BUYER-3', name: 'OGTIC' },
    tender: {
      id: 'T-3',
      title: 'Servicios de Consultoría',
      items: [{ classification: { id: '80101500', scheme: 'UNSPSC' } }],
    },
    awards: [
      {
        id: 'AWD-SVC-1',
        date: '2024-08-01',
        status: 'active',
        value: { amount: 200000, currency: 'DOP' },
        suppliers: [{ id: 'S-3', name: 'Consultora XYZ' }],
      },
    ],
  },
  // Award with no items → inherits from tender (predominantly fuel)
  {
    ocid: 'ocds-fuel-inherit',
    buyer: { id: 'BUYER-4', name: 'Policia Nacional' },
    tender: {
      id: 'T-4',
      title: 'Tickets de Combustible',
      items: [
        { classification: { id: '15101505', scheme: 'UNSPSC' } },
        { classification: { id: '15101506', scheme: 'UNSPSC' } },
      ],
    },
    awards: [
      {
        id: 'AWD-FUEL-INHERIT',
        date: '2024-09-10',
        status: 'active',
        value: { amount: 3000000, currency: 'DOP' },
        items: [], // empty — should inherit from tender
        suppliers: [{ id: 'S-4', name: 'Sunix Petroleum, SRL' }],
      },
    ],
  },
  // Buyer falls back to parties[]
  {
    ocid: 'ocds-buyer-from-parties',
    parties: [
      {
        id: 'PARTY-1',
        name: 'Cuerpo Especializado de Seguridad Aeroportuaria',
        roles: ['buyer'],
      },
    ],
    tender: { id: 'T-5', title: 'Combustible aviación' },
    awards: [
      {
        id: 'AWD-AVIATION-1',
        date: '2024-10-05',
        status: 'active',
        value: { amount: 1200000, currency: 'DOP' },
        items: [{ classification: { id: '15101504', scheme: 'UNSPSC' } }],
        suppliers: [{ id: 'S-5', name: 'AeroFuel SRL' }],
      },
    ],
  },
];

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'dr-extractor-test-'));
  fixturePath = join(tmpDir, 'sample.jsonl.gz');
  const jsonl = RELEASES.map((r) => JSON.stringify(r)).join('\n');
  await writeFile(fixturePath, gzipSync(jsonl));
});

after(async () => {
  await unlink(fixturePath).catch(() => {});
  await rmdir(tmpDir).catch(() => {});
});

describe('DrDgcpAwardsExtractor.streamAwards', () => {
  it('emits fuel + food awards by default and skips services', async () => {
    const extractor = new DrDgcpAwardsExtractor({ bulkFilePaths: [fixturePath] });
    const out: Array<{ id: string; tags: string[]; buyer: string }> = [];
    for await (const a of extractor.streamAwards()) {
      out.push({
        id: a.award.sourceAwardId,
        tags: a.award.categoryTags ?? [],
        buyer: a.award.buyerName,
      });
    }
    const ids = out.map((o) => o.id);
    assert.ok(ids.includes('AWD-FUEL-1'), 'fuel award present');
    assert.ok(ids.includes('AWD-FOOD-1'), 'food award present');
    assert.ok(ids.includes('AWD-FUEL-INHERIT'), 'inherited fuel award present');
    assert.ok(!ids.includes('AWD-SVC-1'), 'services award skipped');
  });

  it('classifies diesel UNSPSC as diesel tag', async () => {
    const extractor = new DrDgcpAwardsExtractor({ bulkFilePaths: [fixturePath] });
    let dieselFound = false;
    for await (const a of extractor.streamAwards()) {
      if (a.award.sourceAwardId === 'AWD-FUEL-1') {
        assert.deepEqual(a.award.categoryTags, ['diesel']);
        assert.equal(a.award.contractValueNative, 5000000);
        assert.equal(a.award.contractCurrency, 'DOP');
        assert.equal(a.award.buyerCountry, 'DO');
        assert.equal(a.awardees.length, 1);
        assert.equal(a.awardees[0]?.supplier.organisationName, 'PETROMOVIL, S.A.');
        dieselFound = true;
      }
    }
    assert.ok(dieselFound, 'AWD-FUEL-1 was not yielded');
  });

  it('inherits tender tags when award.items is empty + tender is predominantly fuel', async () => {
    const extractor = new DrDgcpAwardsExtractor({ bulkFilePaths: [fixturePath] });
    let inherited = false;
    for await (const a of extractor.streamAwards()) {
      if (a.award.sourceAwardId === 'AWD-FUEL-INHERIT') {
        // Tender had 2 fuel codes (diesel + diesel); inheritance gives diesel
        assert.deepEqual(a.award.categoryTags, ['diesel']);
        inherited = true;
      }
    }
    assert.ok(inherited, 'inheritance path did not fire');
  });

  it('falls back to parties[] for buyer when buyer field is missing', async () => {
    const extractor = new DrDgcpAwardsExtractor({ bulkFilePaths: [fixturePath] });
    let aviation = false;
    for await (const a of extractor.streamAwards()) {
      if (a.award.sourceAwardId === 'AWD-AVIATION-1') {
        assert.equal(
          a.award.buyerName,
          'Cuerpo Especializado de Seguridad Aeroportuaria',
        );
        assert.deepEqual(a.award.categoryTags, ['jet-fuel']);
        aviation = true;
      }
    }
    assert.ok(aviation, 'buyer-from-parties fallback did not fire');
  });

  it('respects categoryFilters=["fuel"] (drops food)', async () => {
    const extractor = new DrDgcpAwardsExtractor({
      bulkFilePaths: [fixturePath],
      categoryFilters: ['fuel'],
    });
    const ids: string[] = [];
    for await (const a of extractor.streamAwards()) ids.push(a.award.sourceAwardId);
    assert.ok(ids.includes('AWD-FUEL-1'));
    assert.ok(!ids.includes('AWD-FOOD-1'), 'food award should be dropped');
  });
});
