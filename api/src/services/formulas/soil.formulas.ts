// ─── Cálculo de FC y WP a partir de textura del suelo ───────────────────────

export interface SoilPtfResult {
  wp: number;
  fc: number;
  tipusGra: 'FI' | 'GRUIXUT';
}

export function computePTF(sand: number, clay: number, soc: number): SoilPtfResult {
  const S = sand / 100;
  const C = clay / 100;
  const OM = soc * 1.724;
  const theta1500t = -0.024 * S + 0.487 * C + 0.006 * OM + 0.005 * S * OM - 0.013 * C * OM + 0.068 * S * C + 0.031;
  const wpRaw = theta1500t + (0.14 * theta1500t - 0.02);
  const theta33t = -0.251 * S + 0.195 * C + 0.011 * OM + 0.006 * S * OM - 0.027 * C * OM + 0.452 * S * C + 0.299;
  const fcRaw = theta33t + (1.283 * theta33t * theta33t - 0.374 * theta33t - 0.015);
  const wp = Math.max(0, Math.min(0.8, wpRaw));
  const fc = Math.max(wp, Math.min(0.8, fcRaw));
  const tipusGra = C >= 0.18 || S < 0.7 ? 'FI' : 'GRUIXUT';
  return { wp: +wp.toFixed(3), fc: +fc.toFixed(3), tipusGra };
}


// Cálculo determinista de KC por día de fase.
// Fórmula:
// kc = kc_inicial + ((dia_actual_simulacio - data_inici_fao) / temps_dies_fao) * (kc_final - kc_inicial)
// Nota: aquí usamos diaFase (1..N). Para el día 1 de fase, el progreso es 0.
export function computeKcDeterministic(params: {
  kc_inicial: number;
  kc_final: number;
  dia_fase: number;
  temps_dies_fao: number;
}): number {
  const safeTemps = Math.max(params.temps_dies_fao, 1e-9);
  const progress = Math.max(0, params.dia_fase - 1) / safeTemps;
  const kc = params.kc_inicial + progress * (params.kc_final - params.kc_inicial);
  return +kc.toFixed(6);
}

// ETc (evapotranspiración del cultivo): etc_mm = kc * et0_mm
export function computeEtcMm(params: { kc: number; et0_mm: number }): number {
  return +(params.kc * params.et0_mm).toFixed(6);
}

// p (depletion fraction): p = p_taula_fao + 0.04 * (5 - etc_mm)
export function computePDepletionFraction(params: { p_taula_fao: number; etc_mm: number }): number {
  return +(params.p_taula_fao + 0.04 * (5 - params.etc_mm)).toFixed(6);
}

// Zr determinista por día de fase.
// zr_m = zr_inicial_m + ((dia_actual_simulacio - data_inici_fao)/temps_dies_fao) * (zr_final_m - zr_inicial_m)
export function computeZrDeterministic(params: {
  zr_inicial_m: number;
  zr_final_m: number;
  dia_fase: number;
  temps_dies_fao: number;
}): number {
  const safeTemps = Math.max(params.temps_dies_fao, 1e-9);
  const progress = Math.max(0, params.dia_fase - 1) / safeTemps;
  const zr = params.zr_inicial_m + progress * (params.zr_final_m - params.zr_inicial_m);
  return +zr.toFixed(6);
}

export interface RawCalculation {
  taw_mm: number;
  raw_mm: number;
}

// RAW (readily available water):
// taw_mm = 1000 * (fc - wp) * zr_m
// raw_mm = taw_mm * p
export function computeRawMm(params: {
  fc: number;
  wp: number;
  zr_m: number;
  p: number;
}): RawCalculation {
  const taw = 1000 * (params.fc - params.wp) * params.zr_m;
  const raw = taw * params.p;
  return {
    taw_mm: +taw.toFixed(6),
    raw_mm: +raw.toFixed(6),
  };
}

export interface WaterBalancePreIrrigationCalculation {
  ro: number;
  pe: number;
  d_irrigacio: number;
}

export interface WaterBalanceCalculation extends WaterBalancePreIrrigationCalculation {
  i: number;
  d_drenatge: number;
  dpi: number;
  dr_mm: number;
}

// Cálculo previo al riego:
// - RO
// - necesidad/potencial de riego del día
export function computeRoAndPotentialIrrigation(params: {
  dr_mm: number;
  raw_mm: number;
  precipitacions_mm: number;
  etc_mm: number;
}): WaterBalancePreIrrigationCalculation {
  const ro =
    params.dr_mm < 0.1 * params.raw_mm && params.precipitacions_mm > 20
      ? 0.3 * params.precipitacions_mm
      : 0;
  
  const ke = computeEffectiveRainfallCoefficient(params.precipitacions_mm);
  const pe = ke * Math.max(0, params.precipitacions_mm - ro);

  const dIrrigacio = params.dr_mm - pe + params.etc_mm;

  return {
    ro: +ro.toFixed(6),
    pe: +pe.toFixed(6),
    d_irrigacio: +dIrrigacio.toFixed(6),
  };
}

function computeEffectiveRainfallCoefficient(precipitacions_mm: number): number {
  if (precipitacions_mm <= 2) return 0;
  if (precipitacions_mm <= 10) return 0.5;
  if (precipitacions_mm <= 20) return 0.7;
  return 0.85;
}

// Depleción de zona radicular (día 2..n) con riego YA decidido:
// dr_mm = dr_mm(prev) - (precipitacions_mm - ro) - I + etc_mm + DPi
export function computeDrMmDayN(params: {
  dr_mm_prev: number;
  pe: number;
  etc_mm: number;
  ro: number;
  i: number;
}): WaterBalanceCalculation {
  const dDrenatge =
    params.dr_mm_prev -
    params.pe -
    params.i +
    params.etc_mm;

  const dpi = dDrenatge < 0 ? -dDrenatge : 0;

  const dr =
    params.dr_mm_prev -
    params.pe -
    params.i +
    params.etc_mm +
    dpi;

  const dIrrigacio =
    params.dr_mm_prev -
    params.pe +
    params.etc_mm;

  return {
    ro: +params.ro.toFixed(6),
    pe: +params.pe.toFixed(6),
    d_irrigacio: +dIrrigacio.toFixed(6),
    i: +params.i.toFixed(6),
    d_drenatge: +dDrenatge.toFixed(6),
    dpi: +dpi.toFixed(6),
    dr_mm: +dr.toFixed(6),
  };
}

// Depleción de zona radicular (día 1):
// dr_mm = 1000 * (fc - humitat_sol_pct) * zr_m
export function computeDrMmDay1(params: {
  fc: number;
  humitat_sol_pct: number;
  zr_m: number;
}): number {
  const dr = 1000 * (params.fc - params.humitat_sol_pct) * params.zr_m;
  return +dr.toFixed(6);
}

// ─── Utilidades numéricas ────────────────────────────────────────────────────

const EPSILON = 1e-9;
const SOIL_PARTICLE_DENSITY_KG_M3 = 2650;
const WATER_HEAT_CAPACITY_J_M3_K = 1000 * 4180;
const SOIL_SOLIDS_HEAT_CAPACITY_J_M3_K = 760;

function round6(value: number): number {
  return +value.toFixed(6);
}

function requirePositive(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${fieldName} debe ser > 0. Recibido: ${value}`);
  }
}

function computeDayOfYearUTC(dateLike: Date | string | number): number {
  const date = new Date(dateLike);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`dia_actual_simulacio inválido: ${String(dateLike)}`);
  }

  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const current = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.floor((current - start) / (24 * 60 * 60 * 1000)) + 1;
}

// ─── Humedad del suelo ───────────────────────────────────────────────────────

/**
 * Calcula la nueva humedad del suelo a partir del balance hídrico diario.
 *
 * Fórmula:
 * humitat_sol_pct_nova =
 *   humitat_sol_pct_anterior +
 *   (((precipitacions_mm - ro) + I - etc_mm - DPi) / (1000 * zr_m))
 */
export function computeSoilHumidityPct(params: {
  humitat_sol_pct: number;
  precipitacions_mm: number;
  ro: number;
  i: number;
  etc_mm: number;
  dpi: number;
  zr_m: number;
}): number {
  requirePositive(params.zr_m, 'zr_m');

  const nextHumidity =
    params.humitat_sol_pct +
    (((params.precipitacions_mm - params.ro) + params.i - params.etc_mm - params.dpi) / (1000 * params.zr_m));

  return round6(nextHumidity);
}

// ─── Temperatura del suelo ───────────────────────────────────────────────────

export interface SoilTemperatureResult {
  frequencia_angular: number;
  porositat: number;
  pd: number;
  conductivitat_termica_sol_sec: number;
  conductivitat_termica_sol_saturat: number;
  humitat_volumetrica: number;
  grau_saturacio: number;
  kersten_number: number;
  conductivitat_termica: number;
  capacitat_calorifica_volumetrica: number;
  difusivitat_termica: number;
  d: number;
  dia_any: number;
  temperatura_sol_c: number;
}

const SOIL_TEMPERATURE_DEPTH_M = 0.1;
const ANNUAL_PERIOD_DAYS = 365;

/**
 * Calcula la temperatura del suelo usando la formulación periódica anual.
 *
 * Nota:
 * - Esta función necesita T_avg y A_surface ya calculados aguas arriba.
 * - Usa z = 0.1 m y P = 365 días por defecto, pero ambos son configurables.
 */
export function computeSoilTemperatureC(params: {
  densitat_aparent_kg_m3: number;
  fc: number;
  dr_mm: number;
  zr_m: number;
  tipus_gra: 'FI' | 'GRUIXUT';
  dia_actual_simulacio: Date | string | number;
  temperatura_mitjana_superficial_anual_c: number;
  amplitud_termica_superficial_anual_c: number;
}): SoilTemperatureResult {
  requirePositive(params.densitat_aparent_kg_m3, 'densitat_aparent_kg_m3');
  requirePositive(params.zr_m, 'zr_m');

  const z = SOIL_TEMPERATURE_DEPTH_M;
  const p_dies = ANNUAL_PERIOD_DAYS;

  requirePositive(z, 'z_m');
  requirePositive(p_dies, 'p_dies');

  const frequenciaAngular = (2 * Math.PI) / p_dies;

  const porositat = 1 - (params.densitat_aparent_kg_m3 / SOIL_PARTICLE_DENSITY_KG_M3);
  const pd = (1 - porositat) * SOIL_PARTICLE_DENSITY_KG_M3;

  const conductivitatTermicaSolSec =
    (0.135 * pd + 64.7) / (2700 - 0.947 * pd);

  const conductivitatTermicaSolSaturat =
    Math.pow(0.6089, porositat) * Math.pow(3, 1 - porositat);

  const humitatVolumetrica =
    params.fc - (params.dr_mm / (1000 * params.zr_m));

  const grauSaturacio =
    Math.min(1, Math.max(0, humitatVolumetrica / Math.max(porositat, EPSILON)));

  // Protección numérica para evitar log10(0).
  const safeSaturation = Math.max(grauSaturacio, EPSILON);

  const kerstenNumber =
    params.tipus_gra === 'FI'
      ? Math.log10(safeSaturation) + 1
      : 0.7 * Math.log10(safeSaturation) + 1;

  const conductivitatTermica =
    (conductivitatTermicaSolSaturat - conductivitatTermicaSolSec) * kerstenNumber +
    conductivitatTermicaSolSec;

  const capacitatCalorificaVolumetrica =
    params.densitat_aparent_kg_m3 * SOIL_SOLIDS_HEAT_CAPACITY_J_M3_K +
    WATER_HEAT_CAPACITY_J_M3_K * humitatVolumetrica;

  const difusivitatTermica =
    conductivitatTermica / Math.max(capacitatCalorificaVolumetrica, EPSILON);

  const d =
    Math.sqrt((2 * difusivitatTermica) / Math.max(frequenciaAngular, EPSILON));

  const diaAny = computeDayOfYearUTC(params.dia_actual_simulacio);

  const temperaturaSol =
    params.temperatura_mitjana_superficial_anual_c +
    params.amplitud_termica_superficial_anual_c *
      Math.exp(-z / Math.max(d, EPSILON)) *
      Math.cos((2 * Math.PI * diaAny / p_dies) - (z / Math.max(d, EPSILON)));

  return {
    frequencia_angular: round6(frequenciaAngular),
    porositat: round6(porositat),
    pd: round6(pd),
    conductivitat_termica_sol_sec: round6(conductivitatTermicaSolSec),
    conductivitat_termica_sol_saturat: round6(conductivitatTermicaSolSaturat),
    humitat_volumetrica: round6(humitatVolumetrica),
    grau_saturacio: round6(grauSaturacio),
    kersten_number: round6(kerstenNumber),
    conductivitat_termica: round6(conductivitatTermica),
    capacitat_calorifica_volumetrica: round6(capacitatCalorificaVolumetrica),
    difusivitat_termica: round6(difusivitatTermica),
    d: round6(d),
    dia_any: diaAny,
    temperatura_sol_c: round6(temperaturaSol),
  };
}

// ─── Nutrientes del suelo (genérico + wrappers N/P/K) ───────────────────────

export interface SoilNutrientBalanceResult {
  soil_kg_ha_prev: number;
  entrada_kg_ha: number;
  ftemp: number;
  absorcio_kg_ha: number;
  lixiviacio_kg_ha: number;
  soil_kg_ha_new: number;
  soil_ppm_new: number;
}

export function computeNutrientTemperatureFactor(temperatura_sol_c: number): number {
  if (temperatura_sol_c < 10) return 0.2;
  if (temperatura_sol_c < 15) return 0.5;
  if (temperatura_sol_c <= 25) return 1;
  if (temperatura_sol_c <= 30) return 0.9;
  if (temperatura_sol_c <= 35) return 0.75;
  return 0.6;
}

export function convertSoilPpmToKgHa(params: {
  soil_ppm: number;
  densitat_aparent_kg_m3: number;
  zr_m: number;
}): number {
  requirePositive(params.densitat_aparent_kg_m3, 'densitat_aparent_kg_m3');
  requirePositive(params.zr_m, 'zr_m');

  return round6((params.soil_ppm * params.densitat_aparent_kg_m3 * params.zr_m) / 100);
}

export function convertSoilKgHaToPpm(params: {
  soil_kg_ha: number;
  densitat_aparent_kg_m3: number;
  zr_m: number;
}): number {
  requirePositive(params.densitat_aparent_kg_m3, 'densitat_aparent_kg_m3');
  requirePositive(params.zr_m, 'zr_m');

  return round6((params.soil_kg_ha * 100) / (params.densitat_aparent_kg_m3 * params.zr_m));
}

/**
 * Calcula el balance diario de un nutriente del suelo en ppm.
 *
 * Esta función es genérica. Los wrappers de N/P/K solo cambian el coeficiente de lixiviación.
 */
export function computeSoilNutrientBalancePpm(params: {
  soil_ppm: number;
  entrada_kg_ha: number;
  temperatura_sol_c: number;
  fase_kg_ha_fao: number;
  temps_dies_fao: number;
  humitat_sol_pct: number;
  fc: number;
  densitat_aparent_kg_m3: number;
  zr_m: number;
  dpi: number;
  raw_mm: number;
  p: number;
  lixiviacio_coef: number;
}): SoilNutrientBalanceResult {
  requirePositive(params.fc, 'fc');
  requirePositive(params.temps_dies_fao, 'temps_dies_fao');
  requirePositive(params.densitat_aparent_kg_m3, 'densitat_aparent_kg_m3');
  requirePositive(params.zr_m, 'zr_m');
  requirePositive(params.raw_mm, 'raw_mm');
  requirePositive(params.p, 'p');

  const soilKgHaPrev = convertSoilPpmToKgHa({
    soil_ppm: params.soil_ppm,
    densitat_aparent_kg_m3: params.densitat_aparent_kg_m3,
    zr_m: params.zr_m,
  });

  const ftemp = computeNutrientTemperatureFactor(params.temperatura_sol_c);

  const absorcio =
    Math.min(
      (params.fase_kg_ha_fao / params.temps_dies_fao) *
        (params.humitat_sol_pct / params.fc) *
        ftemp,
      soilKgHaPrev,
    );

  const denominator = params.raw_mm / params.p;
  requirePositive(denominator, 'raw_mm / p');

  const lixiviacio =
    soilKgHaPrev * (params.dpi / denominator) * params.lixiviacio_coef;

  const soilKgHaNew =
    soilKgHaPrev + params.entrada_kg_ha - absorcio - lixiviacio;

  const soilPpmNew = convertSoilKgHaToPpm({
    soil_kg_ha: soilKgHaNew,
    densitat_aparent_kg_m3: params.densitat_aparent_kg_m3,
    zr_m: params.zr_m,
  });

  return {
    soil_kg_ha_prev: round6(soilKgHaPrev),
    entrada_kg_ha: round6(params.entrada_kg_ha),
    ftemp: round6(ftemp),
    absorcio_kg_ha: round6(absorcio),
    lixiviacio_kg_ha: round6(lixiviacio),
    soil_kg_ha_new: round6(soilKgHaNew),
    soil_ppm_new: round6(soilPpmNew),
  };
}

export function computeNitrogenSoilPpm(params: {
  n_sol_ppm: number;
  n_entrada_kg_ha: number;
  temperatura_sol_c: number;
  n_fase_kg_ha_fao: number;
  temps_dies_fao: number;
  humitat_sol_pct: number;
  fc: number;
  densitat_aparent_kg_m3: number;
  zr_m: number;
  dpi: number;
  raw_mm: number;
  p: number;
}): SoilNutrientBalanceResult {
  return computeSoilNutrientBalancePpm({
    soil_ppm: params.n_sol_ppm,
    entrada_kg_ha: params.n_entrada_kg_ha,
    temperatura_sol_c: params.temperatura_sol_c,
    fase_kg_ha_fao: params.n_fase_kg_ha_fao,
    temps_dies_fao: params.temps_dies_fao,
    humitat_sol_pct: params.humitat_sol_pct,
    fc: params.fc,
    densitat_aparent_kg_m3: params.densitat_aparent_kg_m3,
    zr_m: params.zr_m,
    dpi: params.dpi,
    raw_mm: params.raw_mm,
    p: params.p,
    lixiviacio_coef: 0.988,
  });
}

export function computePhosphorusSoilPpm(params: {
  p_sol_ppm: number;
  p_entrada_kg_ha: number;
  temperatura_sol_c: number;
  p_fase_kg_ha_fao: number;
  temps_dies_fao: number;
  humitat_sol_pct: number;
  fc: number;
  densitat_aparent_kg_m3: number;
  zr_m: number;
  dpi: number;
  raw_mm: number;
  p: number;
}): SoilNutrientBalanceResult {
  return computeSoilNutrientBalancePpm({
    soil_ppm: params.p_sol_ppm,
    entrada_kg_ha: params.p_entrada_kg_ha,
    temperatura_sol_c: params.temperatura_sol_c,
    fase_kg_ha_fao: params.p_fase_kg_ha_fao,
    temps_dies_fao: params.temps_dies_fao,
    humitat_sol_pct: params.humitat_sol_pct,
    fc: params.fc,
    densitat_aparent_kg_m3: params.densitat_aparent_kg_m3,
    zr_m: params.zr_m,
    dpi: params.dpi,
    raw_mm: params.raw_mm,
    p: params.p,
    lixiviacio_coef: 0.063,
  });
}

export function computePotassiumSoilPpm(params: {
  k_sol_ppm: number;
  k_entrada_kg_ha: number;
  temperatura_sol_c: number;
  k_fase_kg_ha_fao: number;
  temps_dies_fao: number;
  humitat_sol_pct: number;
  fc: number;
  densitat_aparent_kg_m3: number;
  zr_m: number;
  dpi: number;
  raw_mm: number;
  p: number;
}): SoilNutrientBalanceResult {
  return computeSoilNutrientBalancePpm({
    soil_ppm: params.k_sol_ppm,
    entrada_kg_ha: params.k_entrada_kg_ha,
    temperatura_sol_c: params.temperatura_sol_c,
    fase_kg_ha_fao: params.k_fase_kg_ha_fao,
    temps_dies_fao: params.temps_dies_fao,
    humitat_sol_pct: params.humitat_sol_pct,
    fc: params.fc,
    densitat_aparent_kg_m3: params.densitat_aparent_kg_m3,
    zr_m: params.zr_m,
    dpi: params.dpi,
    raw_mm: params.raw_mm,
    p: params.p,
    lixiviacio_coef: 0.2,
  });
}

// ─── TDS y EC ────────────────────────────────────────────────────────────────

export interface TdsEcResult {
  npk_fertilitzants_kg_ha: number;
  ions_no_npk_fertilitzants_kg_ha: number;
  k_base: number;
  f_dissolucio: number;
  f_rentat: number;
  tds_npk_ppm: number;
  tds_ions_no_npk_ppm: number;
  tds_ppm: number;
  ec_ms_cm: number;
}

/**
 * Calcula TDS i EC a partir de:
 * - l'estat actual NPK del sòl
 * - la relació històrica TDS/NPK del dia anterior
 * - la contribució additiva dels ions no NPK del fertilitzant del dia
 * - la humitat del sòl (dissolució)
 * - el drenatge profund (rentat)
 *
 * Model:
 *   currentNpkPpm = N + P + K
 *   kBase = tds_prev / npk_prev
 *   tdsNpk = currentNpkPpm * kBase
 *
 *   fDissolucio = 1 - exp(-(humitat_sol_pct / fc))
 *   fRentat = 1 - exp(-(lambda_rentat * dpi / raw_mm))
 *
 *   tdsIonsNoNpk =
 *     alpha_ions_no_npk_ppm_per_kg_ha *
 *     ions_no_npk_fertilitzants_kg_ha *
 *     fDissolucio *
 *     (1 - fRentat)
 *
 *   tds = tdsNpk + tdsIonsNoNpk
 *   ec  = tds / 640
 */
export function computeTdsAndEc(params: {
  n_sol_ppm: number;
  p_sol_ppm: number;
  k_sol_ppm: number;

  n_sol_ppm_prev?: number;
  p_sol_ppm_prev?: number;
  k_sol_ppm_prev?: number;
  tds_ppm_prev?: number;

  npk_fertilitzants_kg_ha: number;
  ions_no_npk_fertilitzants_kg_ha: number;

  humitat_sol_pct: number;
  fc: number;
  dpi: number;
  raw_mm: number;

  /**
   * Factor de conversió de kg/ha d'ions no NPK a ppm de TDS.
   * Valor inicial recomanat: 40
   */
  alpha_ions_no_npk_ppm_per_kg_ha?: number;

  /**
   * Sensibilitat del rentat per drenatge profund.
   * Valor inicial recomanat: 1
   */
  lambda_rentat?: number;
}): TdsEcResult {
  const EPSILON = 1e-9;

  const currentNpkPpm =
    params.n_sol_ppm +
    params.p_sol_ppm +
    params.k_sol_ppm;

  const previousNpkPpm =
    (params.n_sol_ppm_prev ?? 0) +
    (params.p_sol_ppm_prev ?? 0) +
    (params.k_sol_ppm_prev ?? 0);

  const kBase =
    params.tds_ppm_prev != null &&
    params.tds_ppm_prev > 0 &&
    previousNpkPpm > EPSILON
      ? params.tds_ppm_prev / previousNpkPpm
      : 1;

  const tdsNpk = currentNpkPpm * kBase;

  const alpha = params.alpha_ions_no_npk_ppm_per_kg_ha ?? 40;
  const lambdaRentat = params.lambda_rentat ?? 1;

  const fDissolucio =
    1 - Math.exp(-(params.humitat_sol_pct / (params.fc + EPSILON)));

  const fRentat =
    1 - Math.exp(-(lambdaRentat * params.dpi / (params.raw_mm + EPSILON)));

  const tdsIonsNoNpk =
    alpha *
    params.ions_no_npk_fertilitzants_kg_ha *
    fDissolucio *
    (1 - fRentat);

  const tds = tdsNpk + tdsIonsNoNpk;
  const ec = tds / 640;

  return {
    npk_fertilitzants_kg_ha: round6(params.npk_fertilitzants_kg_ha),
    ions_no_npk_fertilitzants_kg_ha: round6(params.ions_no_npk_fertilitzants_kg_ha),
    k_base: round6(kBase),
    f_dissolucio: round6(fDissolucio),
    f_rentat: round6(fRentat),
    tds_npk_ppm: round6(tdsNpk),
    tds_ions_no_npk_ppm: round6(tdsIonsNoNpk),
    tds_ppm: round6(tds),
    ec_ms_cm: round6(ec),
  };
}

// ─── Equivalentes de carga ───────────────────────────────────────────────────

export interface ChargeEquivalentComponentInput {
  pct: number;
  quantitat_dosi_kg_ha: number;
  nutrient_io_factor?: number | null;
  massa_molar_nutrient_g_mol: number;
  massa_molar_component_principal_g_mol: number;
  massa_molar_io_g_mol: number;
  massa_component_dins_compost_g_mol?: number | null;
  tipus_io: 'CATIO' | 'ANIO';
  valencia: number;
}

export interface ChargeEquivalentContribution {
  massa_nutrient_kg_ha: number;
  factor: number;
  massa_io_g_ha: number;
  mol_io: number;
  equivalent_carrega_anio: number;
  equivalent_carrega_catio: number;
}

export interface ChargeEquivalentTotals {
  equivalent_carrega_anio: number;
  equivalent_carrega_catio: number;
}

// ─── pH del suelo ────────────────────────────────────────────────────────────

export interface SoilPhResult {
  equivalent_carrega_anio_dia: number;
  equivalent_carrega_catio_dia: number;
  iacidificant: number;
  clay_frac: number;
  soc_frac: number;
  b: number;
  fhum: number;
  delta_ph: number;
  ph_nou: number;
}

/**
 * Calcula el nuevo pH del suelo a partir de los equivalentes de carga diarios,
 * la humedad relativa respecto a FC y una proxy de capacidad tampón del suelo.
 *
 * Nota:
 * - No se aplican límites artificiales al pH calculado.
 * - La validación contra rangos agronómicos debe hacerse aguas arriba
 *   para disparar alarmas si corresponde.
 */
export function computeSoilPh(params: {
  equivalent_carrega_anio_dia: number;
  equivalent_carrega_catio_dia: number;
  humitat_sol_pct: number;
  fc: number;
  ph_anterior: number;
  clay: number;
  soc: number;
  k_ph: number;
}): SoilPhResult {
  requirePositive(params.fc, 'fc');
  requirePositive(params.k_ph, 'k_ph');

  const iacidificant =
    params.equivalent_carrega_catio_dia - params.equivalent_carrega_anio_dia;

  const clayFrac = params.clay / 100;
  const socFrac = params.soc / 100;

  const b = 1 + clayFrac + socFrac;
  const fhum = params.humitat_sol_pct / params.fc;

  const deltaPh =
    -params.k_ph * iacidificant * fhum / Math.max(b, EPSILON);

  const phNou = params.ph_anterior + deltaPh;

  return {
    equivalent_carrega_anio_dia: round6(params.equivalent_carrega_anio_dia),
    equivalent_carrega_catio_dia: round6(params.equivalent_carrega_catio_dia),
    iacidificant: round6(iacidificant),
    clay_frac: round6(clayFrac),
    soc_frac: round6(socFrac),
    b: round6(b),
    fhum: round6(fhum),
    delta_ph: round6(deltaPh),
    ph_nou: round6(phNou),
  };
}
