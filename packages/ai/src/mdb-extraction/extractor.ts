/**
 * MDB per-project extractor. Mirrors the GAIN extractor shape with
 * MDB-specific schema + prompt. Supports the same cost-reduction
 * levers shipped for GAIN in PR #644:
 *   - Haiku triage pre-filter (~30-40% fewer Sonnet calls)
 *   - Anthropic Batch API (50% off all Sonnet calls)
 *
 * Within-project dedup: same company in multiple sections collapses
 * to one row with union of roles + max contractValueUsd (preferring
 * the most specific non-null figure) + concatenated context excerpts
 * capped at ~2KB.
 */

import type { Anthropic } from '@anthropic-ai/sdk';
import { z } from 'zod/v4';
import { getClient, MODELS } from '../client';
import { zodOutputFormat } from '../zod-output';
import { extractUsage, type CacheUsage } from '../prompt-blocks';
import type { MdbPdfSection, ParsedMdbDocument } from './parser';
import {
  MdbExtractionOutput,
  type MdbExtractionOutputT,
  type MdbNamedEntityT,
  type MdbSectorT,
} from './schema';
import { mdbExtractionInstruction, mdbSectionUserMessage } from './prompts';

export interface MdbExtractionResult {
  entities: ExtractedMdbEntityRow[];
  perSection: Array<{ section: MdbPdfSection; output: MdbExtractionOutputT }>;
  triageDecisions: Array<{ section: MdbPdfSection; decision: TriageResult }>;
  usage: CacheUsage;
}

export interface ExtractedMdbEntityRow {
  companyName: string;
  companyNameNormalized: string;
  roles: string[];
  sector: MdbSectorT;
  contractValueUsd: number | null;
  contextExcerpt: string;
  sourceSection: string;
  sourcePage: number;
  extractionConfidence: number;
}

export function normalizeCompanyName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(
      /\s*(s\.\s*a\.|s\.a\.s\.|c\.\s*a\.|ltda\.|inc\.|corp\.|co\.|llc|gmbh|n\.\s*v\.|pte\.?\s*ltd\.?|pty\.?\s*ltd\.?)\s*$/i,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeWithinProject(
  perSection: Array<{ section: MdbPdfSection; output: MdbExtractionOutputT }>,
): ExtractedMdbEntityRow[] {
  const byKey = new Map<string, ExtractedMdbEntityRow>();
  for (const { section, output } of perSection) {
    for (const e of output.entities) {
      const key = normalizeCompanyName(e.companyName);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, buildRow(e, section));
        continue;
      }
      existing.roles = unionStrings(existing.roles, e.roles);
      // Prefer non-null contract value; if both non-null, take max
      // (most specific package-level award beats null borrower-level).
      if (e.contractValueUsd != null) {
        existing.contractValueUsd =
          existing.contractValueUsd == null
            ? e.contractValueUsd
            : Math.max(existing.contractValueUsd, e.contractValueUsd);
      }
      existing.extractionConfidence = Math.max(
        existing.extractionConfidence,
        e.confidence,
      );
      const next = `${existing.contextExcerpt}\n\n— ${section.title} (p${section.startPage}):\n${e.contextExcerpt}`;
      existing.contextExcerpt = next.length > 2048 ? existing.contextExcerpt : next;
    }
  }
  return Array.from(byKey.values());
}

function buildRow(
  e: MdbNamedEntityT,
  section: MdbPdfSection,
): ExtractedMdbEntityRow {
  return {
    companyName: e.companyName,
    companyNameNormalized: normalizeCompanyName(e.companyName),
    roles: [...e.roles],
    sector: e.sector,
    contractValueUsd: e.contractValueUsd,
    contextExcerpt: e.contextExcerpt,
    sourceSection: section.title,
    sourcePage: section.startPage,
    extractionConfidence: e.confidence,
  };
}

function unionStrings(a: string[], b: string[]): string[] {
  return Array.from(new Set([...a, ...b]));
}

function emptyUsage(): CacheUsage {
  return {
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
}

function addUsage(a: CacheUsage, b: CacheUsage): CacheUsage {
  return {
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

// ─── Haiku triage (same shape as GAIN's) ─────────────────────────────

const MdbTriageOutput = z
  .object({
    hasNamedCounterparties: z.boolean(),
    reason: z.string().max(200),
  })
  .strict();

const TRIAGE_INSTRUCTION = `You are a binary classifier. Decide whether the MDB project-document section below names specific commercial counterparties (borrowers, contractors, suppliers, consultants, implementing agencies — but NOT the MDBs themselves like IDB / World Bank / IFC / CDB).

Set hasNamedCounterparties = true ONLY when at least one specific entity name appears in commercial-role context — e.g. "Boskalis Westminster N.V. was awarded the civil works package" or "The Government of Jamaica is the Borrower".

Set hasNamedCounterparties = false when the section contains ANY of:
- safeguards / environmental / social review text
- annexes / appendices / references / glossaries
- project rationale / background / context
- risk assessments / monitoring frameworks
- operational policies / category designations
- disclosure boilerplate / disclaimers

The Inter-American Development Bank, World Bank, IFC, CDB, IBRD, IDA are NEVER counterparties — they're the funder. Country names alone (without "is the Borrower" context) are NOT counterparties.

Be aggressive on the false side. Sonnet is robust enough to recover from edge cases.`;

export interface TriageResult {
  hasNamedCounterparties: boolean;
  reason: string;
  usage: CacheUsage;
}

export async function triageMdbSection(
  section: MdbPdfSection,
): Promise<TriageResult> {
  const client = getClient();
  const userMessage = [
    `Section: ${section.title}`,
    '',
    '--- BEGIN SECTION ---',
    section.text.slice(0, 4000),
    '--- END SECTION ---',
  ].join('\n');

  const response = await client.messages.parse({
    model: MODELS.haiku,
    max_tokens: 256,
    system: [
      {
        type: 'text',
        text: TRIAGE_INSTRUCTION,
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ],
    messages: [{ role: 'user', content: userMessage }],
    output_config: { format: zodOutputFormat(MdbTriageOutput) },
  });
  if (!response.parsed_output) {
    return {
      hasNamedCounterparties: true,
      reason: 'triage_parse_failed',
      usage: extractUsage(response.usage),
    };
  }
  return {
    hasNamedCounterparties: response.parsed_output.hasNamedCounterparties,
    reason: response.parsed_output.reason,
    usage: extractUsage(response.usage),
  };
}

// ─── Real-time per-project extraction ────────────────────────────────

export interface ExtractMdbProjectArgs {
  parsed: ParsedMdbDocument;
  projectName: string;
  bank: string;
  countryCode: string;
  model?: typeof MODELS.sonnet | typeof MODELS.haiku;
  maxSections?: number;
  triage?: boolean;
}

export async function extractMdbProject(
  args: ExtractMdbProjectArgs,
): Promise<MdbExtractionResult> {
  const client = getClient();
  const model = args.model ?? MODELS.sonnet;
  const maxSections = args.maxSections ?? 15;
  const enableTriage = args.triage ?? false;

  const candidates = args.parsed.sections
    .filter((s) => s.kind === 'candidate')
    .slice(0, maxSections);

  const perSection: MdbExtractionResult['perSection'] = [];
  const triageDecisions: MdbExtractionResult['triageDecisions'] = [];
  let totalUsage = emptyUsage();
  let sectionsToExtract = candidates;

  if (enableTriage) {
    sectionsToExtract = [];
    for (const section of candidates) {
      const t = await triageMdbSection(section);
      totalUsage = addUsage(totalUsage, t.usage);
      triageDecisions.push({ section, decision: t });
      if (t.hasNamedCounterparties) sectionsToExtract.push(section);
    }
  }

  for (const section of sectionsToExtract) {
    const userMessage = mdbSectionUserMessage({
      projectName: args.projectName,
      bank: args.bank,
      countryCode: args.countryCode,
      sectionTitle: section.title,
      sectionText: section.text,
    });

    const response = await client.messages.parse({
      model,
      max_tokens: 4096,
      system: [
        {
          type: 'text',
          text: mdbExtractionInstruction(),
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
      messages: [{ role: 'user', content: userMessage }],
      output_config: { format: zodOutputFormat(MdbExtractionOutput) },
    });
    if (!response.parsed_output) {
      throw new Error(
        `extract-mdb-project: parse failed for section "${section.title}"`,
      );
    }
    perSection.push({ section, output: response.parsed_output });
    totalUsage = addUsage(totalUsage, extractUsage(response.usage));
  }

  return {
    entities: dedupeWithinProject(perSection),
    perSection,
    triageDecisions,
    usage: totalUsage,
  };
}

// ─── Batch API path (50% off non-realtime cost) ──────────────────────

const MDB_TOOL_NAME = 'extract_mdb_entities';
const MAX_REQUESTS_PER_BATCH = 9000;

function buildToolDefinition(): Anthropic.Tool {
  const jsonSchema = z.toJSONSchema(MdbExtractionOutput) as unknown as Anthropic.Tool.InputSchema;
  return {
    name: MDB_TOOL_NAME,
    description:
      'Emit the per-section MDB extraction result. Always call this exactly once.',
    input_schema: jsonSchema,
  };
}

export interface BatchExtractMdbRequestInput {
  projectId: string;
  projectName: string;
  bank: string;
  countryCode: string;
  parsed: ParsedMdbDocument;
  model?: typeof MODELS.sonnet | typeof MODELS.haiku;
  maxSections?: number;
}

export interface BatchExtractMdbResult {
  byProject: Map<string, MdbExtractionResult>;
  errors: Map<string, string>;
}

export async function extractMdbProjectsBatch(
  inputs: BatchExtractMdbRequestInput[],
  options: {
    pollIntervalMs?: number;
    maxWaitMs?: number;
    onStatus?: (status: Anthropic.Messages.MessageBatch) => void;
  } = {},
): Promise<BatchExtractMdbResult> {
  const client = getClient();
  const pollInterval = options.pollIntervalMs ?? 30_000;
  const maxWait = options.maxWaitMs ?? 24 * 60 * 60 * 1000;
  const tool = buildToolDefinition();

  type Pending = {
    customId: string;
    projectId: string;
    section: MdbPdfSection;
  };
  const pending: Pending[] = [];
  const reqByProject = new Map<string, BatchExtractMdbRequestInput>();

  for (const input of inputs) {
    reqByProject.set(input.projectId, input);
    const candidates = input.parsed.sections
      .filter((s) => s.kind === 'candidate')
      .slice(0, input.maxSections ?? 15);
    candidates.forEach((section, idx) => {
      pending.push({
        customId: `${input.projectId}/${idx}`,
        projectId: input.projectId,
        section,
      });
    });
  }

  if (pending.length === 0) {
    return { byProject: new Map(), errors: new Map() };
  }
  if (pending.length > MAX_REQUESTS_PER_BATCH) {
    throw new Error(
      `extractMdbProjectsBatch: ${pending.length} requests exceeds per-batch cap of ${MAX_REQUESTS_PER_BATCH}; split inputs across multiple batches`,
    );
  }

  const requests: Anthropic.Messages.BatchCreateParams.Request[] = pending.map(
    (p) => {
      const input = reqByProject.get(p.projectId);
      if (!input) {
        throw new Error(`internal: lost projectId ${p.projectId}`);
      }
      const userMessage = mdbSectionUserMessage({
        projectName: input.projectName,
        bank: input.bank,
        countryCode: input.countryCode,
        sectionTitle: p.section.title,
        sectionText: p.section.text,
      });
      return {
        custom_id: p.customId,
        params: {
          model: input.model ?? MODELS.sonnet,
          max_tokens: 4096,
          system: [
            {
              type: 'text',
              text: mdbExtractionInstruction(),
              cache_control: { type: 'ephemeral', ttl: '1h' },
            },
          ],
          messages: [{ role: 'user', content: userMessage }],
          tools: [tool],
          tool_choice: { type: 'tool', name: MDB_TOOL_NAME },
        },
      };
    },
  );

  const batch = await client.messages.batches.create({ requests });

  const startedAt = Date.now();
  let current = batch;
  while (current.processing_status !== 'ended') {
    if (Date.now() - startedAt > maxWait) {
      throw new Error(
        `extractMdbProjectsBatch: batch ${batch.id} exceeded maxWait ${maxWait}ms`,
      );
    }
    options.onStatus?.(current);
    await new Promise((r) => setTimeout(r, pollInterval));
    current = await client.messages.batches.retrieve(batch.id);
  }
  options.onStatus?.(current);

  const perSectionByProject = new Map<
    string,
    Array<{ section: MdbPdfSection; output: MdbExtractionOutputT }>
  >();
  const usageByProject = new Map<string, CacheUsage>();
  const errors = new Map<string, string>();

  const results = await client.messages.batches.results(batch.id);
  const pendingByCustomId = new Map(pending.map((p) => [p.customId, p]));

  for await (const item of results) {
    const p = pendingByCustomId.get(item.custom_id);
    if (!p) continue;

    if (item.result.type !== 'succeeded') {
      const reason =
        item.result.type === 'errored'
          ? item.result.error.error.message
          : item.result.type;
      errors.set(item.custom_id, reason);
      continue;
    }

    const message = item.result.message;
    const toolBlock = message.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    if (!toolBlock) {
      errors.set(item.custom_id, 'no_tool_use_block');
      continue;
    }
    const parsed = MdbExtractionOutput.safeParse(toolBlock.input);
    if (!parsed.success) {
      errors.set(item.custom_id, `schema_validation: ${parsed.error.message.slice(0, 200)}`);
      continue;
    }

    const accumulator = perSectionByProject.get(p.projectId) ?? [];
    accumulator.push({ section: p.section, output: parsed.data });
    perSectionByProject.set(p.projectId, accumulator);

    const usage = usageByProject.get(p.projectId) ?? emptyUsage();
    usageByProject.set(p.projectId, addUsage(usage, extractUsage(message.usage)));
  }

  const byProject = new Map<string, MdbExtractionResult>();
  for (const [projectId, perSection] of perSectionByProject) {
    byProject.set(projectId, {
      entities: dedupeWithinProject(perSection),
      perSection,
      triageDecisions: [],
      usage: usageByProject.get(projectId) ?? emptyUsage(),
    });
  }
  return { byProject, errors };
}
