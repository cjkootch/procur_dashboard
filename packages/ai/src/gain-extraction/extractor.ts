/**
 * GAIN per-section extractor — Day 3 of gain-extraction-brief.md.
 *
 * Calls Claude with structured output for each candidate section
 * produced by the Day 2 parser, then performs within-report dedup
 * per brief §4.1 stage 3 (collapse to one row per (report, company)
 * with union of commodities + highest market position + concatenated
 * context).
 *
 * Cost / token expectations per brief §4.4:
 *   - Per report: ~3-5 sections × ~10-15k tokens in / ~2-3k out
 *   - Sonnet 4.6 rates: ~$0.15-0.25 / report
 *   - 200-report backfill: ~$30-50; quarterly delta ~$5-10
 */

import type { Anthropic } from '@anthropic-ai/sdk';
import { z } from 'zod/v4';
import { getClient, MODELS } from '../client';
import { zodOutputFormat } from '../zod-output';
import { extractUsage, type CacheUsage } from '../prompt-blocks';
import type { GainSection, ParsedGainReport } from './parser';
import {
  GainExtractionOutput,
  type GainExtractionOutputT,
  type GainNamedImporterT,
  type GainMarketPositionT,
} from './schema';
import { gainExtractionInstruction, gainSectionUserMessage } from './prompts';

/** Output of one full report's extraction — feeds the persistence stage. */
export interface GainExtractionResult {
  /** Within-report-deduped importer rows ready for INSERT. */
  importers: ExtractedImporterRow[];
  /** Per-section raw output for audit / debugging. */
  perSection: Array<{ section: GainSection; output: GainExtractionOutputT }>;
  /** When triage is enabled, the Haiku decision per section. Empty when triage off. */
  triageDecisions: Array<{ section: GainSection; decision: TriageResult }>;
  usage: CacheUsage;
}

export interface ExtractedImporterRow {
  companyName: string;
  companyNameNormalized: string;
  roles: string[];
  commodityCategories: string[];
  marketPosition: GainMarketPositionT;
  supplyPreferences: string[];
  contextExcerpt: string;
  sourceSection: string;
  sourcePage: number;
  extractionConfidence: number;
}

/**
 * Normalize a company name for dedup + later resolver matching.
 * Lowercase, strip common corporate suffixes, collapse whitespace.
 * Does NOT strip accents — the Day 4 resolver handles that.
 */
export function normalizeCompanyName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(
      /\s*(s\.\s*a\.|s\.a\.s\.|c\.\s*a\.|ltda\.|inc\.|corp\.|co\.|llc|gmbh|n\.\s*v\.)\s*$/i,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

const MARKET_POSITION_PRIORITY: GainMarketPositionT[] = [
  'dominant',
  'major',
  'emerging',
  'declining',
  'unknown',
];

function pickBetterPosition(
  a: GainMarketPositionT,
  b: GainMarketPositionT,
): GainMarketPositionT {
  return MARKET_POSITION_PRIORITY.indexOf(a) <=
    MARKET_POSITION_PRIORITY.indexOf(b)
    ? a
    : b;
}

/**
 * Within-report dedup. Same company in multiple sections collapses to
 * one row with: union of roles + commodities + supply prefs; highest
 * market position; max confidence; concatenated context excerpts
 * (capped at ~2KB to keep DB rows manageable).
 */
function dedupeWithinReport(
  perSection: Array<{ section: GainSection; output: GainExtractionOutputT }>,
): ExtractedImporterRow[] {
  const byKey = new Map<string, ExtractedImporterRow>();
  for (const { section, output } of perSection) {
    for (const imp of output.importers) {
      const key = normalizeCompanyName(imp.companyName);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, buildRow(imp, section));
        continue;
      }
      existing.roles = unionStrings(existing.roles, imp.roles);
      existing.commodityCategories = unionStrings(
        existing.commodityCategories,
        imp.commodityCategories,
      );
      existing.supplyPreferences = unionStrings(
        existing.supplyPreferences,
        imp.supplyPreferences,
      );
      existing.marketPosition = pickBetterPosition(
        existing.marketPosition,
        imp.marketPosition,
      );
      existing.extractionConfidence = Math.max(
        existing.extractionConfidence,
        imp.confidence,
      );
      // Concatenate context excerpts, but cap to ~2KB.
      const next = `${existing.contextExcerpt}\n\n— ${section.title} (p${section.startPage}):\n${imp.contextExcerpt}`;
      existing.contextExcerpt = next.length > 2048 ? existing.contextExcerpt : next;
    }
  }
  return Array.from(byKey.values());
}

function buildRow(
  imp: GainNamedImporterT,
  section: GainSection,
): ExtractedImporterRow {
  return {
    companyName: imp.companyName,
    companyNameNormalized: normalizeCompanyName(imp.companyName),
    roles: [...imp.roles],
    commodityCategories: [...imp.commodityCategories],
    marketPosition: imp.marketPosition,
    supplyPreferences: [...imp.supplyPreferences],
    contextExcerpt: imp.contextExcerpt,
    sourceSection: section.title,
    sourcePage: section.startPage,
    extractionConfidence: imp.confidence,
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

export interface ExtractGainReportArgs {
  parsed: ParsedGainReport;
  reportTitle: string;
  reportType: string;
  countryCode: string;
  /** Optional override; defaults to Sonnet for accuracy. */
  model?: typeof MODELS.sonnet | typeof MODELS.haiku;
  /** Hard cap on candidate sections to extract (cost control). */
  maxSections?: number;
  /** Pre-filter sections with Haiku before sending to Sonnet.
   *  Reduces Sonnet calls by ~30-50% on real reports where many
   *  candidate sections are statistical. Default false to preserve
   *  baseline behavior. */
  triage?: boolean;
}

// ─── Haiku triage (cost lever #2 from earlier session) ──────────────
//
// Pre-filter each candidate section with a cheap Haiku call before
// spending Sonnet on it. ~50-70% of candidate sections per report turn
// out to be macro-statistics or trade-table fragments that the
// expensive extractor would reject anyway (noNamedImporters: true).
// Routing those to a $0.005-0.01 Haiku triage saves the $0.05 Sonnet
// call.

const GainTriageOutput = z
  .object({
    hasNamedImporters: z
      .boolean()
      .describe(
        'True only if the section names specific commercial counterparties ' +
          '(companies, distributors, retailers, millers, integrators). ' +
          'False for: country-level statistics, regulatory text, government ' +
          'agency lists, trade-association rosters, post-contact info.',
      ),
    reason: z
      .string()
      .max(200)
      .describe('One short phrase explaining the decision. For audit.'),
  })
  .strict();

const TRIAGE_INSTRUCTION = `You are a binary classifier. Decide whether the section below names specific commercial counterparties (importers, distributors, retailers, millers, refiners, food-service operators, processors).

Set hasNamedImporters = true ONLY when at least one specific company name appears in commercial context — e.g. "Empresas Polar imports US wheat" or "Centro Cuesta operates 70 supermarkets".

Set hasNamedImporters = false when the section contains ANY of:
- country-level trade statistics (origin shares, volumes, prices)
- regulatory text or labeling regulations
- government agency or ministry references
- trade association / chamber of commerce rosters
- post-contact info / USDA contact details
- bibliographies / sources / references

Country names like "United States", "Brazil", "Colombia" are SUPPLIER COUNTRIES, not commercial counterparties — they do NOT count as named importers.

Be aggressive on the false side. Sonnet (the downstream extractor) is robust enough to recover from edge cases you mark false; cost matters more than recall here.`;

export interface TriageResult {
  hasNamedImporters: boolean;
  reason: string;
  usage: CacheUsage;
}

export async function triageGainSection(
  section: GainSection,
): Promise<TriageResult> {
  const client = getClient();
  const userMessage = [
    `Section: ${section.title}`,
    '',
    '--- BEGIN SECTION ---',
    section.text.slice(0, 4000), // triage doesn't need the full section
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
    output_config: { format: zodOutputFormat(GainTriageOutput) },
  });
  if (!response.parsed_output) {
    // Triage failures should fail OPEN — let Sonnet decide rather than
    // silently dropping a potentially-good section.
    return {
      hasNamedImporters: true,
      reason: 'triage_parse_failed',
      usage: extractUsage(response.usage),
    };
  }
  return {
    hasNamedImporters: response.parsed_output.hasNamedImporters,
    reason: response.parsed_output.reason,
    usage: extractUsage(response.usage),
  };
}

export async function extractGainReport(
  args: ExtractGainReportArgs,
): Promise<GainExtractionResult> {
  const client = getClient();
  const model = args.model ?? MODELS.sonnet;
  const maxSections = args.maxSections ?? 12;
  const enableTriage = args.triage ?? false;

  const candidates = args.parsed.sections
    .filter((s) => s.kind === 'candidate')
    .slice(0, maxSections);

  const perSection: GainExtractionResult['perSection'] = [];
  const triageDecisions: GainExtractionResult['triageDecisions'] = [];
  let totalUsage = emptyUsage();
  let sectionsToExtract = candidates;

  if (enableTriage) {
    sectionsToExtract = [];
    for (const section of candidates) {
      const t = await triageGainSection(section);
      totalUsage = addUsage(totalUsage, t.usage);
      triageDecisions.push({ section, decision: t });
      if (t.hasNamedImporters) sectionsToExtract.push(section);
    }
  }

  for (const section of sectionsToExtract) {
    const userMessage = gainSectionUserMessage({
      reportTitle: args.reportTitle,
      reportType: args.reportType,
      countryCode: args.countryCode,
      sectionTitle: section.title,
      sectionText: section.text,
    });

    const systemBlocks: Anthropic.TextBlockParam[] = [
      {
        type: 'text',
        text: gainExtractionInstruction(),
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ];

    const response = await client.messages.parse({
      model,
      max_tokens: 4096,
      system: systemBlocks,
      messages: [{ role: 'user', content: userMessage }],
      output_config: { format: zodOutputFormat(GainExtractionOutput) },
    });
    if (!response.parsed_output) {
      throw new Error(
        `extract-gain-report: parse failed for section "${section.title}"`,
      );
    }
    perSection.push({ section, output: response.parsed_output });
    totalUsage = addUsage(totalUsage, extractUsage(response.usage));
  }

  return {
    importers: dedupeWithinReport(perSection),
    perSection,
    triageDecisions,
    usage: totalUsage,
  };
}

// ─── Batch API path (cost lever #1: 50% off non-realtime cost) ──────
//
// Anthropic Batch API processes within 24h with a flat 50% discount on
// input + output tokens. For the GAIN backfill (~200 reports, no real-
// time requirement) and the quarterly delta (~25 reports), this cuts
// the LLM cost in half with zero quality risk — the model + prompt
// are identical to the real-time path.
//
// One batch covers ALL candidate sections across the supplied reports.
// Anthropic accepts up to 10K requests per batch and we expect ~3-5
// sections × 200 reports = ~1K sections, comfortably under the cap.
// Sections that don't fit are processed in subsequent batches.

const GAIN_TOOL_NAME = 'extract_gain_importers';
const MAX_REQUESTS_PER_BATCH = 9000; // leave headroom below the 10K cap

function buildToolDefinition(): Anthropic.Tool {
  // Force Claude to call this tool with structured output. Zod 4's
  // toJSONSchema converts the strict object schema directly.
  const jsonSchema = z.toJSONSchema(GainExtractionOutput) as unknown as Anthropic.Tool.InputSchema;
  return {
    name: GAIN_TOOL_NAME,
    description:
      'Emit the per-section extraction result. Always call this exactly once.',
    input_schema: jsonSchema,
  };
}

export interface BatchExtractRequestInput {
  /** Stable identifier for the source report (e.g. gain_reports.id). */
  reportId: string;
  reportTitle: string;
  reportType: string;
  countryCode: string;
  parsed: ParsedGainReport;
  /** Optional override; defaults to Sonnet. */
  model?: typeof MODELS.sonnet | typeof MODELS.haiku;
  /** Hard cap on candidate sections per report (cost control). */
  maxSections?: number;
}

export interface BatchExtractResult {
  byReport: Map<string, GainExtractionResult>;
  /** Per-section errors (custom_id → error message). Empty when all succeeded. */
  errors: Map<string, string>;
}

/**
 * Submit + poll + retrieve. Wall-clock varies: ~minutes for small
 * batches, up to 24h cap for large ones. Caller is expected to be a
 * long-running operator script, not a real-time path.
 */
export async function extractGainReportsBatch(
  inputs: BatchExtractRequestInput[],
  options: {
    pollIntervalMs?: number;
    maxWaitMs?: number;
    onStatus?: (status: Anthropic.Messages.MessageBatch) => void;
  } = {},
): Promise<BatchExtractResult> {
  const client = getClient();
  const pollInterval = options.pollIntervalMs ?? 30_000;
  const maxWait = options.maxWaitMs ?? 24 * 60 * 60 * 1000;
  const tool = buildToolDefinition();

  // Build requests + a section index so we can route results back.
  type Pending = {
    customId: string;
    reportId: string;
    section: GainSection;
  };
  const pending: Pending[] = [];
  const reqByReport = new Map<string, BatchExtractRequestInput>();

  for (const input of inputs) {
    reqByReport.set(input.reportId, input);
    const candidates = input.parsed.sections
      .filter((s) => s.kind === 'candidate')
      .slice(0, input.maxSections ?? 12);
    candidates.forEach((section, idx) => {
      pending.push({
        customId: `${input.reportId}/${idx}`,
        reportId: input.reportId,
        section,
      });
    });
  }

  if (pending.length === 0) {
    return { byReport: new Map(), errors: new Map() };
  }
  if (pending.length > MAX_REQUESTS_PER_BATCH) {
    throw new Error(
      `extractGainReportsBatch: ${pending.length} requests exceeds per-batch cap of ${MAX_REQUESTS_PER_BATCH}; split inputs across multiple batches`,
    );
  }

  const requests: Anthropic.Messages.BatchCreateParams.Request[] = pending.map(
    (p) => {
      const input = reqByReport.get(p.reportId);
      if (!input) {
        throw new Error(`internal: lost reportId ${p.reportId}`);
      }
      const userMessage = gainSectionUserMessage({
        reportTitle: input.reportTitle,
        reportType: input.reportType,
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
              text: gainExtractionInstruction(),
              cache_control: { type: 'ephemeral', ttl: '1h' },
            },
          ],
          messages: [{ role: 'user', content: userMessage }],
          tools: [tool],
          tool_choice: { type: 'tool', name: GAIN_TOOL_NAME },
        },
      };
    },
  );

  const batch = await client.messages.batches.create({ requests });

  // Poll until ended.
  const startedAt = Date.now();
  let current = batch;
  while (current.processing_status !== 'ended') {
    if (Date.now() - startedAt > maxWait) {
      throw new Error(
        `extractGainReportsBatch: batch ${batch.id} exceeded maxWait ${maxWait}ms`,
      );
    }
    options.onStatus?.(current);
    await new Promise((r) => setTimeout(r, pollInterval));
    current = await client.messages.batches.retrieve(batch.id);
  }
  options.onStatus?.(current);

  // Stream results, group by reportId, parse tool input via Zod.
  const perSectionByReport = new Map<
    string,
    Array<{ section: GainSection; output: GainExtractionOutputT }>
  >();
  const usageByReport = new Map<string, CacheUsage>();
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
    const parsed = GainExtractionOutput.safeParse(toolBlock.input);
    if (!parsed.success) {
      errors.set(item.custom_id, `schema_validation: ${parsed.error.message.slice(0, 200)}`);
      continue;
    }

    const accumulator = perSectionByReport.get(p.reportId) ?? [];
    accumulator.push({ section: p.section, output: parsed.data });
    perSectionByReport.set(p.reportId, accumulator);

    const usage = usageByReport.get(p.reportId) ?? emptyUsage();
    usageByReport.set(p.reportId, addUsage(usage, extractUsage(message.usage)));
  }

  const byReport = new Map<string, GainExtractionResult>();
  for (const [reportId, perSection] of perSectionByReport) {
    byReport.set(reportId, {
      importers: dedupeWithinReport(perSection),
      perSection,
      triageDecisions: [],
      usage: usageByReport.get(reportId) ?? emptyUsage(),
    });
  }
  return { byReport, errors };
}
