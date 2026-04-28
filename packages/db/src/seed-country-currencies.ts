/**
 * Seed country_default_currencies — best-effort fallback when an
 * award lacks an explicit contract_currency.
 *
 * Caribbean / Latin America fuel awards are highly mixed: some
 * countries publish in local currency (DOP, JMD), others in USD even
 * though a local currency exists (BS, BB, HT, SV, EC). The defaults
 * here reflect what's most common for the public-procurement category
 * the supplier graph ingests.
 *
 * Idempotent (ON CONFLICT). Edit the rows + re-run to update.
 *
 * Run: pnpm --filter @procur/db seed-country-currencies
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

type CurrencySeed = { country: string; currency: string; notes?: string };

const SEEDS: CurrencySeed[] = [
  // Caribbean
  { country: 'DO', currency: 'DOP', notes: 'Dominican Republic — fuel awards routinely in DOP' },
  { country: 'JM', currency: 'JMD', notes: 'Jamaica — most public awards in JMD; private deals often USD' },
  { country: 'TT', currency: 'TTD', notes: 'Trinidad & Tobago' },
  { country: 'BB', currency: 'USD', notes: 'Barbados — most fuel deals invoiced in USD despite BBD existing' },
  { country: 'BS', currency: 'USD', notes: 'Bahamas — same pattern' },
  { country: 'HT', currency: 'USD', notes: 'Haiti — heavily dollarized fuel market' },
  { country: 'CU', currency: 'CUP', notes: 'Cuba' },
  { country: 'PR', currency: 'USD', notes: 'Puerto Rico (US territory)' },

  // North America
  { country: 'US', currency: 'USD' },
  { country: 'CA', currency: 'CAD' },
  { country: 'MX', currency: 'MXN' },

  // Central America
  { country: 'GT', currency: 'GTQ' },
  { country: 'HN', currency: 'HNL' },
  { country: 'SV', currency: 'USD', notes: 'El Salvador — uses USD officially' },
  { country: 'NI', currency: 'NIO' },
  { country: 'CR', currency: 'CRC' },
  { country: 'PA', currency: 'USD', notes: 'Panama — uses USD (balboa pegged)' },

  // South America
  { country: 'CO', currency: 'COP' },
  { country: 'EC', currency: 'USD', notes: 'Ecuador — uses USD officially' },
  { country: 'PE', currency: 'PEN' },
  { country: 'CL', currency: 'CLP' },
  { country: 'AR', currency: 'ARS' },
  { country: 'BR', currency: 'BRL' },
  { country: 'VE', currency: 'VES', notes: 'Venezuela — bolívar soberano' },
  { country: 'UY', currency: 'UYU' },
  { country: 'PY', currency: 'PYG' },
  { country: 'BO', currency: 'BOB' },

  // Europe (key oil-deal jurisdictions)
  { country: 'GB', currency: 'GBP' },
  { country: 'DE', currency: 'EUR' },
  { country: 'FR', currency: 'EUR' },
  { country: 'IT', currency: 'EUR' },
  { country: 'ES', currency: 'EUR' },
  { country: 'NL', currency: 'EUR' },
  { country: 'GR', currency: 'EUR' },
  { country: 'PT', currency: 'EUR' },
  { country: 'BE', currency: 'EUR' },
  { country: 'AT', currency: 'EUR' },
  { country: 'IE', currency: 'EUR' },
  { country: 'FI', currency: 'EUR' },
  { country: 'PL', currency: 'PLN' },
  { country: 'CZ', currency: 'CZK' },
  { country: 'HU', currency: 'HUF' },
  { country: 'RO', currency: 'RON' },
  { country: 'BG', currency: 'BGN' },
  { country: 'HR', currency: 'EUR' },
  { country: 'SE', currency: 'SEK' },
  { country: 'DK', currency: 'DKK' },
  { country: 'NO', currency: 'NOK' },
  { country: 'CH', currency: 'CHF' },
  { country: 'TR', currency: 'TRY' },
  { country: 'RU', currency: 'RUB' },
  { country: 'UA', currency: 'UAH' },

  // Middle East / Africa
  { country: 'IL', currency: 'ILS' },
  { country: 'SA', currency: 'SAR' },
  { country: 'AE', currency: 'AED' },
  { country: 'QA', currency: 'QAR' },
  { country: 'KW', currency: 'KWD' },
  { country: 'EG', currency: 'EGP' },
  { country: 'NG', currency: 'NGN' },
  { country: 'GH', currency: 'GHS' },
  { country: 'ZA', currency: 'ZAR' },
  { country: 'KE', currency: 'KES' },
  { country: 'SN', currency: 'XOF', notes: 'CFA franc (West African)' },

  // Asia
  { country: 'IN', currency: 'INR' },
  { country: 'CN', currency: 'CNY' },
  { country: 'JP', currency: 'JPY' },
  { country: 'KR', currency: 'KRW' },
  { country: 'SG', currency: 'SGD' },
  { country: 'TH', currency: 'THB' },
  { country: 'MY', currency: 'MYR' },
  { country: 'ID', currency: 'IDR' },
  { country: 'PH', currency: 'PHP' },
  { country: 'VN', currency: 'VND' },
  { country: 'PK', currency: 'PKR' },
  { country: 'BD', currency: 'BDT' },

  // Oceania
  { country: 'AU', currency: 'AUD' },
  { country: 'NZ', currency: 'NZD' },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const client = neon(url);
  const db = drizzle(client, { schema, casing: 'snake_case' });

  console.log(`Seeding ${SEEDS.length} country default currencies...`);
  for (const s of SEEDS) {
    await db
      .insert(schema.countryDefaultCurrencies)
      .values({ countryCode: s.country, defaultCurrency: s.currency, notes: s.notes ?? null })
      .onConflictDoUpdate({
        target: schema.countryDefaultCurrencies.countryCode,
        set: {
          defaultCurrency: s.currency,
          notes: s.notes ?? null,
          updatedAt: new Date(),
        },
      });
  }
  console.log(`Done. ${SEEDS.length} rows upserted.`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
