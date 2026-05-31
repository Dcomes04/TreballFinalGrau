export type TipusIo = 'ANIO' | 'CATIO';

export interface ProducteNutrientRow {
  producte_id: string;
  nutrient_id: string;
  pct: number;
}

export interface NutrientRow {
  nutrient_id: string;
  codi?: string | null;
  nom?: string | null;
  massa_molar_g_mol?: number | null;
}

export interface NutrientIoRow {
  nutrient_id: string;
  io_id: string;
  factor?: number | null;
}

export interface IoRow {
  io_id: string;
  nom?: string | null;
  tipus_io: TipusIo;
  valencia: number;
  massa_molar_io_g_mol: number;
}

export interface ChargeEquivalentDataSource {
  producteNutrients: ProducteNutrientRow[];
  nutrients: NutrientRow[];
  nutrientIos: NutrientIoRow[];
  ios: IoRow[];
}

export interface ComputeChargeEquivalentsInput {
  producte_id: string;
  quantitat_dosi_kg_ha: number | null | undefined;
  db: ChargeEquivalentDataSource;

  /**
   * Si ya tengo equivalentes de carga calculados, no recalcularlos
   */
  existing_equivalent_carrega_anio?: number | null;
  existing_equivalent_carrega_catio?: number | null;
}

export interface ComputeChargeEquivalentsResult {
  equivalent_carrega_anio: number;
  equivalent_carrega_catio: number;
  details: Array<{
    nutrient_id: string;
    io_id: string;
    tipus_io: TipusIo;
    pct: number;
    factor: number;
    massa_nutrient_kg_ha: number;
    massa_io_g_ha: number;
    mol_io: number;
    equivalent_carrega: number;
  }>;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function requireFinitePositive(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} ha de ser un número > 0`);
  }
  return value;
}

function normalizePct(pct: number, ctx: string): number {
  if (!Number.isFinite(pct) || pct < 0 || pct > 1) {
    throw new Error(`${ctx}.pct ha d'estar entre 0 i 1`);
  }
  return pct;
}

function resolveFactor(params: {
  nutrientIo: NutrientIoRow;
  io: IoRow;
}): number {
  const explicitFactor = params.nutrientIo.factor;

  if (explicitFactor != null) {
    if (!Number.isFinite(explicitFactor) || explicitFactor < 0) {
      throw new Error(
        `nutrient_io.factor invàlid per nutrient_id=${params.nutrientIo.nutrient_id}, io_id=${params.nutrientIo.io_id}`,
      );
    }
    return explicitFactor;
  }

  throw new Error(
    `Falta nutrient_io.factor per nutrient_id=${params.nutrientIo.nutrient_id}, io_id=${params.nutrientIo.io_id}`,
  );
}

function emptyChargeResult(): ComputeChargeEquivalentsResult {
  return {
    equivalent_carrega_anio: 0,
    equivalent_carrega_catio: 0,
    details: [],
  };
}

function computeChargeForNutrient(params: {
  db: ChargeEquivalentDataSource;
  nutrientId: string;
  pct: number;
  massaNutrientKgHa: number;
}): {
  anio: number;
  catio: number;
  details: ComputeChargeEquivalentsResult['details'];
} {
  const { db, nutrientId, pct, massaNutrientKgHa } = params;
  const nutrientIoRows = db.nutrientIos.filter((row) => row.nutrient_id === nutrientId);

  let anio = 0;
  let catio = 0;
  const details: ComputeChargeEquivalentsResult['details'] = [];

  for (const ni of nutrientIoRows) {
    const io = db.ios.find((row) => row.io_id === ni.io_id) ?? null;
    if (!io) continue;

    const factor = resolveFactor({ nutrientIo: ni, io });
    if (factor === 0) continue;

    const massaMolarIo = requireFinitePositive(io.massa_molar_io_g_mol, 'io.massa_molar_io_g_mol');
    const valenciaAbs = Math.abs(requireFinitePositive(Math.abs(io.valencia), 'io.valencia'));

    const massaIoGHa = massaNutrientKgHa * factor * 1000;
    const molIo = massaIoGHa / massaMolarIo;
    const equivalentCarrega = molIo * valenciaAbs;

    if (io.tipus_io === 'ANIO') anio += equivalentCarrega;
    else catio += equivalentCarrega;

    details.push({
      nutrient_id: nutrientId,
      io_id: io.io_id,
      tipus_io: io.tipus_io,
      pct,
      factor,
      massa_nutrient_kg_ha: massaNutrientKgHa,
      massa_io_g_ha: massaIoGHa,
      mol_io: molIo,
      equivalent_carrega: equivalentCarrega,
    });
  }

  return { anio, catio, details };
}

export function computeChargeEquivalentsForApplication(
  input: ComputeChargeEquivalentsInput,
): ComputeChargeEquivalentsResult {
  const existingAnio = input.existing_equivalent_carrega_anio;
  const existingCatio = input.existing_equivalent_carrega_catio;

  if (isFiniteNonNegative(existingAnio) && isFiniteNonNegative(existingCatio)) {
    return {
      equivalent_carrega_anio: existingAnio,
      equivalent_carrega_catio: existingCatio,
      details: [],
    };
  }

  const quantitatDosiKgHa = input.quantitat_dosi_kg_ha ?? 0;

  if (!Number.isFinite(quantitatDosiKgHa) || quantitatDosiKgHa < 0) {
    throw new Error('quantitat_dosi_kg_ha ha de ser un número >= 0');
  }

  if (quantitatDosiKgHa === 0) {
    return emptyChargeResult();
  }

  const productNutrients = input.db.producteNutrients.filter(
    (row) => row.producte_id === input.producte_id,
  );

  if (productNutrients.length === 0) {
    return emptyChargeResult();
  }

  let equivalentCarregaAnio = 0;
  let equivalentCarregaCatio = 0;

  const details: ComputeChargeEquivalentsResult['details'] = [];

  for (const pn of productNutrients) {
    const pct = normalizePct(
      pn.pct,
      `producte_nutrient(producte_id=${pn.producte_id}, nutrient_id=${pn.nutrient_id})`,
    );

    const massaNutrientKgHa = quantitatDosiKgHa * pct;
    if (massaNutrientKgHa === 0) continue;

    const nutrientCharge = computeChargeForNutrient({
      db: input.db,
      nutrientId: pn.nutrient_id,
      pct,
      massaNutrientKgHa,
    });

    equivalentCarregaAnio += nutrientCharge.anio;
    equivalentCarregaCatio += nutrientCharge.catio;
    details.push(...nutrientCharge.details);
  }

  return {
    equivalent_carrega_anio: equivalentCarregaAnio,
    equivalent_carrega_catio: equivalentCarregaCatio,
    details,
  };
}