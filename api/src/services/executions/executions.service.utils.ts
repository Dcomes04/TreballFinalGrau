import { loadAll } from '../../datasources/repository';

export const DEFAULT_K_PH = 0.005;

// Calcula el número de días completos entre dos fechas
export function diffDaysInclusive(start: Date, end: Date): number {
  const startUtc = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const endUtc = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  return Math.floor((endUtc - startUtc) / (24 * 60 * 60 * 1000)) + 1;
}

// Suma un número entero de días a una fecha
export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + Math.floor(days));
  return d;
}

// Convierte una fecha a ISO para persistirla en la base de datos
export function toISO(date: Date): string {
  return date.toISOString();
}

// Normaliza la etiqueta de un suelo
export function normalizeSoilLabel(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// Normaliza la etiqueta de un nutriente para comparaciones y agrupamientos
export function normalizeNutrientComponent(value: string | null | undefined): string {
  return String(value ?? '').trim().toUpperCase();
}

// Función para calcular la cantidad total de N, P y K aplicada en un día dado un listado de aplicaciones de fertilizante ejecutadas ese día
export function computeDailyFertilizerNpkAndIonMass(params: {
  executedFertilizerApplications: Array<{ producteId: string; quantitatDosiKgHa: number | null }>;
  db: Awaited<ReturnType<typeof loadAll>>;
}) {
  const { executedFertilizerApplications, db } = params;

  let nEntradaKgHa = 0;
  let pEntradaKgHa = 0;
  let kEntradaKgHa = 0;
  let npkFertilitzantsKgHa = 0;
  let ionsNoNpkFertilitzantsKgHa = 0;

  for (const app of executedFertilizerApplications) {
    const dose = app.quantitatDosiKgHa ?? 0;
    if (!Number.isFinite(dose) || dose <= 0) continue;

    const productRows = db.producteNutrients.filter((row) => row.producte_id === app.producteId);

    for (const pn of productRows) {
      const nutrient = db.nutrients.find((row) => row.nutrient_id === pn.nutrient_id) ?? null;
      const component = normalizeNutrientComponent(nutrient?.component_principal);
      const massKgHa = dose * pn.pct;

      if (component === 'N') {
        nEntradaKgHa += massKgHa;
        npkFertilitzantsKgHa += massKgHa;
      } else if (component === 'P') {
        pEntradaKgHa += massKgHa;
        npkFertilitzantsKgHa += massKgHa;
      } else if (component === 'K') {
        kEntradaKgHa += massKgHa;
        npkFertilitzantsKgHa += massKgHa;
      } else {
        ionsNoNpkFertilitzantsKgHa += massKgHa;
      }
    }
  }

  return {
    n_entrada_kg_ha: nEntradaKgHa,
    p_entrada_kg_ha: pEntradaKgHa,
    k_entrada_kg_ha: kEntradaKgHa,
    npk_fertilitzants_kg_ha: npkFertilitzantsKgHa,
    ions_no_npk_fertilitzants_kg_ha: ionsNoNpkFertilitzantsKgHa,
  };
}

// Devuelve las filas de clima_simulacio
export function getClimateRows(db: Awaited<ReturnType<typeof loadAll>>): any[] {
  return db.climaSimulacio ?? [];
}

// Normaliza una fecha a formato ISO con hora 00:00:00Z para comparaciones de días
export function normalizeDateOnlyIso(date: Date): string {
  return toISO(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())));
}

// Función para comparar si dos fechas corresponden al mismo día
export function sameUtcDay(a: Date | string, b: Date | string): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return da.getUTCFullYear() == db.getUTCFullYear() && da.getUTCMonth() == db.getUTCMonth() && da.getUTCDate() == db.getUTCDate();
}

// Devuelve el índice de día de simulación
export function getDayIndexFromD0(d0: Date, targetDate: Date): number {
  return Math.floor((targetDate.getTime() - d0.getTime()) / (24 * 60 * 60 * 1000));
}
