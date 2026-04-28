/**
 * VTC commodity-category classifier shared across all scrapers.
 *
 * Most government portals (UNGM, Jamaica GOJEP, Guyana NPTAB, Colombia
 * SECOP, etc) don't expose structured commodity codes in their public
 * feeds — they emit free-text titles + descriptions. To still let
 * Discover users filter by VTC's commodity buckets, we run a single
 * keyword regex over title + description and emit the matched
 * `taxonomy_categories.slug`.
 *
 * Word boundaries (`\b`) eliminate substring noise ("oil"→"boil",
 * "sand"→"Sandbox", "service"→"servicing"). The keyword list is
 * conservative — better to miss a borderline row than flood the filter
 * with false positives that the user has to mentally re-filter.
 *
 * Slugs match the seeded entries in `taxonomy_categories`:
 *   food-commodities  · petroleum-fuels  · vehicles-fleet  · minerals-metals
 *
 * For scrapers with structured codes (SAM via NAICS) prefer code-based
 * mapping and only fall back to this classifier when the code lookup
 * misses.
 *
 * Languages: English + Spanish. Spanish-source jurisdictions (Colombia
 * SECOP, DR DGCP, Chile Mercado Público) classify off ES titles.
 * Diacritics are stripped from BOTH the input text AND the keyword
 * lists below, so the regex can use ASCII (\b respects ASCII word
 * boundaries; `á` is non-word in JS regex without /u-aware boundaries,
 * which would break matching at accent positions).
 */

/**
 * Strip diacritics + lowercase so Spanish accents don't interfere with
 * regex word boundaries.
 *   "Adquisición de Diésel"   → "adquisicion de diesel"
 *   "Áridos para construcción" → "aridos para construccion"
 *
 * Decompose to NFD, drop combining marks (U+0300..U+036F), lowercase.
 */
function normalize(s: string): string {
  // Combining-mark range U+0300..U+036F via escape so the file stays
  // pure ASCII and code reviewers don't squint at literal diacritics.
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Per-category keywords (already accent-stripped + lowercased to match
 * the normalized input). English first, then Spanish equivalents.
 *
 * Ordering of buckets within the array sets priority — first match
 * wins. food → fuel → vehicles → minerals so a row mentioning both
 * "diesel truck" tags as petroleum-fuels (stronger commodity signal
 * for a fuel trader).
 */
const CATEGORY_REGEXES: Array<readonly [string, RegExp]> = [
  [
    'food-commodities',
    new RegExp(
      '\\b(' +
        [
          // English (singular + plural where ambiguity helps)
          'food', 'foods', 'foodstuff', 'foodstuffs', 'rice', 'sugar',
          'flour', 'poultry', 'chicken', 'beef', 'pork', 'lamb', 'meat',
          'meats', 'bread', 'bakery', 'fruit', 'fruits', 'vegetable',
          'vegetables', 'frozen', 'ration', 'rations', 'dairy', 'wheat',
          'corn', 'maize', 'soybean', 'soybeans', 'soy', 'legume',
          'legumes', 'bean', 'beans', 'lentil', 'lentils', 'oat', 'oats',
          'rye', 'grain', 'grains', 'cereal', 'cereals', 'fertilizer',
          'fertilizers', 'milk', 'cheese', 'egg', 'eggs', 'butter',
          'coffee', 'tea', 'cocoa',
          // Spanish (accent-stripped)
          'comida', 'alimento', 'alimentos', 'alimenticio', 'alimentaria',
          'viveres', 'arroz', 'azucar', 'harina', 'aves', 'pollo', 'carne',
          'ternera', 'cerdo', 'porcino', 'cordero', 'pan', 'fruta',
          'frutas', 'verdura', 'verduras', 'hortaliza', 'hortalizas',
          'congelado', 'congelados', 'racion', 'raciones', 'lacteo',
          'lacteos', 'trigo', 'maiz', 'soja', 'soya', 'legumbre',
          'legumbres', 'frijol', 'frijoles', 'judia', 'alubia',
          'habichuela', 'lenteja', 'lentejas', 'avena', 'centeno', 'grano',
          'granos', 'fertilizante', 'abono', 'leche', 'queso', 'huevo',
          'huevos', 'mantequilla', 'cafe', 'cacao',
        ].join('|') +
        ')\\b',
    ),
  ],
  [
    'petroleum-fuels',
    new RegExp(
      '\\b(' +
        [
          // English
          'fuel', 'fuels', 'diesel', 'gasoline', 'petrol', 'kerosene',
          'jet a-1', 'jet fuel', 'propane', 'lubricant', 'lubrication',
          'petroleum', 'lpg', 'lng', 'heating oil', 'marine fuel',
          'aviation fuel', 'gas oil', 'crude oil',
          // Spanish (accent-stripped)
          'combustible', 'combustibles', 'gasoil', 'gasoleo', 'gasolina',
          'bencina', 'querosene', 'queroseno', 'parafina', 'propano',
          'lubricante', 'lubricantes', 'petroleo', 'glp', 'gnl',
          'fueloil', 'gas natural',
        ].join('|') +
        ')\\b',
    ),
  ],
  [
    'vehicles-fleet',
    new RegExp(
      '\\b(' +
        [
          // English
          'vehicle', 'vehicles', 'vehicular', 'automobile', 'truck',
          'trucks', 'sedan', 'suv', 'minibus', 'bus', 'buses',
          'motorcycle', 'fleet', 'tractor', 'forklift', 'ambulance',
          'chassis',
          // Spanish (accent-stripped)
          'vehiculo', 'vehiculos', 'automovil', 'automoviles', 'coche',
          'coches', 'camion', 'camiones', 'camioneta', 'camionetas',
          'microbus', 'autobus', 'autobuses', 'omnibus', 'colectivo',
          'motocicleta', 'motocicletas', 'flota', 'flotilla',
          'montacargas', 'autoelevador', 'ambulancia', 'chasis',
        ].join('|') +
        ')\\b',
    ),
  ],
  [
    'minerals-metals',
    new RegExp(
      '\\b(' +
        [
          // English
          'mineral', 'minerals', 'ore', 'ores', 'aggregate', 'aggregates',
          'gravel', 'limestone', 'cement', 'iron ore', 'copper ore',
          'zinc ore', 'steel beam', 'steel rebar', 'steel plate',
          'bauxite', 'sandstone',
          // Spanish (accent-stripped). Bare metal names ("hierro",
          // "cobre") omitted — they have too many manufacturing-context
          // false positives in Spanish procurement titles.
          'minerales', 'mena', 'agregado', 'agregados', 'aridos', 'grava',
          'caliza', 'cemento', 'bauxita', 'arenisca',
        ].join('|') +
        ')\\b',
    ),
  ],
];

/**
 * First-match wins. Returns null when nothing matches; caller treats
 * null as "leave category unset" (not "skip the row").
 */
export function classifyVtcCategory(text: string | null | undefined): string | null {
  if (!text) return null;
  const normalized = normalize(text);
  for (const [slug, re] of CATEGORY_REGEXES) {
    if (re.test(normalized)) return slug;
  }
  return null;
}
