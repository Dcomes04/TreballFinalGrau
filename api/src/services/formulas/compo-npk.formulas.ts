// Fórmulas COMPO de NPK derivadas del producto aplicado.
// Este módulo convierte kg/ha de producto en kg/ha de N, P y K.

export interface CompoNpkFromProductParams {
  producte_kg_ha_fase: number;
  n_pct: number;
  p_pct: number;
  k_pct: number;
}

export interface CompoNpkPhaseResult {
  n_fase_kg_ha_compo: number;
  p_fase_kg_ha_compo: number;
  k_fase_kg_ha_compo: number;
}

export interface CompoNpkDayResult extends CompoNpkPhaseResult {
  n_dia_kg_ha_compo: number;
  p_dia_kg_ha_compo: number;
  k_dia_kg_ha_compo: number;
}

function assertNonNegative(value: number, field: string): void {
  // Valida magnitudes físicas/cantidades que no pueden ser negativas.
  // Se usa como guard clause para evitar propagar valores inválidos.
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} debe ser un número >= 0`);
  }
}

function assertPct(value: number, field: string): void {
  // Valida porcentajes de composición del fertilizante en rango [0, 100].
  // Protege el cálculo de NPK frente a datos de catálogo mal cargados.
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${field} debe estar entre 0 y 100`);
  }
}

export interface CompoNpkFromDailyProductParams {
  producte_kg_ha_dia: number;
  n_pct: number;
  p_pct: number;
  k_pct: number;
}

export interface CompoNpkFromDailyProductResult {
  n_dia_kg_ha_compo: number;
  p_dia_kg_ha_compo: number;
  k_dia_kg_ha_compo: number;
}