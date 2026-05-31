import type { FullDB } from '../../datasources/repository';

// ─── N/P/K de la fase fenológica (FAO) ──────────────────────────────────────

function safeDiv(n: number, d: number, fallback = 0): number {
  return d === 0 ? fallback : n / d;
}

export interface PhaseRatios {
  n_ratio_fase: number;
  p_ratio_fase: number;
  k_ratio_fase: number;
  n_ratio_total: number;
  p_ratio_total: number;
  k_ratio_total: number;
}

export interface PhaseNpkParams extends PhaseRatios {
  n_min_kg_ha: number;
  n_max_kg_ha: number;
  p_min_kg_ha: number;
  p_max_kg_ha: number;
  k_min_kg_ha: number;
  k_max_kg_ha: number;
  ec_ms_cm: number;
  ph: number;
}

export interface PhaseNpkCalculation {
  n: number;
  p: number;
  k: number;
  fsal: number;
  nmid: number;
  ntot: number;
  pmid: number;
  fph: number;
  ptot: number;
  kmid: number;
  ktot: number;
}

export interface PhaseNpkRange {
  n_min_fase: number;
  n_max_fase: number;
  p_min_fase: number;
  p_max_fase: number;
  k_min_fase: number;
  k_max_fase: number;
}

export function computePhaseNpkFao(params: PhaseNpkParams): PhaseNpkCalculation {
  const {
    n_min_kg_ha,
    n_max_kg_ha,
    p_min_kg_ha,
    p_max_kg_ha,
    k_min_kg_ha,
    k_max_kg_ha,
    ec_ms_cm,
    ph,
    n_ratio_fase,
    p_ratio_fase,
    k_ratio_fase,
    n_ratio_total,
    p_ratio_total,
    k_ratio_total,
  } = params;

  const fsal = 1 - 0.15 * safeDiv(ec_ms_cm, ec_ms_cm + 1, 0);

  const nmid = (n_min_kg_ha + n_max_kg_ha) / 2;
  const ntot = nmid * fsal;
  const n = ntot * safeDiv(n_ratio_fase, n_ratio_total, 0);

  const pmid = (p_min_kg_ha + p_max_kg_ha) / 2;
  
  let fph: number;
  if (ph < 4) {
    fph = 0.6;
  } else if (ph < 5) {
    fph = 0.75;
  } else if (ph <= 7.5) {
    fph = 1;
  } else if (ph <= 8) {
    fph = 0.85;
  } else {
    fph = 0.7;
  }
  
  const ptot = pmid * fsal * fph;
  const p = ptot * safeDiv(p_ratio_fase, p_ratio_total, 0);

  const kmid = (k_min_kg_ha + k_max_kg_ha) / 2;
  const ktot = kmid * fsal;
  const k = ktot * safeDiv(k_ratio_fase, k_ratio_total, 0);

  return {
    fsal: +fsal.toFixed(6),
    nmid: +nmid.toFixed(6),
    ntot: +ntot.toFixed(6),
    pmid: +pmid.toFixed(6),
    fph: +fph.toFixed(6),
    ptot: +ptot.toFixed(6),
    kmid: +kmid.toFixed(6),
    ktot: +ktot.toFixed(6),
    n: +Math.max(0, n).toFixed(3),
    p: +Math.max(0, p).toFixed(3),
    k: +Math.max(0, k).toFixed(3),
  };
}

// ─── Rango permitido de N/P/K por fase fenológica ───────────────────────────

export function computePhaseNpkRange(
  params: Pick<PhaseNpkParams, 'n_min_kg_ha' | 'n_max_kg_ha' | 'p_min_kg_ha' | 'p_max_kg_ha' | 'k_min_kg_ha' | 'k_max_kg_ha'> &
  Pick<PhaseNpkCalculation, 'fsal' | 'fph'> &
  PhaseRatios,
): PhaseNpkRange {
  const nFactor = params.fsal * safeDiv(params.n_ratio_fase, params.n_ratio_total, 0);
  const pFactor = params.fsal * params.fph * safeDiv(params.p_ratio_fase, params.p_ratio_total, 0);
  const kFactor = params.fsal * safeDiv(params.k_ratio_fase, params.k_ratio_total, 0);

  const nLow = params.n_min_kg_ha * nFactor;
  const nHigh = params.n_max_kg_ha * nFactor;
  const pLow = params.p_min_kg_ha * pFactor;
  const pHigh = params.p_max_kg_ha * pFactor;
  const kLow = params.k_min_kg_ha * kFactor;
  const kHigh = params.k_max_kg_ha * kFactor;

  return {
    n_min_fase: Math.min(nLow, nHigh),
    n_max_fase: Math.max(nLow, nHigh),
    p_min_fase: Math.min(pLow, pHigh),
    p_max_fase: Math.max(pLow, pHigh),
    k_min_fase: Math.min(kLow, kHigh),
    k_max_fase: Math.max(kLow, kHigh),
  };
}

export function getPhaseRatios(db: FullDB, grupId: string, phaseIndex: number): PhaseRatios {
  const grup = db.npkGrups.find((g) => g.grup_id === grupId);
  if (!grup) {
    return {
      n_ratio_fase: 1,
      p_ratio_fase: 1,
      k_ratio_fase: 1,
      n_ratio_total: 1,
      p_ratio_total: 1,
      k_ratio_total: 1,
    };
  }

  const ratios = db.npkRatios
    .filter((r) => r.grup_id === grupId)
    .sort((a, b) => a.ordre_risso - b.ordre_risso);

  const ratio = ratios[phaseIndex] ?? ratios[ratios.length - 1] ?? null;
  if (!ratio) {
    return {
      n_ratio_fase: 1,
      p_ratio_fase: 1,
      k_ratio_fase: 1,
      n_ratio_total: grup.n_ratio_total,
      p_ratio_total: grup.p_ratio_total,
      k_ratio_total: grup.k_ratio_total,
    };
  }

  return {
    n_ratio_fase: ratio.n_ratio_fase,
    p_ratio_fase: ratio.p_ratio_fase,
    k_ratio_fase: ratio.k_ratio_fase,
    n_ratio_total: grup.n_ratio_total,
    p_ratio_total: grup.p_ratio_total,
    k_ratio_total: grup.k_ratio_total,
  };
}