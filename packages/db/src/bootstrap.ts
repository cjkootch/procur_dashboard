import 'dotenv/config';
import { config } from 'dotenv';
import { neon } from '@neondatabase/serverless';

config({ path: '../../.env.local' });
config({ path: '../../.env' });

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const sql = neon(url);
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  console.log('pgvector extension ready');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
