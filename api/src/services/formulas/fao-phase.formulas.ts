// ─── Tiempo (días) de fase fenológica ───────────────────────────────────────

function safeDiv(n: number, d: number, fallback = 0): number {
  return d === 0 ? fallback : n / d;
}

export interface PhaseDurationParams {
  humitat_sol_pct: number;
  wp: number;
  fc: number;
  temperatura_2m_c: number;
  temperatura_sol_c: number;
  ec_ms_cm: number;
  kc: number;
  kc_inicial: number;
  kc_final: number;
  base_temps_dies: number;
}

export interface PhaseDurationCalculation {
  temp_mitjana: number;
  phidric: number;
  ptemp: number;
  psal: number;
  ffase: number;
  h: number;
  effective_days: number;
}