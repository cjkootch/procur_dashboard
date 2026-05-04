/**
 * Shared parser output shape — matches the columns of `crude_assays`
 * + `crude_assay_cuts` in the Drizzle schema. Each parser returns
 * one of these per file. Optional fields are left undefined when the
 * source doesn't publish them.
 */

export type ParsedAssay = {
  source: string; // 'exxonmobil' | 'bp' | 'equinor' | 'totalenergies'
  reference: string;
  sourceFile: string;
  name: string;
  originCountry?: string | null;
  originLabel?: string | null;
  sampleDate?: string | null;
  assayDate?: string | null;
  issueDate?: string | null;
  comments?: string | null;

  densityKgL?: number | null;
  apiGravity?: number | null;
  bblPerMt?: number | null;
  sulphurWtPct?: number | null;
  pourPointC?: number | null;
  acidityMgKohG?: number | null;
  vanadiumMgKg?: number | null;
  nickelMgKg?: number | null;
  nitrogenMgKg?: number | null;
  rvpKpa?: number | null;
  viscosityCst20c?: number | null;
  viscosityCst50c?: number | null;
  mercaptanSulphurMgKg?: number | null;
  h2sMgKg?: number | null;
  waxAppearanceTempC?: number | null;

  raw?: Record<string, unknown> | null;
  cuts: ParsedCut[];
};

export type ParsedCut = {
  cutLabel: string;
  cutOrder: number;
  startTempC?: number | null;
  endTempC?: number | null;
  yieldWtPct?: number | null;
  yieldVolPct?: number | null;
  cumulativeYieldWtPct?: number | null;
  densityKgL?: number | null;
  sulphurWtPct?: number | null;
  raw?: Record<string, unknown> | null;
};
