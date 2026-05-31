import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ENV } from '../../config/env';
import { loadAll } from '../../datasources/repository';
import { upsertRow } from '../../datasources/write';
import {
  fetchAnnualSurfaceThermalStats,
  fetchDayClimate,
} from '../../integrations/openMeteo.client';
import { 
  buildExecutionAlarmService, 
  ExecutionAlarmError,
  type FailExecutionWithAlarm,
 } from '../alarms.service';
import {
  computeDrMmDay1,
  computeEtcMm,
  computePDepletionFraction,
  computeRawMm,
  computeRoAndPotentialIrrigation,
  computePTF,
} from '../formulas/soil.formulas';
import {
  computeCompoBase,
  computeNAplicacionsByFreqTipus,
  type DosiTipus,
  type FreqTipus,
} from '../formulas/compo-phase.formulas';
import { predictFaoPhaseWithCatBoost } from '../ml/catboost-fao.service';
import { computeAndPersistSimulationDay, resolveActivePhaseForDate } from './executions.service.runtime';
import {
  addDays,
  toISO,
  normalizeDateOnlyIso,
} from './executions.service.utils';
import { getOrCreateClimateForDay } from './executions.service.climate';

export const CreateExecutionSchema = z.object({
  // Entrada base per crear una nova execució
  cultiu_id:     z.uuid(),
  latitut:       z.coerce.number().min(-90).max(90),
  longitut:      z.coerce.number().min(-180).max(180),
  nom_ubicacio:  z.string().min(1),

  // Context físic del sòl ja calculat abans d'executar la simulació.
  soil_preview: z.object({
    sand: z.coerce.number(),
    silt: z.coerce.number().optional().nullable(),
    clay: z.coerce.number(),
    soc: z.coerce.number().optional().nullable(),
    densitat_aparent_kg_m3: z.coerce.number(),
    fc: z.coerce.number(),
    wp: z.coerce.number(),
    nom_tipus_sol: z.string().min(1),
    tipus_gra: z.string().optional().nullable(),
  }),

  // Inicio de la simulación (fecha ISO, por ejemplo "2026-03-11")
  temps_simulat_inici: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format YYYY-MM-DD'),

  // Estado inicial del suelo en día 0
  ph:              z.coerce.number().min(0).max(14),
  ec_ms_cm:        z.coerce.number().min(0),
  tds_ppm:         z.coerce.number().min(0),
  humitat_sol_pct: z.coerce.number().min(0).max(1),
  temperatura_sol_c: z.coerce.number(),
  n_sol_ppm:       z.coerce.number().min(0),
  p_sol_ppm:       z.coerce.number().min(0),
  k_sol_ppm:       z.coerce.number().min(0),
});

export type CreateExecutionInput = z.infer<typeof CreateExecutionSchema>;

type BootstrapExecutionContext = {
  db: Awaited<ReturnType<typeof loadAll>>;
  cultiu: Awaited<ReturnType<typeof loadAll>>['cultius'][number];
  ubicacioId: string;
  ubicacio: { latitut: number; longitut: number };
  execucioId: string;
  D0: Date;
  climaD0: Awaited<ReturnType<typeof fetchDayClimate>>;
  effectiveWp: number;
  effectiveFc: number;
  cropSlug: string;
  faseActual: Awaited<ReturnType<typeof loadAll>>['fasesFenologiques'][number];
};

type BootstrapPhaseResult = {
  faseExecucioId: string;
  temps_dies_fao: number;
  dataIniciFaseIso: string;
  diaTotalSimulacioInici: number;
  fasesDetall: Array<{
    ordre_fao: number;
    fase_id: string;
    nom_fao: string;
    temps_dies_fao: number;
  }>;
};

type BootstrapCompoRow = {
  fase_producte_id: string;
  inici_bbch: number;
  fi_bbch: number;
  cataleg_fase_producte_id: string;
  quantitat_dosi: number;
  producte_kg_ha: number;
  n_aplicacions: number | null;
  producte_kg_ha_dia: number;
};

type BootstrapAllPhasesResult = {
  fasesDetall: Array<{
    ordre_fao: number;
    fase_id: string;
    nom_fao: string;
    temps_dies_fao: number;
  }>;
};

// Función para convertir el nombre del cultivo a un slug estandarizado para usarlo como input en modelos ML
export function toCropSlug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const aliasMap: Record<string, string> = {
    tomaquet: 'tomato',
    tomata: 'tomato',
    tomate: 'tomato',
    tomato: 'tomato',
  };
  const alias = aliasMap[normalized];
  if (alias) return alias;
  const raw = normalized.replace(/[-\s]+/g, '_');
  const slug = raw.replace(/[^a-z0-9_]/g, '');
  return slug || 'tomato';
}

// Función que extrae la información de los fertilizantes de la base de datos de una fase fenológica y calcula el peso de cada fase producto
export function buildBootstrapCompoRows(params: {
  db: Awaited<ReturnType<typeof loadAll>>;
  cultiu: Awaited<ReturnType<typeof loadAll>>['cultius'][number];
  faseActual: Awaited<ReturnType<typeof loadAll>>['fasesFenologiques'][number];
  temps_dies: number;
  rawReferenciaMm: number;
}) {
  const { db, cultiu, faseActual, temps_dies, rawReferenciaMm } = params;

  if (!Array.isArray(db.fasesProducte)) {
    throw new Error(
      `loadAll() no ha carregat db.fasesProducte. Claus disponibles: ${Object.keys(db as any).join(', ')}`,
    );
  }

  if (!Array.isArray(db.catalogFasesProducte)) {
    throw new Error(
      `loadAll() no ha carregat db.catalogFasesProducte. Claus disponibles: ${Object.keys(db as any).join(', ')}`,
    );
  }

  if (!Array.isArray(db.catalogProductes)) {
    throw new Error(
      `loadAll() no ha carregat db.catalogProductes. Claus disponibles: ${Object.keys(db as any).join(', ')}`,
    );
  }

  // Obtener todas las filas de fases_producto relacionadas con la fase fenológica actual y el cultivo
  const fasesProducteRows = db.fasesProducte.filter(
    (fp) => fp.cultiu_id === cultiu.cultiu_id && fp.fase_id === faseActual.fase_id,
  );

  // Obtener las filas de catálogo relacionadas con esas fases_producto
  const catalegRows = db.catalogFasesProducte.filter((c) =>
    fasesProducteRows.some((fp) => fp.fase_producte_id === c.fase_producte_id),
  );

  // Calcular el total de unidades BBCH de la fase fenológica actual sumando las unidades de cada fase producto relacionada
  const totalBbchUnitsFase = fasesProducteRows.reduce((acc, fp) => {
    const width = Math.max(0, fp.fiBBCH - fp.iniciBBCH + 1);
    return acc + width;
  }, 0);
  if (totalBbchUnitsFase <= 0) {
    throw new Error(
      `La fase ${faseActual.nom_fao} no té trams BBCH vàlids per calcular temps_dies_compo.`,
    );
  }

  const compoRows: BootstrapCompoRow[] = [];

  for (const cat of catalegRows) {
    // Se resuelve el producto y la fase producto relacionados con esta fila de catálogo
    const producte = db.catalogProductes.find((p) => p.producte_id === cat.producte_id) ?? null;
    if (!producte) continue;

    const faseProducte =
      fasesProducteRows.find((fp) => fp.fase_producte_id === cat.fase_producte_id) ?? null;
    if (!faseProducte) {
      throw new Error(
        `No s'ha trobat fase_producte per cataleg_fase_producte_id="${cat.cataleg_fase_producte_id}"`,
      );
    }

    // Se calcula el número de aplicaciones y la dosis por aplicación
    // Si la frecuencia es "CONTINUA_DURANT_FASE", no se puede determinar un número fijo de aplicaciones
    const freqTipus = cat.freq_tipus as FreqTipus;
    const nAplicacions =
      freqTipus === 'CONTINUA_DURANT_FASE'
        ? null
        : computeNAplicacionsByFreqTipus({
            freq_tipus: freqTipus,
            temps_dies_fao: temps_dies,
            n_aplicacions_cataleg: cat.n_aplicacions_cataleg,
            n_aplicacions_min: cat.n_aplicacions_min,
            n_aplicacions_max: cat.n_aplicacions_max,
          });

    const base = computeCompoBase({
      dosi_tipus: cat.dosi_tipus as DosiTipus,
      freq_tipus: freqTipus,
      quantitat_dosi_cataleg: cat.quantitat_dosi_cataleg,
      quantitat_min: cat.quantitat_min,
      quantitat_max: cat.quantitat_max,
      densitat_kg_l: producte.densitat_kg_l,
      raw_mm: rawReferenciaMm,
      dist_min_fila_m: cultiu.dist_min_fila_m,
      dist_min_col_m: cultiu.dist_min_col_m,
      temps_dies_fao: temps_dies,
      n_aplicacions: nAplicacions,
    });

    compoRows.push({
      fase_producte_id: cat.fase_producte_id,
      inici_bbch: faseProducte.iniciBBCH,
      fi_bbch: faseProducte.fiBBCH,
      cataleg_fase_producte_id: cat.cataleg_fase_producte_id,
      quantitat_dosi: base.quantitat_dosi,
      producte_kg_ha: base.producte_kg_ha,
      n_aplicacions: nAplicacions,
      producte_kg_ha_dia: base.producte_kg_ha_dia,
    });
  }

  // Se ordenan las filas resultantes por inicio BBCH y luego por fin BBCH para facilitar la asignación temporal posterior
  const sortedCompoRows = compoRows.sort((a, b) => {
    if (a.inici_bbch !== b.inici_bbch) return a.inici_bbch - b.inici_bbch;
    return a.fi_bbch - b.fi_bbch;
  });

  return {
    compoRows: sortedCompoRows,
    totalBbchUnitsFase,
  };
}

// Función que transforma los tramos BBCH de cada fase de producto en una ventana temporal dentro de la fase fenológica
export function buildBootstrapPhaseProductSchedule(params: {
  sortedCompoRows: BootstrapCompoRow[];
  totalBbchUnitsFase: number;
  phaseDurationDays: number;
  faseActualNom: string;
}) {
  const { sortedCompoRows, totalBbchUnitsFase, phaseDurationDays, faseActualNom } = params;

  // Elimina duplicados de las fases de producto
  const uniquePhaseRows = sortedCompoRows.filter(
    (row, index, arr) =>
      index === arr.findIndex((item) => item.fase_producte_id === row.fase_producte_id),
  );
  if (uniquePhaseRows.length > phaseDurationDays) {
    throw new Error(
      `La fase ${faseActualNom} té ${uniquePhaseRows.length} fases de producte però només ${phaseDurationDays} dies. No es pot garantir una assignació única per dia.`,
    );
  }

  // Map para guardar la asignación de cada fase de producto a su ventana temporal dentro de la fase fenológica
  const faseProducteSchedule = new Map<string, {
    tempsDiesCompo: number;
    startOffsetDays: number;
    endOffsetDaysExclusive: number;
    bbchUnits: number;
  }>();

  let previousBoundary = 0;
  let cumulativeBbchUnits = 0;

  // Se asigna a cada fase de producto una ventana temporal proporcional a su número de unidades BBCH respecto al total de la fase fenológica
  for (let idx = 0; idx < uniquePhaseRows.length; idx += 1) {
    const row = uniquePhaseRows[idx];
    const bbchUnits = Math.max(0, row.fi_bbch - row.inici_bbch + 1);

    cumulativeBbchUnits += bbchUnits;

    const remainingPhases = uniquePhaseRows.length - idx - 1;
    const rawBoundary = Math.round((cumulativeBbchUnits / totalBbchUnitsFase) * phaseDurationDays);

    const nextBoundary =
      idx === uniquePhaseRows.length - 1
        ? phaseDurationDays
        : Math.min(
            phaseDurationDays - remainingPhases,
            Math.max(previousBoundary + 1, rawBoundary),
          );

    const assignedDays = nextBoundary - previousBoundary;

    faseProducteSchedule.set(row.fase_producte_id, {
      bbchUnits,
      startOffsetDays: previousBoundary,
      endOffsetDaysExclusive: nextBoundary,
      tempsDiesCompo: assignedDays,
    });

    previousBoundary = nextBoundary;
  }

  return faseProducteSchedule;
}

// Función que persiste en la base de datos las fases de producto con su respectiva asignación temporal dentro de la fase fenológica
export async function persistBootstrapPhaseProducts(params: {
 sortedCompoRows: BootstrapCompoRow[];
  faseProducteSchedule: Map<string, {
    tempsDiesCompo: number;
    startOffsetDays: number;
    endOffsetDaysExclusive: number;
    bbchUnits: number;
  }>;
  dataIniciFase: Date;
  diaTotalSimulacioInici: number;
  faseExecucioId: string;
}) {
  const { sortedCompoRows, faseProducteSchedule, dataIniciFase, diaTotalSimulacioInici, faseExecucioId } = params;

  for (const row of sortedCompoRows) {
    const schedule = faseProducteSchedule.get(row.fase_producte_id);
    if (!schedule) {
      throw new Error(
        `No s'ha pogut resoldre la finestra temporal per a fase_producte_id="${row.fase_producte_id}"`,
      );
    }

    const dataIniciCompo = addDays(dataIniciFase, schedule.startOffsetDays);

    const producteExecucioId = randomUUID();
    await upsertRow(ENV.PATH, 'fase_producte_execucio', {
      pkColumns: 'producte_execucio_id',
      data: {
        producte_execucio_id: producteExecucioId,
        fase_producte_id: row.fase_producte_id,
        fase_execucio_id: faseExecucioId,
        temps_dies_compo: schedule.tempsDiesCompo,
        data_inici_compo: toISO(dataIniciCompo),
        pes_dia_kg_ha: 0,
      },
    });

    await upsertRow(ENV.PATH, 'cataleg_fase_producte_execucio', {
      pkColumns: ['cataleg_fase_producte_id', 'producte_execucio_id'],
      data: {
        cataleg_fase_producte_id: row.cataleg_fase_producte_id,
        producte_execucio_id: producteExecucioId,
        quantitat_dosi: row.quantitat_dosi,
        ultima_aplicacio: null,
        producte_kg_ha: row.producte_kg_ha,
        producte_kg_ha_dia: row.producte_kg_ha_dia,
        producte_kg_ha_fase: 0,
        n_aplicacions: row.n_aplicacions,
        aplicacions_fetes: 0,
      },
    });
  }
}

// Función para comprovar que la ubicación está en la base de datos y si no está, añadirla
export async function resolveOrCreateUbicacio(params: {
  db: Awaited<ReturnType<typeof loadAll>>;
  input: CreateExecutionInput;
}): Promise<{
  ubicacioId: string;
  ubicacio: { latitut: number; longitut: number };
}> {
  const { db, input } = params;
  const COORD_TOL = 0.00001;
  const normalizeText = (value: string) => value.trim().toLowerCase();
  const targetNom = normalizeText(input.nom_ubicacio);

  const existingUbicacioByCoords = db.ubicacions.find(
    (u) =>
      Math.abs(u.latitut - input.latitut) <= COORD_TOL &&
      Math.abs(u.longitut - input.longitut) <= COORD_TOL,
  );

  const existingUbicacioByName = db.ubicacions.find(
    (u) => normalizeText(u.nom) === targetNom,
  );

  const existingUbicacio = existingUbicacioByCoords ?? existingUbicacioByName ?? null;

  const ubicacioId = existingUbicacio?.ubicacio_id ?? randomUUID();

  if (!existingUbicacio) {
    await upsertRow(ENV.PATH, 'ubicacio', {
      pkColumns: 'ubicacio_id',
      data: {
        ubicacio_id: ubicacioId,
        nom: input.nom_ubicacio,
        latitut: input.latitut,
        longitut: input.longitut,
      },
    });
  }

  return {
    ubicacioId,
    ubicacio: {
      latitut: existingUbicacio?.latitut ?? input.latitut,
      longitut: existingUbicacio?.longitut ?? input.longitut,
    },
  };
}

// Función para comprovar que el suelo de la ubicación está en la base de datos y si no está, añadirlo
export async function resolvePlantacioSoil(params: {
  db: Awaited<ReturnType<typeof loadAll>>;
  ubicacioId: string;
  soilPreview: CreateExecutionInput['soil_preview'];
}) {
  const { db, ubicacioId, soilPreview } = params;

  const existingSol = db.sols.find((row) => row.ubicacio_id === ubicacioId) ?? null;

  if (existingSol) {
    return existingSol;
  }

  if (!soilPreview.sand || !soilPreview.clay) throw new Error(`Soil preview incomplet: sand=${soilPreview.sand}, clay=${soilPreview.clay}`);
  const tipusGra = soilPreview.sand >= 0.18 || soilPreview.clay < 0.7 ? 'FI' : 'GRUIXUT';

  const sol = {
    sol_id: randomUUID(),
    ubicacio_id: ubicacioId,
    nom_tipus_sol: soilPreview.nom_tipus_sol,
    sand: soilPreview.sand,
    clay: soilPreview.clay,
    soc: soilPreview.soc ?? null,
    densitat_aparent_kg_m3: soilPreview.densitat_aparent_kg_m3,
    fc: soilPreview.fc,
    wp: soilPreview.wp,
    tipus_gra: tipusGra
  };

  await upsertRow(ENV.PATH, 'sol', {
    pkColumns: 'sol_id',
    data: sol,
  });

  return sol;
}

// Función para obtener las fases FAO del cultiu y ordenarlas por ordre_fao
export function getFasesFaoForCultiu(db: Awaited<ReturnType<typeof loadAll>>, cultiuId: string) {
  const fasesFao = db.fasesFenologiques
    .filter((f) => f.cultiu_id === cultiuId)
    .sort((a, b) => a.ordre_fao - b.ordre_fao);

  if (fasesFao.length === 0) {
    throw new Error(`No s'han trobat fases FAO per a cultiu_id "${cultiuId}"`);
  }

  return fasesFao;
}

// Función para completar la fila de execucio_simulada creada previamente en INITIALIZING y obtener el ID de sol_simulacio necesario para el día 0
export async function prepareExecutionRows(params: {
  db: Awaited<ReturnType<typeof loadAll>>;
  input: CreateExecutionInput;
  execucioId?: string;
  cultiuId: string;
  solId: string;
  ubicacioId: string;
  D0: Date;
  annualSurfaceThermalStats: Awaited<ReturnType<typeof fetchAnnualSurfaceThermalStats>>;
}) {
  const { execucioId, cultiuId, solId, D0, annualSurfaceThermalStats } = params;

   if (!execucioId) {
    throw new Error('prepareExecutionRows requereix execucioId.');
  }
  const solSimulacioId = randomUUID();

  // Completar la fila de execucio_simulada creada previamente en INITIALIZING
  await upsertRow(ENV.PATH, 'execucio_simulada', {
    pkColumns: 'execucio_id',
    data: {
      execucio_id: execucioId,
      cultiu_id: cultiuId,
      sol_id: solId,
      temps_simulat_inici: toISO(D0),
      temps_simulat_fi: null,
      dia_actual_simulacio: toISO(D0),
      temperatura_mitjana_superficial_anual_c: annualSurfaceThermalStats.temperatura_mitjana_superficial_anual_c,
      amplitud_termica_superficial_anual_c: annualSurfaceThermalStats.amplitud_termica_superficial_anual_c,
    },
  });

  return { execucioId, solSimulacioId };
}

// Función que prepara a todas las fases fenológicas FAO de una ejecución antes de que comience la simulación diària
export async function bootstrapExecutionAllPhasesData(params: {
  ctx: BootstrapExecutionContext;
  fasesFao: Awaited<ReturnType<typeof loadAll>>['fasesFenologiques'];
  failExecutionWithAlarm: FailExecutionWithAlarm;
}): Promise<BootstrapAllPhasesResult> {
  const { ctx, fasesFao, failExecutionWithAlarm } = params;

  const phaseResults: BootstrapPhaseResult[] = [];

  let currentDate = new Date(ctx.D0);
  let currentDay = 0;

  // Iterar por cada fase fenológica FAO, calcular su duración con el modelo ML y persistir la información relevante para cada fase
  for (const fase of fasesFao) {
    const phaseCtx: BootstrapExecutionContext = {
      ...ctx,
      faseActual: fase,
    };

    const phaseResult = await bootstrapExecutionPhaseData({
      ctx: phaseCtx,
      failExecutionWithAlarm,
      dataIniciFase: currentDate,
      diaTotalSimulacioInici: currentDay,
    });

    // Persistir la información de la fase actual en la tabla fase_fenologica_execucio
    phaseResults.push(phaseResult);

    // Calcular la fecha de inicio de la siguiente fase sumando los días de duración de la fase actual
    const phaseDuration = Math.max(1, Math.ceil(phaseResult.temps_dies_fao));
    currentDate = addDays(currentDate, phaseDuration);
    currentDay += phaseDuration;
  }

  if (phaseResults.length === 0) {
    throw new Error('No s’ha pogut bootstrapar cap fase FAO.');
  }

  return {
    fasesDetall: phaseResults.flatMap((row) => row.fasesDetall),
  };
}

// Función que inicializa una fase fenológica concreta de una ejecución
export async function bootstrapExecutionPhaseData(params: {
  ctx: BootstrapExecutionContext;
  failExecutionWithAlarm: FailExecutionWithAlarm;
  dataIniciFase: Date;
  diaTotalSimulacioInici: number;
}): Promise<BootstrapPhaseResult> {
  const { ctx, failExecutionWithAlarm, dataIniciFase, diaTotalSimulacioInici } = params;
  const { db, cultiu, cropSlug, faseActual, effectiveWp, effectiveFc, execucioId } = ctx;

  const phaseClimate = await getOrCreateClimateForDay({
    db,
    execucioId,
    ubicacioId: ctx.ubicacioId,
    ubicacio: ctx.ubicacio,
    targetDate: dataIniciFase,
  });

  const diaTotalSimulacio = diaTotalSimulacioInici;
  const diaFase = 1;

  // Si base_temps_dies es 0 o negativo, lanzar una alarma y marcar la ejecución como fallida
  const baseTempsDies = (faseActual.temps_min_dies + faseActual.temps_max_dies) / 2;
  if (baseTempsDies <= 0) {
    await failExecutionWithAlarm(
      `base_temps_dies invàlid en fase ${faseActual.nom_fao}: valor=${baseTempsDies}.`,
      {
        fase_id: faseActual.fase_id,
        fase_nom: faseActual.nom_fao,
        base_temps_dies: baseTempsDies,
        temps_min_dies: faseActual.temps_min_dies,
        temps_max_dies: faseActual.temps_max_dies,
      },
      {
        fase_id: faseActual.fase_id,
        fase_nom: faseActual.nom_fao,
        dia_total_simulacio: diaTotalSimulacio,
        dia_fase: diaFase,
      },
    );
  }

  const mlInput = {
    crop_slug: cropSlug,
    phase_name: faseActual.nom_fao,
    
    // Suelo
    wp: effectiveWp,
    fc: effectiveFc,

    //Clima
    temperatura_2m_c: phaseClimate.temperatura_2m_c,
    air_humidity_pct: phaseClimate.humitat_2m,
    precipitacions_mm: phaseClimate.precipitacions_mm,
    solar_radiation_ghi: phaseClimate.radiacio_solar_mj_m2,
    wind_speed: phaseClimate.wind_speed_10m,

    // Parámetros de la fase FAO
    kc_inicial: faseActual.kc_inicial,
    kc_final: faseActual.kc_final,
  };

  const mlPrediction = await predictFaoPhaseWithCatBoost(mlInput);
  const temps_dies = mlPrediction.duration_days;

  if (temps_dies < 1) {
    await failExecutionWithAlarm(
      `temps_dies_fao invàlid (< 1) en fase ${faseActual.nom_fao}: valor=${temps_dies}.`,
      {
        temps_dies_fao: temps_dies,
        fase_id: faseActual.fase_id,
        fase_nom: faseActual.nom_fao,
        model: 'catboost_hybrid',
      },
      {
        fase_id: faseActual.fase_id,
        fase_nom: faseActual.nom_fao,
        dia_total_simulacio: diaTotalSimulacio,
        dia_fase: diaFase,
      },
    );
  }

  const faseExecucioId = randomUUID();
  await upsertRow(ENV.PATH, 'fase_fenologica_execucio', {
    pkColumns: ['execucio_id', 'fase_id'],
    data: {
      fase_execucio_id: faseExecucioId,
      execucio_id: execucioId,
      fase_id: faseActual.fase_id,
      data_inici_fao: toISO(dataIniciFase),
      temps_dies_fao: temps_dies,
      kc: faseActual.kc_inicial,
      zr_m: faseActual.zr_inicial_m,
    },
  });

  const zrRef = (faseActual.zr_inicial_m + faseActual.zr_final_m) / 2;
  const kcRef = faseActual.kc_inicial;
  const etcRef = computeEtcMm({ kc: kcRef, et0_mm: phaseClimate.et0_mm, });
  const pRef = computePDepletionFraction({ p_taula_fao: cultiu.p_taula_fao, etc_mm: etcRef, });
  const rawReferenciaMm = computeRawMm({ fc: effectiveFc, wp: effectiveWp, zr_m: zrRef, p: pRef, }).raw_mm;
  
  // Extraer la información de los fertilizantes de la base de datos para esta fase fenológica y calcular el peso de cada fase producto
  const { compoRows: sortedCompoRows, totalBbchUnitsFase } = buildBootstrapCompoRows({ db, cultiu, faseActual, temps_dies, rawReferenciaMm, });

  // Construir el calendario de aplicación de productos para esta fase fenológica asignando cada fase producto a una ventana temporal dentro de la duración total de la fase
  const phaseDurationDays = Math.max(1, Math.ceil(temps_dies));
  const faseProducteSchedule = buildBootstrapPhaseProductSchedule({
    sortedCompoRows,
    totalBbchUnitsFase,
    phaseDurationDays,
    faseActualNom: faseActual.nom_fao,
  });

  // Persistir en la base de datos las fases de producto con su respectiva asignación temporal dentro de la fase fenológica
  await persistBootstrapPhaseProducts({
    sortedCompoRows,
    faseProducteSchedule,
    dataIniciFase,
    diaTotalSimulacioInici,
    faseExecucioId,
  });

  return {
    faseExecucioId,
    temps_dies_fao: temps_dies,
    dataIniciFaseIso: toISO(dataIniciFase),
    diaTotalSimulacioInici,
    fasesDetall: [
      {
        ordre_fao: faseActual.ordre_fao,
        fase_id: faseActual.fase_id,
        nom_fao: faseActual.nom_fao,
        temps_dies_fao: temps_dies,
      },
    ],
  };
}

// Función principal para crear una ejecución simulada a partir de la entrada del usuario
export async function createExecution(input: CreateExecutionInput, options: { execucioId: string }) {
  const db = await loadAll(ENV.PATH);

  const cultiu = db.cultius.find((c) => c.cultiu_id === input.cultiu_id) ?? null;
  if (!cultiu) throw new Error(`No s'ha trobat cultiu_id "${input.cultiu_id}"`);

  // Comprovar o crear la ubicación
  const { ubicacioId, ubicacio } = await resolveOrCreateUbicacio({ db, input });

  // Comprobar o crear el suelo de la ubicación
  const sol = await resolvePlantacioSoil({ db, ubicacioId, soilPreview: input.soil_preview });
  const solId = sol.sol_id;

  // Obtener las fases FAO del cultivo y ordenarlas por ordre_fao
  const fasesFao = getFasesFaoForCultiu(db, cultiu.cultiu_id);
  const D0 = new Date(`${input.temps_simulat_inici}T00:00:00.000Z`);

  const faseActual = fasesFao[0];
  if (!faseActual) {
    throw new Error(`No s'ha pogut determinar la fase actual per al cultiu "${cultiu.nom}".`);
  }

  // Obtener el clima del día 0 para la ubicación
  const climateD0 = await fetchDayClimate(ubicacio.latitut, ubicacio.longitut, D0);
  
  // Obtener las estadísticas térmicas superficiales anuales para la ubicación y añadirlas a execucio_simulada
  const annualSurfaceThermalStats = await fetchAnnualSurfaceThermalStats( ubicacio.latitut, ubicacio.longitut, D0, );

  // Calcular y persistir toda la información de las fases FAO, productos, aplicaciones planificadas y reglas continuas para la ejecución
  const { execucioId, solSimulacioId } = await prepareExecutionRows({ db, input, execucioId: options.execucioId, cultiuId: cultiu.cultiu_id, solId, ubicacioId, D0, annualSurfaceThermalStats });

  // Cálculo de los valores derivados del día 0
  const kcD0 = faseActual.kc_inicial;
  const zrD0 = faseActual.zr_inicial_m;
  const etcD0 = computeEtcMm({ kc: kcD0, et0_mm: climateD0.et0_mm });
  const pD0 = computePDepletionFraction({ p_taula_fao: cultiu.p_taula_fao, etc_mm: etcD0, });
  const rawD0 = computeRawMm({ fc: Number(sol.fc), wp: Number(sol.wp), zr_m: zrD0, p: pD0, }).raw_mm;
  const drD0 = computeDrMmDay1({ fc: Number(sol.fc), humitat_sol_pct: input.humitat_sol_pct, zr_m: zrD0, });
  const waterPreBalanceD0 = computeRoAndPotentialIrrigation({ dr_mm: drD0, raw_mm: rawD0, precipitacions_mm: climateD0.precipitacions_mm, etc_mm: etcD0, });
  const hasValidWaterStorageD0 = Number.isFinite(rawD0) && Number.isFinite(drD0) && Number.isFinite(zrD0) && rawD0 > 0 && zrD0 > 0;
  const shouldIrrigateD0 = hasValidWaterStorageD0 && drD0 >= rawD0;
  const iD0 = shouldIrrigateD0 ? Math.max(0, waterPreBalanceD0.d_irrigacio) : 0;

  // Guardar el estado inicial del suelo en sol_simulacio
  await upsertRow(ENV.PATH, 'sol_simulacio', {
    pkColumns: ['execucio_id', 'inici'],
    data: {
      sol_simulacio_id: solSimulacioId,
      sol_id: solId,
      execucio_id: execucioId,

      // Valores iniciales impuestos por el usuario
      ph: input.ph,
      humitat_sol_pct: input.humitat_sol_pct,
      temperatura_sol_c: input.temperatura_sol_c,
      tds_ppm: input.tds_ppm,
      ec_ms_cm: input.ec_ms_cm,
      n_sol_ppm: input.n_sol_ppm,
      p_sol_ppm: input.p_sol_ppm,
      k_sol_ppm: input.k_sol_ppm,

      // Valores derivados del día 0
      p: pD0,
      etc_mm: etcD0,
      raw_mm: rawD0,
      dr_mm: drD0,
      i_mm: iD0,

      // Fechas de inicio y fin del día 0
      inici: normalizeDateOnlyIso(D0),
      final: normalizeDateOnlyIso(addDays(D0, 1)),
    },
  });

  // Construir la función de alarma específica para esta ejecución
  const failExecutionWithAlarm = buildExecutionAlarmService({ execucioId, d0: D0 });

  // Convertir el nombre del cultivo a un slug para usarlo como input en modelos ML
  const cropSlug = toCropSlug(cultiu.nom);

  // Contexto común para el bootstrap de todas las fases FAO
  const phaseBootstrapCtx: BootstrapExecutionContext = {
    db,
    cultiu,
    ubicacioId,
    ubicacio,
    execucioId,
    D0,
    climaD0: climateD0,
    effectiveWp: Number(sol.wp),
    effectiveFc: Number(sol.fc),
    cropSlug,
    faseActual,
  };

  // Preparar toda la información de las fases FAO, productos, aplicaciones planificadas y reglas continuas para la ejecución antes de que comience la simulación diària
  await bootstrapExecutionAllPhasesData({ ctx: phaseBootstrapCtx, fasesFao, failExecutionWithAlarm });

  const dbRuntime = await loadAll(ENV.PATH);
  const execRuntime = dbRuntime.execucions.find((row) => row.execucio_id === execucioId) ?? null;
  if (!execRuntime) throw new Error(`No s'ha trobat execucio_id "${execucioId}" després de preparar l'execució.`);
  const activePhaseRuntime = resolveActivePhaseForDate({ db: dbRuntime, execucioId, targetDate: D0 });
  if (!activePhaseRuntime) throw new Error(`No s'ha trobat fase activa inicial per a execucio_id="${execucioId}" en el dia 0.`);
  
  // Realizar la simulación del día 0 para comprobar que no hay alarmas inmediatas por condiciones iniciales del suelo o clima, y si las hay, marcar la ejecución como fallida
  const day0Result = await computeAndPersistSimulationDay({
    execucioId,
    targetDate: D0,
    dayIndex: 0,
    failExecutionWithAlarm,
    db: dbRuntime,
    exec: execRuntime,
    activePhase: activePhaseRuntime,
  });

  // Comprovar si hay alguna alarma en el día 0
  if (day0Result.day0SoilAlarm) {
    const failIso = toISO(D0);

    await upsertRow(ENV.PATH, 'execucio_simulada', {
      pkColumns: 'execucio_id',
      data: {
        execucio_id: execucioId,
        estat: 'FAILED',
        temps_simulat_fi: failIso,
        dia_actual_simulacio: failIso,
      },
    });

    throw new ExecutionAlarmError(
      "S'ha registrat una alarma en el dia 0. L'estat final s'ha fixat a FAILED.",
      execucioId,
      failIso,
    );
  }

  await upsertRow(ENV.PATH, 'execucio_simulada', {
    pkColumns: 'execucio_id',
    data: {
      execucio_id: execucioId,
      estat: 'RUNNING',
      temps_simulat_fi: null,
      dia_actual_simulacio: toISO(D0),
    },
  });

  return {
    execucio_id: execucioId,
    cultiu_id: cultiu.cultiu_id,
    estat: 'RUNNING',
    temps_simulat_inici: toISO(D0),
    dia_actual_simulacio: toISO(D0),
  };
}

