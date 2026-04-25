import { z } from 'zod';

export const ClassifyOutput = z
  .object({
    category: z.string().describe('Taxonomy category slug from the provided list'),
    subCategory: z
      .string()
      .nullable()
      .describe('Optional taxonomy sub-category slug, null if not applicable'),
    confidence: z.number().min(0).max(1).describe('Confidence score 0-1'),
  })
  .strict();

export type ClassifyOutputT = z.infer<typeof ClassifyOutput>;

export const SummaryOutput = z
  .object({
    summary: z
      .string()
      .describe('2-3 sentence summary of the opportunity in neutral English'),
  })
  .strict();

export type SummaryOutputT = z.infer<typeof SummaryOutput>;

export const LanguageOutput = z
  .object({
    language: z
      .string()
      .describe('ISO 639-1 two-letter language code (e.g. en, es, fr, pt)'),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type LanguageOutputT = z.infer<typeof LanguageOutput>;

export const TranslationOutput = z
  .object({
    title: z.string(),
    description: z.string(),
  })
  .strict();

export type TranslationOutputT = z.infer<typeof TranslationOutput>;

export const RequirementType = z.enum([
  'technical',
  'financial',
  'legal',
  'compliance',
  'experience',
]);

export const ExtractedRequirement = z
  .object({
    id: z.string().describe('Stable short identifier (e.g. REQ-1, FIN-2)'),
    type: RequirementType,
    text: z.string(),
    mandatory: z.boolean(),
    sourceSection: z
      .string()
      .describe('Section/heading of the tender document where this was stated'),
  })
  .strict();

export const EvaluationCriterion = z
  .object({
    name: z.string(),
    weight: z
      .number()
      .min(0)
      .max(100)
      .describe('Weight as percentage 0-100, or 0 if unknown'),
    description: z.string(),
  })
  .strict();

export const ExtractRequirementsOutput = z
  .object({
    requirements: z.array(ExtractedRequirement),
    criteria: z.array(EvaluationCriterion),
    mandatoryDocuments: z
      .array(z.string())
      .describe('List of document names that bidders must submit'),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe('Overall extraction confidence 0-1'),
  })
  .strict();

export type ExtractRequirementsOutputT = z.infer<typeof ExtractRequirementsOutput>;

export const DraftSectionOutput = z
  .object({
    content: z
      .string()
      .describe('The drafted section content in plain text with paragraph breaks'),
    wordCount: z.number().int().nonnegative(),
    coverageNotes: z
      .string()
      .describe('One sentence on which requirements and criteria this draft addresses'),
  })
  .strict();

export type DraftSectionOutputT = z.infer<typeof DraftSectionOutput>;

export const ShredSentence = z
  .object({
    sectionPath: z
      .string()
      .describe(
        'Outline section number/path the sentence belongs to (e.g. "1.1.3" or "Volume I / 2.4"). Empty string if no section is detectable.',
      ),
    sectionTitle: z
      .string()
      .nullable()
      .describe('Section heading title if present in the source text, else null'),
    sentenceText: z.string().describe('The compliance sentence verbatim from the source'),
    shredType: z
      .enum(['shall', 'will', 'must', 'should', 'may', 'none'])
      .describe(
        'Compliance verb classification. shall/will/must = mandatory. should = strongly recommended. may = optional. none = not a compliance sentence.',
      ),
  })
  .strict();

export const ShredRfpOutput = z
  .object({
    sentences: z
      .array(ShredSentence)
      .describe('Compliance sentences extracted from the RFP text, in document order'),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe('Overall extraction confidence 0-1'),
  })
  .strict();

export type ShredRfpOutputT = z.infer<typeof ShredRfpOutput>;
