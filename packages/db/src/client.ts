import { neon, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

type NeonHttpDb = ReturnType<typeof drizzle<typeof schema>>;

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 400;

async function retryingFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(input, init);
      if (res.ok) return res;
      if (!RETRYABLE_STATUSES.has(res.status)) return res;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    const delay = BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * 200);
    await new Promise((r) => setTimeout(r, delay));
  }
  throw lastError instanceof Error ? lastError : new Error('retryingFetch: exhausted retries');
}

// Apply globally so any @neondatabase/serverless caller benefits without
// having to pass the fetch function explicitly.
neonConfig.fetchFunction = retryingFetch;

let cached: NeonHttpDb | null = null;

function build(): NeonHttpDb {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set — populate .env.local at the repo root or export it before running',
    );
  }
  const sql = neon(url);
  return drizzle(sql, { schema, casing: 'snake_case' });
}

export type Db = NeonHttpDb;

export const db = new Proxy({} as NeonHttpDb, {
  get(_target, prop, receiver) {
    if (!cached) cached = build();
    return Reflect.get(cached as object, prop, receiver);
  },
});
