import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Pre-recorded audio assets for ringless voicemail (RVM) dispatch.
 *
 * The autopilot's RVM executor (PR 3) plays audio from this table
 * via Twilio TwiML <Play> on machine_end_beep detection. Audio
 * bytes live in Vercel Blob; this row carries the metadata + link.
 *
 * Generation paths (operator-selected at upload time):
 *   - 'voicebox'      — Voicebox running locally on operator's
 *                       Mac; browser POSTs to localhost:17493
 *                       /generate, gets bytes back, uploads here
 *   - 'manual_upload' — operator drag-drops a .mp3/.wav file
 *                       generated elsewhere (ElevenLabs UI, hand
 *                       recording, Slybroadcast asset library, etc.)
 *   - 'elevenlabs'    — hosted TTS via ElevenLabs API (deferred;
 *                       PR 4 may add this if Voicebox path proves
 *                       insufficient for some markets)
 *   - 'other'         — escape hatch
 *
 * Scope: per (probe, variant, language). When variant_id is null,
 * the asset applies to all of the probe's variants for that
 * language (probe-default audio). Variant-specific assets win over
 * probe-defaults at dispatch time.
 *
 * Active gating: is_active=false rows preserve audit history when
 * an operator iterates on a recording without losing the prior
 * version. Unique partial index ensures only ONE active asset per
 * (probe, variant, language) tuple — prevents the autopilot from
 * having to pick between two equally-valid assets.
 *
 * Languages mirror probe.outreach_language taxonomy (ISO 639-1).
 * Cross-language: a probe targeting JP recipients with
 * outreach_language='ja' gets the active asset where language='ja'.
 * If none exists, the probe's RVM dispatch is skipped at the
 * autopilot eligibility check — operator gets a clear "no audio
 * for ja in probe X" reason.
 */
export const rvmAudioAssets = pgTable(
  'rvm_audio_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** market_probes.id; cascade-delete with the probe. */
    probeId: text('probe_id').notNull(),

    /** market_probe_message_variants.id. Null = probe-default audio
     *  used when no variant-specific asset exists. */
    variantId: text('variant_id'),

    /** ISO 639-1 lowercase. Pairs with probe.outreach_language at
     *  dispatch time. */
    language: text('language').notNull(),

    /** What the audio says, in plain text. Audit + retranslation
     *  source. Capped at 4000 chars (typical voicemail is < 60s,
     *  i.e. < 200 words; this is a generous ceiling). */
    sourceText: text('source_text').notNull(),

    /** Vercel Blob URL. Public-read (Twilio fetches via TwiML). */
    audioUrl: text('audio_url').notNull(),

    /** MIME type. Twilio Play accepts audio/mpeg + audio/wav.
     *  We accept either; default mpeg for size. */
    audioFormat: text('audio_format').notNull().default('audio/mpeg'),

    /** Duration of the audio in milliseconds. Helps the autopilot
     *  enforce voicemail-box length limits (most carriers cap at
     *  60-90s) — assets exceeding 90s flagged at dispatch time. */
    durationMs: integer('duration_ms'),

    /** Voicebox profile id used for generation, when known. Lets
     *  operators see "this asset was generated with the 'Cole-EN'
     *  profile" in the UI + retain the link for regeneration. */
    voiceProfileId: text('voice_profile_id'),

    /** Generation source — see header comment. */
    generatedVia: text('generated_via').notNull(),

    /** ISO timestamp of generation. */
    generatedAt: timestamp('generated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    /** Operator who uploaded / generated. */
    generatedByUserId: text('generated_by_user_id'),

    /** false = retired. Preserves history; new uploads create a new
     *  active row. Unique constraint scoped via partial index. */
    isActive: boolean('is_active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    probeIdx: index('rvm_audio_assets_probe_idx').on(table.probeId),
    variantIdx: index('rvm_audio_assets_variant_idx')
      .on(table.variantId)
      .where(sql`${table.variantId} IS NOT NULL`),
    /** Only one active asset per (probe, variant, language). The
     *  variantId-null case still gets covered because `is null`
     *  groups distinctly under PG's NULLS DISTINCT semantics — but
     *  to be safe, callers MUST treat variantId-null as a separate
     *  scope from variantId='X' regardless. */
    activeUniq: uniqueIndex('rvm_audio_assets_active_uniq')
      .on(table.probeId, table.variantId, table.language)
      .where(sql`${table.isActive}`),
  }),
);

export type RvmAudioAsset = typeof rvmAudioAssets.$inferSelect;
export type NewRvmAudioAsset = typeof rvmAudioAssets.$inferInsert;
