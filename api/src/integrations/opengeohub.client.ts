import { fromUrl,
  type GeoTIFFImage,
 } from 'geotiff';
import { requireValidCoords } from './openMeteo.client'

export interface SampledSoil {
  sand_pct: number;
  silt_pct: number;
  clay_pct: number;
  soc_pct: number;
  bulk_density_kg_m3: number;
}

const COG_URLS = {
  sand: 'https://s3.opengeohub.org/global-soil/global_soil_props_v20250523/sand.tot_iso.11277.2020.wpct_m_120m_b0cm..30cm_20200101_20221231_g_epsg.4326_v20250523.tif',
  silt: 'https://s3.opengeohub.org/global-soil/global_soil_props_v20250523/silt.tot_iso.11277.2020.wpct_m_120m_b0cm..30cm_20200101_20221231_g_epsg.4326_v20250523.tif',
  clay: 'https://s3.opengeohub.org/global-soil/global_soil_props_v20250523/clay.tot_iso.11277.2020.wpct_m_120m_b0cm..30cm_20200101_20221231_g_epsg.4326_v20250523.tif',
  soc: 'https://s3.opengeohub.org/global-soil/global_soil_props_v20250204_mosaics/oc_iso.10694.1995.wpml_m_120m_b0cm..30cm_20200101_20221231_g_epsg.4326_v20250204.tif',
  bd: 'https://s3.opengeohub.org/global-soil/global_soil_props_v20250204_mosaics/bd.core_iso.11272.2017.g.cm3_m_120m_b0cm..30cm_20200101_20221231_g_epsg.4326_v20250204.tif'
} as const;

const imageCache = new Map<string, Promise<GeoTIFFImage>>();

// Reintenta las descargas para tolerar fallos temporales de red o S3.
async function retryAsync<T>( operation: () => Promise<T>, attempts = 3 ): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        imageCache.clear();
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// Valida que el valor es un porcentaje entre 0 y 100
function requirePercent(value: number, fieldName: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`OpenGeoHub ${fieldName} fora de rang 0..100: ${value}`);
  }
  return value;
}

// Normaliza diferentes formatos de no-data
function parseNoData(noDataRaw: unknown): number | null {
  if (noDataRaw == null) return null;
  if (typeof noDataRaw === 'number') return Number.isFinite(noDataRaw) ? noDataRaw : null;
  if (typeof noDataRaw === 'string') {
    const parsed = Number(noDataRaw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// Descarga la imagen GeoTIFF y la cachea para futuras consultas
async function getImage(url: string): Promise<GeoTIFFImage> {
  if (!imageCache.has(url)) {
    imageCache.set(url, (async () => {
      const tiff = await retryAsync(() => fromUrl(url));
      return tiff.getImage();
    })());
  }
  return imageCache.get(url)!;
}

// Intenta obtener la imagen de múltiples URLs
async function getImageFromSources(layer: keyof typeof COG_URLS): Promise<GeoTIFFImage> {
  const errors: string[] = [];
  // Cada capa apunta a una única URL; la envolvemos en una lista para mantener el patrón de reintento.
  for (const url of [COG_URLS[layer]]) {
    try {
      return await getImage(url);
    } catch (err) {
      errors.push(`${new URL(url).hostname}: ${(err as Error).message}`);
      imageCache.delete(url);
    }
  }
  throw new Error(`OpenGeoHub ${layer} fetch failed (${errors.join(' | ')})`);
}

// Lee el valor del píxel más cercano a lat/lon para la capa especificada
async function readNearestPixelAtLatLon(layer: keyof typeof COG_URLS, latitut: number, longitut: number): Promise<number> {
  const image = await getImageFromSources(layer);
  const img = image as unknown as {
    getWidth: () => number;
    getHeight: () => number;
    getBoundingBox: () => [number, number, number, number];
    getGDALNoData?: () => unknown;
    readRasters: (opts: {
      window: [number, number, number, number];
      samples: number[];
      interleave: true;
    }) => Promise<ArrayLike<number>>;
  };

  const width = img.getWidth();
  const height = img.getHeight();
  const [minX, minY, maxX, maxY] = img.getBoundingBox();
  if (longitut < minX || longitut > maxX || latitut < minY || latitut > maxY) {
    throw new Error(`Coordenada fuera de cobertura de OpenGeoHub: lat=${latitut}, lon=${longitut}`);
  }

  const xFloat = ((longitut - minX) / (maxX - minX)) * width;
  const yFloat = ((maxY - latitut) / (maxY - minY)) * height;
  const x = Math.min(width - 1, Math.max(0, Math.floor(xFloat)));
  const y = Math.min(height - 1, Math.max(0, Math.floor(yFloat)));
  const values = await img.readRasters({ window: [x, y, x + 1, y + 1], samples: [0], interleave: true, });
  const value = Number(values[0]);
  if (!Number.isFinite(value)) {
    throw new TypeError(`Valor inválido de OpenGeoHub a lat=${latitut}, lon=${longitut}`);
  }

  const noData = parseNoData(img.getGDALNoData?.());
  if (noData != null && Math.abs(value - noData) <= 1e-9) {
    throw new Error(`OpenGeoHub no-data pixel a lat=${latitut}, lon=${longitut}`);
  }

  return value;
}

// Función para obtener propiedades de suelo desde OpenGeoHub a partir de coordenadas lat/lon
export async function fetchSoilFromCoords(latitut: number, longitut: number): Promise<SampledSoil> {
  requireValidCoords(latitut, longitut);

  const [sandRaw, clayRaw, socRaw, bdRaw] = await Promise.all([
    readNearestPixelAtLatLon('sand', latitut, longitut),
    readNearestPixelAtLatLon('clay', latitut, longitut),
    readNearestPixelAtLatLon('soc', latitut, longitut),
    readNearestPixelAtLatLon('bd', latitut, longitut),
  ]);

  let siltRaw: number;
  try {
    siltRaw = await readNearestPixelAtLatLon('silt', latitut, longitut);
  } catch (error) {
    // Si la capa de limo falla, la derivamos de arena y arcilla para no romper la resolución del suelo.
    siltRaw = 100 - sandRaw - clayRaw;
    console.warn(
      `OpenGeoHub silt layer failed at lat=${latitut}, lon=${longitut}; ` +
      `deriving silt from sand/clay instead. Cause: ${(error as Error).message}`,
    );
  }

  const sandPct = requirePercent(sandRaw, 'sand');
  const clayPct = requirePercent(clayRaw, 'clay');
  const siltPct = requirePercent(siltRaw, 'silt');

  const textureSum = sandPct + siltPct + clayPct;

  if (!Number.isFinite(textureSum) || textureSum < 98 || textureSum > 102) {
    throw new Error(
      `Textura OpenGeoHub incoherente: sand+silt+clay=${textureSum.toFixed(2)} ` +
      `(sand=${sandPct}, silt=${siltPct}, clay=${clayPct})`,
    );
  }

  // Conversión de SOC de g/kg a % (g/100g)
  const socPct = socRaw * 0.1 * 0.1;

  // Conversión de densidad aparente de g/cm3 a kg/m3
  const bulkDensityKgM3 = bdRaw * 10;


  // Redondeos para estabilizar persistencia en BD y comparación.
  return {
    sand_pct: +sandPct.toFixed(1),
    silt_pct: +siltPct.toFixed(1),
    clay_pct: +clayPct.toFixed(1),
    soc_pct: +socPct.toFixed(2),
    bulk_density_kg_m3: +bulkDensityKgM3.toFixed(0),
  };
}
