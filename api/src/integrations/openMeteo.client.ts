interface OpenMeteoDaily {
  time: string[];
  temperature_2m_mean: (number | null)[];
  temperature_2m_min: (number | null)[];
  temperature_2m_max: (number | null)[];
  relative_humidity_2m_mean: (number | null)[];
  wind_speed_10m_max: (number | null)[];
  precipitation_sum: (number | null)[];
  et0_fao_evapotranspiration: (number | null)[];
  shortwave_radiation_sum: (number | null)[];
}

interface OpenMeteoResponse {
  daily: OpenMeteoDaily;
}

export interface AnnualSurfaceThermalStats {
  temperatura_mitjana_superficial_anual_c: number;
  amplitud_termica_superficial_anual_c: number;
  dies_valids: number;
}

// Resultado diario normalizado al formato interno de la simulación
export interface DayClimate {
  temperatura_2m_c: number;
  temperatura_min_2m_c: number;
  temperatura_max_2m_c: number;
  humitat_2m: number;
  wind_speed_10m: number;
  precipitacions_mm: number;
  et0_mm: number;
  radiacio_solar_mj_m2: number;
}

// Convierte un objeto Date a string ISO con formato YYYY-MM-DD (UTC)
function toIsoDateUTC(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Función para comparar valores numéricos con cierta tolerancia
export function requireValidCoords(latitut: number, longitut: number): void {
  if (!Number.isFinite(latitut) || latitut < -90 || latitut > 90) {
    throw new Error(`Latitud invàlida: ${latitut}`);
  }

  if (!Number.isFinite(longitut) || longitut < -180 || longitut > 180) {
    throw new Error(`Longitud invàlida: ${longitut}`);
  }
}

// Función para realizar fetch con timeout y parseo JSON
async function fetchTextJson(url: string, label: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch(url, { signal: controller.signal });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${label} error ${res.status}: ${text.slice(0, 200)}`);
    }

    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

const DAILY_VARS = [
  'temperature_2m_mean',
  'temperature_2m_min',
  'temperature_2m_max',
  'relative_humidity_2m_mean',
  'wind_speed_10m_max',
  'precipitation_sum',
  'et0_fao_evapotranspiration',
  'shortwave_radiation_sum',
].join(',');

// Valida que Open-Meteo haya devuelto valor para la fecha solicitada
function requireDailyValue( arr: (number | null)[] | undefined, fieldName: string, dateStr: string): number {
  const value = arr?.[0];
  if (value == null) {
    throw new Error(`Open-Meteo sin valor obligatorio "${fieldName}" para ${dateStr}.`);
  }

  if (!Number.isFinite(value)) {
    throw new Error(`Open-Meteo valor no finito "${fieldName}" para ${dateStr}: ${value}.`);
  }

  return value;
}

// Función para obtener el clima diario de Open-Meteo dado latitud, longitud y fecha
export async function fetchDayClimate( latitut: number, longitut: number, date: Date): Promise<DayClimate> {
  requireValidCoords(latitut, longitut);
  const dateStr = toIsoDateUTC(date);
  const todayStr = toIsoDateUTC(new Date());

  const base = dateStr < todayStr ? 'https://archive-api.open-meteo.com/v1/archive' : 'https://api.open-meteo.com/v1/forecast';
  const url = `${base}?latitude=${latitut}&longitude=${longitut}&start_date=${dateStr}&end_date=${dateStr}&daily=${DAILY_VARS}&timezone=auto`;

  const json = (await fetchTextJson(url, 'Open-Meteo')) as OpenMeteoResponse;
  const d = json.daily;
  const tMin = requireDailyValue(d.temperature_2m_min, 'temperature_2m_min', dateStr);
  const tMax = requireDailyValue(d.temperature_2m_max, 'temperature_2m_max', dateStr);
  const tMean = requireDailyValue(d.temperature_2m_mean, 'temperature_2m_mean', dateStr);
  const humitat2m = requireDailyValue(d.relative_humidity_2m_mean, 'relative_humidity_2m_mean', dateStr);
  const wind10m = requireDailyValue(d.wind_speed_10m_max, 'wind_speed_10m_max', dateStr);
  const precipitacions = requireDailyValue(d.precipitation_sum, 'precipitation_sum', dateStr);
  const et0 = requireDailyValue(d.et0_fao_evapotranspiration, 'et0_fao_evapotranspiration', dateStr);
  const radiacio = requireDailyValue(d.shortwave_radiation_sum, 'shortwave_radiation_sum', dateStr);

  return {
    temperatura_2m_c: tMean,
    temperatura_min_2m_c: tMin,
    temperatura_max_2m_c: tMax,
    humitat_2m: humitat2m,
    wind_speed_10m: wind10m,
    precipitacions_mm: precipitacions,
    et0_mm: et0,
    radiacio_solar_mj_m2: radiacio,
  };
}

// Función para obtener las estadísticas térmicas superficiales anuales de Open-Meteo dado latitud, longitud y fecha de referencia
export async function fetchAnnualSurfaceThermalStats( latitut: number, longitut: number, referenceDate: Date): Promise<AnnualSurfaceThermalStats> {
  requireValidCoords(latitut, longitut);
  const end = new Date(referenceDate);
  end.setUTCDate(end.getUTCDate() - 1);

  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 364);

  const startDate = toIsoDateUTC(start);
  const endDate = toIsoDateUTC(end);

  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${latitut}&longitude=${longitut}&start_date=${startDate}&end_date=${endDate}&daily=temperature_2m_mean&timezone=auto`;

  const json = (await fetchTextJson(url, 'Open-Meteo annual stats')) as OpenMeteoResponse;
  const means = (json.daily?.temperature_2m_mean ?? []).filter((value): value is number => value != null && Number.isFinite(value));
  if (means.length < 365) throw new Error(`Open-Meteo annual stats insuficientes (${means.length} días válidos entre ${startDate} y ${endDate}).`);

  const tAvg = means.reduce((acc, value) => acc + value, 0) / means.length;
  const amplitude = (Math.max(...means) - Math.min(...means)) / 2;

  return {
    temperatura_mitjana_superficial_anual_c: tAvg,
    amplitud_termica_superficial_anual_c: amplitude,
    dies_valids: means.length,
  };
}
