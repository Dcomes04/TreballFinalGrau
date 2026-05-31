import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ENV } from '../../config/env';

const SOIL_TEXTURE_SCRIPT = path.join(ENV.REPO_ROOT, 'ml', 'soil_texture_excel.py');
const PYTHON_TIMEOUT_MS = 120_000;
const textureCache = new Map<string, string>();

// Genera una clave de cache única para cada pareja sand/clay
function textureKey(sand: number, clay: number): string {
  return `${sand.toFixed(4)}|${clay.toFixed(4)}`;
}

// Comprueba que tanto el workbook como el script Python existen en disco
function ensureDependencies(): void {
  if (!fs.existsSync(ENV.SOIL_TEXTURE_WORKBOOK)) {
    throw new Error(`No existe la calculadora de textura en: ${ENV.SOIL_TEXTURE_WORKBOOK}`);
  }
  if (!fs.existsSync(SOIL_TEXTURE_SCRIPT)) {
    throw new Error(`No existe el script de textura en: ${SOIL_TEXTURE_SCRIPT}`);
  }
}

// Ejecuta el script Python de textura y devuelve stdout como texto
async function runSoilTexturePython(args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const pythonArgs = [ SOIL_TEXTURE_SCRIPT, '--workbook', ENV.SOIL_TEXTURE_WORKBOOK, ...args ];
    console.log('[SOIL-TEXTURE] python=', ENV.PYTHON_BIN);
    console.log('[SOIL-TEXTURE] args=', pythonArgs);

    const child = spawn(
      ENV.PYTHON_BIN,
      pythonArgs,
      { cwd: ENV.REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Tiempo de espera agotado calculando textura de suelo.'));
    }, PYTHON_TIMEOUT_MS);

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(`No se pudo lanzar Python para textura: ${error.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || `Error en calculadora de textura (code=${code}).`;
        reject(new Error(`${detail}\nPython usado por la API: ${ENV.PYTHON_BIN}`));
        return;
      }
      const text = stdout.trim();
      if (!text) {
        reject(new Error('La calculadora de textura no devolvió texto.'));
        return;
      }
      resolve(text);
    });
  });
}

// Valida que los inputs de textura son números finitos dentro de rangos plausibles
function validateTextureInput(sand: number, clay: number): void {
  if (!Number.isFinite(sand) || !Number.isFinite(clay)) {
    throw new TypeError(`Valores inválidos para textura: sand=${sand}, clay=${clay}`);
  }

  if (sand < 0 || sand > 100) {
    throw new RangeError(`sand fuera de rango 0..100: ${sand}`);
  }

  if (clay < 0 || clay > 100) {
    throw new RangeError(`clay fuera de rango 0..100: ${clay}`);
  }

  if (sand + clay > 101) {
    throw new RangeError(
      `Textura incoherente: sand + clay no puede superar 100. sand=${sand}, clay=${clay}`,
    );
  }
}

// Clasifica textura del suelo usando la calculadora Excel de USDA vía script Python
export async function classifySoilTextureWithExcel(sand: number, clay: number): Promise<string> {
  validateTextureInput(sand, clay);
  const key = textureKey(sand, clay);
  const cached = textureCache.get(key);
  if (cached) return cached;

  ensureDependencies();
  const result = await runSoilTexturePython([
    '--sand', String(sand),
    '--clay', String(clay),
  ]);

  const texture = result.trim();

  textureCache.set(key, texture);
  return texture;
}
