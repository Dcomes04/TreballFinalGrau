import { randomUUID } from 'node:crypto';
import { ENV } from '../../config/env';
import { loadAll } from '../../datasources/repository';
import { upsertRow } from '../../datasources/write';
import {
  fetchDayClimate,
} from '../../integrations/openMeteo.client';
import { 
  buildExecutionAlarmService, 
  ExecutionAlarmError,
  type FailExecutionWithAlarm,
} from '../alarms.service';
import {
  computeRoAndPotentialIrrigation,
  computeDrMmDay1,
  computeDrMmDayN,
  computeSoilTemperatureC,
  computeSoilHumidityPct,
  computeNitrogenSoilPpm,
  computePhosphorusSoilPpm,
  computePotassiumSoilPpm,
  computeTdsAndEc,
  computeSoilPh,
  computeEtcMm,
  computeKcDeterministic,
  computePDepletionFraction,
  computeRawMm,
  computeZrDeterministic,
} from '../formulas/soil.formulas';
import {
  type DosiTipus,
  type FreqTipus,
} from '../formulas/compo-phase.formulas';
import {
  evaluateDailySuitability,
  type CropThresholds,
} from './executions.service.crop-suitability';
import {
  RegistreEsdevenimentTipus,
  buildFixedFertilizerPlanForProduct,
  evaluateDailyDistribution,
  type ContinuousFertigationRule,
  type PlannedFertilizerApplication,
} from '../formulas/events.formulas';
import { computeChargeEquivalentsForApplication } from '../formulas/charge-equivalents.formulas';
import { 
  createExecution,
  type CreateExecutionInput,
} from './executions.service.create';
import {
  addDays,
  toISO,
  computeDailyFertilizerNpkAndIonMass,
  normalizeNutrientComponent,
  normalizeDateOnlyIso,
  getDayIndexFromD0,
  DEFAULT_K_PH,
} from './executions.service.utils';
import {
  getOrCreateClimateForDay,
} from './executions.service.climate';

type DailyProductExecutionState = {
  producte_execucio_id: string;
  fase_producte_id: string;
  fase_producte_nom: string;
  fase_execucio_id: string;
  cataleg_fase_producte_id: string;
  producte_id: string;
  producte_nom: string | null;
  phase_name: string;
  freq_tipus: FreqTipus;
  dosi_tipus: DosiTipus;
  quantitat_dosi: number;
  producte_kg_ha: number | null;
  densitat_kg_l: number | null;
  temps_dies_compo: number;
  data_inici_compo: string;
  n_aplicacions: number | null;
  aplicacions_fetes: number;
  ultima_aplicacio: string | null;
};

type ActivePhaseExecutionState = {
  fase_execucio_id: string;
  fase_id: string;
  nom_fao: string;
  ordre_fao: number;
  data_inici_fao: string;
  temps_dies_fao: number;
  dia_fase: number;
  fase_catalog: Awaited<ReturnType<typeof loadAll>>['fasesFenologiques'][number];
  productes: DailyProductExecutionState[];
};

type AnnualSurfaceThermalStatsRuntime = {
  temperatura_mitjana_superficial_anual_c: number;
  amplitud_termica_superficial_anual_c: number;
  dies_valids?: number | null;
};

type DailyRuntimeContext = {
  db: Awaited<ReturnType<typeof loadAll>>;
  exec: Awaited<ReturnType<typeof loadAll>>['execucions'][number];
  cultiu: Awaited<ReturnType<typeof loadAll>>['cultius'][number];
  ubicacio: Awaited<ReturnType<typeof loadAll>>['ubicacions'][number];
  ubicacioId: string;
  solId: string;
  existingSol: Awaited<ReturnType<typeof loadAll>>['sols'][number];
  annualSurfaceThermalStats: AnnualSurfaceThermalStatsRuntime;
  D0: Date;
  targetDate: Date;
  dayIndex: number;
  activePhase: ActivePhaseExecutionState;
  soilPrev: RuntimeSoilState;
  climate: Awaited<ReturnType<typeof fetchDayClimate>>;
};

type RuntimeSoilState = {
  sol_simulacio_id: string;
  ph: number;
  humitat_sol_pct: number;
  etc_mm: number;
  raw_mm: number;
  dr_mm: number;
  i_mm: number;
  temperatura_sol_c: number;
  tds_ppm: number;
  ec_ms_cm: number;
  n_sol_ppm: number;
  p_sol_ppm: number;
  k_sol_ppm: number;
  inici: string;
  final: string;
};

type DailySimulationResult = {
  day0Suitability: { status: 'NO_APTO' | 'APTO' | 'OPTIMO'; reasons: string[] } | null;
  day0SoilAlarm: string | null;
  alarmRaised: boolean;
  daySummary: {
    dia_total_simulacio: number;
    date_iso: string;
    fase_nom: string;
    dia_fase: number;
    irrigation_lamina_mm: number;
    fertilizer_events: number;
  };
};

// Persiste un evento de riego o fertilización aplicado, y devuelve su ID generado
export async function persistRegistreEvent(params: { execucioId: string; diaActualSimulacio: number; D0: Date; faseExecucioId: string | null; tipus: RegistreEsdevenimentTipus }): Promise<string> {
  const { execucioId, diaActualSimulacio, D0, faseExecucioId, tipus } = params;
  const esdevenimentId = randomUUID();
  const eventDate = addDays(D0, diaActualSimulacio);

  await upsertRow(ENV.PATH, 'registre_esdeveniment', {
    pkColumns: 'esdeveniment_id',
    data: {
      esdeveniment_id: esdevenimentId,
      execucio_id: execucioId,
      fase_execucio_id: faseExecucioId,
      donat_a: toISO(eventDate),
      tipus,
      dia_total_simulacio: diaActualSimulacio,
    },
  });

  return esdevenimentId;
}

// persiste los eventos de riego y fertilización aplicados en el día, y devuelve las cargas equivalentes totales para el día
export async function persistDistributionEventsForDay(params: {
  db: Awaited<ReturnType<typeof loadAll>>;
  execucioId: string;
  diaActualSimulacio: number;
  D0: Date;
  faseExecucioIdCurrent: string;
  irrigationTriggered: boolean;
  irrigationDepthMm: number | null;
  fertilizerExecutions: Array<{
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
  }>;
}): Promise<{
  equivalent_carrega_anio_dia: number;
  equivalent_carrega_catio_dia: number;
}> {
  const { db, execucioId, diaActualSimulacio, D0, faseExecucioIdCurrent, irrigationTriggered, irrigationDepthMm, fertilizerExecutions } = params;

  // Si se ha activado riego, persistir evento de riego aplicado y su detalle de lámina aplicada
  if (irrigationTriggered && irrigationDepthMm != null && irrigationDepthMm > 0) {
    const irrigationEventId = await persistRegistreEvent({
      execucioId,
      diaActualSimulacio,
      D0,
      faseExecucioId: faseExecucioIdCurrent,
      tipus: RegistreEsdevenimentTipus.IRRIGACIO_APLICADA,
    });

    await upsertRow(ENV.PATH, 'aplicacio_aigua', {
      pkColumns: 'esdeveniment_id',
      data: {
        esdeveniment_id: irrigationEventId,
        lamina_mm: irrigationDepthMm,
      },
    });

  }

  let equivalentCarregaAnioDia = 0;
  let equivalentCarregaCatioDia = 0;

  // Para cada aplicación de fertilizante aplicada, persistir evento de fertilización aplicado y su detalle de producto y dosis, y acumular sus cargas equivalentes para el día
  for (const item of fertilizerExecutions) {
    if (item.quantitatDosiKgHa == null || item.quantitatDosiKgHa <= 0) {
      continue;
    }

    // Persistir evento de fertilización aplicado y su detalle de producto y dosis
    const fertEventId = await persistRegistreEvent({
      execucioId,
      diaActualSimulacio,
      D0,
      faseExecucioId: item.faseExecucioId,
      tipus: RegistreEsdevenimentTipus.FERTIRRIGACIO_APLICADA,
    });

    // Calcular cargas equivalentes de la aplicación para el día y acumularlas en el total diario
    const chargeEq = computeChargeEquivalentsForApplication({
      producte_id: item.producteId,
      quantitat_dosi_kg_ha: item.quantitatDosiKgHa,
      db: {
        producteNutrients: db.producteNutrients,
        nutrients: db.nutrients,
        nutrientIos: db.nutrientIos,
        ios: db.ios,
      },
    });

    equivalentCarregaAnioDia += chargeEq.equivalent_carrega_anio;
    equivalentCarregaCatioDia += chargeEq.equivalent_carrega_catio;

    await upsertRow(ENV.PATH, 'aplicacio_npk', {
      pkColumns: 'esdeveniment_id',
      data: {
        esdeveniment_id: fertEventId,
        producte_id: item.producteId,
        producte_execucio_id: item.producteExecucioId,
        cataleg_fase_producte_id: item.catalegFaseProducteId,
        quantitat_dosi_kg_ha: item.quantitatDosiKgHa,
        equivalent_carrega_anio: chargeEq.equivalent_carrega_anio,
        equivalent_carrega_catio: chargeEq.equivalent_carrega_catio,
      },
    });

    await upsertRow(ENV.PATH, 'cataleg_fase_producte_execucio', {
      pkColumns: ['cataleg_fase_producte_id', 'producte_execucio_id'],
      data: {
        cataleg_fase_producte_id: item.catalegFaseProducteId,
        producte_execucio_id: item.producteExecucioId,
        aplicacions_fetes: item.newAplicacionsFetes,
        ultima_aplicacio: toISO(addDays(D0, item.newUltimaAplicacio)),
      },
    });
  }
  return {
    equivalent_carrega_anio_dia: equivalentCarregaAnioDia,
    equivalent_carrega_catio_dia: equivalentCarregaCatioDia,
  };
}


export function getSoilSimulationRows(db: Awaited<ReturnType<typeof loadAll>>): any[] {
  return db.solSimulacio ?? [];
}

// Obtiene la fase activa de la ejecución para una fecha y prepara su contexto diario
export function resolveActivePhaseForDate(params: { db: Awaited<ReturnType<typeof loadAll>>; execucioId: string; targetDate: Date }): ActivePhaseExecutionState | null {
  const { db, execucioId, targetDate } = params;
  const phaseExecRows = db.fasesFenologiquesExecucio .filter((row) => row.execucio_id === execucioId) .sort((a, b) => new Date(a.data_inici_fao).getTime() - new Date(b.data_inici_fao).getTime());

  const targetTs = targetDate.getTime();
  
  // Buscar la fase activa para la fecha objetivo
  const active = phaseExecRows.find((row) => {
    const start = new Date(row.data_inici_fao);
    const end = addDays(start, Math.max(1, Math.ceil(row.temps_dies_fao)));
    return targetTs >= start.getTime() && targetTs < end.getTime();
  }) ?? null;
  if (!active) return null;

  // Obtener información de catálogo de la fase activa y preparar contexto de productos para la fase
  const faseCatalog = db.fasesFenologiques.find((row) => row.fase_id === active.fase_id) ?? null;
  if (!faseCatalog) return null;

  const diaFase = Math.floor((targetTs - new Date(active.data_inici_fao).getTime()) / (24 * 60 * 60 * 1000)) + 1;
  const phaseProducts = db.fasesProducteExecucio.filter((row) => row.fase_execucio_id === active.fase_execucio_id);
  
  // Para cada producto de la fase, obtener información de catálogo relacionada para enriquecer el contexto de ejecución
  const catExecRows = db.catalogFasesProducteExecucio ?? [];
  const catRows = db.catalogFasesProducte ?? [];

  // El resultado es una estructura con información de la fase activa y sus productos, enriquecida con datos de catálogo para facilitar cálculos posteriores en la simulación
  const productes: DailyProductExecutionState[] = phaseProducts.map((prodExec) => {
    const catExec = catExecRows.find((row: any) => row.producte_execucio_id === prodExec.producte_execucio_id) ?? null;
    const cat = catExec ? catRows.find((row: any) => row.cataleg_fase_producte_id === catExec.cataleg_fase_producte_id) ?? null : null;
    const producte = cat ? db.catalogProductes.find((row) => row.producte_id === cat.producte_id) ?? null : null;
    const faseProducte = db.fasesProducte.find((row) => row.fase_producte_id === prodExec.fase_producte_id) ?? null;

    return {
      producte_execucio_id: prodExec.producte_execucio_id,
      fase_producte_id: prodExec.fase_producte_id,
      fase_producte_nom: faseProducte?.nom_fase_producte ?? 'Fase de producte',
      fase_execucio_id: prodExec.fase_execucio_id,
      cataleg_fase_producte_id: catExec?.cataleg_fase_producte_id ?? '',
      producte_id: cat?.producte_id ?? '',
      producte_nom: producte?.nom ?? null,
      phase_name: faseCatalog.nom_fao,
      freq_tipus: (cat?.freq_tipus ?? 'UNICA') as FreqTipus,
      dosi_tipus: (cat?.dosi_tipus ?? 'KG_HA') as DosiTipus,
      quantitat_dosi: Number(catExec?.quantitat_dosi ?? 0),
      producte_kg_ha: catExec?.producte_kg_ha ?? null,
      densitat_kg_l: producte?.densitat_kg_l ?? null,
      temps_dies_compo: Number(prodExec.temps_dies_compo ?? 0),
      data_inici_compo: toISO(new Date(prodExec.data_inici_compo)),
      n_aplicacions: typeof catExec?.n_aplicacions === 'number' ? catExec.n_aplicacions : null,
      aplicacions_fetes: Number(catExec?.aplicacions_fetes ?? 0),
      ultima_aplicacio: catExec?.ultima_aplicacio? toISO(new Date(catExec.ultima_aplicacio)) : null
    };
  }).filter((row) => !!row.cataleg_fase_producte_id && !!row.producte_id);

  return {
    fase_execucio_id: active.fase_execucio_id,
    fase_id: active.fase_id,
    nom_fao: faseCatalog.nom_fao,
    ordre_fao: faseCatalog.ordre_fao,
    data_inici_fao: toISO(new Date(active.data_inici_fao)),
    temps_dies_fao: Number(active.temps_dies_fao),
    dia_fase: diaFase,
    fase_catalog: faseCatalog,
    productes,
  };
}

// Normaliza un registro de estado de suelo de la tabla sol_simulacio a una estructura con tipos adecuados para su uso en la simulación
function normalizeRuntimeSoilState(row: any): RuntimeSoilState {
  return {
    sol_simulacio_id: String(row.sol_simulacio_id),
    ph: Number(row.ph),
    humitat_sol_pct: Number(row.humitat_sol_pct),
    etc_mm: Number(row.etc_mm ?? 0),
    raw_mm: Number(row.raw_mm ?? 0),
    dr_mm: Number(row.dr_mm ?? 0),
    i_mm: Number(row.i_mm ?? 0),
    temperatura_sol_c: Number(row.temperatura_sol_c),
    tds_ppm: Number(row.tds_ppm),
    ec_ms_cm: Number(row.ec_ms_cm),
    n_sol_ppm: Number(row.n_sol_ppm),
    p_sol_ppm: Number(row.p_sol_ppm),
    k_sol_ppm: Number(row.k_sol_ppm),
    inici: toISO(new Date(row.inici)),
    final: toISO(new Date(row.final)),
  };
}

// Busca una ubicación persistida por nombre
export function resolveLatestSoilState(params: { db: Awaited<ReturnType<typeof loadAll>>, execucioId: string, targetDate: Date, allowSameDay?: boolean }): RuntimeSoilState {
  const { db, execucioId, targetDate, allowSameDay = false } = params;

  const rows = (db.solSimulacio ?? [])
    .filter((row: any) => row.execucio_id === execucioId)
    .sort((a: any, b: any) => new Date(b.inici).getTime() - new Date(a.inici).getTime());

  const targetTime = targetDate.getTime();

  const prev =
    rows.find((row: any) => {
      const rowTime = new Date(row.inici).getTime();

      return allowSameDay
        ? rowTime <= targetTime
        : rowTime < targetTime;
    }) ?? null;

  if (!prev) {
    throw new Error(
      `No s'ha trobat estat de sòl previ per a execucio_id="${execucioId}" i dia="${targetDate.toISOString()}"`
    );
  }

  return normalizeRuntimeSoilState(prev);
}

// Función para calcular la cantidad total de N, P y K aplicada en un día dado un listado de aplicaciones de fertilizante ejecutadas ese día
export function buildPlannedApplicationsForDay(params: { activePhase: ActivePhaseExecutionState; dayIndex: number; d0: Date }) {
  const { activePhase, dayIndex, d0 } = params;
  const plannedFixedApplications: PlannedFertilizerApplication[] = [];
  const continuousRules: ContinuousFertigationRule[] = [];

  for (const product of activePhase.productes) {
    const diaIniciSimulacio = getDayIndexFromD0(d0, new Date(product.data_inici_compo));
    if (product.freq_tipus === 'CONTINUA_DURANT_FASE') {
      continuousRules.push({
        diaIniciSimulacio,
        tempsDiesCompo: product.temps_dies_compo,
        nAplicacions: product.n_aplicacions,
        faseExecucioId: product.fase_execucio_id,
        producteExecucioId: product.producte_execucio_id,
        faseProducteId: product.fase_producte_id,
        faseProducteNom: product.fase_producte_nom,
        compoUrl: null,
        catalegFaseProducteId: product.cataleg_fase_producte_id,
        producteId: product.producte_id,
        producteNom: product.producte_nom,
        phaseName: product.phase_name,
        freqTipus: product.freq_tipus,
        dosiTipus: product.dosi_tipus,
        quantitatDosi: product.quantitat_dosi,
        producteKgHa: product.producte_kg_ha,
        densitatKgL: product.densitat_kg_l,
        aplicacionsFetesActuals: product.aplicacions_fetes,
        ultimaAplicacioActual: product.ultima_aplicacio ? getDayIndexFromD0(d0, new Date(product.ultima_aplicacio)) : null,
      });
      continue;
    }

    plannedFixedApplications.push(...buildFixedFertilizerPlanForProduct({
      faseExecucioId: product.fase_execucio_id,
      producteExecucioId: product.producte_execucio_id,
      faseProducteId: product.fase_producte_id,
      faseProducteNom: product.fase_producte_nom,
      compoUrl: null,
      catalegFaseProducteId: product.cataleg_fase_producte_id,
      producteId: product.producte_id,
      producteNom: product.producte_nom,
      phaseName: product.phase_name,
      freqTipus: product.freq_tipus,
      dosiTipus: product.dosi_tipus,
      quantitatDosi: product.quantitat_dosi,
      producteKgHa: product.producte_kg_ha,
      densitatKgL: product.densitat_kg_l,
      diaIniciSimulacio,
      tempsDiesCompo: product.temps_dies_compo,
      nAplicacions: product.n_aplicacions,
      aplicacionsFetesActuals: product.aplicacions_fetes,
      ultimaAplicacioActual: product.ultima_aplicacio ? getDayIndexFromD0(d0, new Date(product.ultima_aplicacio)) : null,
    }).filter((row) => row.diaSimulacio === dayIndex));
  }

  return { plannedFixedApplications, continuousRules };
}

// Función para persistir el estado diario de N, P y K aplicado por producto en la fase
export async function persistPhaseProductDailyState(params: {
  db: Awaited<ReturnType<typeof loadAll>>;
  executedFertilizerApplications: Array<{ producteExecucioId: string; producteId: string; quantitatDosiKgHa: number | null }>;
  phaseExecucioId: string;
}) {
  const { db, executedFertilizerApplications, phaseExecucioId } = params;
  const producteTotals = new Map<string, { n: number; p: number; k: number; dose: number }>();

  // Para cada aplicación de fertilizante ejecutada en el día, calcular su contribución de N, P y K aplicada y acumularla en el total por producto
  for (const app of executedFertilizerApplications) {
    const dose = app.quantitatDosiKgHa ?? 0;
    if (!Number.isFinite(dose) || dose <= 0) continue;
    let n = 0;
    let p = 0;
    let k = 0;
    
    // Para calcular la contribución de N, P y K de la aplicación, se buscan los nutrientes asociados al producto aplicado 
    // y se calcula la masa aplicada de cada nutriente según el porcentaje que aporta el nutriente en el producto
    for (const pn of db.producteNutrients.filter((row) => row.producte_id === app.producteId)) {
      const nutrient = db.nutrients.find((row) => row.nutrient_id === pn.nutrient_id) ?? null;
      const comp = normalizeNutrientComponent(nutrient?.component_principal);
      const mass = dose * pn.pct;
      if (comp === 'N') n += mass;
      if (comp === 'P') p += mass;
      if (comp === 'K') k += mass;
    }
    const prev = producteTotals.get(app.producteExecucioId) ?? { n: 0, p: 0, k: 0, dose: 0 };
    prev.n += n;
    prev.p += p;
    prev.k += k;
    prev.dose += dose;
    producteTotals.set(app.producteExecucioId, prev);
  }

  // Para cada producto con aplicaciones ejecutadas en el día, persistir su estado diario de N, P y K aplicado en la fase, acumulando con el estado previo si existiera
  for (const [producteExecucioId, total] of producteTotals.entries()) {
    const row = db.fasesProducteExecucio.find((item) => item.producte_execucio_id === producteExecucioId) as any;
    const nextN = Number(row?.n_fase_kg_ha_compo ?? 0) + total.n;
    const nextP = Number(row?.p_fase_kg_ha_compo ?? 0) + total.p;
    const nextK = Number(row?.k_fase_kg_ha_compo ?? 0) + total.k;
    const pesDia = total.n + total.p + total.k;

    await upsertRow(ENV.PATH, 'fase_producte_execucio', {
      pkColumns: 'producte_execucio_id',
      data: {
        producte_execucio_id: producteExecucioId,
        n_dia_kg_ha_compo: total.n,
        p_dia_kg_ha_compo: total.p,
        k_dia_kg_ha_compo: total.k,
        n_fase_kg_ha_compo: nextN,
        p_fase_kg_ha_compo: nextP,
        k_fase_kg_ha_compo: nextK,
        pes_dia_kg_ha: pesDia,
      },
    });
  }
}

// Construye el contexto de ejecución para un día específico, obteniendo y preparando toda la información necesaria de la base de datos para realizar los cálculos de simulación del día
export async function buildDailyRuntimeContext(params: { 
  execucioId: string; 
  targetDate: Date; 
  dayIndex: number, 
  db: Awaited<ReturnType<typeof loadAll>>;
  exec: Awaited<ReturnType<typeof loadAll>>['execucions'][number];
  activePhase: ActivePhaseExecutionState;
}) : Promise<DailyRuntimeContext> {
  const { execucioId, targetDate, dayIndex, db, exec, activePhase } = params;

  const cultiuId = exec.cultiu_id;
  if (!cultiuId) throw new Error(`No s'ha trobat cultiu_id per a execucio "${exec.execucio_id}"`);
  const cultiu = db.cultius.find((row) => row.cultiu_id === cultiuId) ?? null;
  if (!cultiu) throw new Error(`No s'ha trobat cultiu_id "${cultiuId}"`);

  const solId = exec.sol_id;
  if (!solId) throw new Error(`No s'ha trobat sol_id per a execucio_id "${execucioId}"`);
  
  const existingSol = db.sols.find((row) => row.sol_id === solId) ?? null;
  if (!existingSol) throw new Error(`No s'ha trobat sol_id "${solId}"`);

  const ubicacio = db.ubicacions.find((row) => row.ubicacio_id === existingSol.ubicacio_id) ?? null;
  if (!ubicacio) throw new Error(`No s'ha trobat ubicacio_id "${existingSol.ubicacio_id}"`);
  
  const D0 = new Date(exec.temps_simulat_inici);

  // Obtener el clima para la fecha objetivo y los datos del suelo del último registro de esta ejecución
  const climate = await getOrCreateClimateForDay({ db, execucioId, ubicacioId: ubicacio.ubicacio_id, ubicacio, targetDate });
  const soilPrev = resolveLatestSoilState({ db, execucioId, targetDate, allowSameDay: dayIndex === 0 });

  const annualSurfaceThermalStats: AnnualSurfaceThermalStatsRuntime = {
    temperatura_mitjana_superficial_anual_c: Number(exec.temperatura_mitjana_superficial_anual_c),
    amplitud_termica_superficial_anual_c: Number(exec.amplitud_termica_superficial_anual_c),
    dies_valids: null,
  };

  if (
    !Number.isFinite(annualSurfaceThermalStats.temperatura_mitjana_superficial_anual_c) ||
    !Number.isFinite(annualSurfaceThermalStats.amplitud_termica_superficial_anual_c)
  ) {
    throw new Error(
      `Falten estadístics tèrmics anuals en execucio_simulada per a execucio_id="${execucioId}".`,
    );
  }

  return {
    db,
    exec,
    cultiu,
    ubicacio,
    ubicacioId: ubicacio.ubicacio_id,
    solId,
    existingSol,
    annualSurfaceThermalStats,
    D0,
    targetDate,
    dayIndex,
    activePhase,
    soilPrev,
    climate,
  };
}

// Realiza el cálculo de la simulación para un día específico y persiste los resultados
export async function computeAndPersistSimulationDay(params: { 
  execucioId: string; 
  targetDate: Date; 
  dayIndex: number; 
  failExecutionWithAlarm: FailExecutionWithAlarm;
  db: Awaited<ReturnType<typeof loadAll>>;
  exec: Awaited<ReturnType<typeof loadAll>>['execucions'][number];
  activePhase: ActivePhaseExecutionState;
}): Promise<DailySimulationResult> {
  const { execucioId, targetDate, dayIndex, failExecutionWithAlarm } = params;
  
  // Construir el contexto de ejecución para el día objetivo
  const runtime = await buildDailyRuntimeContext({ execucioId, targetDate, dayIndex, db: params.db, exec: params.exec, activePhase: params.activePhase });

  const { db, cultiu, activePhase, soilPrev, targetDate: targetDay, D0, climate, annualSurfaceThermalStats, existingSol, solId } = runtime;

  const cropThresholds: CropThresholds = {
    temp_opt_min_c: cultiu.temp_opt_min_c,
    temp_opt_max_c: cultiu.temp_opt_max_c,
    temp_abs_min_c: cultiu.temp_abs_min_c,
    temp_abs_max_c: cultiu.temp_abs_max_c,
    ph_opt_min: cultiu.ph_opt_min,
    ph_opt_max: cultiu.ph_opt_max,
    ph_abs_min: cultiu.ph_abs_min,
    ph_abs_max: cultiu.ph_abs_max,
    ec_abs_max_ms_cm: cultiu.ec_abs_max_ms_cm,
  };

  // Evaluar la aptitud diaria para la fase activa y el día objetivo, utilizando los datos climáticos y del suelo, y los umbrales del cultivo
  const suitability = evaluateDailySuitability({ temperatura_2m_c: climate.temperatura_2m_c, ph: soilPrev.ph, ec_ms_cm: soilPrev.ec_ms_cm, thresholds: cropThresholds });

  if (suitability.status === 'NO_APTO') {
    await failExecutionWithAlarm(
      `Aptitud diària NO APTA a la fase ${activePhase.nom_fao} (dia ${dayIndex}). ${suitability.reasons.join(' | ')}`,
      {
        fase_id: activePhase.fase_id,
        fase_nom: activePhase.nom_fao,
        data: targetDay.toISOString().slice(0, 10),
        temperatura_2m_c: climate.temperatura_2m_c,
        ph: soilPrev.ph,
        ec_ms_cm: soilPrev.ec_ms_cm,
        thresholds: cropThresholds,
        reasons: suitability.reasons,
      },
      {
        fase_id: activePhase.fase_id,
        fase_nom: activePhase.nom_fao,
        dia_total_simulacio: dayIndex,
        dia_fase: activePhase.dia_fase,
      },
    );
    return {
      day0Suitability: dayIndex === 0 ? suitability : null,
      day0SoilAlarm: suitability.reasons.join(' | '),
      alarmRaised: true,
      daySummary: {
        dia_total_simulacio: dayIndex,
        date_iso: normalizeDateOnlyIso(targetDay),
        fase_nom: activePhase.nom_fao,
        dia_fase: activePhase.dia_fase,
        irrigation_lamina_mm: 0,
        fertilizer_events: 0,
      },
    };
  }

  // Si es el día 0, no se realizan cálculos de simulación, solo se evalúa la aptitud y se retorna el resultado
  if (dayIndex === 0) {
    return {
      day0Suitability: suitability,
      day0SoilAlarm: null,
      alarmRaised: false,
      daySummary: {
        dia_total_simulacio: 0,
        date_iso: normalizeDateOnlyIso(targetDay),
        fase_nom: activePhase.nom_fao,
        dia_fase: activePhase.dia_fase,
        irrigation_lamina_mm: Number(soilPrev.i_mm ?? 0),
        fertilizer_events: 0,
      },
    };
  }

  // Para días posteriores al día 0, se realizan los cálculos de simulación utilizando las fórmulas correspondientes, y se persisten los resultados en la base de datos
  const kc = computeKcDeterministic({ 
    kc_inicial: activePhase.fase_catalog.kc_inicial, 
    kc_final: activePhase.fase_catalog.kc_final, 
    dia_fase: activePhase.dia_fase, 
    temps_dies_fao: activePhase.temps_dies_fao,
   });
  
  const etcMm = computeEtcMm({ kc, et0_mm: climate.et0_mm });
  
  const pValue = computePDepletionFraction({ p_taula_fao: cultiu.p_taula_fao, etc_mm: etcMm });
  
  const zrM = computeZrDeterministic({ 
    zr_inicial_m: activePhase.fase_catalog.zr_inicial_m, 
    zr_final_m: activePhase.fase_catalog.zr_final_m, 
    dia_fase: activePhase.dia_fase, 
    temps_dies_fao: activePhase.temps_dies_fao, });

  await upsertRow(ENV.PATH, 'fase_fenologica_execucio', {
    pkColumns: ['execucio_id', 'fase_id'],
    data: {
      execucio_id: execucioId,
      fase_id: activePhase.fase_id,
      kc: kc,
      zr_m: zrM,
    },
  });

  if (existingSol.fc == null || existingSol.wp == null) {
    throw new Error(`Falten dades de camp de capacitat i punt de marcescència en sol_id="${solId}". Són necessàries per al càlcul de la simulació diària.`);
  }
  
  const rawCalc = computeRawMm({ fc: existingSol.fc, wp: existingSol.wp, zr_m: zrM, p: pValue }); 
  
  const waterPreBalance = computeRoAndPotentialIrrigation({ dr_mm: soilPrev.dr_mm, raw_mm: rawCalc.raw_mm, precipitacions_mm: climate.precipitacions_mm, etc_mm: etcMm });
    
  // Mirra si se tiene que regar hoy (raw_mm > dr_mm) y se calcula la lámina de riego necesaria para cubrir el déficit, pero sin superar el mm de déficit existente
  const irrigationDepthMm = soilPrev.dr_mm >= rawCalc.raw_mm ? Math.max(0, waterPreBalance.d_irrigacio) : 0;

  const drInput =
    dayIndex === 1
      ? computeDrMmDay1({ fc: existingSol.fc, humitat_sol_pct: soilPrev.humitat_sol_pct, zr_m: zrM })
      : soilPrev.dr_mm ?? 0;

  const waterBalance = computeDrMmDayN({ dr_mm_prev: drInput, pe: waterPreBalance.pe, etc_mm: etcMm, ro: waterPreBalance.ro, i: irrigationDepthMm });

  // Cálculo de la humedad del suelo
  const humitatSol = computeSoilHumidityPct({
    humitat_sol_pct: soilPrev.humitat_sol_pct,
    precipitacions_mm: climate.precipitacions_mm,
    ro: waterBalance.ro,
    i: waterBalance.i,
    etc_mm: etcMm,
    dpi: waterBalance.dpi,
    zr_m: zrM,
  });

  if ( existingSol.densitat_aparent_kg_m3 == null || existingSol.tipus_gra == null ) {
    throw new Error(`Falten dades de densitat aparent en sol_id="${solId}". Són necessàries per al càlcul de la simulació diària.`);
  }

  // Cálculo de la temperatura del suelo
  const temperaturaSol = computeSoilTemperatureC({
    densitat_aparent_kg_m3: existingSol.densitat_aparent_kg_m3,
    fc: existingSol.fc,
    dr_mm: waterBalance.dr_mm,
    zr_m: zrM,
    tipus_gra: existingSol.tipus_gra,
    dia_actual_simulacio: targetDay,
    temperatura_mitjana_superficial_anual_c: annualSurfaceThermalStats.temperatura_mitjana_superficial_anual_c,
    amplitud_termica_superficial_anual_c: annualSurfaceThermalStats.amplitud_termica_superficial_anual_c,
  }).temperatura_sol_c;

  // Construir el plan de aplicaciones de fertilizante para el día objetivo
  const distributionInputs = buildPlannedApplicationsForDay({ activePhase, dayIndex, d0: D0 });

  // Evaluar la distribución diaria de riego y fertilización
  const distribution = evaluateDailyDistribution({
    diaActualSimulacio: dayIndex,
    laminaMm: irrigationDepthMm,
    plannedFixedApplications: distributionInputs.plannedFixedApplications,
    continuousRules: distributionInputs.continuousRules,
  });

  // Persistir los eventos de riego y fertilización aplicados en el día, y obtener las cargas equivalentes totales para el día
  const chargeEq = await persistDistributionEventsForDay({
    db,
    execucioId,
    diaActualSimulacio: dayIndex,
    D0,
    faseExecucioIdCurrent: activePhase.fase_execucio_id,
    irrigationTriggered: distribution.irrigationTriggered,
    irrigationDepthMm: distribution.irrigationDepthMm,
    fertilizerExecutions: distribution.executedFertilizerApplications,
  });

  const phaseCount = Math.max(1, db.fasesFenologiques.filter((f) => f.cultiu_id === cultiu.cultiu_id).length);
  const nFaseKgHaFao = Number((activePhase.fase_catalog as any).n_fase_kg_ha_fao ?? (((cultiu.n_min_kg_ha + cultiu.n_max_kg_ha) / 2) / phaseCount));
  const pFaseKgHaFao = Number((activePhase.fase_catalog as any).p_fase_kg_ha_fao ?? (((cultiu.p_min_kg_ha + cultiu.p_max_kg_ha) / 2) / phaseCount));
  const kFaseKgHaFao = Number((activePhase.fase_catalog as any).k_fase_kg_ha_fao ?? (((cultiu.k_min_kg_ha + cultiu.k_max_kg_ha) / 2) / phaseCount));

  const executedFertilizerApplications = distribution.executedFertilizerApplications.map((row) => ({ producteId: row.producteId, quantitatDosiKgHa: row.quantitatDosiKgHa }));
  // Cálculo de las masas de N, P y K aplicadas en el día a partir de las aplicaciones de fertilizante ejecutadas
  const fertMasses = computeDailyFertilizerNpkAndIonMass({ executedFertilizerApplications: executedFertilizerApplications, db });

  // Cálculo de los nuevos ppm de N, P y K en el suelo a partir de las masas aplicadas, las condiciones del suelo y clima, y las características de la fase activa
  const nNext = computeNitrogenSoilPpm({
    n_sol_ppm: soilPrev.n_sol_ppm,
    n_entrada_kg_ha: fertMasses.n_entrada_kg_ha,
    temperatura_sol_c: temperaturaSol,
    n_fase_kg_ha_fao: nFaseKgHaFao,
    temps_dies_fao: activePhase.temps_dies_fao,
    humitat_sol_pct: humitatSol,
    fc: existingSol.fc,
    densitat_aparent_kg_m3: existingSol.densitat_aparent_kg_m3,
    zr_m: zrM,
    dpi: waterBalance.dpi,
    raw_mm: rawCalc.raw_mm,
    p: pValue,
  }).soil_ppm_new;

  const pNext = computePhosphorusSoilPpm({
    p_sol_ppm: soilPrev.p_sol_ppm,
    p_entrada_kg_ha: fertMasses.p_entrada_kg_ha,
    temperatura_sol_c: temperaturaSol,
    p_fase_kg_ha_fao: pFaseKgHaFao,
    temps_dies_fao: activePhase.temps_dies_fao,
    humitat_sol_pct: humitatSol,
    fc: existingSol.fc,
    densitat_aparent_kg_m3: existingSol.densitat_aparent_kg_m3,
    zr_m: zrM,
    dpi: waterBalance.dpi,
    raw_mm: rawCalc.raw_mm,
    p: pValue,
  }).soil_ppm_new;

  const kNext = computePotassiumSoilPpm({
    k_sol_ppm: soilPrev.k_sol_ppm,
    k_entrada_kg_ha: fertMasses.k_entrada_kg_ha,
    temperatura_sol_c: temperaturaSol,
    k_fase_kg_ha_fao: kFaseKgHaFao,
    temps_dies_fao: activePhase.temps_dies_fao,
    humitat_sol_pct: humitatSol,
    fc: existingSol.fc,
    densitat_aparent_kg_m3: existingSol.densitat_aparent_kg_m3,
    zr_m: zrM,
    dpi: waterBalance.dpi,
    raw_mm: rawCalc.raw_mm,
    p: pValue,
  }).soil_ppm_new;

  // Cálculo de los nuevos valores de TDS y EC
  const tdsEc = computeTdsAndEc({
    n_sol_ppm: nNext,
    p_sol_ppm: pNext,
    k_sol_ppm: kNext,
    n_sol_ppm_prev: soilPrev.n_sol_ppm,
    p_sol_ppm_prev: soilPrev.p_sol_ppm,
    k_sol_ppm_prev: soilPrev.k_sol_ppm,
    tds_ppm_prev: soilPrev.tds_ppm,
    npk_fertilitzants_kg_ha: fertMasses.npk_fertilitzants_kg_ha,
    ions_no_npk_fertilitzants_kg_ha: fertMasses.ions_no_npk_fertilitzants_kg_ha,
    humitat_sol_pct: humitatSol,
    fc: existingSol.fc,
    dpi: waterBalance.dpi,
    raw_mm: rawCalc.raw_mm,
  });

  if ( existingSol.clay == null || existingSol.soc == null ) {
    throw new Error(`Falten dades de textura i matèria orgànica en sol_id="${solId}". Són necessàries per al càlcul de la simulació diària.`);
  }

  // Cálculo del nuevo pH del suelo
  const phNext = computeSoilPh({
    equivalent_carrega_anio_dia: chargeEq.equivalent_carrega_anio_dia,
    equivalent_carrega_catio_dia: chargeEq.equivalent_carrega_catio_dia,
    humitat_sol_pct: humitatSol,
    fc: existingSol.fc,
    ph_anterior: soilPrev.ph,
    clay: existingSol.clay,
    soc: existingSol.soc,
    k_ph: DEFAULT_K_PH,
  }).ph_nou;

  // Persistir el estado diario de N, P y K aplicado por producto en la fase para el día objetivo
  await persistPhaseProductDailyState({
    db,
    executedFertilizerApplications: distribution.executedFertilizerApplications.map((row) => ({
      producteExecucioId: row.producteExecucioId,
      producteId: row.producteId,
      quantitatDosiKgHa: row.quantitatDosiKgHa,
    })),
    phaseExecucioId: activePhase.fase_execucio_id,
  });

  await upsertRow(ENV.PATH, 'sol_simulacio', {
    pkColumns: ['execucio_id', 'inici'],
    data: {
      sol_simulacio_id: randomUUID(),
      sol_id: solId,
      execucio_id: execucioId,
      ph: phNext,
      humitat_sol_pct: humitatSol,
      p: pValue,
      etc_mm: etcMm,
      raw_mm: rawCalc.raw_mm,
      dr_mm: waterBalance.dr_mm,
      i_mm: waterBalance.i,
      temperatura_sol_c: temperaturaSol,
      tds_ppm: tdsEc.tds_ppm,
      ec_ms_cm: tdsEc.ec_ms_cm,
      n_sol_ppm: nNext,
      p_sol_ppm: pNext,
      k_sol_ppm: kNext,
      inici: normalizeDateOnlyIso(targetDay),
      final: normalizeDateOnlyIso(addDays(targetDay, 1)),
    },
  });

  return {
    day0Suitability: dayIndex === 0 ? suitability : null,
    day0SoilAlarm: null,
    alarmRaised: false,
    daySummary: {
      dia_total_simulacio: dayIndex,
      date_iso: normalizeDateOnlyIso(targetDay),
      fase_nom: activePhase.nom_fao,
      dia_fase: activePhase.dia_fase,
      irrigation_lamina_mm: waterBalance.i,
      fertilizer_events: distribution.executedFertilizerApplications.length,
    },
  };
}

// Función para ejecutar el proceso de un día de simulación para una ejecución dada
export async function runNextDay(execucioId: string) {
  const db = await loadAll(ENV.PATH);
  const exec = db.execucions.find((row) => row.execucio_id === execucioId) ?? null;
  if (!exec) throw new Error(`No s'ha trobat execucio_id "${execucioId}"`);
  if (exec.estat !== 'RUNNING') {
    throw new Error(`L'execució "${execucioId}" no està en RUNNING. Estat actual: ${exec.estat}`);
  }

  const currentDate = new Date(exec.dia_actual_simulacio);
  const nextDate = addDays(currentDate, 1);
  const d0 = new Date(exec.temps_simulat_inici);
  const nextDayIndex = getDayIndexFromD0(d0, nextDate);
  console.info(
    `[EXEC-NEXT-DAY] execucio_id=${execucioId} dia_total_simulacio=${nextDayIndex} date=${normalizeDateOnlyIso(nextDate)}`,
  );

  // Obtiene la fase activa de la ejecución para una fecha y prepara su contexto diario
  const activePhase = resolveActivePhaseForDate({ db, execucioId, targetDate: nextDate });
  
  // Si no hay fase activa, se asume que la simulación ha finalizado correctamente y se marca como SUCCESS
  if (!activePhase) {
    console.info(
      `[EXEC-NEXT-DAY] execucio_id=${execucioId} dia_total_simulacio=${nextDayIndex} execucio finalitzada en SUCCESS`,
    );
    await upsertRow(ENV.PATH, 'execucio_simulada', {
      pkColumns: 'execucio_id',
      data: {
        execucio_id: execucioId,
        estat: 'SUCCESS',
        temps_simulat_fi: toISO(nextDate),
        dia_actual_simulacio: toISO(nextDate),
      },
    });
    return {
      execucio_id: execucioId,
      estat: 'SUCCESS',
      temps_simulat_fi: toISO(nextDate),
      dia_actual_simulacio: toISO(nextDate),
      finished: true,
    };
  }

  const failExecutionWithAlarm = buildExecutionAlarmService({ execucioId, d0 });
  
  // Realiza el cálculo de la simulación para el día objetivo y persiste los resultados, gestionando posibles alarmas de no aptitud o errores en el proceso
  const result = await computeAndPersistSimulationDay({ execucioId, targetDate: nextDate, dayIndex: nextDayIndex, failExecutionWithAlarm, db, exec, activePhase });

  if (result.alarmRaised) {
    await upsertRow(ENV.PATH, 'execucio_simulada', {
      pkColumns: 'execucio_id',
      data: {
        execucio_id: execucioId,
        estat: 'FAILED',
        temps_simulat_fi: toISO(nextDate),
        dia_actual_simulacio: toISO(nextDate),
      },
    });

    throw new ExecutionAlarmError(
      `S'ha registrat una alarma durant el càlcul del dia ${nextDayIndex}.`,
      execucioId,
      toISO(nextDate),
    );
  }

  await upsertRow(ENV.PATH, 'execucio_simulada', {
    pkColumns: 'execucio_id',
    data: {
      execucio_id: execucioId,
      estat: 'RUNNING',
      dia_actual_simulacio: toISO(nextDate),
      temps_simulat_fi: null,
    },
  });

  console.info(
    `[EXEC-NEXT-DAY] execucio_id=${execucioId} dia_total_simulacio=${nextDayIndex} calculat correctament`,
  );

  return {
    execucio_id: execucioId,
    estat: 'RUNNING',
    dia_actual_simulacio: toISO(nextDate),
    finished: false,
    day_summary: result.daySummary,
  };
}

// Función para ejecutar en loop el proceso diario de una ejecución hasta que finalice o alcance un límite de días para evitar loops infinitos
export async function runExecutionUntilEnd(execucioId: string) {
  const maxDays = 4000;
  for (let i = 0; i < maxDays; i += 1) {
    const step = await runNextDay(execucioId);
    if (step.finished) return step;
  }

  throw new Error(
    `S'ha superat el límit de ${maxDays} dies per a l'execució "${execucioId}"`,
  );
}

// Función para ejecutar en background el proceso completo de una ejecución desde su estado actual hasta el final
async function runExecutionInBackground(execucioId: string): Promise<void> {
  try {
    await runExecutionUntilEnd(execucioId);
  } catch (err) {
    if (err instanceof ExecutionAlarmError) {
      console.warn(
        `[EXEC-BG] execucio_id=${execucioId} finalizada en FAILED por alarma: ${(err as Error).message}`,
      );
      return;
    }

    console.error(
      `[EXEC-BG] execucio_id=${execucioId} error inesperado en background: ${(err as Error).message}`,
    );

    try {
      const db = await loadAll(ENV.PATH);
      const currentExec = db.execucions.find((row) => row.execucio_id === execucioId) ?? null;
      const failIso = currentExec?.dia_actual_simulacio instanceof Date
        ? currentExec.dia_actual_simulacio.toISOString()
        : (currentExec?.dia_actual_simulacio ?? new Date().toISOString());

      await upsertRow(ENV.PATH, 'execucio_simulada', {
        pkColumns: 'execucio_id',
        data: {
          execucio_id: execucioId,
          estat: 'FAILED',
          temps_simulat_fi: failIso,
          dia_actual_simulacio: failIso,
        },
      });
    } catch (persistErr) {
      console.error(
        `[EXEC-BG] execucio_id=${execucioId} no se pudo persistir FAILED: ${(persistErr as Error).message}`,
      );
    }
  }
}

// Función principal para crear una ejecución y lanzarla inmediatamente
export async function createExecutionAndRunFull(input: CreateExecutionInput) {
  const execucioId = randomUUID();
  const D0 = new Date(`${input.temps_simulat_inici}T00:00:00.000Z`);

  // Creamos la fila de ejecución con estado INITIALIZING antes de lanzar el proceso en background
  await upsertRow(ENV.PATH, 'execucio_simulada', {
    pkColumns: 'execucio_id',
    data: {
      execucio_id: execucioId,
      cultiu_id: input.cultiu_id,
      sol_id: null,
      estat: 'INITIALIZING',
      temps_simulat_inici: toISO(D0),
      temps_simulat_fi: null,
      dia_actual_simulacio: toISO(D0),
    },
  });

  setImmediate(() => {
    void (async () => {
      try {
        console.info(`[EXEC-BG-INIT] execucio_id=${execucioId} iniciant execució en background per cultiu_id=${input.cultiu_id}`);
        // Generar los datos inciales
        const created = await createExecution(input, { execucioId });
        console.info(`[EXEC-BG-INIT] execucio_id=${execucioId} creada con cultiu_id=${created.cultiu_id}`);

        // Lanzar la ejecución en background del cálculo diario de la simulación
        void runExecutionInBackground(created.execucio_id);
      } catch (err) {
        console.error(`[EXEC-BG-INIT] execucio_id=${execucioId} error=${(err as Error).message}`);

        await upsertRow(ENV.PATH, 'execucio_simulada', {
          pkColumns: 'execucio_id',
          data: {
            execucio_id: execucioId,
            estat: 'FAILED',
            temps_simulat_fi: toISO(new Date()),
            dia_actual_simulacio: toISO(D0),
          },
        });
      }
    })();
  });

  return {
    execucio_id: execucioId,
    cultiu_id: input.cultiu_id,
    estat: 'INITIALIZING',
    temps_simulat_inici: toISO(D0),
    dia_actual_simulacio: toISO(D0),
    async_started: true,
  };
}