import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { ENV } from '../config/env';
import { loadAll } from '../datasources/repository';
import { upsertRow } from '../datasources/write';

export interface SuperficieOption {
  n_files: number;
  n_columnes: number;
  llargada_real_m: number;
  amplada_real_m: number;
  superficie_m2: number;
  plantes_totals: number;
}

export interface SuperficieContext {
  cultiu_id: string;
  cultiu_nom?: string;
  llargada_max_m: number;
  amplada_max_m: number;
  n_plantes: number;
  dist_min_fila_m: number;
  dist_min_col_m: number;
  options: SuperficieOption[];
}

export interface SuperficieScenarioPreview {
  escenari_id: string;
  n_opcions: number;
}

export interface SuperficieScenarioResponse extends SuperficieContext {
  escenari_id: string;
  n_opcions: number;
}

type StoredSuperficieScenario = SuperficieContext & {
  escenari_id: string;
  n_opcions: number;
  creat_en_iso: string;
  expira_en_ms: number;
};

const SUPERFICIE_SCENARIO_TTL_MS = 30 * 60 * 1000;
const SUPERFICIE_SCENARIO_CACHE = new Map<string, StoredSuperficieScenario>();

export const ChooseSuperficieSchema = z.object({
  n_files:    z.coerce.number().int().positive(),
  n_columnes: z.coerce.number().int().positive(),
});

export const GetSuperficieOptionsInputSchema = z.object({
  cultiu_id:      z.uuid(),
  cultiu_nom:     z.string().optional(),
  llargada_max_m: z.coerce.number().positive(),
  amplada_max_m:  z.coerce.number().positive(),
  n_plantes:      z.coerce.number().int().positive(),
});
export const ChooseSuperficieFromInputSchema = GetSuperficieOptionsInputSchema.extend({
  n_files:    z.coerce.number().int().positive(),
  n_columnes: z.coerce.number().int().positive(),
});

export type ChooseSuperficieInput = z.infer<typeof ChooseSuperficieSchema>;
export type GetSuperficieOptionsInput = z.infer<typeof GetSuperficieOptionsInputSchema>;
export type ChooseSuperficieFromInput = z.infer<typeof ChooseSuperficieFromInputSchema>;

// Reduce un número a 2 decimales
function round2(n: number) {
  return Math.round(n * 100) / 100;
}

// Calcula las opciones de distribución de plantas en una superficie dada las restricciones y el cultivo
// Devuelve las opciones ordenadas por superficie de menor a mayor
function calcOptions( llargada_max_m: number, amplada_max_m: number, n_plantes: number, dist_min_fila_m: number, dist_min_col_m: number ): SuperficieOption[] {
  const options: SuperficieOption[] = [];
  const PLANTS_RANG = 2;
  const minPlantes = Math.max(1, n_plantes - PLANTS_RANG);
  const maxPlantes = n_plantes + PLANTS_RANG;
  const maxFiles = Math.floor(amplada_max_m / dist_min_fila_m) - 2;

  for (let nFiles = 1; nFiles <= maxFiles; nFiles++) {
    const ampladaReal = round2((nFiles + 2) * dist_min_fila_m);
    if (ampladaReal > amplada_max_m) break;
    const nColumnesMin = Math.ceil(minPlantes / nFiles);
    const nColumnesMax = Math.floor(maxPlantes / nFiles);

    for (let nColumnes = nColumnesMin; nColumnes <= nColumnesMax; nColumnes++) {
      const plantesTotals = nFiles * nColumnes;
      if (plantesTotals < minPlantes || plantesTotals > maxPlantes) continue;
      const llargadaReal = round2((nColumnes + 2) * dist_min_col_m);
      if (llargadaReal > llargada_max_m) continue;

      options.push({
        n_files: nFiles,
        n_columnes: nColumnes,
        llargada_real_m: llargadaReal,
        amplada_real_m: ampladaReal,
        superficie_m2: round2(llargadaReal * ampladaReal),
        plantes_totals: plantesTotals,
      });
    }
  }
  
  return options.sort((a, b) => a.superficie_m2 - b.superficie_m2);
}

// Dado un input, calcula las opciones de superficie y devuelve un escenari_id para recuperar las opciones posteriormente
async function getSuperficieOptionsFromInput( input: GetSuperficieOptionsInput ): Promise<SuperficieContext> {
  const db = await loadAll(ENV.PATH);
  const cultiu = db.cultius?.find((c: { cultiu_id: string }) => c.cultiu_id === input.cultiu_id);
  if (!cultiu) throw new Error(`cultiu_id "${input.cultiu_id}" not found`);

  const options = calcOptions( input.llargada_max_m, input.amplada_max_m, input.n_plantes, cultiu.dist_min_fila_m, cultiu.dist_min_col_m );

  return {
    cultiu_id: input.cultiu_id,
    cultiu_nom: cultiu.nom ?? input.cultiu_nom,
    llargada_max_m: input.llargada_max_m,
    amplada_max_m: input.amplada_max_m,
    n_plantes: input.n_plantes,
    dist_min_fila_m: cultiu.dist_min_fila_m,
    dist_min_col_m: cultiu.dist_min_col_m,
    options,
  };
}

// Elimina del cache los escenarios de superficie expirados
function pruneExpiredSuperficieScenarios(): void {
  const now = Date.now();
  for (const [scenarioId, entry] of SUPERFICIE_SCENARIO_CACHE.entries()) {
    if (entry.expira_en_ms <= now) SUPERFICIE_SCENARIO_CACHE.delete(scenarioId);
  }
}

// Almacena un escenario de superficie en el cache y devuelve un preview con el escenari_id para recuperarlo posteriormente
function storeSuperficieScenario(context: SuperficieContext): SuperficieScenarioPreview {
  pruneExpiredSuperficieScenarios();
  const scenarioId = randomUUID();
  SUPERFICIE_SCENARIO_CACHE.set(scenarioId, {
    ...context,
    escenari_id: scenarioId,
    n_opcions: context.options.length,
    creat_en_iso: new Date().toISOString(),
    expira_en_ms: Date.now() + SUPERFICIE_SCENARIO_TTL_MS,
  });

  return {
    escenari_id: scenarioId,
    n_opcions: context.options.length,
  };
}

// Dado un escenari_id y una opción elegida, devuelve la opción con el plantacio_id asociado (creándolo si no existe) y una advertencia si la opción ya existía para ese cultivo
export async function previewSuperficieOptionsFromInput(
  input: GetSuperficieOptionsInput,
): Promise<SuperficieScenarioPreview> {
  const context = await getSuperficieOptionsFromInput(input);
  return storeSuperficieScenario(context);
}

// Dado un escenari_id, devuelve las opciones de superficie asociadas a ese escenario (si no ha expirado) sin el plantacio_id
function getStoredSuperficieScenario(scenarioId: string): StoredSuperficieScenario {
  pruneExpiredSuperficieScenarios();
  const stored = SUPERFICIE_SCENARIO_CACHE.get(scenarioId);
  if (!stored) throw new Error(`escenari_id "${scenarioId}" no encontrado o ha expirado`);

  return stored;
}

// Dado un escenari_id, devuelve las opciones de superficie asociadas a ese escenario (si no ha expirado) sin el plantacio_id
export function getStoredSuperficieScenarioOptions(scenarioId: string): SuperficieScenarioResponse {
  const stored = getStoredSuperficieScenario(scenarioId);
  const { creat_en_iso, expira_en_ms, ...response } = stored;
  return response; 
}

// Dado un escenari_id y una opción elegida, devuelve la opción con el plantacio_id asociado (creándolo si no existe) y una advertencia si la opción ya existía para ese cultivo
export async function chooseSuperficieFromInput( input: ChooseSuperficieFromInput ): Promise<SuperficieOption & { plantacio_id: string; already_saved?: boolean; warning?: string }> {
  const ctx = await getSuperficieOptionsFromInput({
    cultiu_id: input.cultiu_id,
    cultiu_nom: input.cultiu_nom,
    llargada_max_m: input.llargada_max_m,
    amplada_max_m: input.amplada_max_m,
    n_plantes: input.n_plantes,
  });

  const chosen = ctx.options.find((o) => o.n_files === input.n_files && o.n_columnes === input.n_columnes);
  if (!chosen) throw new Error(`Opció n_files=${input.n_files} n_columnes=${input.n_columnes} no és vàlida`);

  const db = await loadAll(ENV.PATH);

  const existing = db.plantacions?.find((p) =>
    p.cultiu_id === input.cultiu_id &&
    p.n_files === chosen.n_files &&
    p.n_columnes === chosen.n_columnes &&
    p.llargada_real_m === chosen.llargada_real_m &&
    p.amplada_real_m === chosen.amplada_real_m &&
    p.n_plantes_real === chosen.plantes_totals
  ) ?? null;

  if (existing) {
    return {
      ...chosen,
      plantacio_id: existing.plantacio_id,
      already_saved: true,
      warning: 'Aquesta superfície per aquest cultiu ja està guardada.',
    };
  }

  const plantacioId = randomUUID();

  await upsertRow(ENV.PATH, 'plantacio', {
    pkColumns: 'plantacio_id',
    data: {
      plantacio_id: plantacioId,
      cultiu_id: input.cultiu_id,
      n_files: chosen.n_files,
      n_columnes: chosen.n_columnes,
      llargada_real_m: chosen.llargada_real_m,
      amplada_real_m: chosen.amplada_real_m,
      n_plantes_real: chosen.plantes_totals,
    },
  });

  return {
    ...chosen,
    plantacio_id: plantacioId,
  };
}