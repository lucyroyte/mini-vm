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
    // All boroughs load, so Queens across the land border is known to be land.
  },
  parks: { label: 'Parks properties', needsGeometry: true, ids: ['enfh-gkve'], search: 'Parks Properties' },
  hydrography: { label: 'Hydrography', needsGeometry: true, ids: ['pjs3-c3z5', 'drh3-e2fd'], search: 'Hydrography' },
  shoreline: { label: 'Shoreline', needsGeometry: true, ids: ['59xk-wagz', '2qj2-cctx'], search: 'Shoreline' },
  floodplain: {
    label: 'FEMA 100-year floodplain',
    needsGeometry: true,
    ids: ['aqw3-vugz', 'ezfn-5dsb'],
    search: 'Sea Level Rise Maps (2020s 100-year Floodplain)',
    fallbackSearch: 'NYC Stormwater Flood Map',
    // aqw3-vugz is the 2020s 500-year floodplain; its A and V zones are the
    // 100-year floodplain inside it.
    keep: (p) => !('fld_zone' in p) || /^[AV]/.test(p.fld_zone ?? ''),
  },
  wetlands: { label: 'Wetlands (NYC Parks)', needsGeometry: true, ids: ['p48c-iqtu'], search: 'NYC Wetlands' },
  landcover: {
    label: 'Land use and buildings (MapPLUTO)',
    ids: ['64uk-42ks'],
    search: 'Primary Land Use Tax Lot Output (PLUTO)',
  },
  lotShapes: { label: 'Tax lot polygons', needsGeometry: true, ids: ['i38t-6if2'], search: 'TAX_LOT_POLYGON' },
  buildings: { label: 'Building footprints', needsGeometry: true, ids: ['5zhs-2jue', 'nqwf-w8eh'], search: 'Building Footprints' },
  streetTrees: { label: 'Street trees (2015 census)', ids: ['uvpi-gqnh'], search: '2015 Street Tree Census - Tree Data' },
  heatVulnerability: { label: 'Heat Vulnerability Index (DOHMH)', ids: ['4mhf-duep'], search: 'Heat Vulnerability Index Rankings' },
  benchmarking: {
    label: 'Building energy and emissions (Local Law 84)',
    ids: ['5zyy-y8am'],
    search: 'NYC Building Energy and Water Data Disclosure for Local Law 84 (2022-Present)',
  },
};

export const isBrooklyn = (p) => /brooklyn/i.test(p.boro_name ?? p.boroname ?? p.BoroName ?? '') || String(p.boro_code ?? p.borocode ?? p.BoroCode) === '3';

// 2020 Census population and housing units for each Brooklyn census block,
// extracted from the Census Bureau's PL 94-171 redistricting file by
// tools/census_blocks.py. Keyed like PLUTO's bctcb2020 (borough, tract, block).
export const CENSUS_BLOCKS_URL = 'data/census/brooklyn-blocks-2020.json';
export const CENSUS_SOURCE = 'https://www.census.gov/programs-surveys/decennial-census/about/rdo/summary-files.html';

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
  // A "map" asset has metadata but no rows, so a geometry column is the
  // real sign that a dataset can be drawn.
  const usable = (found) => found && (found.geom || !layer.needsGeometry);
  for (const id of layer.ids) {
    const found = await attempt(id);
    if (usable(found)) return found;
  }
  for (const query of [layer.search, layer.fallbackSearch].filter(Boolean)) {
    try {
      for (const id of await searchCatalog(query)) {
        const found = await attempt(id);
        if (usable(found)) return found;
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

async function fetchCSV(dataset, params, label, onProgress, parse) {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const q = new URLSearchParams({ ...params, $limit: PAGE, $offset: offset, $order: ':id' });
    const res = await fetch(`${DOMAIN}/resource/${dataset.id}.csv?${q}`, { signal: AbortSignal.timeout(180000) });
    if (!res.ok) throw new Error(`${res.status} loading ${label}`);
    const rows = (await res.text()).trim().split('\n').slice(1);
    for (const line of rows) {
      const row = parse(line.split(',').map((s) => s.replace(/"/g, '')));
      if (row) out.push(row);
    }
    onProgress?.(out.length);
    if (rows.length < PAGE) return out;
  }
}

// Tax lots from PLUTO: location, land use, floors, lot and building area,
// residential units and the 2020 census block. Fetched as CSV with only the
// columns we need (about 280k rows for Brooklyn).
export async function loadLots(onProgress) {
  const dataset = await resolve(LAYERS.landcover);
  const lots = await fetchCSV(dataset, {
    $select: 'latitude,longitude,landuse,numfloors,lotarea,bldgarea,unitsres,bctcb2020,zipcode,bbl',
    $where: "borough='BK' AND latitude IS NOT NULL",
  }, 'PLUTO', onProgress, ([lat, lon, landuse, floors, lotarea, bldgarea, units, block, zip, bbl]) => (lat ? {
    lat: +lat, lon: +lon, landuse: landuse.padStart(2, '0'), floors: +floors || 0, lotarea: +lotarea || 0, bldgarea: +bldgarea || 0,
    units: +units || 0, block, zip, bbl: String(Math.round(+bbl || 0)),
  } : null));
  return { lots, source: `${DOMAIN}/d/${dataset.id}`, name: dataset.meta.name };
}

// Living street trees: location and trunk diameter, for tree canopy shade.
export async function loadStreetTrees(onProgress) {
  const dataset = await resolve(LAYERS.streetTrees);
  const trees = await fetchCSV(dataset, {
    $select: 'latitude,longitude,tree_dbh',
    $where: "boroname='Brooklyn' AND status='Alive'",
  }, 'street trees', onProgress, ([lat, lon, dbh]) => (lat ? { lat: +lat, lon: +lon, dbh: +dbh || 0 } : null));
  return { trees, source: `${DOMAIN}/d/${dataset.id}`, name: dataset.meta.name };
}

// Heat Vulnerability Index (1 = least, 5 = most vulnerable) by ZIP code area.
export async function loadHeatVulnerability() {
  const dataset = await resolve(LAYERS.heatVulnerability);
  const rows = await getJSON(`${DOMAIN}/resource/${dataset.id}.json?$limit=1000`);
  const byZip = Object.fromEntries(rows.map((r) => [r.zcta20 ?? r.zipcode ?? r.zcta, +r.hvi]).filter(([z, v]) => z && v));
  return { byZip, source: `${DOMAIN}/d/${dataset.id}`, name: dataset.meta.name };
}

// Yearly greenhouse gas emissions that large buildings (over 25,000 sq ft)
// report under Local Law 84, from their metered electricity, gas, oil and
// steam, for the latest report year. A property covering several tax lots lists
// all of their BBLs. Campuses report a parent property and its buildings; the
// parent's total is kept and its buildings dropped, so nothing counts twice.
export async function loadBenchmarking() {
  const dataset = await resolve(LAYERS.benchmarking);
  const rows = await getJSON(`${DOMAIN}/resource/${dataset.id}.json?${new URLSearchParams({
    $select: 'property_id,parent_property_id,report_year,nyc_borough_block_and_lot,total_location_based_ghg,property_gfa_calculated',
    $where: "borough='BROOKLYN'",
    $limit: 50000,
  })}`);
  const year = Math.max(...rows.map((r) => +r.report_year || 0));
  const latest = rows.filter((r) => +r.report_year === year);
  const ids = new Set(latest.map((r) => r.property_id));
  const properties = [];
  for (const r of latest) {
    const tonnes = +r.total_location_based_ghg;
    if (!(tonnes > 0) || ids.has(r.parent_property_id)) continue;
    const bbls = String(r.nyc_borough_block_and_lot ?? '').replace(/-/g, '').match(/\b3\d{9}\b/g);
    if (bbls) properties.push({ bbls: [...new Set(bbls)], tonnes, area: +r.property_gfa_calculated || 0 });
  }
  return { properties, year, source: `${DOMAIN}/d/${dataset.id}`, name: `${dataset.meta.name}, ${year} reports` };
}

export async function loadCensusBlocks(url = CENSUS_BLOCKS_URL) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} loading census blocks`);
  return { blocks: await res.json(), source: CENSUS_SOURCE, name: '2020 Census Redistricting Data (PL 94-171), Kings County blocks' };
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

// The tax lot polygon under a point, for the Lot tool. Lots are fetched one at
// a time as the pointer moves, so the app never downloads all ~276k shapes.
// Air rights and sub lots are skipped in favor of the ground lot.
let lotsDataset;
export async function loadLotAt(lon, lat, signal) {
  lotsDataset ??= resolve(LAYERS.lotShapes);
  const dataset = await lotsDataset;
  const params = new URLSearchParams({ $limit: 10, $where: `intersects(${dataset.geom ?? 'the_geom'}, 'POINT(${lon} ${lat})')` });
  const json = await getJSON(`${DOMAIN}/resource/${dataset.id}.geojson?${params}`, signal);
  const ground = (f) => !f.properties.air_lot_flag && !f.properties.sub_lot_flag;
  return json.features.find(ground) ?? json.features[0] ?? null;
}

// FloodNet street flood sensors (NYU, CUNY and the City) in Brooklyn: where
// they are, from FloodNet's API, and the floods each has measured since 2020,
// from NYC Open Data. Loaded only when the layer is turned on.
const FLOODNET_API = 'https://api.floodnet.nyc/api/rest/deployments/flood';
export async function loadFloodNet() {
  const [{ deployments }, events] = await Promise.all([
    getJSON(FLOODNET_API),
    getJSON(`${DOMAIN}/resource/aq7i-eu5q.json?${new URLSearchParams({
      $select: 'sensor_name,count(*) as floods,max(max_depth_inches) as deepest,sum(case(max_depth_inches>=4,1,true,0)) as over4',
      $where: "starts_with(sensor_name, 'BK')",
      $group: 'sensor_name',
      $limit: 5000,
    })}`),
  ]);
  const byName = Object.fromEntries(events.map((e) => [e.sensor_name, e]));
  return {
    type: 'FeatureCollection',
    features: deployments.filter((d) => d.name.startsWith('BK') && d.location).map((d) => {
      const e = byName[d.name];
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: d.location.coordinates },
        properties: {
          name: d.name.replace(/^BK - /, ''), kind: d.deploy_type, since: d.date_deployed?.slice(0, 10),
          floods: +(e?.floods ?? 0), over4: +(e?.over4 ?? 0), deepest: +(e?.deepest ?? 0),
        },
      };
    }),
  };
}
