import { ENV } from '../../config/env';
import { loadAll } from '../../datasources/repository';
import { deleteRowsWhere } from '../../datasources/write';
import {
  computeKcDeterministic,
  computeZrDeterministic,
} from '../formulas/soil.formulas';
import { RegistreEsdevenimentTipus } from '../formulas/events.formulas';
import {
  addDays,
  normalizeDateOnlyIso,
  getDayIndexFromD0,
  getClimateRows,
} from './executions.service.utils';

type ExecutionPhaseDetail = {
  ordre_fao: number;
  fase_id: string;
  nom_fao: string;
  temps_dies_fao: number;
  kc_inicial: number;
  kc_final: number;
  zr_inicial_m: number;
  zr_final_m: number;
};

// Construye una lista de fases fenológicas con información detallada para una ejecución dada, ordenadas por su orden FAO
export function buildExecutionFasesDetall( db: Awaited<ReturnType<typeof loadAll>>, execucioId: string,): ExecutionPhaseDetail[] {
  const fasesExecucio = db.fasesFenologiquesExecucio.filter((f) => f.execucio_id === execucioId).sort((a, b) =>
        new Date(a.data_inici_fao).getTime() -
        new Date(b.data_inici_fao).getTime(),
    );

  if (fasesExecucio.length === 0) throw new Error(`No s'han trobat fases fenològiques per a execucio_id "${execucioId}"`);

  return fasesExecucio.map((f) => {
    const faseCat = db.fasesFenologiques.find((cat) => cat.fase_id === f.fase_id);
    if (!faseCat) throw new Error(`No s'ha trobat la fase fenològica "${f.fase_id}" per a execucio_id "${execucioId}"`);

    return {
      ordre_fao: faseCat.ordre_fao,
      fase_id: f.fase_id,
      nom_fao: faseCat.nom_fao,
      temps_dies_fao: f.temps_dies_fao,
      kc_inicial: faseCat.kc_inicial,
      kc_final: faseCat.kc_final,
      zr_inicial_m: faseCat.zr_inicial_m,
      zr_final_m: faseCat.zr_final_m,
    };
  });
}

// Construye una línea temporal diaria de la ejecución con información relevante para cada día
export function buildDailyTimelineByPhase(params: { db: Awaited<ReturnType<typeof loadAll>>, execucioId: string, fasesDetall: ExecutionPhaseDetail[], d0: Date }) {
  const { db, execucioId, fasesDetall, d0 } = params;

  // Se crea un map para acceder rápidamente a los detalles de las fases por su ID
  const phaseDetailById = new Map(fasesDetall.map((row) => [row.fase_id, row]));
  const phaseExecRows = db.fasesFenologiquesExecucio.filter((row) => row.execucio_id === execucioId).sort((a, b) => new Date(a.data_inici_fao).getTime() - new Date(b.data_inici_fao).getTime());
  const phaseByExecId = new Map(
    phaseExecRows.map((row) => {
      const start = new Date(row.data_inici_fao);
      const duration = Math.max(1, Math.ceil(Number(row.temps_dies_fao ?? 0)));
      const end = addDays(start, duration - 1);
      const detail = phaseDetailById.get(row.fase_id);
      if (!detail) throw new Error(`faseDetalls no trobats per fase_id: ${row.fase_id}`);

      return [
        row.fase_execucio_id,
        {
          fase_id: row.fase_id,
          nom_fao: detail.nom_fao,
          ordre_fao: detail.ordre_fao,
          duration,
          kc_inicial: detail.kc_inicial,
          kc_final: detail.kc_final,
          zr_inicial_m: detail.zr_inicial_m,
          zr_final_m: detail.zr_final_m,
          start,
          end,
        },
      ] as const;
    }),
  );

  // Para cada fase de producto en ejecución, se obtiene una lista de ventanas de producto con información relevante para la línea temporal diaria
  const productWindows = db.fasesProducteExecucio.filter((row) => phaseByExecId.has(row.fase_execucio_id)).map((row) => {
    const phase = phaseByExecId.get(row.fase_execucio_id);
    if (!phase) throw new Error(`No s'ha trobat la fase fenològica en execució per a fase_execucio_id "${row.fase_execucio_id}"`);
    const catExec = db.catalogFasesProducteExecucio.find((item) => item.producte_execucio_id === row.producte_execucio_id);
    if (!catExec) throw new Error(`No s'ha trobat el catàleg de fases de producte per a producte_execucio_id "${row.producte_execucio_id}"`);
    const cat = db.catalogFasesProducte.find((item) => item.cataleg_fase_producte_id === catExec.cataleg_fase_producte_id);
    if (!cat) throw new Error(`No s'ha trobat el catàleg de fases de producte per a cataleg_fase_producte_id "${catExec.cataleg_fase_producte_id}"`);
    const producte = db.catalogProductes.find((item) => item.producte_id === cat.producte_id);
    if (!producte) throw new Error(`No s'ha trobat el producte per a producte_id "${cat.producte_id}"`);
    const faseProducte = db.fasesProducte.find((item) => item.fase_producte_id === row.fase_producte_id);
    if (!faseProducte) throw new Error(`No s'ha trobat la fase de producte per a fase_producte_id "${row.fase_producte_id}"`);

    const start = new Date(row.data_inici_compo);
    const duration = Math.max(1, Math.ceil(Number(row.temps_dies_compo ?? 0)));
    const end = addDays(start, duration - 1);

    return {
      fase_id: phase.fase_id,
      fase_producte_id: row.fase_producte_id,
      fase_producte_nom: faseProducte.nom_fase_producte,
      producte_id: cat.producte_id,
      producte_nom: producte.nom,
      start,
      end,
    };
  });

  // Se crea un map con la información climática de cada día para acceder rápidamente durante la construcción de la línea temporal diaria
  const climateByDay = new Map( getClimateRows(db).filter((row: any) => row.execucio_id === execucioId).map((row: any) => [normalizeDateOnlyIso(new Date(row.inici)), row] as const));

  // Se crea un map con la información de eventos de irrigación y fertirrigación de cada día para acceder rápidamente durante la construcción de la línea temporal diaria
  const waterByEventId = new Map(db.aplicacionsAigua.map((row) => [row.esdeveniment_id, row] as const));
  const npkByEventId = new Map<string, typeof db.aplicacionsNpk>();
  for (const row of db.aplicacionsNpk) {
    const prev = npkByEventId.get(row.esdeveniment_id) ?? [];
    prev.push(row);
    npkByEventId.set(row.esdeveniment_id, prev);
  }

  // eventsByDay tendrá una entrada por cada día de la simulación que tenga eventos registrados, con la información de irrigación y fertirrigación aplicada ese día
  const eventsByDay = new Map<string, {
    irrigacio_lamina_mm: number;
    fertirrigacio: Array<{
      producte_id: string;
      producte_nom: string;
      quantitat_dosi_kg_ha: number;
    }>;
  }>();

  // Función auxiliar para agregar un evento a su bucket diario correspondiente en eventsByDay
  const appendEventToDayBucket = (eventRow: Awaited<ReturnType<typeof loadAll>>['registresEsdeveniment'][number]) => {
    const dayIso = normalizeDateOnlyIso(new Date(eventRow.donat_a));
    const bucket = eventsByDay.get(dayIso) ?? { irrigacio_lamina_mm: 0, fertirrigacio: [] };

    if (eventRow.tipus === RegistreEsdevenimentTipus.IRRIGACIO_APLICADA) {
      bucket.irrigacio_lamina_mm = waterByEventId.get(eventRow.esdeveniment_id)?.lamina_mm ?? 0;
    }

    if (eventRow.tipus === RegistreEsdevenimentTipus.FERTIRRIGACIO_APLICADA) {
      const npkRows = npkByEventId.get(eventRow.esdeveniment_id) ?? [];
      for (const npk of npkRows) {
        const producteNom = db.catalogProductes.find((row) => row.producte_id === npk.producte_id)?.nom;
        if (!producteNom) throw new Error(`No s'ha trobat el producte per a producte_id "${npk.producte_id}"`);

        bucket.fertirrigacio.push({
          producte_id: npk.producte_id,
          producte_nom: producteNom,
          quantitat_dosi_kg_ha: npk.quantitat_dosi_kg_ha,
        });
      }
    }

    eventsByDay.set(dayIso, bucket);
  };

  // Se recorren todos los eventos registrados para la ejecución, ordenados por fecha, y se agregan a su bucket diario correspondiente en eventsByDay
  const eventRows = db.registresEsdeveniment.filter((row) => row.execucio_id === execucioId).sort((a, b) => new Date(a.donat_a).getTime() - new Date(b.donat_a).getTime());
  for (const eventRow of eventRows) appendEventToDayBucket(eventRow);

  // Map para agrupar la información diaria por fase fenológica, con la estructura final que se quiere construir en la línea temporal diaria de la ejecución
  const phaseGroups = new Map<string, {
    fase_id: string;
    nom_fao: string;
    ordre_fao: number;
    days: Array<{
      dia_total_simulacio: number;
      date_iso: string;
      clima: {
        temperatura_2m_c: number;
        humitat_2m: number;
        precipitacions_mm: number;
        et0_mm: number;
      };
      sol: {
        ph: number;
        humitat_sol_pct: number;
        p_depletion_fraction: number;
        temperatura_sol_c: number;
        ec_ms_cm: number;
        tds_ppm: number;
        n_sol_ppm: number;
        p_sol_ppm: number;
        k_sol_ppm: number;
        dr_mm: number;
        raw_mm: number;
        i_mm: number;
        kc: number;
        zr_m: number;
        etc_mm: number;
      };
      esdeveniments: {
        irrigacio_lamina_mm: number;
        fertirrigacio_total: number;
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
    }>;
  }>();

  // Se recorren todos los días de la simulación para construir la línea temporal diaria 
  // asignando a cada día su fase fenológica activa, su información climática, su información de eventos y su información de productos aplicados ese día
  const soilRows = db.solSimulacio.filter((row: any) => row.execucio_id === execucioId).sort((a: any, b: any) => new Date(a.inici).getTime() - new Date(b.inici).getTime());
  for (const soilRow of soilRows) {
    const date = new Date(soilRow.inici);
    const dateIso = normalizeDateOnlyIso(date);
    const dayIndex = getDayIndexFromD0(d0, date);

    // Fase fenológica que está activa el día actual
    const activePhase = phaseExecRows.find((row) => {
      const start = new Date(row.data_inici_fao);
      const duration = Math.ceil(row.temps_dies_fao)
      const end = addDays(start, duration - 1);
      return date.getTime() >= start.getTime() && date.getTime() <= end.getTime();
    });
    if (!activePhase) throw new Error(`No s'ha trobat la fase fenològica activa per al dia ${dayIndex} (${dateIso}) en la simulació amb execucio_id "${execucioId}"`);

    // Detalles de la fase fenológica activa
    const phaseDetail = phaseDetailById.get(activePhase.fase_id);
    if (!phaseDetail) throw new Error(`No s'ha trobat el detall de la fase fenològica per a fase_id "${activePhase.fase_id}" en la simulació amb execucio_id "${execucioId}"`);
    
    // Información que se necesita de la fase activa
    const phaseGroup = phaseGroups.get(activePhase.fase_id) ?? {
      fase_id: activePhase.fase_id,
      nom_fao: phaseDetail.nom_fao,
      ordre_fao: phaseDetail.ordre_fao,
      days: [],
    };

    // Información climática del día actual y bucket de eventos (irrigación y fertirrigación) del día actual
    const climate = climateByDay.get(dateIso);
    if (!climate) throw new Error(`No s'ha trobat la informació climàtica per al dia ${dayIndex} (${dateIso}) en la simulació amb execucio_id "${execucioId}"`);
    const eventBucket = eventsByDay.get(dateIso) ?? {
      irrigacio_lamina_mm: 0,
      fertirrigacio: [],
    };

    const productGroups = new Map<string, {
      fase_producte_id: string;
      fase_producte_nom: string;
      productes: Array<{
        producte_id: string;
        producte_nom: string;
        quantitat_dosi_kg_ha: number;
      }>;
    }>();

    const activeWindowsForDay = productWindows.filter((item) => item.fase_id === activePhase.fase_id && date.getTime() >= item.start.getTime() && date.getTime() <= item.end.getTime());
    const uniqueActiveProductPhaseIds = [...new Set(activeWindowsForDay.map((item) => item.fase_producte_id))];
    if (uniqueActiveProductPhaseIds.length > 1)
      throw new Error(
        `Solapament de fases de producte detectat el dia ${dayIndex} (${dateIso}) en la fase fenològica ${phaseGroup.nom_fao}. ` +
        `Fases de producte actives: ${uniqueActiveProductPhaseIds.join(', ')}`,
      );

      // Se crean grupos para cada fase de producto activa ese día, aunque no tengan eventos de fertirrigación asignados
      for (const window of activeWindowsForDay) {
      productGroups.set(window.fase_producte_id, {
        fase_producte_id: window.fase_producte_id,
        fase_producte_nom: window.fase_producte_nom,
        productes: [],
      });
    }

    // Si hay fertirrigación aplicada ese día, se asigna a la fase de producto activa correspondiente
    for (const fert of eventBucket.fertirrigacio) {
      const candidateWindows = activeWindowsForDay.filter((item) => item.producte_id === fert.producte_id).sort((a, b) => b.start.getTime() - a.start.getTime());
      const window = candidateWindows[0];

      // Si no hay ventana activa para este producto, evitamos romper la vista del resultado.
      if (!window) {
        console.warn(
          `[buildDailyTimelineByPhase] No active product window for producte_id="${fert.producte_id}" ` +
          `on dia=${dayIndex} (${dateIso}) in execucio_id="${execucioId}"`,
        );
        continue;
      }

      const existing = productGroups.get(window.fase_producte_id);
      if (!existing) {
        throw new Error(
          `No s'ha trobat grup de fase de producte "${window.fase_producte_id}" ` +
          `per al producte "${fert.producte_id}" el dia ${dayIndex} (${dateIso}).`,
        );
      }

      existing.productes.push({
        producte_id: fert.producte_id,
        producte_nom: fert.producte_nom,
        quantitat_dosi_kg_ha: fert.quantitat_dosi_kg_ha,
      });
    }

    // Calcular kc y zr para el día actual dentro de la fase fenológica activa
    const activePhaseRuntime = phaseByExecId.get(activePhase.fase_execucio_id);
    if (!activePhaseRuntime) throw new Error(`No s'ha trobat la fase fenològica en execució per a fase_execucio_id "${activePhase.fase_execucio_id}"`);
    const dayOffsetWithinPhase = Math.max(0, Math.floor((date.getTime() - activePhaseRuntime.start.getTime()) / (1000 * 60 * 60 * 24)));
    const diaFase = dayOffsetWithinPhase + 1;
    const kcForDay = computeKcDeterministic({
      kc_inicial: activePhaseRuntime.kc_inicial,
      kc_final: activePhaseRuntime.kc_final,
      dia_fase: diaFase,
      temps_dies_fao: activePhaseRuntime.duration,
    });
    const zrForDay = computeZrDeterministic({
      zr_inicial_m: activePhaseRuntime.zr_inicial_m,
      zr_final_m: activePhaseRuntime.zr_final_m,
      dia_fase: diaFase,
      temps_dies_fao: activePhaseRuntime.duration,
    });

    if (typeof soilRow.p !== 'number') throw new Error(`La fila de sol_simulacio del dia ${dayIndex} (${dateIso}) no té p vàlid`,);

    phaseGroup.days.push({
      dia_total_simulacio: dayIndex,
      date_iso: dateIso,
      clima: {
          temperatura_2m_c: climate.temperatura_2m_c,
          humitat_2m: climate.humitat_2m,
          precipitacions_mm: climate.precipitacions_mm,
          et0_mm: climate.et0_mm,
        },
      sol: {
        ph: soilRow.ph,
        humitat_sol_pct: soilRow.humitat_sol_pct,
        p_depletion_fraction: soilRow.p,
        temperatura_sol_c: soilRow.temperatura_sol_c,
        ec_ms_cm: soilRow.ec_ms_cm,
        tds_ppm: soilRow.tds_ppm,
        n_sol_ppm: soilRow.n_sol_ppm,
        p_sol_ppm: soilRow.p_sol_ppm,
        k_sol_ppm: soilRow.k_sol_ppm,
        dr_mm: soilRow.dr_mm,
        raw_mm: soilRow.raw_mm,
        i_mm: soilRow.i_mm ?? 0,
        kc: kcForDay,
        zr_m: zrForDay,
        etc_mm: soilRow.etc_mm,
      },
      esdeveniments: {
        irrigacio_lamina_mm: eventBucket.irrigacio_lamina_mm,
        fertirrigacio_total: eventBucket.fertirrigacio.length,
        fase_producte: [...productGroups.values()],
      },
    });
    phaseGroups.set(activePhase.fase_id, phaseGroup);
  }

  return [...phaseGroups.values()]
    .sort((a, b) => a.ordre_fao - b.ordre_fao)
    .map((phase) => ({
      ...phase,
      days: [...phase.days].sort((a, b) => a.dia_total_simulacio - b.dia_total_simulacio),
    }));
}

// Obtener los datos de execucio_simulada para un ID dado
export async function getExecution(id: string) {
  const db = await loadAll(ENV.PATH);
  return db.execucions.find((e) => e.execucio_id === id) ?? null;
}

// Determina el estado efectivo de la ejecución
export function resolveEffectiveEstat( execEstat: string, hasAlarms: boolean,
): 'INITIALIZING' | 'RUNNING' | 'FAILED' | 'SUCCESS' {
  if (hasAlarms || execEstat === 'FAILED') return 'FAILED';
  if (execEstat === 'RUNNING') return 'RUNNING';
  if (execEstat === 'INITIALIZING') return 'INITIALIZING';
  return 'SUCCESS';
}

// Recupera la información detallada de una ejecución, incluyendo fases y alarmas
export async function getExecutionResultView(execucioId: string) {
  const db = await loadAll(ENV.PATH);
  const exec = db.execucions.find((e) => e.execucio_id === execucioId) ?? null;
  if (!exec) throw new Error(`No s'ha trobat l'execució "${execucioId}"`);
  const d0 = new Date(exec.temps_simulat_inici);

  const alarms = db.alarmes
    .filter((a) => a.execucio_id === execucioId)
    .sort((a, b) => (b.dia_total_simulacio ?? 0) - (a.dia_total_simulacio ?? 0));
  const alarmsView = alarms.map((alarm) => ({
    alarma_id: alarm.alarma_id,
    tipus_alarma: alarm.tipus_alarma,
    estat: alarm.estat,
    motiu: alarm.motiu ?? null,
    fase_id: alarm.fase_id ?? null,
    fase_nom: alarm.fase_nom ?? null,
    dia_total_simulacio: alarm.dia_total_simulacio ?? null,
    dia_fase: alarm.dia_fase ?? null,
    dia_iso: alarm.dia_total_simulacio == null
      ? null
      : normalizeDateOnlyIso(addDays(d0, Math.max(alarm.dia_total_simulacio, 0))),
  }));

  const fases = buildExecutionFasesDetall(db, execucioId);
  const dailyTimelineByPhase = buildDailyTimelineByPhase({ db, execucioId, fasesDetall: fases, d0: new Date(exec.temps_simulat_inici) });

  const effectiveEstat = resolveEffectiveEstat(exec.estat, alarms.length > 0);

  return {
    execucio_id: exec.execucio_id,
    estat: effectiveEstat,
    temps_simulat_inici: exec.temps_simulat_inici,
    dia_actual_simulacio: exec.dia_actual_simulacio,
    fases_inicialitzades: fases.length,
    fases_detall: fases,
    daily_timeline_by_phase: dailyTimelineByPhase,
    alarmes: alarmsView,
  };
}

// Formatear correctamente los valores de las celdas en CSV, manejando comillas y caracteres especiales
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let raw = '';
  if (typeof value === 'string') {
    raw = value;
  } else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    raw = `${value}`;
  } else {
    raw = JSON.stringify(value);
  }
  if (/[",\n\r]/.test(raw)) {
    return `"${raw.replaceAll('"', '""')}"`;
  }
  return raw;
}

// Convierte un array de objetos en formato clave-valor a CSV
export function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) {
    return 'execucio_id,estat\n';
  }

  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];

  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row[header])).join(','));
  }

  return lines.join('\n');
}

// Construye las filas del dataset para un día dado, expandiendo por fases de producto y eventos asociados
export function buildDatasetRowsForDay(params: {
  phase: {
    nom_fao: string;
  };
  day: {
    dia_total_simulacio: number;
    date_iso: string;
    clima: {
      temperatura_2m_c: number;
      humitat_2m: number;
      precipitacions_mm: number;
      et0_mm: number;
    };
    sol: {
      ph: number;
      humitat_sol_pct: number;
      p_depletion_fraction: number;
      temperatura_sol_c: number;
      ec_ms_cm: number;
      tds_ppm: number;
      n_sol_ppm: number;
      p_sol_ppm: number;
      k_sol_ppm: number;
      dr_mm: number;
      raw_mm: number;
      kc: number;
      zr_m: number;
      etc_mm: number;
    };
    esdeveniments: {
      irrigacio_lamina_mm: number;
      fertirrigacio_total: number;
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
}): Array<Record<string, unknown>> {
  const { phase, day } = params;
  const groups = day.esdeveniments.fase_producte.length > 0
    ? day.esdeveniments.fase_producte
    : [{ fase_producte_id: '', fase_producte_nom: 'Sense fase de producte', productes: [] }];

  return groups.map((group) => ({
    dia_total_simulacio: day.dia_total_simulacio,
    date_iso: day.date_iso,
    fase_fenologica_nom: phase.nom_fao,
    fase_producte_nom: group.fase_producte_nom,
    clima_temperatura_2m_c: day.clima?.temperatura_2m_c ?? null,
    clima_humitat_2m: day.clima?.humitat_2m ?? null,
    clima_precipitacions_mm: day.clima?.precipitacions_mm ?? null,
    clima_et0_mm: day.clima?.et0_mm ?? null,
    sol_ph: day.sol.ph,
    sol_humitat_sol_pct: day.sol.humitat_sol_pct,
    sol_temperatura_sol_c: day.sol.temperatura_sol_c,
    sol_ec_ms_cm: day.sol.ec_ms_cm,
    sol_tds_ppm: day.sol.tds_ppm,
    sol_n_sol_ppm: day.sol.n_sol_ppm,
    sol_p_sol_ppm: day.sol.p_sol_ppm,
    sol_k_sol_ppm: day.sol.k_sol_ppm,
    sol_p_depletion_fraction: day.sol.p_depletion_fraction,
    terminal_dr_mm: day.sol.dr_mm,
    terminal_raw_mm: day.sol.raw_mm,
    terminal_kc: day.sol.kc,
    terminal_zr_m: day.sol.zr_m,
    sol_etc_mm: day.sol.etc_mm,
    irrigacio_lamina_l_m3: day.esdeveniments.irrigacio_lamina_mm,
    fertirrigacio_detall_grup_json: JSON.stringify(
      group.productes.map((product) => ({
        nom_producte: product.producte_nom ?? product.producte_id,
        quantitat_a_aplicar_kg_ha: product.quantitat_dosi_kg_ha,
      })),
    ),
  }));
}

// Construye una fila vacía con todas las columnas del dataset para casos sin datos
export function buildEmptyDatasetRow(): Record<string, unknown> {
  return {
    dia_total_simulacio: '',
    date_iso: '',
    fase_fenologica_nom: '',
    fase_producte_nom: '',
    clima_temperatura_2m_c: '',
    clima_humitat_2m: '',
    clima_precipitacions_mm: '',
    clima_et0_mm: '',
    sol_ph: '',
    sol_humitat_sol_pct: '',
    sol_temperatura_sol_c: '',
    sol_ec_ms_cm: '',
    sol_tds_ppm: '',
    sol_n_sol_ppm: '',
    sol_p_sol_ppm: '',
    sol_k_sol_ppm: '',
    sol_p_depletion_fraction: '',
    terminal_dr_mm: '',
    terminal_raw_mm: '',
    terminal_kc: '',
    terminal_zr_m: '',
    sol_etc_mm: '',
    irrigacio_lamina_l_m3: '',
    fertirrigacio_detall_grup_json: '',
  };
}

// Construye un CSV con la evolución diaria de clima, suelo y eventos para una ejecución dada
export async function getExecutionDatasetCsv(execucioId: string) {
  const result = await getExecutionResultView(execucioId);

  const rows: Array<Record<string, unknown>> = [];
  for (const phase of result.daily_timeline_by_phase ?? []) {
    for (const day of phase.days) {
      rows.push(
        ...buildDatasetRowsForDay({
          phase,
          day,
        }),
      );
    }
  }

  if (rows.length === 0) {
    rows.push(buildEmptyDatasetRow());
  }

  const safeExecucioId = String(result.execucio_id).replaceAll(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `simulacio_${safeExecucioId}_${result.estat.toLowerCase()}_dataset.csv`;
  return {
    filename,
    csv: toCsv(rows),
  };
}

// Recupera una lista de ejecuciones con información resumida para cada una, ordenadas por fecha de inicio simulada (más reciente primero)
export async function listExecutions() {
  const db = await loadAll(ENV.PATH);

  const sorted = [...db.execucions].sort((a, b) =>
      new Date(b.temps_simulat_inici).getTime() -
      new Date(a.temps_simulat_inici).getTime(),
  );

  return sorted.map((exec) => {
    const cultiu = exec.cultiu_id ? db.cultius.find((c) => c.cultiu_id === exec.cultiu_id) ?? null : null;
    const sol = exec.sol_id ? db.sols.find((s) => s.sol_id === exec.sol_id) ?? null : null;
    const ubicacio = sol?.ubicacio_id ? db.ubicacions.find((u) => u.ubicacio_id === sol.ubicacio_id) ?? null : null;
    const firstSoilState = db.solSimulacio
      .filter((s) => s.execucio_id === exec.execucio_id)
      .sort(
        (a, b) =>
          new Date(a.inici).getTime() -
          new Date(b.inici).getTime(),
      )[0] ?? null;
    const executionAlarms = db.alarmes.filter((a) => a.execucio_id === exec.execucio_id);
    const firstAlarm = executionAlarms[0] ?? null;
    const effectiveStatus = resolveEffectiveEstat(exec.estat, executionAlarms.length > 0);

    return {
      execucio_id: exec.execucio_id,
      estat: effectiveStatus,
      temps_simulat_inici: exec.temps_simulat_inici,
      dia_actual_simulacio: exec.dia_actual_simulacio ?? null,

      cultiu_id: cultiu?.cultiu_id ?? exec.cultiu_id ?? null,
      cultiu: cultiu
        ? {
            cultiu_id: cultiu.cultiu_id,
            nom: cultiu.nom,
          }
        : null,

      ubicacio: ubicacio
        ? {
            nom: ubicacio.nom,
            latitut: ubicacio.latitut,
            longitut: ubicacio.longitut,
          }
        : null,

      latitut: ubicacio?.latitut ?? null,
      longitut: ubicacio?.longitut ?? null,

      ph: firstSoilState?.ph ?? null,
      ec_ms_cm: firstSoilState?.ec_ms_cm ?? null,
      tds_ppm: firstSoilState?.tds_ppm ?? null,
      humitat_sol_pct: firstSoilState?.humitat_sol_pct ?? null,
      temperatura_sol_c: firstSoilState?.temperatura_sol_c ?? null,
      n_sol_ppm: firstSoilState?.n_sol_ppm ?? null,
      p_sol_ppm: firstSoilState?.p_sol_ppm ?? null,
      k_sol_ppm: firstSoilState?.k_sol_ppm ?? null,

      failed_info: firstAlarm
        ? {
            motiu: firstAlarm.motiu ?? null,
            dia_total_simulacio: firstAlarm.dia_total_simulacio ?? null,
            fase_nom: firstAlarm.fase_nom ?? null,
          }
        : null,
    };
  });
}

// Recupera la información necesaria para reutilizar la configuración de una ejecución existente
export async function getExecutionReuseInput(id: string) {
  const db = await loadAll(ENV.PATH);

  const exec = db.execucions.find((e) => e.execucio_id === id) ?? null;
  if (!exec) throw new Error(`No s'ha trobat l'execució "${id}"`);

  const firstSoilState = db.solSimulacio.filter((s) => s.execucio_id === id).sort((a, b) => new Date(a.inici).getTime() - new Date(b.inici).getTime())[0] ?? null;
  if (!firstSoilState) throw new Error(`L'execució "${id}" no té estat inicial de sòl en sol_simulacio.`);

  const sol = (exec.sol_id ? db.sols.find((s) => s.sol_id === exec.sol_id) : null) ?? db.sols.find((s) => s.sol_id === firstSoilState.sol_id) ?? null;
  if (!sol) throw new Error(`No s'ha trobat sòl per a execucio_id "${id}"`);

  const ubicacio = db.ubicacions.find((u) => u.ubicacio_id === sol.ubicacio_id) ?? null;
  if (!ubicacio) throw new Error(`No s'ha trobat ubicacio_id "${sol.ubicacio_id}"`);

  const cultiu = db.cultius.find((c) => c.cultiu_id === exec.cultiu_id) ?? null;
  if (!cultiu) throw new Error(`No s'ha trobat el cultiu "${exec.cultiu_id}"`);

  const soilPreview = {
    sand: sol.sand ?? null,
    silt: sol.sand != null && sol.clay != null ? Number((100 - sol.sand - sol.clay).toFixed(3)) : null,
    clay: sol.clay ?? null,
    soc: sol.soc ?? null,
    densitat_aparent_kg_m3: sol.densitat_aparent_kg_m3 ?? null,
    fc: sol.fc ?? null,
    wp: sol.wp ?? null,
    nom_tipus_sol: sol.nom_tipus_sol ?? null,
    tipus_gra: sol.tipus_gra ?? null,
  };

  return {
    cultiu_id: cultiu.cultiu_id,
    cultiu_nom: cultiu.nom,

    latitut: ubicacio.latitut,
    longitut: ubicacio.longitut,
    nom_ubicacio: ubicacio.nom,

    soil_preview: soilPreview,

    temps_simulat_inici: new Date(exec.temps_simulat_inici).toISOString().slice(0, 10),

    ph: firstSoilState.ph,
    ec_ms_cm: firstSoilState.ec_ms_cm,
    tds_ppm: firstSoilState.tds_ppm,
    humitat_sol_pct: firstSoilState.humitat_sol_pct,
    temperatura_sol_c: firstSoilState.temperatura_sol_c,
    n_sol_ppm: firstSoilState.n_sol_ppm,
    p_sol_ppm: firstSoilState.p_sol_ppm,
    k_sol_ppm: firstSoilState.k_sol_ppm,
  };
}

// Eliminar una ejecución y todos sus datos relacionados
export async function deleteExecution(id: string) {
  const db = await loadAll(ENV.PATH);
  const exec = db.execucions.find((e) => e.execucio_id === id) ?? null;
  if (!exec) throw new Error(`No s'ha trobat l'execució "${id}"`);

  // Para eliminar una ejecución, primero se identifican todas las filas relacionadas en otras tablas
  const faseExecIds = db.fasesFenologiquesExecucio.filter((f) => f.execucio_id === id).map((f) => f.fase_execucio_id);
  const producteExecIds = db.fasesProducteExecucio.filter((p) => faseExecIds.includes(p.fase_execucio_id)).map((p) => p.producte_execucio_id);
  const eventIds = db.registresEsdeveniment.filter((e) => e.execucio_id === id).map((e) => e.esdeveniment_id);

  // Luego se eliminan todas las filas relacionadas, contando cuántas se eliminan en total
  let deleted = 0;
  deleted += await deleteRowsWhere(ENV.PATH, 'cataleg_fase_producte_execucio', { where: { producte_execucio_id: producteExecIds } });
  deleted += await deleteRowsWhere(ENV.PATH, 'fase_producte_execucio', { where: { fase_execucio_id: faseExecIds } });
  deleted += await deleteRowsWhere(ENV.PATH, 'fase_fenologica_execucio', { where: { execucio_id: id } });
  deleted += await deleteRowsWhere(ENV.PATH, 'aplicacio_aigua', { where: { esdeveniment_id: eventIds } });
  deleted += await deleteRowsWhere(ENV.PATH, 'aplicacio_npk', { where: { esdeveniment_id: eventIds } });
  deleted += await deleteRowsWhere(ENV.PATH, 'registre_esdeveniment', { where: { execucio_id: id } });
  deleted += await deleteRowsWhere(ENV.PATH, 'clima_simulacio', { where: { execucio_id: id } });
  deleted += await deleteRowsWhere(ENV.PATH, 'sol_simulacio', { where: { execucio_id: id } });
  deleted += await deleteRowsWhere(ENV.PATH, 'alarma_esdeveniment', { where: { execucio_id: id } });
  deleted += await deleteRowsWhere(ENV.PATH, 'execucio_simulada', { where: { execucio_id: id } });

  return { execucio_id: id, deleted_rows: deleted };
}
