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
// Measured land cover shares that override an open space's mapped category.
const COVER = { forest: 0.6, paved: 0.7, openForest: 0.25 };

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

// Crown diameter in feet from trunk diameter in inches, a rough fit for NYC's
// common street trees (a 12 in London plane spreads about 25 ft).
const crownFeet = (dbh) => Math.min(60, 5 + 1.6 * dbh);

export function buildGrid({ boundary, otherBoroughs = [], parks = [], hydrography = [], shoreline = [], floodplain = [], wetlands = [], lots = [], elevation = null, surfaceTemp = null, stormwater = null, landcover = null, trees = [], census = null, hvi = null }) {
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
  // Queens (and Manhattan across the East River) are land, not open water.
  const other = new Uint8Array(samples);
  rasterizePolygons(otherBoroughs, lattice, proj, (i) => { other[i] = 1; });
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
  const landFrac = new Float32Array(all), otherFrac = new Float32Array(all), hydroFrac = new Float32Array(all), floodFrac = new Float32Array(all);
  const parkCounts = new Uint8Array(all * PARK_CLASSES.length);
  const wetCounts = new Uint8Array(all * WETLAND_CLASSES.length);
  const share = 1 / (SUB * SUB);
  for (let r = 0; r < lattice.rows; r++) {
    for (let c = 0; c < lattice.cols; c++) {
      const i = r * lattice.cols + c;
      const k = Math.floor(r / SUB) * cols + Math.floor(c / SUB);
      if (land[i]) landFrac[k] += share;
      else if (other[i]) otherFrac[k] += share;
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
  const residents = new Float32Array(all);
  const hviSum = new Float32Array(all), hviArea = new Float32Array(all);
  const lotResidents = census ? censusToLots(lots, census) : null;
  lots.forEach((lot, n) => {
    const group = LAND_USE[lot.landuse];
    const g = group ? GROUPS.indexOf(group) : -1;
    const [x, y] = proj.toXY(lot.lon, lot.lat);
    const c = Math.floor((x - x0) / CELL), r = Math.floor((y - y0) / CELL);
    const area = lot.lotarea * SQFT;
    const rad = Math.floor(Math.sqrt(area) / CELL / 2);
    const spread = (2 * rad + 1) ** 2;
    const people = lotResidents ? lotResidents[n] : 0;
    const v = hvi?.[lot.zip];
    for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
      const cc = c + dc, rr = r + dr;
      if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) continue;
      const cell = rr * cols + cc;
      residents[cell] += people / spread;
      if (v) { hviSum[cell] += (v * area) / spread; hviArea[cell] += area / spread; }
      if (g < 0) continue;
      const k = cell * GROUPS.length + g;
      lotArea[k] += area / spread;
      floorArea[k] += lot.bldgarea / spread;
      floorWeighted[k] += (lot.bldgarea * lot.floors) / spread;
    }
  });

  // Street tree canopy: each tree's crown area, added to the cell it stands in.
  const crown = new Float32Array(all);
  for (const t of trees) {
    const [x, y] = proj.toXY(t.lon, t.lat);
    const c = Math.floor((x - x0) / CELL), r = Math.floor((y - y0) / CELL);
    if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
    crown[r * cols + c] += Math.PI * (crownFeet(t.dbh) / 2) ** 2 * SQFT;
  }

  // Measured land cover: average every pixel whose center falls in the cell.
  const cover = landcover && measureCover(landcover, proj, { x0, y0, cols, rows });

  // Keep land cells plus a margin of water around the shore. Cells that are
  // mostly another borough's land are left out: they are neither Brooklyn nor sea.
  const isLand = (k) => landFrac[k] >= 0.5 && hydroFrac[k] < 0.5;
  const isOtherBorough = (k) => !isLand(k) && landFrac[k] + otherFrac[k] >= 0.5;
  const keep = new Uint8Array(all);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (landFrac[r * cols + c] === 0) continue;
    for (let dr = -WATER_MARGIN; dr <= WATER_MARGIN; dr++) for (let dc = -WATER_MARGIN; dc <= WATER_MARGIN; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && cc >= 0 && rr < rows && cc < cols && !isOtherBorough(rr * cols + cc)) keep[rr * cols + cc] = 1;
    }
  }

  // Shoreline: cells crossed by the shoreline layer, or land touching water
  // (the land border with Queens is not shoreline).
  const shore = new Uint8Array(all);
  rasterizeLines(shoreline, { x0, y0, step: CELL, cols, rows }, proj, (k) => { shore[k] = 1; });
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const k = r * cols + c;
    if (!isLand(k)) continue;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) { shore[k] = 1; continue; }
      const kk = rr * cols + cc;
      if (!isLand(kk) && !isOtherBorough(kk)) shore[k] = 1;
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
    // Shares of the cell measured from the air (NaN where not measured).
    tree: new Float32Array(N).fill(NaN), grass: new Float32Array(N).fill(NaN), paved: new Float32Array(N).fill(NaN),
    existing: new Uint8Array(N),
    residents: new Float32Array(N), // 2020 Census population, placed on homes
    hvi: new Float32Array(N), // Heat Vulnerability Index of the ZIP code, 1–5 (0 = unknown)
    canopy: new Float32Array(N), // share of the cell shaded by street trees
    surfaceTemp: new Float32Array(N).fill(NaN), // °F, summer surface temperature measured by Landsat
    // NYC's Stormwater Flood Maps: share of the cell flooded, and average depth
    // in inches where it is, for the moderate (2.13 in/hr) and extreme (3.66 in/hr) storms.
    stormFrac: [new Float32Array(N), new Float32Array(N)],
    stormDepth: [new Float32Array(N), new Float32Array(N)],
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
    cells.residents[i] = residents[k];
    cells.hvi[i] = hviArea[k] ? hviSum[k] / hviArea[k] : 0;
    cells.canopy[i] = Math.min(1, crown[k] / CELL_AREA);
    if (cover && cover.n[k]) {
      cells.tree[i] = cover.tree[k] / cover.n[k];
      cells.grass[i] = cover.grass[k] / cover.n[k];
      cells.paved[i] = cover.paved[k] / cover.n[k];
    }

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

    if (surfaceTemp && isLand(k)) {
      let sum = 0, m = 0;
      for (const fy of [0.25, 0.75]) for (const fx of [0.25, 0.75]) {
        const v = surfaceTemp(...proj.toLonLat(x0 + (c + fx) * CELL, y0 + (r + fy) * CELL));
        if (Number.isFinite(v)) { sum += v; m++; }
      }
      if (m) cells.surfaceTemp[i] = sum / m;
    }

    if (stormwater && isLand(k)) {
      // A 5 × 5 sample of the 8 m flood maps. Shallow flooding (4 in–1 ft)
      // counts as 8 in deep, deep flooding (over 1 ft) as 18 in.
      for (let storm = 0; storm < 2; storm++) {
        let wet = 0, depth = 0;
        for (let fy = 0.1; fy < 1; fy += 0.2) for (let fx = 0.1; fx < 1; fx += 0.2) {
          const v = stormwater(...proj.toLonLat(x0 + (c + fx) * CELL, y0 + (r + fy) * CELL), storm);
          if (v) { wet++; depth += v === 1 ? 8 : 18; }
        }
        cells.stormFrac[storm][i] = wet / 25;
        cells.stormDepth[storm][i] = wet ? depth / wet : 0;
      }
    }

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
      let type = measured(PARK_CLASSES[best], i);
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
      case 'open': return TYPE_INDEX[measured('park', i)];
      case 'vacant': return TYPE_INDEX[measured('meadow', i)];
    }
    return TYPE_INDEX.street;
  }

  // Open space as it looks from the air: a park's wooded parts are forest and
  // its courts and playgrounds are plaza, and most "vacant" lots are paved.
  function measured(type, i) {
    const tree = cells.tree[i], grass = cells.grass[i], paved = cells.paved[i];
    if (Number.isNaN(tree)) return type;
    switch (type) {
      case 'park': case 'meadow':
        if (tree >= COVER.forest) return 'forest';
        if (paved >= COVER.paved) return type === 'park' ? 'plaza' : 'parking';
        return type;
      case 'forest':
        if (paved >= COVER.paved) return 'plaza';
        if (tree < COVER.openForest && grass >= tree) return 'meadow';
        return type;
    }
    return type;
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

// Splits each census block's population among its tax lots in proportion to
// their housing units (dasymetric mapping). Blocks whose lots list no units
// (dorms, nursing homes, shelters) are split by building floor area.
function censusToLots(lots, blocks) {
  const units = new Map(), floor = new Map();
  for (const lot of lots) {
    units.set(lot.block, (units.get(lot.block) ?? 0) + lot.units);
    floor.set(lot.block, (floor.get(lot.block) ?? 0) + lot.bldgarea);
  }
  return Float32Array.from(lots, (lot) => {
    const pop = blocks[lot.block]?.[0];
    if (!pop) return 0;
    const u = units.get(lot.block), f = floor.get(lot.block);
    return u ? (pop * lot.units) / u : f ? (pop * lot.bldgarea) / f : 0;
  });
}

function measureCover({ bbox: [w, s, e, n], width, height, rgba }, proj, { x0, y0, cols, rows }) {
  const all = cols * rows;
  const out = { tree: new Float32Array(all), grass: new Float32Array(all), paved: new Float32Array(all), n: new Uint16Array(all) };
  const dx = (e - w) / width, dy = (n - s) / height;
  for (let py = 0; py < height; py++) {
    const lat = n - (py + 0.5) * dy;
    for (let px = 0; px < width; px++) {
      const p = (py * width + px) * 4;
      if (rgba[p] === 255) continue; // outside the city
      const [x, y] = proj.toXY(w + (px + 0.5) * dx, lat);
      const c = Math.floor((x - x0) / CELL), r = Math.floor((y - y0) / CELL);
      if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
      const k = r * cols + c;
      out.tree[k] += rgba[p] / 250;
      out.grass[k] += rgba[p + 1] / 250;
      out.paved[k] += rgba[p + 2] / 250;
      out.n[k]++;
    }
  }
  return out;
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

// Cells whose centers fall inside a polygon feature.
export function cellsInPolygon(world, feature) {
  const { x0, y0, cols, rows, lon0, lat0 } = world.grid;
  const out = new Set();
  rasterizePolygons([feature], { x0, y0, step: CELL, cols, rows }, makeProjection(lon0, lat0), (k) => {
    if (world.index[k] >= 0) out.add(world.index[k]);
  });
  return [...out];
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
