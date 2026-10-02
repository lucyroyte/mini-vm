// The MapLibre map: basemap, the cell grid, and the reference data layers.

import { ECOSYSTEMS } from './ecosystems.js';
import { cellBoundary, HA_PER_CELL } from './grid.js';
import { loadBuildingsInView } from './data.js';

/* global maplibregl */

// OpenFreeMap's vector Positron style: free, no API key, OpenStreetMap data.
const BASEMAP = 'https://tiles.openfreemap.org/styles/positron';

const empty = () => ({ type: 'FeatureCollection', features: [] });

export function createMap(container, world) {
  const [w, s, e, n] = world.bbox;
  const map = new maplibregl.Map({
    container,
    style: BASEMAP,
    bounds: [[w, s], [e, n]],
    fitBoundsOptions: { padding: { top: 70, bottom: 20, left: 20, right: 360 } },
    attributionControl: { compact: true, customAttribution: 'Data: <a href="https://opendata.cityofnewyork.us/">NYC Open Data</a>, USGS 3DEP' },
    dragRotate: false,
    pitchWithRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-left');
  map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');
  // Wait for the style, not every basemap tile, so a slow basemap never blocks editing.
  return new Promise((resolve) => map.once('style.load', () => { addLayers(map, world); resolve(map); }));
}

function addLayers(map, world) {
  const features = [];
  for (let i = 0; i < world.cells.count; i++) {
    features.push({
      type: 'Feature', id: i, properties: {},
      geometry: { type: 'Polygon', coordinates: [cellBoundary(world, i).map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)])] },
    });
  }
  const fc = (list) => ({ type: 'FeatureCollection', features: list ?? [] });
  map.addSource('cells', { type: 'geojson', data: fc(features), tolerance: 0 });
  map.addSource('boundary', { type: 'geojson', data: fc(world.layers.boundary) });
  map.addSource('floodplain', { type: 'geojson', data: fc(world.layers.floodplain) });
  map.addSource('parks', { type: 'geojson', data: fc(world.layers.parks) });
  map.addSource('hydrography', { type: 'geojson', data: fc(world.layers.hydrography) });
  map.addSource('shoreline', { type: 'geojson', data: fc(world.layers.shoreline) });
  map.addSource('buildings', { type: 'geojson', data: empty() });
  map.addSource('cursor', { type: 'geojson', data: empty() });

  map.addLayer({
    id: 'cells', type: 'fill', source: 'cells',
    paint: { 'fill-color': ['coalesce', ['feature-state', 'c'], '#cccccc'], 'fill-opacity': 0.75, 'fill-antialias': false },
  });
  map.addLayer({
    id: 'grid', type: 'line', source: 'cells', minzoom: 14.5,
    paint: { 'line-color': '#ffffff', 'line-opacity': 0.5, 'line-width': 0.5 },
  });
  map.addLayer({
    id: 'buildings', type: 'fill', source: 'buildings', minzoom: 15,
    paint: { 'fill-color': '#4b4b4b', 'fill-opacity': 0.35, 'fill-outline-color': '#333333' },
  });
  map.addLayer({
    id: 'floodplain', type: 'fill', source: 'floodplain', layout: { visibility: 'none' },
    paint: { 'fill-color': '#1f6fd1', 'fill-opacity': 0.3 },
  });
  map.addLayer({
    id: 'parks', type: 'line', source: 'parks', layout: { visibility: 'none' },
    paint: { 'line-color': '#1d6b2b', 'line-width': 1.2 },
  });
  map.addLayer({
    id: 'hydrography', type: 'fill', source: 'hydrography', layout: { visibility: 'none' },
    paint: { 'fill-color': '#2a83c6', 'fill-opacity': 0.5, 'fill-outline-color': '#1b5a8a' },
  });
  map.addLayer({
    id: 'shoreline', type: 'line', source: 'shoreline', layout: { visibility: 'none' },
    paint: { 'line-color': '#0a3d62', 'line-width': 1.5 },
  });
  map.addLayer({
    id: 'boundary', type: 'line', source: 'boundary',
    paint: { 'line-color': '#222222', 'line-width': 1.5, 'line-opacity': 0.8 },
  });
  map.addLayer({
    id: 'cursor-fill', type: 'fill', source: 'cursor',
    paint: { 'fill-color': ['coalesce', ['get', 'color'], '#000000'], 'fill-opacity': 0.35 },
  });
  map.addLayer({
    id: 'cursor', type: 'line', source: 'cursor',
    paint: { 'line-color': '#111111', 'line-width': 2 },
  });

  // Building footprints are fetched for the current view once zoomed in.
  let pending;
  const refreshBuildings = async () => {
    if (map.getLayoutProperty('buildings', 'visibility') === 'none' || map.getZoom() < 15) return;
    pending?.abort();
    pending = new AbortController();
    const b = map.getBounds();
    try {
      const data = await loadBuildingsInView([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], pending.signal);
      map.getSource('buildings').setData(data);
    } catch (err) {
      if (err.name !== 'AbortError') console.warn('Building footprints unavailable:', err.message);
    }
  };
  map.on('moveend', refreshBuildings);
  map.refreshBuildings = refreshBuildings;
}

// Colors -----------------------------------------------------------------------

const lerp = (a, b, t) => a + (b - a) * t;
function ramp(stops, v) {
  if (v <= stops[0][0]) return stops[0][1];
  for (let k = 1; k < stops.length; k++) {
    if (v <= stops[k][0]) {
      const [v0, c0] = stops[k - 1], [v1, c1] = stops[k];
      const t = (v - v0) / (v1 - v0);
      const a = hex(c0), b = hex(c1);
      return `rgb(${a.map((x, i) => Math.round(lerp(x, b[i], t))).join(',')})`;
    }
  }
  return stops[stops.length - 1][1];
}
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

export const SCALES = {
  flood: { label: 'Flood depth', unit: 'ft', stops: [[0, '#f2f2f2'], [0.33, '#c6dbef'], [1, '#6baed6'], [3, '#2171b5'], [8, '#08306b']] },
  heat: { label: 'Summer surface temperature', unit: '°F', stops: [[85, '#2c7bb6'], [95, '#ffffbf'], [101, '#fdae61'], [108, '#d7191c']] },
  residents: { label: 'Residents per hectare', unit: '/ha', stops: [[0, '#f7f4ea'], [50, '#fdd49e'], [200, '#fc8d59'], [500, '#d7301f'], [1000, '#7f0000']] },
  habitat: { label: 'Habitat value', unit: '/10', stops: [[0, '#f7f4ea'], [3, '#c2e699'], [6, '#41ab5d'], [10, '#00441b']] },
  elevation: { label: 'Elevation', unit: 'ft', stops: [[-5, '#2b5d8a'], [0, '#a6d1e6'], [10, '#f1eebd'], [40, '#c9a46b'], [150, '#7a4b2a']] },
};

// Fills every cell's color for a display mode.
export function paintCells(map, world, mode, vision, results) {
  const { existing } = world.cells;
  const N = world.cells.count;
  const color = (i) => {
    switch (mode) {
      case 'today': return ECOSYSTEMS[existing[i]].color;
      case 'changes': return vision.current[i] === existing[i] ? '#eeeeee' : ECOSYSTEMS[vision.current[i]].color;
      case 'flood': {
        const p = results.perCell;
        if (ECOSYSTEMS[vision.current[i]].id === 'water') return '#dfe9f2';
        const d = Math.max(p.coastalDepth[i], p.stormDepth[i] >= 4 ? p.stormDepth[i] / 12 : 0);
        return ramp(SCALES.flood.stops, d);
      }
      case 'heat': return ramp(SCALES.heat.stops, results.perCell.heat[i]);
      case 'habitat': return ramp(SCALES.habitat.stops, results.perCell.habitat[i]);
      case 'residents': return ramp(SCALES.residents.stops, results.perCell.residents[i] / HA_PER_CELL);
      case 'elevation': return ramp(SCALES.elevation.stops, world.cells.elevation[i]);
      default: return ECOSYSTEMS[vision.current[i]].color;
    }
  };
  for (let i = 0; i < N; i++) map.setFeatureState({ source: 'cells', id: i }, { c: color(i) });
}

export function paintSome(map, vision, ids) {
  for (const i of ids) map.setFeatureState({ source: 'cells', id: i }, { c: ECOSYSTEMS[vision.current[i]].color });
}

export function setCursor(map, rings, color) {
  map.getSource('cursor')?.setData({
    type: 'FeatureCollection',
    features: rings.map((ring) => ({ type: 'Feature', properties: { color }, geometry: { type: 'Polygon', coordinates: [ring] } })),
  });
}
