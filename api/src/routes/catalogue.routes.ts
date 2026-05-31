import { Router, Request, Response } from 'express';
import { ENV } from '../config/env';
import { loadAll } from '../datasources/repository';
import {
  resolveSoilContextFromCoords,
  resolveSoilContextFromName,
} from '../services/soil.service';
import { computePTF } from '../services/formulas/soil.formulas';

export const catalogueRouter = Router();

// GET /catalogue/plantacions  
// Devuelve todas las plantaciones con su información básica, incluyendo el sol y cultiu relacionados para cada plantació. No se incluyen los cálculos de textura ni ficha de cultivo.
catalogueRouter.get('/plantacions', async (_req: Request, res: Response): Promise<void> => {
  try {
    const db = await loadAll(ENV.PATH);
    const result = db.plantacions.map((p) => ({
      ...p,
      sol: null,
      cultiu: db.cultius.find((c) => c.cultiu_id === p.cultiu_id) ?? null,
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /catalogue/cultius 
// Devuelve la lista de cultivos con su información básica pero sin los cálculos de textura ni fitxa de cultiu.
catalogueRouter.get('/cultius', async (_req: Request, res: Response): Promise<void> => {
  try {
    const db = await loadAll(ENV.PATH);
    res.json(db.cultius);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /catalogue/ubicacions
// Devuelve la lista de ubicaciones tal como está persistida en la base de datos, sin cálculos ni procesamientos adicionales.
catalogueRouter.get('/ubicacions', async (_req: Request, res: Response): Promise<void> => {
  try {
    const db = await loadAll(ENV.PATH);
    res.json(db.ubicacions);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

function deriveSiltFromSandClay(sand: number | null, clay: number | null): number | null {
  if (sand == null || clay == null) return null;
  return Number((100 - sand - clay).toFixed(3));
}

function normalizeLookupText(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function isSamePersistedLocation(latA: number, lonA: number, latB: number, lonB: number): boolean {
  return Math.abs(latA - latB) <= 0.00001 && Math.abs(lonA - lonB) <= 0.00001;
}

function findPersistedSoilFallback(params: {
  db: Awaited<ReturnType<typeof loadAll>>;
  lat: number;
  lon: number;
  name?: string | null;
}) {
  const { db, lat, lon, name } = params;
  const normalizedName = normalizeLookupText(name);
  const byName = normalizedName
    ? db.ubicacions.find((ubicacio) => normalizeLookupText(ubicacio.nom) === normalizedName) ?? null
    : null;

  const sameCoords = db.ubicacions.find((ubicacio) =>
    isSamePersistedLocation(lat, lon, ubicacio.latitut, ubicacio.longitut),
  ) ?? null;
  const nearest = byName ?? (
    sameCoords
      ? sameCoords
      : null
  );

  if (!nearest) return null;
  const sol = db.sols.find((row) => row.ubicacio_id === nearest.ubicacio_id) ?? null;
  if (!sol || sol.sand == null || sol.clay == null) return null;

  const silt = deriveSiltFromSandClay(sol.sand, sol.clay);
  const ptf = sol.fc != null && sol.wp != null
    ? { fc: sol.fc, wp: sol.wp }
    : computePTF(sol.sand, sol.clay, sol.soc ?? 0);

  return {
    ubicacio: nearest,
    sol,
    sand: sol.sand,
    silt,
    clay: sol.clay,
    soc: sol.soc ?? null,
    densitat_aparent_kg_m3: sol.densitat_aparent_kg_m3 ?? null,
    fc: ptf.fc,
    wp: ptf.wp,
    nom_tipus_sol: sol.nom_tipus_sol ?? null,
  };
}

// GET /catalogue/geocode?lat=...&lon=...
// Devuelve información de ubicación y suelo a partir de coordenadas.
// La lógica de Nominatim, OpenGeoHub y clasificación de textura se delega en soil.service.ts.
catalogueRouter.get('/geocode', async (req: Request, res: Response): Promise<void> => {
  const lat = Number.parseFloat(req.query.lat as string);
  const lon = Number.parseFloat(req.query.lon as string);

  // Validar que lat y lon son coordenadas válidas
  if ( Number.isNaN(lat) || Number.isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180 ) {
    res.status(400).json({ error: 'lat and lon must be valid coordinates' });
    return;
  }

  try {
    const result = await resolveSoilContextFromCoords({
      Path: ENV.PATH,
      lat,
      lon,
    });

    res.json(result);
  } catch (err) {
    res.status(502).json({
      error: `Geocode error: ${(err as Error).message}`,
    });
  }
});

// GET /catalogue/geocode-by-name?name=...
// Devuelve información de ubicación y suelo a partir de un nombre de ubicación.
// La conversión nombre → coordenadas y la resolución del suelo se delegan en soil.service.ts.
catalogueRouter.get('/geocode-by-name', async (req: Request, res: Response): Promise<void> => {
  const rawName = req.query.name;

  if (typeof rawName !== 'string') {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  // Validar que el nombre no es vacío después de limpiar espacios
  const name = rawName.trim();
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  try {
    const result = await resolveSoilContextFromName({
      Path: ENV.PATH,
      name,
    });

    res.json(result);
  } catch (err) {
    res.status(502).json({
      error: `Geocode-by-name error: ${(err as Error).message}`,
    });
  }
});