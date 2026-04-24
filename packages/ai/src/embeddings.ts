import OpenAI from 'openai';

let cached: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!cached) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error(
        'OPENAI_API_KEY is not set — needed for content-library embeddings',
      );
    }
    cached = new OpenAI();
  }
  return cached;
}

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMS = 1536;

export async function embedText(input: string): Promise<number[]> {
  const client = getOpenAI();
  const trimmed = input.slice(0, 30_000); // ~7.5K tokens; text-embedding-3-small cap is 8k
  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: trimmed,
    encoding_format: 'float',
  });
  const vec = response.data[0]?.embedding;
  if (!vec || vec.length !== EMBEDDING_DIMS) {
    throw new Error(`embedText returned unexpected vector (len=${vec?.length ?? 0})`);
  }
  return vec;
}

export async function embedMany(inputs: string[]): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const client = getOpenAI();
  const batch = inputs.map((t) => t.slice(0, 30_000));
  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: batch,
    encoding_format: 'float',
  });
  return response.data.map((d) => d.embedding);
}
