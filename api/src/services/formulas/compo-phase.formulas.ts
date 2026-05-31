export type DosiTipus =
  | 'KG_HA'
  | 'L_HA'
  | 'ML_HA'
  | 'G_PLANTA'
  | 'ML_PLANTA'
  | 'ML_L'
  | 'ML_100L'
  | 'L_1000L'
  | 'ML_1000L'
  | 'KG_L'
  | 'KG_100L'
  | 'KG_1000L'
  | 'ML_KG';

export type FreqTipus =
  | 'UNICA'
  | 'N_APLICACIONS'
  | 'DIARIA'
  | 'SETMANAL'
  | 'CADA_15_DIES'
  | 'MENSUAL'
  | 'CONTINUA_DURANT_FASE';

export interface EffectiveDoseParams {
  quantitat_dosi_cataleg: number | null | undefined;
  quantitat_min: number | null | undefined;
  quantitat_max: number | null | undefined;
}

/**
 * Selecciona la dosis efectiva de ejecución (`quantitat_dosi`) a partir del catálogo.
 *
 * Regla:
 * 1) si hay `quantitat_dosi_cataleg`, usarla;
 * 2) si no, promedio de min/max;
 * 3) si no, min;
 * 4) si no, max;
 * 5) si no existe nada, null.
 */
export function selectEffectiveQuantitatDosi(params: EffectiveDoseParams): number | null {
  if (params.quantitat_dosi_cataleg != null) return params.quantitat_dosi_cataleg;
  if (params.quantitat_min != null && params.quantitat_max != null) {
    return (params.quantitat_min + params.quantitat_max) / 2;
  }
  if (params.quantitat_min != null) return params.quantitat_min;
  if (params.quantitat_max != null) return params.quantitat_max;
  return null;
}

export interface DoseToKgHaParams {
  dosi_tipus: DosiTipus;
  quantitat_dosi: number;
  densitat_kg_l?: number | null;
  raw_mm?: number | null;
  dist_min_fila_m?: number | null;
  dist_min_col_m?: number | null;
}

function requirePositive(value: number | null | undefined, field: string): number {
  // Validador reutilizable para parámetros obligatorios en fórmulas de dosis.
  // Lanza error explícito para evitar cálculos silenciosos con 0/null.
  if (value == null || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} debe ser > 0 para este tipo de dosis`);
  }
  return value;
}

function normalizeDoseForWaterVolume(dosi_tipus: DosiTipus, quantitat_dosi: number): number {
  // Normaliza dosis expresadas por 100 L o 1000 L a la unidad base por litro.
  // Esto permite reutilizar la misma fórmula de ML_L / KG_L.
  if (dosi_tipus === 'ML_100L' || dosi_tipus === 'KG_100L') return quantitat_dosi / 100;
  if (dosi_tipus === 'ML_1000L' || dosi_tipus === 'KG_1000L') return quantitat_dosi / 1000;
  return quantitat_dosi;
}

function roundHalfUp(value: number): number {
  // Redondeo "0.5 hacia arriba" para convertir a entero sin sesgo hacia abajo.
  // Se usa en reglas donde el MD pide floor(x + 0.5).
  return Math.floor(value + 0.5);
}

function ceilAtLeastOne(value: number): number {
  // Para frecuencias aproximadas, evitamos infraestimar aplicaciones:
  // siempre redondeamos hacia arriba y con mínimo 1.
  return Math.max(1, Math.ceil(value));
}

/**
 * Convierte la dosis del catálogo a kg/ha por aplicación (`producte_kg_ha`).
 *
 * Implementa exactamente los casos documentados en el MD.
 */
export function convertDoseToKgHaPerApplication(params: DoseToKgHaParams): number {
  const q = params.quantitat_dosi;
  const dosiTipus = params.dosi_tipus;

  if (!Number.isFinite(q) || q < 0) {
    throw new Error('quantitat_dosi debe ser un número >= 0');
  }

  switch (dosiTipus) {
    case 'KG_HA': {
      return q;
    }
    case 'L_HA': {
      const densitat = requirePositive(params.densitat_kg_l, 'densitat_kg_l');
      return q * densitat;
    }
    case 'ML_HA': {
      const densitat = requirePositive(params.densitat_kg_l, 'densitat_kg_l');
      return (q / 1000) * densitat;
    }
    case 'G_PLANTA': {
      const distFila = requirePositive(params.dist_min_fila_m, 'dist_min_fila_m');
      const distCol = requirePositive(params.dist_min_col_m, 'dist_min_col_m');
      return (q * (1 / (distFila * distCol)) * 10000) / 1000;
    }
    case 'ML_PLANTA': {
      const densitat = requirePositive(params.densitat_kg_l, 'densitat_kg_l');
      const distFila = requirePositive(params.dist_min_fila_m, 'dist_min_fila_m');
      const distCol = requirePositive(params.dist_min_col_m, 'dist_min_col_m');
      return ((q * (1 / (distFila * distCol)) * 10000) / 1000) * densitat;
    }
    case 'ML_100L':
    case 'ML_1000L':
    case 'ML_L': {
      const densitat = requirePositive(params.densitat_kg_l, 'densitat_kg_l');
      const rawMm = requirePositive(params.raw_mm, 'raw_mm');
      const qMlL = normalizeDoseForWaterVolume(dosiTipus, q);
      return ((qMlL * rawMm * 10000) / 1000) * densitat;
    }
    case 'L_1000L': {
      const densitat = requirePositive(params.densitat_kg_l, 'densitat_kg_l');
      const rawMm = requirePositive(params.raw_mm, 'raw_mm');
      const qLL = q / 1000; // L por L
      return (qLL * rawMm * 10000) * densitat;
    }
    case 'KG_100L':
    case 'KG_1000L':
    case 'KG_L': {
      const rawMm = requirePositive(params.raw_mm, 'raw_mm');
      const qKgL = normalizeDoseForWaterVolume(dosiTipus, q);
      return qKgL * rawMm * 10000;
    }
    case 'ML_KG': {
      throw new Error('dosi_tipus ML_KG no está soportado en la conversión actual a kg/ha');
    }
    default: {
      throw new Error(`dosi_tipus no soportado en conversión a kg/ha: ${dosiTipus}`);
    }
  }
}

export interface ProductKgHaDayParams {
  freq_tipus: FreqTipus;
  producte_kg_ha: number;
  temps_dies_fao: number;
  n_aplicacions?: number | null;
}

/**
 * Calcula la cantidad de producto por día (`producte_kg_ha_dia`)
 * según el tipo de frecuencia del catálogo.
 *
 * Reglas:
 * - UNICA: producte_kg_ha / temps_dies_fao
 * - N_APLICACIONS: (producte_kg_ha * n_aplicacions) / temps_dies_fao
 * - DIARIA: producte_kg_ha
 * - CONTINUA_DURANT_FASE: producte_kg_ha
 * - SETMANAL: producte_kg_ha / 7
 * - CADA_15_DIES: producte_kg_ha / 15
 * - MENSUAL: producte_kg_ha / 30
 */
export function computeProductKgHaDay(params: ProductKgHaDayParams): number {
  if (!Number.isFinite(params.producte_kg_ha) || params.producte_kg_ha < 0) {
    throw new Error('producte_kg_ha debe ser un número >= 0');
  }
  if (!Number.isFinite(params.temps_dies_fao) || params.temps_dies_fao <= 0) {
    throw new Error('temps_dies_fao debe ser > 0');
  }

  switch (params.freq_tipus) {
    case 'UNICA':
      return params.producte_kg_ha / params.temps_dies_fao;

    case 'N_APLICACIONS': {
      if (params.n_aplicacions == null || !Number.isFinite(params.n_aplicacions) || params.n_aplicacions < 0) {
        throw new Error('n_aplicacions debe estar informado y ser >= 0 para freq_tipus N_APLICACIONS');
      }
      return ((params.producte_kg_ha * params.n_aplicacions) / params.temps_dies_fao);
    }

    case 'DIARIA':
    case 'CONTINUA_DURANT_FASE':
      return params.producte_kg_ha;

    case 'SETMANAL':
      return params.producte_kg_ha / 7;

    case 'CADA_15_DIES':
      return params.producte_kg_ha / 15;

    case 'MENSUAL':
      return params.producte_kg_ha / 30;

    default:
      throw new Error(`freq_tipus no soportado: ${params.freq_tipus satisfies never}`);
  }
}

export interface TempsDiesCompoFromPesoParams {
  temps_dies_fao: number;
  pes_dia_kg_ha: number;
  pes_total_kg_ha: number;
}

export interface ComputeCompoBaseInput {
  dosi_tipus: DosiTipus;
  freq_tipus: FreqTipus;

  quantitat_dosi_cataleg: number | null | undefined;
  quantitat_min: number | null | undefined;
  quantitat_max: number | null | undefined;

  densitat_kg_l?: number | null;
  raw_mm?: number | null;
  dist_min_fila_m?: number | null;
  dist_min_col_m?: number | null;

  temps_dies_fao: number;
  n_aplicacions?: number | null;
}

export interface ComputeCompoBaseResult {
  quantitat_dosi: number;
  producte_kg_ha: number;
  producte_kg_ha_dia: number;
}

/**
 * Cálculo base COMPO por producto:
 * 1) resuelve la dosis efectiva,
 * 2) la convierte a kg/ha por aplicación,
 * 3) deriva la cantidad diaria de producto.
 *
 * Esta función NO calcula NPK, peso diario ni temps_dies_compo.
 */
export function computeCompoBase(input: ComputeCompoBaseInput): ComputeCompoBaseResult {
  const quantitat_dosi = selectEffectiveQuantitatDosi({
    quantitat_dosi_cataleg: input.quantitat_dosi_cataleg,
    quantitat_min: input.quantitat_min,
    quantitat_max: input.quantitat_max,
  });

  if (quantitat_dosi == null) {
    throw new Error('No se puede calcular COMPO: falta quantitat_dosi (catálogo/min/max)');
  }

  const producte_kg_ha = convertDoseToKgHaPerApplication({
    dosi_tipus: input.dosi_tipus,
    quantitat_dosi,
    densitat_kg_l: input.densitat_kg_l,
    raw_mm: input.raw_mm,
    dist_min_fila_m: input.dist_min_fila_m,
    dist_min_col_m: input.dist_min_col_m,
  });

  const producte_kg_ha_dia = computeProductKgHaDay({
    freq_tipus: input.freq_tipus,
    producte_kg_ha,
    temps_dies_fao: input.temps_dies_fao,
    n_aplicacions: input.n_aplicacions,
  });

  return {
    quantitat_dosi: quantitat_dosi,
    producte_kg_ha,
    producte_kg_ha_dia,
  };
}

export interface NAplicacionsByFreqParams {
  freq_tipus: FreqTipus;
  temps_dies_fao: number;
  n_aplicacions_cataleg?: number | null;
  n_aplicacions_min?: number | null;
  n_aplicacions_max?: number | null;
  raw_mm?: number | null;
  etc_mm?: number | null;
}

/**
 * Calcula `n_aplicacions` (entero) según `freq_tipus`.
 *
 * Reglas implementadas según MD:
 * - UNICA: 1
 * - N_APLICACIONS: catálogo -> promedio min/max (half-up) -> min -> max -> null
 * - DIARIA: ceil(temps_dies_fao)
 * - SETMANAL: ceil(temps_dies_fao / 7)
 * - CADA_15_DIES: ceil(temps_dies_fao / 15)
 * - MENSUAL: ceil(temps_dies_fao / 30)
 * - CONTINUA_DURANT_FASE: ceil(temps_dies_fao / (raw_mm / etc_mm))
 */
export function computeNAplicacionsByFreqTipus(params: NAplicacionsByFreqParams): number | null {
  if (!Number.isFinite(params.temps_dies_fao) || params.temps_dies_fao <= 0) {
    throw new Error('temps_dies_fao debe ser > 0');
  }

  switch (params.freq_tipus) {
    case 'UNICA':
      return 1;

    case 'N_APLICACIONS': {
      if (params.n_aplicacions_cataleg != null) return Math.max(1, Math.trunc(params.n_aplicacions_cataleg));
      if (params.n_aplicacions_min != null && params.n_aplicacions_max != null) {
        return Math.max(1, roundHalfUp((params.n_aplicacions_min + params.n_aplicacions_max) / 2));
      }
      if (params.n_aplicacions_min != null) return Math.max(1, Math.trunc(params.n_aplicacions_min));
      if (params.n_aplicacions_max != null) return Math.max(1, Math.trunc(params.n_aplicacions_max));
      return null;
    }

    case 'DIARIA':
      return ceilAtLeastOne(params.temps_dies_fao);

    case 'SETMANAL':
      return ceilAtLeastOne(params.temps_dies_fao / 7);

    case 'CADA_15_DIES':
      return ceilAtLeastOne(params.temps_dies_fao / 15);

    case 'MENSUAL':
      return ceilAtLeastOne(params.temps_dies_fao / 30);

    default:
      throw new Error(`freq_tipus no soportado: ${params.freq_tipus}`);
  }
}

export interface TempsDiesCompoFromBbchParams {
  temps_dies_fao: number;
  inici_bbch: number;
  fi_bbch: number;
  total_bbch_units_fase: number;
}