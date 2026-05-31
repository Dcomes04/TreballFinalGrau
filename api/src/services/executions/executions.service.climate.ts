import { randomUUID } from 'node:crypto';
import { ENV } from '../../config/env';
import { loadAll } from '../../datasources/repository';
import { upsertRow } from '../../datasources/write';
import { fetchDayClimate } from '../../integrations/openMeteo.client';
import {
  addDays,
  getClimateRows,
  normalizeDateOnlyIso,
  sameUtcDay,
} from './executions.service.utils';

// Función para obtener el clima de un día específico para una ejecución, o crear la entrada en la base de datos si no existe
export async function getOrCreateClimateForDay(params: {
  db: Awaited<ReturnType<typeof loadAll>>;
  execucioId: string;
  ubicacioId: string;
  ubicacio: { latitut: number; longitut: number };
  targetDate: Date;
}) {
  const { db, execucioId, ubicacioId, ubicacio, targetDate } = params;

  // Intentar encontrar una fila de clima_simulacio existente para la ejecución y día objetivo
  const existing = getClimateRows(db).find((row: any) => row.execucio_id === execucioId && sameUtcDay(row.inici, targetDate)) ?? null;
  if (existing) {
    return {
      temperatura_2m_c: existing.temperatura_2m_c,
      humitat_2m: existing.humitat_2m,
      precipitacions_mm: existing.precipitacions_mm,
      radiacio_solar_mj_m2: existing.radiacio_solar_mj_m2,
      et0_mm: existing.et0_mm,
      wind_speed_10m: existing.wind_speed_10m ?? 0,
    } as Awaited<ReturnType<typeof fetchDayClimate>>;
  }

  // Si no existe, obtener el clima del día objetivo usando la API externa OpenMeteo
  const climate = await fetchDayClimate( ubicacio.latitut, ubicacio.longitut, targetDate);

  // Persistir el clima obtenido para esta ejecución y día en la tabla clima_simulacio
  await upsertRow(ENV.PATH, 'clima_simulacio', {
    pkColumns: ['execucio_id', 'inici'],
    data: {
      clima_id: randomUUID(),
      execucio_id: execucioId,
      ubicacio_id: ubicacioId,
      temperatura_2m_c: climate.temperatura_2m_c,
      humitat_2m: climate.humitat_2m,
      precipitacions_mm: climate.precipitacions_mm,
      radiacio_solar_mj_m2: climate.radiacio_solar_mj_m2,
      et0_mm: climate.et0_mm,
      wind_speed_10m: climate.wind_speed_10m,
      inici: normalizeDateOnlyIso(targetDate),
      final: normalizeDateOnlyIso(addDays(targetDate, 1)),
    },
  });

  return climate;
}

// Función para persistir el clima de un día específico para una ejecución dada, asumiendo que ya se ha obtenido el clima
export async function persistClimateForDay(params: { execucioId: string; ubicacioId: string; targetDate: Date; climate: Awaited<ReturnType<typeof fetchDayClimate>> }) {
  const { execucioId, ubicacioId, targetDate, climate } = params;

  await upsertRow(ENV.PATH, 'clima_simulacio', {
    pkColumns: ['execucio_id', 'inici'],
    data: {
      clima_id: randomUUID(),
      execucio_id: execucioId,
      ubicacio_id: ubicacioId,
      temperatura_2m_c: climate.temperatura_2m_c,
      humitat_2m: climate.humitat_2m,
      precipitacions_mm: climate.precipitacions_mm,
      radiacio_solar_mj_m2: climate.radiacio_solar_mj_m2,
      et0_mm: climate.et0_mm,
      wind_speed_10m: climate.wind_speed_10m,
      inici: normalizeDateOnlyIso(targetDate),
      final: normalizeDateOnlyIso(addDays(targetDate, 1)),
    },
  });
}