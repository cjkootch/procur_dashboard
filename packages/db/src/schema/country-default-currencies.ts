import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Best-effort currency assumption for awards with NULL contract_currency.
 * Static seed loaded once via `seed-country-currencies`. Updated rarely.
 *
 * Caveat: some Caribbean countries trade fuel in USD even though their
 * local currency exists (BS, BB, JM partially). The defaults reflect
 * what's most common for the public-procurement category. Edit the
 * seed and re-run if a country's behavior shifts.
 *
 * Public-domain. No tenant scoping.
 */
export const countryDefaultCurrencies = pgTable('country_default_currencies', {
  /** ISO-3166-1 alpha-2. */
  countryCode: text('country_code').primaryKey(),
  /** ISO-4217 currency code. */
  defaultCurrency: text('default_currency').notNull(),
  notes: text('notes'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type CountryDefaultCurrency = typeof countryDefaultCurrencies.$inferSelect;
export type NewCountryDefaultCurrency = typeof countryDefaultCurrencies.$inferInsert;
