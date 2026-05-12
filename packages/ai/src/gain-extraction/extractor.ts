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
}

export async function extractGainReport(
  args: ExtractGainReportArgs,
): Promise<GainExtractionResult> {
  const client = getClient();
  const model = args.model ?? MODELS.sonnet;
  const maxSections = args.maxSections ?? 12;

  const candidates = args.parsed.sections
    .filter((s) => s.kind === 'candidate')
    .slice(0, maxSections);

  const perSection: GainExtractionResult['perSection'] = [];
  let totalUsage = emptyUsage();

  for (const section of candidates) {
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
    usage: totalUsage,
  };
}
