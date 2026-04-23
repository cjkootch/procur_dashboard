import 'dotenv/config';
import { config } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

config({ path: '../../.env.local' });
config({ path: '../../.env' });

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'drizzle');

type NeonFn = ReturnType<typeof neon>;

async function withRetry<T>(op: () => Promise<T>, label: string): Promise<T> {
  const delays = [0, 1000, 3000, 8000, 15000];
  let lastErr: unknown;
  for (const delay of delays) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  retry [${label}] after ${delay}ms: ${msg}`);
    }
  }
  throw lastErr;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const sql = neon(url) as NeonFn;

  await withRetry(() => sql`CREATE EXTENSION IF NOT EXISTS vector`, 'enable vector');
  await withRetry(
    () => sql`
      CREATE TABLE IF NOT EXISTS __drizzle_migrations (
        id serial PRIMARY KEY,
        hash text NOT NULL UNIQUE,
        created_at bigint NOT NULL
      )
    `,
    'create migrations table',
  );

  const rows = (await withRetry(
    () => sql`SELECT hash FROM __drizzle_migrations`,
    'list applied',
  )) as Array<{ hash: string }>;
  const applied = new Set(rows.map((r) => r.hash));

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip  ${file}`);
      continue;
    }
    const content = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const statements = content
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);

    console.log(`apply ${file} (${statements.length} statements)`);
    let i = 0;
    for (const stmt of statements) {
      i += 1;
      await withRetry(() => sql(stmt), `${file} stmt ${i}/${statements.length}`);
    }

    await withRetry(
      () => sql`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (${file}, ${Date.now()})`,
      'record migration',
    );
  }

  console.log('migrations complete');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
