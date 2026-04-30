/**
 * Inlined enums + unit-conversion helpers from vex's `@vex/domain`.
 *
 * The fuel calculator originated in vex and imported these from a
 * shared domain package. We inline them here so the calculator stays
 * a self-contained, dependency-free module — no cross-package coupling
 * to procur's own enum/schema layer, no risk of vex/procur drift.
 *
 * If procur grows its own canonical Incoterm/ProductType enums later,
 * we can re-export them from here without touching calculator.ts.
 */

export const ProductType = {
  Ulsd: 'ulsd',
  Gasoline87: 'gasoline_87',
  Gasoline91: 'gasoline_91',
  JetA: 'jet_a',
  JetA1: 'jet_a1',
  Kerosene: 'kerosene',
  Avgas: 'avgas',
  Lfo: 'lfo',
  Hfo: 'hfo',
  Lng: 'lng',
  Lpg: 'lpg',
  BiodieselB20: 'biodiesel_b20',
  Rice: 'rice',
  Beans: 'beans',
  Pork: 'pork',
  Chicken: 'chicken',
  CookingOil: 'cooking_oil',
  PowderedMilk: 'powdered_milk',
} as const;
export type ProductType = (typeof ProductType)[keyof typeof ProductType];

export const IncotermType = {
  Fob: 'fob',
  Cif: 'cif',
  Cfr: 'cfr',
  Dap: 'dap',
  Exw: 'exw',
  Fas: 'fas',
} as const;
export type IncotermType = (typeof IncotermType)[keyof typeof IncotermType];

export const PaymentTermsType = {
  Prepayment100: 'prepayment_100',
  Prepayment80_20: 'prepayment_80_20',
  LcSight: 'lc_sight',
  Lc60d: 'lc_60d',
  Lc90d: 'lc_90d',
  Lc120d: 'lc_120d',
  Sblc: 'sblc',
  OpenAccount: 'open_account',
  TelegraphicTransfer: 'telegraphic_transfer',
  Mixed: 'mixed',
} as const;
export type PaymentTermsType =
  (typeof PaymentTermsType)[keyof typeof PaymentTermsType];

export const OfacScreeningStatus = {
  NotStarted: 'not_started',
  InProgress: 'in_progress',
  Cleared: 'cleared',
  Flagged: 'flagged',
  Rejected: 'rejected',
} as const;
export type OfacScreeningStatus =
  (typeof OfacScreeningStatus)[keyof typeof OfacScreeningStatus];

export const USG_PER_BBL = 42;
export const LITRES_PER_USG = 3.785411784;

/** Convert US gallons to metric tonnes using product density in kg/L. */
export function usgToMt(usg: number, densityKgL: number): number {
  return (usg * LITRES_PER_USG * densityKgL) / 1000;
}

/** Convert US gallons to barrels. */
export function usgToBbl(usg: number): number {
  return usg / USG_PER_BBL;
}
