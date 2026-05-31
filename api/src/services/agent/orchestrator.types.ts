// Contratos de validación/transporte entre frontend y orquestador de agentes
import { z } from 'zod';

export const AgentDraftSchema = z.object({
  execucio_id: z.uuid().optional(),
  plantacio_id: z.uuid().optional(),
  cultiu_id: z.uuid().optional(),
  cultiu_nom: z.string().optional(),
  nom_ubicacio: z.string().optional(),
  latitut: z.number().min(-90).max(90).optional(),
  longitut: z.number().min(-180).max(180).optional(),
  llargada_max_m: z.number().positive().optional(),
  amplada_max_m: z.number().positive().optional(),
  n_plantes: z.number().int().positive().optional(),
  temps_simulat_inici: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  ph: z.number().min(0).max(14).optional(),
  ec_ms_cm: z.number().min(0).optional(),
  tds_ppm: z.number().min(0).optional(),
  humitat_sol_pct: z.number().min(0).max(1).optional(),
  temperatura_sol_c: z.number().optional(),
  n_sol_ppm: z.number().min(0).optional(),
  p_sol_ppm: z.number().min(0).optional(),
  k_sol_ppm: z.number().min(0).optional(),
  selected_superficie: z.object({
    n_files: z.number().int().positive(),
    n_columnes: z.number().int().positive(),
    llargada_real_m: z.number().positive().optional(),
    amplada_real_m: z.number().positive().optional(),
    superficie_m2: z.number().positive().optional(),
    plantes_totals: z.number().int().positive().optional(),
  }).optional(),
  soil_preview: z.object({
    sand: z.number().nullable(),
    silt: z.number().nullable().optional(),
    clay: z.number().nullable(),
    soc: z.number().nullable().optional(),
    densitat_aparent_kg_m3: z.number().nullable().optional(),
    fc: z.number().nullable().optional(),
    wp: z.number().nullable().optional(),
    nom_tipus_sol: z.string().nullable().optional(),
  }).optional(),
});

export const AgentRequestSchema = z.object({
  message: z.string().min(1),
  draft: AgentDraftSchema.default({}),
  active_result_execution_id: z.uuid().optional(),
});

export type AgentRequest = z.infer<typeof AgentRequestSchema>;
export type AgentDraft = z.infer<typeof AgentDraftSchema>;

export type AgentToolResult = {
  status: 'ok' | 'error';
  tool: string | null;
  message?: string;
  missing?: string[];
  [key: string]: unknown;
};

export type AgentResponse = {
  result: AgentToolResult;
};
