import 'server-only';
import { db, retrievalRuns } from '@procur/db';

/**
 * BGE-reranker-v2-m3 wrapper. Sharpens a candidate set of passages
 * after pgvector retrieval (or any other recall stage) by scoring
 * each (query, passage) pair through a cross-encoder.
 *
 * Cross-encoder vs bi-encoder distinction:
 *   - bi-encoder (BGE-M3, OpenAI text-3) embeds query + passage
 *     independently → cheap, recall-friendly
 *   - cross-encoder (this) jointly attends over query + passage →
 *     expensive, precision-friendly
 *
 * Used as a SECOND stage on top of bi-encoder retrieval: pull e.g.
 * top-50 by cosine similarity, then rerank with this and keep the
 * top-5 the LLM drafter actually sees. Direct cross-encoder over
 * the whole corpus is too expensive.
 *
 * Discipline:
 *   - Reranker scores are INTERNAL — never surface in outbound copy
 *     or in the operator's approval chip.
 *   - Every call writes a row to `retrieval_runs` for audit + offline
 *     model-comparison eval.
 *   - When `HUGGINGFACE_API_TOKEN` is missing OR the API errors, we
 *     fall back to identity (return the input order untouched). The
 *     caller still gets a valid result; the audit row is marked
 *     `model_version: 'identity'` so eval can filter out fallback runs.
 */

const HF_RERANKER_ENDPOINT =
  'https://api-inference.huggingface.co/models/BAAI/bge-reranker-v2-m3';
const HF_TIMEOUT_MS = 15_000;

export interface Passage {
  id: string;
  text: string;
}

export interface RerankInput {
  query: string;
  passages: Passage[];
  topK?: number;
  /** Caller context stamped onto retrieval_runs.context for audit. */
  context?: Record<string, unknown>;
}

export interface RerankedPassage {
  id: string;
  text: string;
  /** Cosine-equivalent score the reranker gave; INTERNAL ONLY. */
  score: number;
  rank: number;
}

export interface RerankResult {
  passages: RerankedPassage[];
  modelVersion: string;
  retrievalRunId: string;
}

/**
 * Rerank `passages` against `query` and return the top-K kept,
 * sorted by score descending. Always writes a retrieval_runs audit
 * row, even on identity fallback.
 */
export async function rerankPassages(input: RerankInput): Promise<RerankResult> {
  const topK = input.topK ?? 5;
  const candidateCount = input.passages.length;

  if (candidateCount === 0) {
    const id = await recordRetrievalRun({
      query: input.query,
      candidateCount: 0,
      selectedIds: [],
      modelVersion: 'noop',
      context: input.context ?? {},
    });
    return { passages: [], modelVersion: 'noop', retrievalRunId: id };
  }

  const apiToken = process.env.HUGGINGFACE_API_TOKEN;
  if (!apiToken) {
    return identityFallback(input, topK, 'identity_no_token');
  }

  let scores: number[];
  try {
    scores = await scoreViaHfInference(
      input.query,
      input.passages.map((p) => p.text),
      apiToken,
    );
  } catch (err) {
    console.warn('[bge-reranker] HF inference failed, falling back to identity', err);
    return identityFallback(input, topK, 'identity_hf_error');
  }

  if (scores.length !== input.passages.length) {
    console.warn(
      `[bge-reranker] score count mismatch (got ${scores.length}, expected ${input.passages.length}); falling back`,
    );
    return identityFallback(input, topK, 'identity_score_mismatch');
  }

  const indexed = input.passages.map((p, i) => ({ ...p, score: scores[i] ?? 0 }));
  indexed.sort((a, b) => b.score - a.score);
  const kept = indexed.slice(0, topK).map((p, i) => ({
    id: p.id,
    text: p.text,
    score: p.score,
    rank: i,
  }));

  const id = await recordRetrievalRun({
    query: input.query,
    candidateCount,
    selectedIds: kept.map((p) => p.id),
    modelVersion: 'bge-reranker-v2-m3',
    context: input.context ?? {},
  });

  return {
    passages: kept,
    modelVersion: 'bge-reranker-v2-m3',
    retrievalRunId: id,
  };
}

/**
 * Append-only audit row. Every reranker call writes one; the catalog
 * never reads them back at request time — eval / debugging surfaces
 * read independently. Failures are swallowed (a missing audit row
 * MUST NEVER fail the caller's drafting flow).
 */
export async function recordRetrievalRun(input: {
  query: string;
  candidateCount: number;
  selectedIds: string[];
  modelVersion: string;
  context?: Record<string, unknown>;
}): Promise<string> {
  try {
    const [row] = await db
      .insert(retrievalRuns)
      .values({
        query: input.query.slice(0, 4_000),
        candidateCount: input.candidateCount,
        selectedIds: input.selectedIds,
        modelVersion: input.modelVersion,
        context: input.context ?? {},
      })
      .returning({ id: retrievalRuns.id });
    return row?.id ?? '';
  } catch (err) {
    console.error('[bge-reranker] retrieval_runs insert failed', err);
    return '';
  }
}

function identityFallback(
  input: RerankInput,
  topK: number,
  modelVersion: string,
): Promise<RerankResult> {
  return Promise.resolve().then(async () => {
    const kept = input.passages.slice(0, topK).map((p, i) => ({
      id: p.id,
      text: p.text,
      score: 0,
      rank: i,
    }));
    const id = await recordRetrievalRun({
      query: input.query,
      candidateCount: input.passages.length,
      selectedIds: kept.map((p) => p.id),
      modelVersion,
      context: input.context ?? {},
    });
    return { passages: kept, modelVersion, retrievalRunId: id };
  });
}

/**
 * HF Inference API call. The reranker model expects a payload of
 * `{ inputs: { source_sentence: query, sentences: [...] } }` per the
 * sentence-similarity task; HF returns an array of scores in the
 * same order.
 *
 * Free tier is rate-limited (~10 req/min). For higher throughput,
 * swap to a dedicated inference endpoint or self-host via the
 * Python module's offline batch path.
 */
async function scoreViaHfInference(
  query: string,
  passages: string[],
  apiToken: string,
): Promise<number[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HF_TIMEOUT_MS);
  try {
    const res = await fetch(HF_RERANKER_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs: {
          source_sentence: query,
          sentences: passages,
        },
        // wait_for_model true keeps free-tier cold-starts from
        // bouncing us with 503 — costs ~30s on first call but is
        // the cheapest production-acceptable path.
        options: { wait_for_model: true },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HF inference ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as unknown;
    if (!Array.isArray(json)) {
      throw new Error(`HF inference returned non-array: ${typeof json}`);
    }
    return json.map((v) => (typeof v === 'number' ? v : 0));
  } finally {
    clearTimeout(timeoutId);
  }
}
