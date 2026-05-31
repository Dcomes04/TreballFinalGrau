import { loadAll } from '../datasources/repository';
import { fetchSoilFromCoords } from '../integrations/opengeohub.client';
import { requireValidCoords } from '../integrations/openMeteo.client';
import { computePTF } from './formulas/soil.formulas';
import { classifySoilTextureWithExcel } from './ml/soil-texture.service';

// Tipo auxiliar para representar la base de datos cargada
type Database = Awaited<ReturnType<typeof loadAll>>;

// Respuesta final que devuelven las rutas /catalogue/geocode y /catalogue/geocode-by-name
export type SoilContextResponse = {
  nom: string;
  latitut: number;
  longitut: number;
  sand: number;
  silt: number;
  clay: number;
  soc: number;
  densitat_aparent_kg_m3: number;
  fc: number;
  wp: number;
  nom_tipus_sol: string;
};

// Parte de la respuesta relacionada solamente con propiedades del suelo
type SoilValues = Omit<SoilContextResponse, 'nom' | 'latitut' | 'longitut'>;

// Respuesta mínima que necesitamos de Nominatim cuando buscamos coordenadas por nombre
type NominatimSearchResponse = {
  lat?: string;
  lon?: string;
  display_name?: string;
};

// Hace fetch con un timeout, usada en las llamadas a Nominatim
async function fetchJsonWithTimeout<T>( url: string, label: string, options?: RequestInit ): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${label} error ${response.status}: ${text.slice(0, 200)}`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

// Calcula el porcentaje de limo a partir de arena (sand) y arcilla (clay)
export function deriveSiltFromSandClay( sand: number, clay: number ): number {
  if (!Number.isFinite(sand) || sand < 0 || sand > 100) throw new Error(`sand inválida: ${sand}`);
  if (!Number.isFinite(clay) || clay < 0 || clay > 100) throw new Error(`clay inválida: ${clay}`);
  return Number((100 - sand - clay).toFixed(3));
}

// Normaliza textos para comparar nombres de ubicación de forma robusta
function normalizeLookupText(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// Busca una ubicación persistida por nombre normalizado
function findPersistedLocationByName( db: Database, name: string ) {
  const normalizedName = normalizeLookupText(name);
  if (!normalizedName) return null;

  return (
    db.ubicacions.find(
      (ubicacio) => normalizeLookupText(ubicacio.nom) === normalizedName,
    ) ?? null
  );
}

// Compara dos pares de coordenadas permitiendo una diferencia mínima
function isSamePersistedLocation( latA: number, lonA: number, latB: number, lonB: number ): boolean {
  return Math.abs(latA - latB) <= 0.00001 && Math.abs(lonA - lonB) <= 0.00001;
}

// Busca una ubicación persistida por coordenadas
function findPersistedLocationByCoords( db: Database, lat: number, lon: number ) {
  return (
    db.ubicacions.find((ubicacio) =>
      isSamePersistedLocation(
        lat,
        lon,
        ubicacio.latitut,
        ubicacio.longitut,
      ),
    ) ?? null
  );
}

// Busca los datos de suelo asociados a una ubicación persistida
function findPersistedSoilContextByLocation( db: Database, ubicacio: Database['ubicacions'][number] ) {
  const sol = db.sols.find((row) => row.ubicacio_id === ubicacio.ubicacio_id) ?? null;
  if (!sol) return null;

  if (sol.sand == null || sol.clay == null || sol.soc == null || sol.densitat_aparent_kg_m3 == null || sol.fc == null || sol.wp == null || !sol.nom_tipus_sol) {
    throw new Error(
      `El sòl persistent de la ubicació "${ubicacio.nom}" està incomplet.`,
    );
  }

  const ptf = sol.fc != null && sol.wp != null ? { fc: sol.fc, wp: sol.wp } : computePTF(sol.sand, sol.clay, sol.soc ?? 0);

  return {
    nom: ubicacio.nom,
    latitut: ubicacio.latitut,
    longitut: ubicacio.longitut,
    sand: sol.sand,
    silt: deriveSiltFromSandClay(sol.sand, sol.clay),
    clay: sol.clay,
    soc: sol.soc,
    densitat_aparent_kg_m3: sol.densitat_aparent_kg_m3,
    fc: ptf.fc,
    wp: ptf.wp,
    nom_tipus_sol: sol.nom_tipus_sol
  } satisfies SoilContextResponse;
}

// Resuelve el nombre de la ubicación a partir de coordenadas usando Nominatim
async function resolveLocationNameFromCoords( lat: number, lon: number ): Promise<string> {
  const nomUrl = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}` + '&format=json&accept-language=ca';

  const response = await fetch(nomUrl, { headers: { 'User-Agent': 'SimulacioAgricola/1.0' }});
  if (!response.ok) {
    throw new Error(`Nominatim reverse error ${response.status}: ${response.statusText}`);
  }

  const nomJson = await fetchJsonWithTimeout<{ name?: string; display_name?: string }>(
    nomUrl,
    'Nominatim reverse',
    { headers: { 'User-Agent': 'SimulacioAgricola/1.0' } },
  );

  const nom = nomJson.name?.trim() || nomJson.display_name?.split(',')[0]?.trim();
  if (!nom) {
    throw new Error('No s’ha pogut resoldre el nom de la ubicació amb aquestes coordenades.');
  }

  return nom;
}

// Resuelve coordenadas a partir del nombre de ubicación usando Nominatim
async function resolveCoordsFromLocationName(name: string): Promise<{ nom: string; latitut: number; longitut: number }> {
  const searchUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(name)}` + '&format=json&limit=1&accept-language=ca';
  const response = await fetch(searchUrl, { headers: { 'User-Agent': 'SimulacioAgricola/1.0' }});
  if (!response.ok) {
    throw new Error(`Nominatim search error ${response.status}: ${response.statusText}`);
  }

  const list = await fetchJsonWithTimeout<NominatimSearchResponse[]>(
    searchUrl,
    'Nominatim search',
    { headers: { 'User-Agent': 'SimulacioAgricola/1.0' } },
  );
  const first = list[0];
  if (!first?.lat || !first?.lon) throw new Error('No s\'ha trobat cap ubicacio amb aquest nom');

  const latitut = Number.parseFloat(first.lat);
  const longitut = Number.parseFloat(first.lon);
  if ( Number.isNaN(latitut) || Number.isNaN(longitut) || latitut < -90 || latitut > 90 || longitut < -180 || longitut > 180 ) {
    throw new Error('Nominatim ha retornat coordenades invàlides');
  }

  const nom = first.display_name?.split(',')[0]?.trim() || name;

  return { nom, latitut, longitut };
}

// Obtiene propiedades de suelo desde OpenGeoHub y clasifica el tipo de suelo con Excel
async function resolveSoilValuesFromCoords(lat: number, lon: number): Promise<SoilValues> {
  const soilData = await fetchSoilFromCoords(lat, lon);
  const ptf = computePTF( soilData.sand_pct, soilData.clay_pct, soilData.soc_pct );
  const nom_tipus_sol = await classifySoilTextureWithExcel( soilData.sand_pct, soilData.clay_pct );

  return {
    sand: soilData.sand_pct,
    silt: deriveSiltFromSandClay(soilData.sand_pct, soilData.clay_pct),
    clay: soilData.clay_pct,
    soc: soilData.soc_pct,
    densitat_aparent_kg_m3: soilData.bulk_density_kg_m3,
    fc: ptf.fc,
    wp: ptf.wp,
    nom_tipus_sol
  };
}

// Resuelve contexto de suelo a partir de coordenadas
export async function resolveSoilContextFromCoords(params: { Path: string; lat: number; lon: number }): Promise<SoilContextResponse> {
  const { Path, lat, lon } = params;
  requireValidCoords(lat, lon);

  const db = await loadAll(Path);
  
  // Primero se busca si ya existe una ubicación persistida con estas coordenadas, y si tiene suelo asociado
  const persistedLocation = findPersistedLocationByCoords(db, lat, lon);
  if (persistedLocation) {
    const persistedSoil = findPersistedSoilContextByLocation(db, persistedLocation);
    if (persistedSoil) return persistedSoil
  }

  // Si no hay suelo persistido, se resuelve el nombre de la ubicación y los valores de suelo en paralelo
  const nom = await resolveLocationNameFromCoords(lat, lon);
  const soil = await resolveSoilValuesFromCoords(lat, lon);

  return { nom, latitut: lat, longitut: lon, ...soil };
}

// Resuelve contexto de suelo a partir del nombre de una ubicación
export async function resolveSoilContextFromName(params: { Path: string; name: string }): Promise<SoilContextResponse> {
  const { Path, name } = params;

  const cleanName = name.trim();
  if (!cleanName) throw new Error('El nombre de la ubicación no puede estar vacío');

  const db = await loadAll(Path);

  // Primero se busca si ya existe una ubicación persistida con estas coordenadas, y si tiene suelo asociado
  const persistedLocation = findPersistedLocationByName(db, cleanName);
  if (persistedLocation) {
    const persistedSoil = findPersistedSoilContextByLocation(db, persistedLocation);
    if (persistedSoil) return persistedSoil;

    const soil = await resolveSoilValuesFromCoords(persistedLocation.latitut, persistedLocation.longitut);

    return { 
      nom: persistedLocation.nom, 
      latitut: persistedLocation.latitut, 
      longitut: persistedLocation.longitut, 
      ...soil 
    };
  }

  const location = await resolveCoordsFromLocationName(cleanName);
  const soil = await resolveSoilValuesFromCoords(location.latitut, location.longitut);

  return {
    nom: location.nom,
    latitut: location.latitut,
    longitut: location.longitut,
    ...soil,
  };
}