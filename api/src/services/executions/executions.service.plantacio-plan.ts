import { randomUUID } from 'node:crypto';
import { ENV } from '../../config/env';
import { loadAll } from '../../datasources/repository';
import { deleteRowsWhere, upsertRow } from '../../datasources/write';
import { getExecutionResultView } from './executions.service.read';

type ExecutionPlanProductRow = {
  execucio_plantacio_dia_fertilitzant_id: string;
  producte_id: string;
  producte_nom: string | null;
  quantitat_dosi_kg_ha: number;
  quantitat_total_kg: number;
};

type ExecutionPlanDayRow = {
  execucio_plantacio_dia_id: string;
  dia_total_simulacio: number;
  data_iso: string;
  fase_nom: string;
  fase_producte_nom: string;
  irrigacio_lamina_mm: number;
  superficie_m2: number | null;
  aigua_total_l: number;
  aigua_total_m3: number;
  fertilitzant_total_kg_ha: number;
  fertilitzant_total_kg: number;
  productes: ExecutionPlanProductRow[];
};

export type ExecutionPlantacioPlanView = {
  execucio_plantacio_id: string;
  execucio_id: string;
  plantacio_id: string;
  cultiu_id: string | null;
  cultiu_nom: string | null;
  created_at: string;
  estat?: 'INITIALIZING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | null;
  alarma?: {
    alarma_id?: string | null;
    tipus_alarma?: string | null;
    motiu?: string | null;
    fase_nom?: string | null;
    dia_total_simulacio?: number | null;
  } | null;
  llargada_real_m: number | null;
  amplada_real_m: number | null;
  superficie_m2: number | null;
  n_files: number | null;
  n_columnes: number | null;
  n_plantes_real: number | null;
  reg_total_mm: number;
  aigua_total_l: number;
  aigua_total_m3: number;
  fertilitzant_total_kg_ha: number;
  fertilitzant_total_kg: number;
  dies_totals: number;
  dies: ExecutionPlanDayRow[];
};

export type ExecutionPlantacioPlanJobResult = {
  execucio_plantacio_id: string;
  execucio_id: string;
  plantacio_id: string;
  estat:  'INITIALIZING' | 'RUNNING' | 'SUCCESS' | 'FAILED';
  async_started: boolean;
  message: string;
};

function round3(value: number): number {
  if (!Number.isFinite(value)) throw new Error(`No es pot arrodonir un valor no finit: ${value}`);
  return Number(value.toFixed(3));
}

function computeSurfaceM2(params: { llargada: number; amplada: number }): number {
  const { llargada, amplada } = params;
  if (!Number.isFinite(llargada) || !Number.isFinite(amplada) || llargada <= 0 || amplada <= 0) throw new Error('La plantació no té dimensions vàlides per calcular la superfície');
  return round3(llargada * amplada);
}

function aggregateFertilizerRows(params: {
  phase: { nom_fao: string };
  day: {
    dia_total_simulacio: number;
    date_iso: string;
    sol: {
      i_mm: number;
    };
    esdeveniments: {
      fase_producte: Array<{
        fase_producte_id: string;
        fase_producte_nom: string;
        productes: Array<{
          producte_id: string;
          producte_nom: string;
          quantitat_dosi_kg_ha: number;
        }>;
      }>;
    };
  };
  superficieM2: number | null;
}): ExecutionPlanDayRow {
  const { phase, day, superficieM2 } = params;
  const productMap = new Map<string, ExecutionPlanProductRow>();
  const productPhaseNames = new Set<string>();

  for (const group of day.esdeveniments.fase_producte) {
    if (group.fase_producte_nom) productPhaseNames.add(group.fase_producte_nom);

    for (const product of group.productes) {
      const key = product.producte_id;
      const existing = productMap.get(key) ?? {
        execucio_plantacio_dia_fertilitzant_id: randomUUID(),
        producte_id: product.producte_id,
        producte_nom: product.producte_nom,
        quantitat_dosi_kg_ha: 0,
        quantitat_total_kg: 0,
      };

      existing.quantitat_dosi_kg_ha += product.quantitat_dosi_kg_ha;
      if (superficieM2 != null) {
        existing.quantitat_total_kg += product.quantitat_dosi_kg_ha * (superficieM2 / 10000);
      }
      productMap.set(key, existing);
    }
  }

  const productes = [...productMap.values()].map((row) => ({
    ...row,
    quantitat_dosi_kg_ha: round3(row.quantitat_dosi_kg_ha),
    quantitat_total_kg: round3(row.quantitat_total_kg),
  }));

  const irrigacioMm = day.sol.i_mm;
  const aiguaTotalL = superficieM2 != null ? irrigacioMm * superficieM2 : 0;

  const fertilitzantTotalKgHa = productes.reduce((acc, row) => acc + row.quantitat_dosi_kg_ha, 0);
  const fertilitzantTotalKg = productes.reduce((acc, row) => acc + row.quantitat_total_kg, 0);

  return {
    execucio_plantacio_dia_id: randomUUID(),
    dia_total_simulacio: day.dia_total_simulacio,
    data_iso: new Date(day.date_iso).toISOString(),
    fase_nom: phase.nom_fao,
    fase_producte_nom: [...productPhaseNames].join(' · '),
    irrigacio_lamina_mm: day.sol.i_mm,
    superficie_m2: superficieM2,
    aigua_total_l: round3(aiguaTotalL),
    aigua_total_m3: round3(aiguaTotalL / 1000),
    fertilitzant_total_kg_ha: round3(fertilitzantTotalKgHa),
    fertilitzant_total_kg: round3(fertilitzantTotalKg),
    productes,
  };
}

function buildPlanFromExecutionResult(params: {
  execucioId: string;
  plantacioId: string;
  plantacio: Awaited<ReturnType<typeof loadAll>>['plantacions'][number];
  cultiuId: string | null;
  cultiuNom: string | null;
  createdAt: string;
  result: Awaited<ReturnType<typeof getExecutionResultView>>;
  existingPlanId: string;
}): ExecutionPlantacioPlanView {
  const { execucioId, plantacioId, plantacio, cultiuId, cultiuNom, createdAt, result, existingPlanId } = params;
  
  if (!plantacio.amplada_real_m || !plantacio.llargada_real_m) throw new Error('La plantació no té dimensions reals per calcular el pla');
  const superficieM2 = computeSurfaceM2({
    llargada: plantacio.llargada_real_m,
    amplada: plantacio.amplada_real_m,
  });

  const dies: ExecutionPlanDayRow[] = [];
  
  if (!result.daily_timeline_by_phase || result.daily_timeline_by_phase.length === 0) throw new Error(`L'execució "${execucioId}" no té línia temporal diària per generar el pla`);

  for (const phase of result.daily_timeline_by_phase) {
    for (const day of phase.days) {
      dies.push(aggregateFertilizerRows({
        phase: { nom_fao: phase.nom_fao },
        day,
        superficieM2,
      }));
    }
  }

  const totals = dies.reduce((acc, day) => {
    acc.reg_total_mm += day.irrigacio_lamina_mm ?? 0;
    acc.aigua_total_l += day.aigua_total_l;
    acc.aigua_total_m3 += day.aigua_total_m3;
    acc.fertilitzant_total_kg_ha += day.fertilitzant_total_kg_ha;
    acc.fertilitzant_total_kg += day.fertilitzant_total_kg;
    return acc;
  }, {
    reg_total_mm: 0,
    aigua_total_l: 0,
    aigua_total_m3: 0,
    fertilitzant_total_kg_ha: 0,
    fertilitzant_total_kg: 0,
  });

  return {
    execucio_plantacio_id: existingPlanId,
    execucio_id: execucioId,
    plantacio_id: plantacioId,
    cultiu_id: cultiuId,
    cultiu_nom: cultiuNom,
    created_at: createdAt,
    llargada_real_m: plantacio.llargada_real_m ?? null,
    amplada_real_m: plantacio.amplada_real_m ?? null,
    superficie_m2: superficieM2,
    n_files: plantacio.n_files ?? null,
    n_columnes: plantacio.n_columnes ?? null,
    n_plantes_real: plantacio.n_plantes_real ?? null,
    reg_total_mm: round3(totals.reg_total_mm),
    aigua_total_l: round3(totals.aigua_total_l),
    aigua_total_m3: round3(totals.aigua_total_m3),
    fertilitzant_total_kg_ha: round3(totals.fertilitzant_total_kg_ha),
    fertilitzant_total_kg: round3(totals.fertilitzant_total_kg),
    dies_totals: dies.length,
    dies,
  };
}

// Genera el plan de una plantación para una ejecución dada, guardándolo en la base de datos
export async function generateExecutionPlantacioPlan(execucioId: string, plantacioId: string): Promise<ExecutionPlantacioPlanView> {
  const db = await loadAll(ENV.PATH);
  const exec = db.execucions.find((row) => row.execucio_id === execucioId) ?? null;
  if (!exec) throw new Error(`No s'ha trobat execucio_id "${execucioId}"`);
  const execEstat = String(exec.estat ?? '').toUpperCase();
  if (execEstat === 'RUNNING' || execEstat === 'QUEUED') {
    throw new Error(`No es pot generar el pla mentre l'execució "${execucioId}" està en estat ${execEstat}`);
  }

  const plantacio = db.plantacions.find((row) => row.plantacio_id === plantacioId) ?? null;
  if (!plantacio) throw new Error(`No s'ha trobat plantacio_id "${plantacioId}"`);
  if (plantacio.llargada_real_m == null || plantacio.amplada_real_m == null) {
    throw new Error(`La plantacio "${plantacioId}" no té llargada_real_m/amplada_real_m per calcular el pla`);
  }

  const cultiu = plantacio.cultiu_id
    ? db.cultius.find((row) => row.cultiu_id === plantacio.cultiu_id) ?? null
    : (exec.cultiu_id ? db.cultius.find((row) => row.cultiu_id === exec.cultiu_id) ?? null : null);

  const result = await getExecutionResultView(execucioId);
  const existing = db.execucioPlantacio.find(
    (row) => row.execucio_id === execucioId && row.plantacio_id === plantacioId,
  ) ?? null;
  const execucioPlantacioId = existing?.execucio_plantacio_id ?? randomUUID();
  const createdAt = existing?.created_at instanceof Date
    ? existing.created_at.toISOString()
    : existing?.created_at ?? new Date().toISOString();

  const plan = buildPlanFromExecutionResult({
    execucioId,
    plantacioId,
    plantacio,
    cultiuId: cultiu?.cultiu_id ?? null,
    cultiuNom: cultiu?.nom ?? null,
    createdAt,
    result,
    existingPlanId: execucioPlantacioId,
  });

  await upsertRow(ENV.PATH, 'execucio_plantacio', {
    pkColumns: 'execucio_plantacio_id',
    data: {
      execucio_plantacio_id: plan.execucio_plantacio_id,
      execucio_id: plan.execucio_id,
      plantacio_id: plan.plantacio_id,
      cultiu_id: plan.cultiu_id,
      llargada_real_m: plan.llargada_real_m,
      amplada_real_m: plan.amplada_real_m,
      superficie_m2: plan.superficie_m2,
      n_files: plan.n_files,
      n_columnes: plan.n_columnes,
      n_plantes_real: plan.n_plantes_real,
      reg_total_mm: plan.reg_total_mm,
      aigua_total_l: plan.aigua_total_l,
      aigua_total_m3: plan.aigua_total_m3,
      fertilitzant_total_kg_ha: plan.fertilitzant_total_kg_ha,
      fertilitzant_total_kg: plan.fertilitzant_total_kg,
      dies_totals: plan.dies_totals,
      created_at: plan.created_at,
      estat: 'SUCCESS',
    },
  });

  const existingDayIds = db.execucioPlantacioDia
    .filter((row) => row.execucio_plantacio_id === plan.execucio_plantacio_id)
    .map((row) => row.execucio_plantacio_dia_id);

  if (existingDayIds.length > 0) {
    await deleteRowsWhere(ENV.PATH, 'execucio_plantacio_dia_fertilitzant', {
      where: { execucio_plantacio_dia_id: existingDayIds },
    });
  }
  await deleteRowsWhere(ENV.PATH, 'execucio_plantacio_dia', {
    where: { execucio_plantacio_id: plan.execucio_plantacio_id },
  });

  for (const day of plan.dies) {
    await upsertRow(ENV.PATH, 'execucio_plantacio_dia', {
      pkColumns: 'execucio_plantacio_dia_id',
      data: {
        execucio_plantacio_dia_id: day.execucio_plantacio_dia_id,
        execucio_plantacio_id: plan.execucio_plantacio_id,
        dia_total_simulacio: day.dia_total_simulacio,
        data_iso: day.data_iso,
        fase_nom: day.fase_nom,
        fase_producte_nom: day.fase_producte_nom,
        irrigacio_lamina_mm: day.irrigacio_lamina_mm,
        superficie_m2: day.superficie_m2,
        aigua_total_l: day.aigua_total_l,
        aigua_total_m3: day.aigua_total_m3,
        fertilitzant_total_kg_ha: day.fertilitzant_total_kg_ha,
        fertilitzant_total_kg: day.fertilitzant_total_kg,
      },
    });

    for (const product of day.productes) {
      await upsertRow(ENV.PATH, 'execucio_plantacio_dia_fertilitzant', {
        pkColumns: 'execucio_plantacio_dia_fertilitzant_id',
        data: {
          execucio_plantacio_dia_fertilitzant_id: product.execucio_plantacio_dia_fertilitzant_id,
          execucio_plantacio_dia_id: day.execucio_plantacio_dia_id,
          producte_id: product.producte_id,
          producte_nom: product.producte_nom,
          quantitat_dosi_kg_ha: product.quantitat_dosi_kg_ha,
          quantitat_total_kg: product.quantitat_total_kg,
        },
      });
    }
  }

  return plan;
}

export async function getExecutionPlantacioPlanView(execucioId: string, plantacioId: string): Promise<ExecutionPlantacioPlanView> {
  const db = await loadAll(ENV.PATH);
  const plan = db.execucioPlantacio.find((row) => row.execucio_id === execucioId && row.plantacio_id === plantacioId);
  if (!plan) throw new Error(`No s'ha trobat cap pla per execucio_id="${execucioId}" i plantacio_id="${plantacioId}"`);

  const cultiu = db.cultius.find((row) => row.cultiu_id === plan.cultiu_id);

  const dayRows = db.execucioPlantacioDia
    .filter((row) => row.execucio_plantacio_id === plan.execucio_plantacio_id)
    .sort((a, b) => Number(a.dia_total_simulacio) - Number(b.dia_total_simulacio));

  const dayIds = new Set(dayRows.map((day) => day.execucio_plantacio_dia_id));
  const productRows = db.execucioPlantacioDiaFertilitzant.filter((row) => dayIds.has(row.execucio_plantacio_dia_id));

  const dies = dayRows.map((day) => ({
    execucio_plantacio_dia_id: day.execucio_plantacio_dia_id,
    dia_total_simulacio: day.dia_total_simulacio,
    data_iso: day.data_iso instanceof Date ? day.data_iso.toISOString() : String(day.data_iso ?? ''),
    fase_nom: day.fase_nom ?? '',
    fase_producte_nom: day.fase_producte_nom ?? '',
    irrigacio_lamina_mm: day.irrigacio_lamina_mm ?? 0,
    superficie_m2: day.superficie_m2 ?? null,
    aigua_total_l: day.aigua_total_l ?? 0,
    aigua_total_m3: day.aigua_total_m3 ?? 0,
    fertilitzant_total_kg_ha: day.fertilitzant_total_kg_ha ?? 0,
    fertilitzant_total_kg: day.fertilitzant_total_kg ?? 0,
    productes: productRows
      .filter((product) => product.execucio_plantacio_dia_id === day.execucio_plantacio_dia_id)
      .map((product) => ({
        execucio_plantacio_dia_fertilitzant_id: product.execucio_plantacio_dia_fertilitzant_id,
        producte_id: product.producte_id,
        producte_nom: product.producte_nom ?? null,
        quantitat_dosi_kg_ha: product.quantitat_dosi_kg_ha ?? 0,
        quantitat_total_kg: product.quantitat_total_kg ?? 0,
      })),
  }));

  return {
    execucio_plantacio_id: plan.execucio_plantacio_id,
    execucio_id: plan.execucio_id,
    plantacio_id: plan.plantacio_id,
    cultiu_id: plan.cultiu_id ?? null,
    cultiu_nom: cultiu?.nom ?? null,
    created_at: plan.created_at instanceof Date ? plan.created_at.toISOString() : String(plan.created_at ?? ''),
    estat: plan.estat ?? null,
    alarma: null,
    llargada_real_m: plan.llargada_real_m ?? null,
    amplada_real_m: plan.amplada_real_m ?? null,
    superficie_m2: plan.superficie_m2 ?? null,
    n_files: plan.n_files ?? null,
    n_columnes: plan.n_columnes ?? null,
    n_plantes_real: plan.n_plantes_real ?? null,
    reg_total_mm: plan.reg_total_mm ?? 0,
    aigua_total_l: plan.aigua_total_l ?? 0,
    aigua_total_m3: plan.aigua_total_m3 ?? 0,
    fertilitzant_total_kg_ha: plan.fertilitzant_total_kg_ha ?? 0,
    fertilitzant_total_kg: plan.fertilitzant_total_kg ?? 0,
    dies_totals: plan.dies_totals ?? dies.length,
    dies,
  };
}

// Inicia la generación del plan de una plantación para una ejecución dada
export async function createExecutionPlantacioPlanJob( execucioId: string, plantacioId: string): Promise<ExecutionPlantacioPlanJobResult> {
  const db = await loadAll(ENV.PATH);

  const exec = db.execucions.find((row) => row.execucio_id === execucioId);
  if (!exec) throw new Error(`No s'ha trobat execucio_id "${execucioId}"`);

  const execEstat = String(exec.estat ?? '').toUpperCase();
  if (execEstat !== 'SUCCESS') throw new Error(`No es pot generar el pla mentre l'execució "${execucioId}" està en estat ${execEstat}`);

  const plantacio = db.plantacions.find((row) => row.plantacio_id === plantacioId);
  if (!plantacio) throw new Error(`No s'ha trobat plantacio_id "${plantacioId}"`);

  const existing = db.execucioPlantacio.find((row) => row.execucio_id === execucioId && row.plantacio_id === plantacioId,);

  const execucioPlantacioId = existing?.execucio_plantacio_id ?? randomUUID();
  const createdAt = existing?.created_at instanceof Date ? existing.created_at.toISOString() : existing?.created_at ?? new Date().toISOString();

  if (plantacio.llargada_real_m == null || plantacio.amplada_real_m == null) throw new Error(`La plantacio "${plantacioId}" no té llargada_real_m/amplada_real_m per calcular el pla`);

  await upsertRow(ENV.PATH, 'execucio_plantacio', {
    pkColumns: 'execucio_plantacio_id',
    data: {
      execucio_plantacio_id: execucioPlantacioId,
      execucio_id: execucioId,
      plantacio_id: plantacioId,
      cultiu_id: plantacio.cultiu_id,
      llargada_real_m: plantacio.llargada_real_m,
      amplada_real_m: plantacio.amplada_real_m,
      superficie_m2: Number((plantacio.llargada_real_m * plantacio.amplada_real_m).toFixed(3)),
      n_files: plantacio.n_files,
      n_columnes: plantacio.n_columnes,
      n_plantes_real: plantacio.n_plantes_real,
      reg_total_mm: 0,
      aigua_total_l: 0,
      aigua_total_m3: 0,
      fertilitzant_total_kg_ha: 0,
      fertilitzant_total_kg: 0,
      dies_totals: 0,
      created_at: createdAt,
      estat: 'RUNNING',
    },
  });

  setImmediate(() => {
    void generateExecutionPlantacioPlan( execucioId, plantacioId ).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);

      console.error(`[EXEC-PLANTACIO-PLAN] execucio_plantacio_id=${execucioPlantacioId} error=${message}`);

      await upsertRow(ENV.PATH, 'execucio_plantacio', {
        pkColumns: 'execucio_plantacio_id',
        data: {
          execucio_plantacio_id: execucioPlantacioId,
          execucio_id: execucioId,
          plantacio_id: plantacioId,
          estat: 'FAILED',
          error_message: message,
          updated_at: new Date().toISOString(),
        },
      });
    });
  });

  return {
    execucio_plantacio_id: execucioPlantacioId,
    execucio_id: execucioId,
    plantacio_id: plantacioId,
    estat: 'RUNNING',
    async_started: true,
    message: `Generació del pla iniciada. execucio_plantacio_id=${execucioPlantacioId}`,
  };
}
