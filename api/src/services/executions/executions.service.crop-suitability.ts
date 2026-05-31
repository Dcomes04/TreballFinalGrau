export type SuitabilityStatus = 'NO_APTO' | 'APTO' | 'OPTIMO';

export interface CropThresholds {
  temp_opt_min_c: number | null | undefined;
  temp_opt_max_c: number | null | undefined;
  temp_abs_min_c: number | null | undefined;
  temp_abs_max_c: number | null | undefined;
  ph_opt_min: number | null | undefined;
  ph_opt_max: number | null | undefined;
  ph_abs_min: number | null | undefined;
  ph_abs_max: number | null | undefined;
  ec_abs_max_ms_cm: number | null | undefined;
}

export interface DailySuitabilityInput {
  temperatura_2m_c: number;
  ph: number;
  ec_ms_cm: number;
  thresholds: CropThresholds;
}

export interface DailySuitabilityResult {
  status: SuitabilityStatus;
  reasons: string[];
}

// Evaluar lo ideal que puede ser el tipo de suelo y clima de un día para el cultivo, según los umbrales definidos en el producto
export function evaluateDailySuitability(input: DailySuitabilityInput): DailySuitabilityResult {
  const { temperatura_2m_c, ph, ec_ms_cm, thresholds } = input;
  let status: SuitabilityStatus = 'OPTIMO';
  const reasons: string[] = [];
  
  // Orden de severidad: si incumple un umbral absoluto ya es NO_APTO, aunque cumpla otros óptimos 
  // Si incumple un umbral óptimo pero no absoluto, es APTO aunque no sea ideal
  // Si cumple todos los umbrales, es OPTIMO
  const rank: Record<SuitabilityStatus, number> = { NO_APTO: 0, APTO: 1, OPTIMO: 2, };

  // Función auxiliar para añadir una razón y actualizar el estado de forma ordenada
  const addReason = (params: { condition: boolean; reason: string; nextStatus: SuitabilityStatus; currentStatus: SuitabilityStatus; }): SuitabilityStatus => {
    if (!params.condition) return params.currentStatus;
    reasons.push(params.reason);

    return rank[params.nextStatus] < rank[params.currentStatus] ? params.nextStatus : params.currentStatus;
  };

  // Evaluar umbrales absolutos primero, ya que son más severos
  status = addReason({
    condition: thresholds.temp_abs_min_c != null && temperatura_2m_c < thresholds.temp_abs_min_c,
    reason: `temperatura_2m_c (${temperatura_2m_c}) per sota del mínim absolut (${thresholds.temp_abs_min_c})`,
    nextStatus: 'NO_APTO',
    currentStatus: status,
  });

  status = addReason({
    condition: thresholds.temp_abs_max_c != null && temperatura_2m_c > thresholds.temp_abs_max_c,
    reason: `temperatura_2m_c (${temperatura_2m_c}) per sobre del màxim absolut (${thresholds.temp_abs_max_c})`,
    nextStatus: 'NO_APTO',
    currentStatus: status,
  });

  status = addReason({
    condition: thresholds.ph_abs_min != null && ph < thresholds.ph_abs_min,
    reason: `pH (${ph}) per sota del mínim absolut (${thresholds.ph_abs_min})`,
    nextStatus: 'NO_APTO',
    currentStatus: status,
  });

  status = addReason({
    condition: thresholds.ph_abs_max != null && ph > thresholds.ph_abs_max,
    reason: `pH (${ph}) per sobre del màxim absolut (${thresholds.ph_abs_max})`,
    nextStatus: 'NO_APTO',
    currentStatus: status,
  });

  status = addReason({
    condition: thresholds.ec_abs_max_ms_cm != null && ec_ms_cm > thresholds.ec_abs_max_ms_cm,
    reason: `EC (${ec_ms_cm}) per sobre del màxim absolut (${thresholds.ec_abs_max_ms_cm})`,
    nextStatus: 'NO_APTO',
    currentStatus: status,
  });

  // Evaluar umbrales óptimos solo si no se ha incumplido ningún absoluto
  if (status !== 'NO_APTO') {
    status = addReason({
      condition: thresholds.temp_opt_min_c != null && temperatura_2m_c < thresholds.temp_opt_min_c,
      reason: `temperatura_2m_c (${temperatura_2m_c}) fora d'òptim per sota (${thresholds.temp_opt_min_c})`,
      nextStatus: 'APTO',
      currentStatus: status,
    });

    status = addReason({
      condition: thresholds.temp_opt_max_c != null && temperatura_2m_c > thresholds.temp_opt_max_c,
      reason: `temperatura_2m_c (${temperatura_2m_c}) fora d'òptim per sobre (${thresholds.temp_opt_max_c})`,
      nextStatus: 'APTO',
      currentStatus: status,
    });

    status = addReason({
      condition: thresholds.ph_opt_min != null && ph < thresholds.ph_opt_min,
      reason: `pH (${ph}) fora d'òptim per sota (${thresholds.ph_opt_min})`,
      nextStatus: 'APTO',
      currentStatus: status,
    });

    status = addReason({
      condition: thresholds.ph_opt_max != null && ph > thresholds.ph_opt_max,
      reason: `pH (${ph}) fora d'òptim per sobre (${thresholds.ph_opt_max})`,
      nextStatus: 'APTO',
      currentStatus: status,
    });
  }

  return { status, reasons };
}