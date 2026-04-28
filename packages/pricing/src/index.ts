/**
 * `@procur/pricing` — fuel-deal economics.
 *
 * Layered:
 *   - `./domain`      — inlined enums + unit-conversion helpers (pure)
 *   - `./calculator`  — `calculateFuelDeal` and stages, ported verbatim
 *                        from vex (pure, deterministic, no I/O)
 *   - `./benchmarks`  — `benchmarkFor` (pure mapping) + `getBenchmarkPrice`
 *                        (Drizzle lookup against `commodity_prices`)
 *
 * Server-only: anything that imports `./benchmarks` pulls in `@procur/db`,
 * which is a server-only module. The calculator + domain pieces are
 * pure and safe to import anywhere.
 */
export * from './calculator';
export * from './benchmarks';
export {
  ProductType,
  IncotermType,
  PaymentTermsType,
  OfacScreeningStatus,
  USG_PER_BBL,
  LITRES_PER_USG,
  usgToBbl,
  usgToMt,
} from './domain';
