// Loading real Brooklyn data from NYC Open Data (Socrata).
//
// Dataset IDs on NYC Open Data change when datasets are republished, so each
// layer lists known IDs first and falls back to a catalog search by name.
// Metadata from /api/views/{id}.json tells us the geometry column, so the
// server can clip each layer to Brooklyn's bounding box before sending it.

const DOMAIN = 'https://data.cityofnewyork.us';
const CATALOG = 'https://api.us.socrata.com/api/catalog/v1';
const PAGE = 50000;

// Rough Brooklyn extent, used to clip requests before the real boundary is known.
export const BROOKLYN_BBOX = [-74.06, 40.565, -73.83, 40.745];

export const LAYERS = {
  boundary: {
    label: 'Borough boundary',
    needsGeometry: true,
    ids: ['gthc-hcne', 'tqmj-j8zm', '7t3b-ywvw'],
    search: 'Borough Boundaries',
    keep: (p) => /brooklyn/i.test(p.boro_name ?? p.boroname ?? p.BoroName ?? '') || String(p.boro_code ?? p.borocode ?? p.BoroCode) === '3',
  },
  parks: { label: 'Parks properties', needsGeometry: true, ids: ['enfh-gkve'], search: 'Parks Properties' },
  hydrography: { label: 'Hydrography', needsGeometry: true, ids: ['drh3-e2fd'], search: 'Hydrography' },
  shoreline: { label: 'Shoreline', needsGeometry: true, ids: ['2qj2-cctx'], search: 'Shoreline' },
  floodplain: {
    label: 'FEMA 100-year floodplain',
    needsGeometry: true,
    ids: ['ezfn-5dsb'],
    search: 'Sea Level Rise Maps (2020s 100-year Floodplain)',
    fallbackSearch: 'NYC Stormwater Flood Map',
  },
  wetlands: { label: 'Wetlands (NYC Parks)', needsGeometry: true, ids: ['p48c-iqtu'], search: 'NYC Wetlands' },
  landcover: {
    label: 'Land use and buildings (MapPLUTO)',
    ids: ['64uk-42ks'],
    search: 'Primary Land Use Tax Lot Output (PLUTO)',
  },
  buildings: { label: 'Building footprints', needsGeometry: true, ids: ['5zhs-2jue', 'nqwf-w8eh'], search: 'Building Footprints' },
};

async function getJSON(url, signal = AbortSignal.timeout(120000)) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

const metaCache = new Map();

async function metadata(id) {
  if (!metaCache.has(id)) {
    metaCache.set(id, getJSON(`${DOMAIN}/api/views/${id}.json`).then((meta) => {
      // Legacy "map" views keep their rows in a child dataset.
      if (meta.viewType === 'geo' && meta.childViews?.length) {
        return getJSON(`${DOMAIN}/api/views/${meta.childViews[0]}.json`).then((child) => ({ ...child, parentId: id }));
      }
      return meta;
    }));
  }
  return metaCache.get(id);
}

const GEOMETRY_TYPES = ['multipolygon', 'polygon', 'multiline', 'line', 'multipoint', 'point', 'location'];

function geometryColumn(meta) {
  return meta.columns?.find((c) => GEOMETRY_TYPES.includes(c.dataTypeName))?.fieldName;
}

async function searchCatalog(query) {
  const url = `${CATALOG}?domains=data.cityofnewyork.us&search_context=data.cityofnewyork.us&q=${encodeURIComponent(query)}&limit=8`;
  const json = await getJSON(url);
  const want = query.toLowerCase();
  const results = json.results.map((r) => r.resource);
  results.sort((a, b) => (b.name.toLowerCase() === want) - (a.name.toLowerCase() === want));
  return results.map((r) => r.id);
}

// Resolves a layer to a dataset: { id, meta, geom }.
async function resolve(layer) {
  const tried = new Set();
  const attempt = async (id) => {
    if (tried.has(id)) return null;
    tried.add(id);
    try {
      const meta = await metadata(id);
      return { id: meta.id ?? id, meta, geom: geometryColumn(meta) };
    } catch {
      return null;
    }
  };
  for (const id of layer.ids) {
    const found = await attempt(id);
    if (found) return found;
  }
  for (const query of [layer.search, layer.fallbackSearch].filter(Boolean)) {
    try {
      for (const id of await searchCatalog(query)) {
        const found = await attempt(id);
        if (found && (found.geom || !layer.needsGeometry)) return found;
      }
    } catch { /* catalog unavailable; try next */ }
  }
  throw new Error(`Could not find the ${layer.label} dataset on NYC Open Data`);
}

const withinBox = (geom, [w, s, e, n]) => `within_box(${geom}, ${n}, ${w}, ${s}, ${e})`;
const intersectsBox = (geom, [w, s, e, n]) =>
  `intersects(${geom}, 'POLYGON((${w} ${s}, ${e} ${s}, ${e} ${n}, ${w} ${n}, ${w} ${s}))')`;

// Fetches every feature of a dataset as GeoJSON, paging past Socrata's row limit.
async function fetchFeatures(dataset, where, onProgress, signal) {
  const features = [];
  for (let offset = 0; ; offset += PAGE) {
    const params = new URLSearchParams({ $limit: PAGE, $offset: offset, $order: ':id' });
    if (where) params.set('$where', where);
    const json = await getJSON(`${DOMAIN}/resource/${dataset.id}.geojson?${params}`, signal);
    features.push(...json.features);
    onProgress?.(features.length);
    if (json.features.length < PAGE) return features;
  }
}

// Loads a polygon or line layer clipped to Brooklyn.
export async function loadLayer(key, onProgress, bbox = BROOKLYN_BBOX) {
  const layer = LAYERS[key];
  const dataset = await resolve(layer);
  let features;
  const wheres = dataset.geom
    ? [intersectsBox(dataset.geom, bbox), withinBox(dataset.geom, bbox), null]
    : [null];
  let lastError;
  for (const where of wheres) {
    try {
      features = await fetchFeatures(dataset, where, onProgress);
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!features) {
    // Last resort for legacy shapefile-backed datasets.
    const json = await getJSON(`${DOMAIN}/api/geospatial/${dataset.meta.parentId ?? dataset.id}?method=export&format=GeoJSON`)
      .catch(() => { throw lastError; });
    features = json.features;
  }
  features = features.filter((f) => f.geometry);
  if (layer.keep) features = features.filter((f) => layer.keep(f.properties ?? {}));
  return { features, source: `${DOMAIN}/d/${dataset.id}`, name: dataset.meta.name };
}

// Tax lots from PLUTO: location, land use, floors, lot and building area.
// Fetched as CSV with only the columns we need (about 280k rows for Brooklyn).
export async function loadLots(onProgress) {
  const dataset = await resolve(LAYERS.landcover);
  const lots = [];
  for (let offset = 0; ; offset += PAGE) {
    const params = new URLSearchParams({
      $select: 'latitude,longitude,landuse,numfloors,lotarea,bldgarea',
      $where: "borough='BK' AND latitude IS NOT NULL",
      $limit: PAGE, $offset: offset, $order: ':id',
    });
    const res = await fetch(`${DOMAIN}/resource/${dataset.id}.csv?${params}`, { signal: AbortSignal.timeout(180000) });
    if (!res.ok) throw new Error(`${res.status} loading PLUTO`);
    const rows = (await res.text()).trim().split('\n').slice(1);
    for (const line of rows) {
      const [lat, lon, landuse, floors, lotarea, bldgarea] = line.split(',').map((s) => s.replace(/"/g, ''));
      if (!lat) continue;
      lots.push({ lat: +lat, lon: +lon, landuse: landuse.padStart(2, '0'), floors: +floors || 0, lotarea: +lotarea || 0, bldgarea: +bldgarea || 0 });
    }
    onProgress?.(lots.length);
    if (rows.length < PAGE) break;
  }
  return { lots, source: `${DOMAIN}/d/${dataset.id}`, name: dataset.meta.name };
}

// Building footprints within a map view, for display at street-level zooms.
let buildingsDataset;
export async function loadBuildingsInView(bbox, signal) {
  buildingsDataset ??= resolve(LAYERS.buildings);
  const dataset = await buildingsDataset;
  const params = new URLSearchParams({ $limit: 8000, $where: withinBox(dataset.geom ?? 'the_geom', bbox) });
  const json = await getJSON(`${DOMAIN}/resource/${dataset.id}.geojson?${params}`, signal);
  for (const f of json.features) {
    const p = f.properties;
    p.height = +(p.height_roof ?? p.heightroof ?? 0);
  }
  return json;
}
