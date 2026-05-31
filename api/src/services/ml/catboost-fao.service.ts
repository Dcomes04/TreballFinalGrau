import path from 'node:path';
import { spawn } from 'node:child_process';
import { ENV } from '../../config/env';

// Interfaz de entrada para la función de predicción de fase FAO con CatBoost
export interface PredictFaoPhaseInput {
  crop_slug: string;
  phase_name: string;

  wp: number;
  fc: number;

  temperatura_2m_c: number;
  air_humidity_pct: number;
  precipitacions_mm: number;
  solar_radiation_ghi: number;
  wind_speed: number;

  kc_inicial: number;
  kc_final: number;
}

// Interfaz de salida esperada del script de predicción CatBoost
export interface PredictFaoPhaseOutput {
  crop_slug: string;
  phase_name: string;
  duration_days: number;
  model_duration_days: number;
}

const PREDICT_SCRIPT = path.join(ENV.REPO_ROOT, 'ml', 'predict_catboost_fao.py');
const PYTHON_TIMEOUT_MS = 60_000;

// Función que lanza el script de Python para predecir la duración de la fase FAO con CatBoost
export async function predictFaoPhaseWithCatBoost(
  input: PredictFaoPhaseInput,
): Promise<PredictFaoPhaseOutput> {
  const requiredKeys: Array<keyof PredictFaoPhaseInput> = [
    'crop_slug',
    'phase_name',
    'wp',
    'fc',
    'temperatura_2m_c',
    'air_humidity_pct',
    'precipitacions_mm',
    'solar_radiation_ghi',
    'wind_speed',
    'kc_inicial',
    'kc_final',
  ];

  // Validación básica de que el payload tiene todas las claves necesarias antes de lanzar Python
  const invalid = requiredKeys.filter((key) => {
    const value = input[key];
    if (value == null) return true;
    if (typeof value === 'string') return value.trim() === '';
    if (typeof value === 'number') return !Number.isFinite(value);
    return false;
  });

  if (invalid.length > 0) {
    throw new Error(`Payload incompleto o inválido para CatBoost. Claves: ${invalid.join(', ')}`);
  }

  return new Promise((resolve, reject) => {
    // Lanzar el proceso hijo de Python con el script de predicción
    const child = spawn(ENV.PYTHON_BIN, [PREDICT_SCRIPT], {
      cwd: ENV.REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // timeout para evitar que el proceso quede colgado indefinidamente
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Tiempo de espera agotado al ejecutar la inferencia CatBoost.'));
    }, PYTHON_TIMEOUT_MS);

    // Capturar stdout y stderr para debug y para obtener la salida JSON del script
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(`No se ha podido lanzar Python para CatBoost: ${error.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        console.error(`[CATBOOST-ERROR] phase=${input.phase_name} code=${code}`);
        if (stderr.trim()) console.error(`[CATBOOST-STDERR] ${stderr.trim()}`);
        if (stdout.trim()) console.error(`[CATBOOST-STDOUT] ${stdout.trim()}`);
        reject(new Error(stderr.trim() || `La inferencia CatBoost ha fallado con código ${code}.`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout) as PredictFaoPhaseOutput;
        resolve(parsed);
      } catch (error) {
        reject(new Error(`La salida de CatBoost no es JSON válido: ${(error as Error).message}`));
      }
    });

    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}
