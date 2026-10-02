// Builds the Borough and its 50 m Cells from the loaded data, and assigns each
// cell the ecosystem type of its dominant land cover.

import { TYPE_INDEX, WATER } from './ecosystems.js';
import { makeProjection, bboxOf, rasterizePolygons, rasterizeLines } from './geo.js';

export const CELL = 50; // meters
export const CELL_AREA = CELL * CELL; // 2,500 m²
export const HA_PER_CELL = CELL_AREA / 10000; // per-hectare values × this = per-cell values
const SUB = Math.max(1, Math.round(CELL / 25)); // land cover is sampled on a 25 m lattice inside each cell
const WATER_MARGIN = Math.round(400 / CELL); // water cells kept around the shore (400 m), so visions can build into the water
const SQFT = 0.092903;

// NYC Parks property categories → ecosystem type.
const PARK_TYPES = {
  'Flagship Park': 'park', 'Community Park': 'park', 'Neighborhood Park': 'park',
  'Recreational Field/Courts': 'park', 'Waterfront Facility': 'park', 'Historic House Park': 'park',
  'Managed Sites': 'park', 'Nature Area': 'forest', 'Undeveloped': 'meadow', 'Lot': 'meadow',
  'Garden': 'garden', 'Cemetery': 'cemetery', 'Parkway': 'green-street', 'Mall': 'green-street',
  'Strip': 'green-street', 'Playground': 'plaza', 'Jointly Operated Playground': 'plaza',
  'Triangle/Plaza': 'plaza', 'Buildings/Institutions': 'plaza', 'Operations': 'plaza',
};
const PARK_CLASSES = [...new Set(Object.values(PARK_TYPES))];

// NYC Parks wetland classes → ecosystem type. Emergent wetland is tidal marsh
// inside the floodplain and freshwater marsh outside it. Mapped open water is
// left to the hydrography layer.
const WETLAND_TYPES = { 'Estuarine': 'salt-marsh', 'Emergent': 'salt-marsh', 'Scrub/Shrub': 'fresh-wetland', 'Forested': 'fresh-wetland' };
const WETLAND_CLASSES = ['salt-marsh', 'fresh-wetland'];

// PLUTO land use codes → land cover group.
const LAND_USE = {
  '01': 'res', '02': 'res', '03': 'res', '04': 'res', '05': 'com', '08': 'com',
  '06': 'ind', '07': 'trans', '09': 'open', '10': 'parking', '11': 'vacant',
};
const GROUPS = ['res', 'com', 'ind', 'trans', 'open', 'parking', 'vacant'];

export const sizeForFloors = (f) => (f >= 13 ? 'high' : f >= 5 ? 'mid' : 'low');

export function buildGrid({ boundary, parks = [], hydrography = [], shoreline = [], floodplain = [], wetlands = [], lots = [], elevation = null }) {
  const [w, s, e, n] = bboxOf(boundary);
  const proj = makeProjection((w + e) / 2, (s + n) / 2);
  const [bx0, by0] = proj.toXY(w, s);
  const [bx1, by1] = proj.toXY(e, n);
  const margin = WATER_MARGIN * CELL;
  const x0 = Math.floor((bx0 - margin) / CELL) * CELL;
  const y0 = Math.floor((by0 - margin) / CELL) * CELL;
  const cols = Math.ceil((bx1 + margin - x0) / CELL);
  const rows = Math.ceil((by1 + margin - y0) / CELL);
  const lattice = { x0, y0, step: CELL / SUB, cols: cols * SUB, rows: rows * SUB };
  const samples = lattice.cols * lattice.rows;

  // Rasterize every polygon layer onto the sample lattice.
  const land = new Uint8Array(samples);
  rasterizePolygons(boundary, lattice, proj, (i) => { land[i] = 1; });
  const hydro = new Uint8Array(samples);
  rasterizePolygons(hydrography.filter(isArea), lattice, proj, (i) => { hydro[i] = 1; });
  const flood = new Uint8Array(samples);
  rasterizePolygons(floodplain, lattice, proj, (i) => { flood[i] = 1; });
  const park = new Uint8Array(samples);
  rasterizePolygons(parks, lattice, proj, (i, f) => {
    const type = PARK_TYPES[f.properties?.typecategory] ?? 'park';
    park[i] = PARK_CLASSES.indexOf(type) + 1;
  });

  // Wetlands, rasterized after the floodplain so emergent marsh can be split by it.
  const wet = new Uint8Array(samples);
  rasterizePolygons(wetlands, lattice, proj, (i, f) => {
    let type = WETLAND_TYPES[f.properties?.classname];
    if (!type) return;
    if (f.properties.classname === 'Emergent' && !flood[i]) type = 'fresh-wetland';
    wet[i] = WETLAND_CLASSES.indexOf(type) + 1;
  });

  // Aggregate samples to cells.
  const all = cols * rows;
  const landFrac = new Float32Array(all), hydroFrac = new Float32Array(all), floodFrac = new Float32Array(all);
  const parkCounts = new Uint8Array(all * PARK_CLASSES.length);
  const wetCounts = new Uint8Array(all * WETLAND_CLASSES.length);
  const share = 1 / (SUB * SUB);
  for (let r = 0; r < lattice.rows; r++) {
    for (let c = 0; c < lattice.cols; c++) {
      const i = r * lattice.cols + c;
      const k = Math.floor(r / SUB) * cols + Math.floor(c / SUB);
      if (land[i]) landFrac[k] += share;
      if (hydro[i]) hydroFrac[k] += share;
      if (flood[i]) floodFrac[k] += share;
      if (park[i] && land[i]) parkCounts[k * PARK_CLASSES.length + park[i] - 1]++;
      if (wet[i] && land[i]) wetCounts[k * WETLAND_CLASSES.length + wet[i] - 1]++;
    }
  }

  // Tax lots: spread each lot's area over the cells it likely covers, so a large
  // lot (a rail yard, the Navy Yard) doesn't land entirely in one cell.
  const lotArea = new Float32Array(all * GROUPS.length);
  const floorArea = new Float32Array(all * GROUPS.length);
  const floorWeighted = new Float32Array(all * GROUPS.length);
  for (const lot of lots) {
    const group = LAND_USE[lot.landuse];
    if (!group) continue;
    const g = GROUPS.indexOf(group);
    const [x, y] = proj.toXY(lot.lon, lot.lat);
    const c = Math.floor((x - x0) / CELL), r = Math.floor((y - y0) / CELL);
    const area = lot.lotarea * SQFT;
    const rad = Math.floor(Math.sqrt(area) / CELL / 2);
    const spread = (2 * rad + 1) ** 2;
    for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
      const cc = c + dc, rr = r + dr;
      if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) continue;
      const k = (rr * cols + cc) * GROUPS.length + g;
      lotArea[k] += area / spread;
      floorArea[k] += lot.bldgarea / spread;
      floorWeighted[k] += (lot.bldgarea * lot.floors) / spread;
    }
  }

  // Keep land cells plus a margin of water around the shore.
  const isLand = (k) => landFrac[k] >= 0.5 && hydroFrac[k] < 0.5;
  const keep = new Uint8Array(all);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (landFrac[r * cols + c] === 0) continue;
    for (let dr = -WATER_MARGIN; dr <= WATER_MARGIN; dr++) for (let dc = -WATER_MARGIN; dc <= WATER_MARGIN; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && cc >= 0 && rr < rows && cc < cols) keep[rr * cols + cc] = 1;
    }
  }

  // Shoreline: cells crossed by the shoreline layer, or land touching water.
  const shore = new Uint8Array(all);
  rasterizeLines(shoreline, { x0, y0, step: CELL, cols, rows }, proj, (k) => { shore[k] = 1; });
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const k = r * cols + c;
    if (!isLand(k)) continue;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= rows || cc >= cols || !isLand(rr * cols + cc)) shore[k] = 1;
    }
  }

  // Build the cell arrays.
  const ids = [];
  for (let k = 0; k < all; k++) if (keep[k]) ids.push(k);
  const N = ids.length;
  const cells = {
    count: N,
    col: new Uint16Array(N), row: new Uint16Array(N),
    elevation: new Float32Array(N),
    inFloodplain: new Uint8Array(N), onShoreline: new Uint8Array(N),
    land: new Float32Array(N),
    existing: new Uint8Array(N),
  };
  const index = new Int32Array(all).fill(-1);
  let missingElevation = 0;
  ids.forEach((k, i) => {
    const c = k % cols, r = Math.floor(k / cols);
    index[k] = i;
    cells.col[i] = c;
    cells.row[i] = r;
    cells.land[i] = landFrac[k];
    cells.inFloodplain[i] = floodFrac[k] >= 0.25 ? 1 : 0;
    cells.onShoreline[i] = isLand(k) && shore[k] ? 1 : 0;

    let elev = NaN;
    if (elevation) {
      let sum = 0, m = 0;
      for (const fy of [0.25, 0.75]) for (const fx of [0.25, 0.75]) {
        const v = elevation(...proj.toLonLat(x0 + (c + fx) * CELL, y0 + (r + fy) * CELL));
        if (Number.isFinite(v)) { sum += v; m++; }
      }
      if (m) elev = sum / m;
    }
    if (!Number.isFinite(elev)) {
      // No elevation data: a rough guess from the floodplain and the shore.
      missingElevation++;
      elev = !isLand(k) ? -10 : cells.inFloodplain[i] ? 6 : 30;
    }
    cells.elevation[i] = elev;

    cells.existing[i] = classify(k, i);
  });

  function classify(k, i) {
    if (!isLand(k)) return WATER;
    // Mapped wetlands win over park and lot categories: Marine Park is a
    // "Community Park" but mostly salt marsh, and federal parkland is "open space" in PLUTO.
    const [salt, fresh] = wetCounts.subarray(k * WETLAND_CLASSES.length, (k + 1) * WETLAND_CLASSES.length);
    if ((salt + fresh) / (SUB * SUB) >= 0.5 * landFrac[k]) return TYPE_INDEX[salt >= fresh ? 'salt-marsh' : 'fresh-wetland'];
    // Parks
    const pc = parkCounts.subarray(k * PARK_CLASSES.length, (k + 1) * PARK_CLASSES.length);
    let parkTotal = 0, best = 0;
    for (let j = 0; j < pc.length; j++) { parkTotal += pc[j]; if (pc[j] > pc[best]) best = j; }
    if (parkTotal / (SUB * SUB) >= 0.5 * landFrac[k]) {
      let type = PARK_CLASSES[best];
      // Natural areas at the water's edge in the floodplain are tidal marsh.
      if ((type === 'forest' || type === 'meadow') && cells.inFloodplain[i] && cells.elevation[i] < 6) type = 'salt-marsh';
      return TYPE_INDEX[type];
    }
    // Tax lots
    const la = lotArea.subarray(k * GROUPS.length, (k + 1) * GROUPS.length);
    let total = 0, g = 0;
    for (let j = 0; j < la.length; j++) { total += la[j]; if (la[j] > la[g]) g = j; }
    if (total < 0.25 * CELL_AREA * landFrac[k]) {
      // Mostly streets and other public rights-of-way.
      return TYPE_INDEX.street;
    }
    const floors = floorWeighted[k * GROUPS.length + g] / (floorArea[k * GROUPS.length + g] || 1) || 1;
    const size = sizeForFloors(floors);
    switch (GROUPS[g]) {
      case 'res': return TYPE_INDEX[`res-${size}`];
      case 'com': return TYPE_INDEX[`com-${size}`];
      case 'ind': return TYPE_INDEX[`ind-${size}`];
      case 'trans': return TYPE_INDEX[cells.onShoreline[i] ? 'port' : 'rail'];
      case 'parking': return TYPE_INDEX.parking;
      case 'open': return TYPE_INDEX.park;
      case 'vacant': return TYPE_INDEX.meadow;
    }
    return TYPE_INDEX.street;
  }

  let landSamples = 0;
  for (let i = 0; i < samples; i++) landSamples += land[i];

  return {
    borough: {
      name: 'Brooklyn',
      boundary,
      totalArea: landSamples * (CELL / SUB) ** 2, // m²
    },
    grid: { x0, y0, cols, rows, lon0: (w + e) / 2, lat0: (s + n) / 2 },
    cells,
    index,
    missingElevation,
  };
}

function isArea(f) {
  const t = f.geometry?.type;
  return t === 'Polygon' || t === 'MultiPolygon';
}

// Square boundary polygon of a cell, as [lon, lat] ring.
export function cellBoundary(world, i) {
  const { x0, y0, lon0, lat0 } = world.grid;
  const proj = makeProjection(lon0, lat0);
  const c = world.cells.col[i], r = world.cells.row[i];
  const x = x0 + c * CELL, y = y0 + r * CELL;
  return [[x, y], [x + CELL, y], [x + CELL, y + CELL], [x, y + CELL], [x, y]].map(([px, py]) => proj.toLonLat(px, py));
}

export function cellCenter(world, i) {
  const { x0, y0, lon0, lat0 } = world.grid;
  return makeProjection(lon0, lat0).toLonLat(x0 + (world.cells.col[i] + 0.5) * CELL, y0 + (world.cells.row[i] + 0.5) * CELL);
}

export function cellAt(world, lon, lat) {
  const { x0, y0, cols, rows, lon0, lat0 } = world.grid;
  const [x, y] = makeProjection(lon0, lat0).toXY(lon, lat);
  const c = Math.floor((x - x0) / CELL), r = Math.floor((y - y0) / CELL);
  if (c < 0 || r < 0 || c >= cols || r >= rows) return -1;
  return world.index[r * cols + c];
}

// Cells whose centers fall inside a square of the given side (meters) centered
// on a point. Used to load visions saved on a coarser grid.
export function cellsInSquare(world, lon, lat, side) {
  const { x0, y0, cols, rows, lon0, lat0 } = world.grid;
  const [x, y] = makeProjection(lon0, lat0).toXY(lon, lat);
  const lo = (v, v0) => Math.floor((v - side / 2 - v0) / CELL - 0.5) + 1;
  const hi = (v, v0) => Math.ceil((v + side / 2 - v0) / CELL - 0.5) - 1;
  const c0 = lo(x, x0), c1 = hi(x, x0), r0 = lo(y, y0), r1 = hi(y, y0);
  const out = [];
  for (let r = Math.max(0, r0); r <= Math.min(rows - 1, r1); r++) for (let c = Math.max(0, c0); c <= Math.min(cols - 1, c1); c++) {
    const j = world.index[r * cols + c];
    if (j >= 0) out.push(j);
  }
  return out;
}

// 8-connected neighbor cell ids.
export function neighbors(world, i, out = []) {
  out.length = 0;
  const { cols, rows } = world.grid;
  const c = world.cells.col[i], r = world.cells.row[i];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    const rr = r + dr, cc = c + dc;
    if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
    const j = world.index[rr * cols + cc];
    if (j >= 0) out.push(j);
  }
  return out;
}
