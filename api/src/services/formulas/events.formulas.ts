import type { DosiTipus, FreqTipus } from './compo-phase.formulas';

export const RegistreEsdevenimentTipus = {
  IRRIGACIO_APLICADA: 'IRRIGACIO_APLICADA',
  FERTIRRIGACIO_APLICADA: 'FERTIRRIGACIO_APLICADA',
} as const;

export type RegistreEsdevenimentTipus =
  (typeof RegistreEsdevenimentTipus)[keyof typeof RegistreEsdevenimentTipus];

export interface PlannedFertilizerApplication {
  /** Día absoluto de simulación en el que toca esta aplicación fija. */
  diaSimulacio: number;

  /** Contexto de persistencia / trazabilidad. */
  faseExecucioId: string;
  producteExecucioId: string;
  faseProducteId: string;
  faseProducteNom: string;
  catalegFaseProducteId: string;
  producteId: string;
  producteNom: string | null;
  compoUrl: string | null;
  phaseName: string;

  /** Configuración agronómica. */
  freqTipus: FreqTipus;
  dosiTipus: DosiTipus;
  quantitatDosi: number;
  producteKgHa: number | null;
  densitatKgL: number | null;

  /** Duración efectiva del componente dentro de la fase. */
  tempsDiesCompo: number;

  /** Número objetivo de aplicaciones, si aplica. */
  nAplicacions: number | null;

  /** Estado actual del producto en ejecución. En bootstrap será 0/null. */
  aplicacionsFetesActuals: number;
  ultimaAplicacioActual: number | null;
}

export interface ContinuousFertigationRule {
  /** Ventana activa del componente. */
  diaIniciSimulacio: number;
  tempsDiesCompo: number;

  /** Número objetivo de aplicaciones, si aplica. En continua normalmente será null. */
  nAplicacions: number | null;

  /** Contexto de persistencia / trazabilidad. */
  faseExecucioId: string;
  producteExecucioId: string;
  faseProducteId: string;
  faseProducteNom: string;
  compoUrl: string | null;
  catalegFaseProducteId: string;
  producteId: string;
  producteNom: string | null;
  phaseName: string;

  /** Configuración agronómica. */
  freqTipus: FreqTipus;
  dosiTipus: DosiTipus;
  quantitatDosi: number;
  producteKgHa: number | null;
  densitatKgL: number | null;

  /** Estado actual del producto en ejecución. En bootstrap será 0/null. */
  aplicacionsFetesActuals: number;
  ultimaAplicacioActual: number | null;
}

export interface ExecutedFertilizerApplication {
  faseExecucioId: string;
  producteExecucioId: string;
  catalegFaseProducteId: string;
  producteId: string;
  producteNom: string | null;
  phaseName: string;

  freqTipus: FreqTipus;
  dosiTipus: DosiTipus;

  diaSimulacio: number;
  quantitatDosiKgHa: number | null;
  isContinuous: boolean;

  newAplicacionsFetes: number;
  newUltimaAplicacio: number;
}

export interface DailyDistributionDecision {
  irrigationTriggered: boolean;
  irrigationDepthMm: number | null;
  fixedApplicationsToday: PlannedFertilizerApplication[];
  executedFertilizerApplications: ExecutedFertilizerApplication[];
}

export function getComponentEndDayInclusive(
  diaIniciSimulacio: number,
  tempsDiesCompo: number,
): number {
  const duration = Math.max(1, Math.ceil(tempsDiesCompo));
  return diaIniciSimulacio + duration - 1;
}

export function isWithinComponentWindow(
  diaActualSimulacio: number,
  diaIniciSimulacio: number,
  tempsDiesCompo: number,
): boolean {
  const diaFi = getComponentEndDayInclusive(diaIniciSimulacio, tempsDiesCompo);
  return diaActualSimulacio >= diaIniciSimulacio && diaActualSimulacio <= diaFi;
}

/**
 * Devuelve los días objetivo de N_APLICACIONS repartidos dentro de la ventana.
 * La primera aplicación cae en el inicio del componente.
 */
export function getNAplicacionsTargetDays(params: {
  diaIniciSimulacio: number;
  tempsDiesCompo: number;
  nAplicacions: number;
}): number[] {
  const { diaIniciSimulacio, tempsDiesCompo, nAplicacions } = params;

  if (nAplicacions <= 0) return [];

  const duration = Math.max(1, Math.ceil(tempsDiesCompo));
  const lastDay = getComponentEndDayInclusive(diaIniciSimulacio, duration);

  if (nAplicacions === 1) {
    return [diaIniciSimulacio];
  }

  const spacing = duration / nAplicacions;
  const targets = new Set<number>();

  for (let idx = 0; idx < nAplicacions; idx += 1) {
    const rawTarget = diaIniciSimulacio + idx * spacing;
    const plannedDay = Math.min(lastDay, Math.max(diaIniciSimulacio, Math.floor(rawTarget)));
    targets.add(plannedDay);
  }

  return [...targets].sort((a, b) => a - b);
}

export function buildFixedFertilizerPlanForProduct(params: {
  faseExecucioId: string;
  producteExecucioId: string;
  faseProducteId: string;
  faseProducteNom: string;
  compoUrl: string | null;
  catalegFaseProducteId: string;
  producteId: string;
  producteNom: string | null;
  phaseName: string;
  freqTipus: FreqTipus;
  dosiTipus: DosiTipus;
  quantitatDosi: number;
  producteKgHa: number | null;
  densitatKgL: number | null;
  diaIniciSimulacio: number;
  tempsDiesCompo: number;
  nAplicacions: number | null;
  aplicacionsFetesActuals?: number;
  ultimaAplicacioActual?: number | null;
}): PlannedFertilizerApplication[] {
  const {
    faseExecucioId,
    producteExecucioId,
    faseProducteId,
    faseProducteNom,
    catalegFaseProducteId,
    producteId,
    producteNom,
    compoUrl,
    phaseName,
    freqTipus,
    dosiTipus,
    quantitatDosi,
    producteKgHa,
    densitatKgL,
    diaIniciSimulacio,
    tempsDiesCompo,
    nAplicacions,
    aplicacionsFetesActuals = 0,
    ultimaAplicacioActual = null,
  } = params;

  if (freqTipus === 'CONTINUA_DURANT_FASE') {
    return [];
  }

  const endDay = getComponentEndDayInclusive(diaIniciSimulacio, tempsDiesCompo);

  const build = (day: number): PlannedFertilizerApplication => ({
    diaSimulacio: day,
    faseExecucioId,
    faseProducteId,
    faseProducteNom,
    producteExecucioId,
    catalegFaseProducteId,
    producteId,
    producteNom,
    compoUrl,
    phaseName,
    freqTipus,
    dosiTipus,
    quantitatDosi,
    producteKgHa,
    densitatKgL,
    tempsDiesCompo,
    nAplicacions: nAplicacions ?? null,
    aplicacionsFetesActuals,
    ultimaAplicacioActual,
  });

  switch (freqTipus) {
    case 'UNICA':
      return [build(diaIniciSimulacio)];

    case 'N_APLICACIONS':
      return getNAplicacionsTargetDays({
        diaIniciSimulacio,
        tempsDiesCompo,
        nAplicacions: nAplicacions ?? 0,
      }).map(build);

    case 'DIARIA': {
      const out: PlannedFertilizerApplication[] = [];
      for (let day = diaIniciSimulacio; day <= endDay; day += 1) {
        out.push(build(day));
      }
      return out;
    }

    case 'SETMANAL': {
      const out: PlannedFertilizerApplication[] = [];
      for (let day = diaIniciSimulacio; day <= endDay; day += 7) {
        out.push(build(day));
      }
      return out;
    }

    case 'CADA_15_DIES': {
      const out: PlannedFertilizerApplication[] = [];
      for (let day = diaIniciSimulacio; day <= endDay; day += 15) {
        out.push(build(day));
      }
      return out;
    }

    case 'MENSUAL': {
      const out: PlannedFertilizerApplication[] = [];
      for (let day = diaIniciSimulacio; day <= endDay; day += 30) {
        out.push(build(day));
      }
      return out;
    }

    default:
      return [];
  }
}

function isValidPositive(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}

function normalizePerLiterDose(params: {
  dosiTipus: DosiTipus;
  quantitatDosi: number;
}): number {
  const { dosiTipus, quantitatDosi } = params;

  if (dosiTipus === 'ML_100L' || dosiTipus === 'KG_100L') {
    return quantitatDosi / 100;
  }

  if (dosiTipus === 'ML_1000L' || dosiTipus === 'KG_1000L' || dosiTipus === 'L_1000L') {
    return quantitatDosi / 1000;
  }

  return quantitatDosi;
}

function computeMlDoseKgHa(params: {
  dosiTipus: DosiTipus;
  quantitatDosi: number;
  laminaMm: number;
  densitatKgL: number | null | undefined;
}): number | null {
  const { dosiTipus, quantitatDosi, laminaMm, densitatKgL } = params;
  if (!isValidPositive(densitatKgL)) return null;

  const qMlL = normalizePerLiterDose({ dosiTipus, quantitatDosi });
  return ((qMlL * laminaMm * 10000) / 1000) * densitatKgL;
}

function computeKgDoseKgHa(params: {
  dosiTipus: DosiTipus;
  quantitatDosi: number;
  laminaMm: number;
}): number {
  const { dosiTipus, quantitatDosi, laminaMm } = params;
  const qKgL = normalizePerLiterDose({ dosiTipus, quantitatDosi });
  return qKgL * laminaMm * 10000;
}

function computeLiterDoseKgHa(params: {
  quantitatDosi: number;
  laminaMm: number;
  densitatKgL: number | null | undefined;
}): number | null {
  const { quantitatDosi, laminaMm, densitatKgL } = params;
  if (!isValidPositive(densitatKgL)) return null;

  const qLL = quantitatDosi / 1000;
  return qLL * laminaMm * 10000 * densitatKgL;
}

export function computeFertilizerDoseKgHa(input: {
  freqTipus: FreqTipus;
  dosiTipus: DosiTipus;
  quantitatDosi: number;
  densitatKgL?: number | null;
  laminaMm?: number | null;
  producteKgHa?: number | null;
}): number | null {
  const { dosiTipus, quantitatDosi, densitatKgL, laminaMm, producteKgHa } = input;

  const isWaterDependentDose =
    dosiTipus === 'ML_L' ||
    dosiTipus === 'ML_100L' ||
    dosiTipus === 'ML_1000L' ||
    dosiTipus === 'KG_L' ||
    dosiTipus === 'KG_100L' ||
    dosiTipus === 'KG_1000L' ||
    dosiTipus === 'L_1000L';

  if (isWaterDependentDose) {
    if (!isValidPositive(laminaMm)) return null;

    if (dosiTipus === 'ML_L' || dosiTipus === 'ML_100L' || dosiTipus === 'ML_1000L') {
      return computeMlDoseKgHa({ dosiTipus, quantitatDosi, laminaMm, densitatKgL });
    }

    if (dosiTipus === 'KG_L' || dosiTipus === 'KG_100L' || dosiTipus === 'KG_1000L') {
      return computeKgDoseKgHa({ dosiTipus, quantitatDosi, laminaMm });
    }

    if (dosiTipus === 'L_1000L') {
      return computeLiterDoseKgHa({ quantitatDosi, laminaMm, densitatKgL });
    }

    return null;
  }

  if (dosiTipus === 'KG_HA') {
    return quantitatDosi;
  }

  return producteKgHa ?? null;
}

/**
 * Evalúa el día completo en una sola llamada:
 * - 1 decisión de riego
 * - N aplicaciones fijas del día
 * - N aplicaciones continuas si hubo riego y el componente está activo
 */
export function evaluateDailyDistribution(params: {
  diaActualSimulacio: number;
  laminaMm: number | null;
  plannedFixedApplications: PlannedFertilizerApplication[];
  continuousRules: ContinuousFertigationRule[];
}): DailyDistributionDecision {
  const {
    diaActualSimulacio,
    laminaMm,
    plannedFixedApplications,
    continuousRules,
  } = params;

  const hasPositiveLamina =
    laminaMm != null && Number.isFinite(laminaMm) && laminaMm > 0;

  const irrigationTriggered = hasPositiveLamina;

  const fixedApplicationsToday = plannedFixedApplications.filter(
    (row) => row.diaSimulacio === diaActualSimulacio,
  );

  const executedFertilizerApplications: ExecutedFertilizerApplication[] = [];

  for (const row of fixedApplicationsToday) {
    executedFertilizerApplications.push({
      faseExecucioId: row.faseExecucioId,
      producteExecucioId: row.producteExecucioId,
      catalegFaseProducteId: row.catalegFaseProducteId,
      producteId: row.producteId,
      producteNom: row.producteNom,
      phaseName: row.phaseName,
      freqTipus: row.freqTipus,
      dosiTipus: row.dosiTipus,
      diaSimulacio: diaActualSimulacio,
      quantitatDosiKgHa: computeFertilizerDoseKgHa({
        freqTipus: row.freqTipus,
        dosiTipus: row.dosiTipus,
        quantitatDosi: row.quantitatDosi,
        densitatKgL: row.densitatKgL,
        laminaMm,
        producteKgHa: row.producteKgHa,
      }),
      isContinuous: false,
      newAplicacionsFetes: row.aplicacionsFetesActuals + 1,
      newUltimaAplicacio: diaActualSimulacio,
    });
  }

  if (irrigationTriggered) {
    for (const rule of continuousRules) {
      if (
        !isWithinComponentWindow(
          diaActualSimulacio,
          rule.diaIniciSimulacio,
          rule.tempsDiesCompo,
        )
      ) {
        continue;
      }

      executedFertilizerApplications.push({
        faseExecucioId: rule.faseExecucioId,
        producteExecucioId: rule.producteExecucioId,
        catalegFaseProducteId: rule.catalegFaseProducteId,
        producteId: rule.producteId,
        producteNom: rule.producteNom,
        phaseName: rule.phaseName,
        freqTipus: rule.freqTipus,
        dosiTipus: rule.dosiTipus,
        diaSimulacio: diaActualSimulacio,
        quantitatDosiKgHa: computeFertilizerDoseKgHa({
          freqTipus: rule.freqTipus,
          dosiTipus: rule.dosiTipus,
          quantitatDosi: rule.quantitatDosi,
          densitatKgL: rule.densitatKgL,
          laminaMm,
          producteKgHa: rule.producteKgHa,
        }),
        isContinuous: true,
        newAplicacionsFetes: rule.aplicacionsFetesActuals + 1,
        newUltimaAplicacio: diaActualSimulacio,
      });
    }
  }

  return {
    irrigationTriggered,
    irrigationDepthMm: laminaMm,
    fixedApplicationsToday,
    executedFertilizerApplications,
  };
}
