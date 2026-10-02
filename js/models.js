// Simple climate models. Each takes the grid and an array of ecosystem type
// indexes (one per cell) and returns borough-wide metrics plus per-cell values
// for the map. Running them on the existing types gives "today"; running them
// on a vision's types gives the vision.

import { ECOSYSTEMS } from './ecosystems.js';
import { neighbors, CELL, HA_PER_CELL } from './grid.js';

// A design 100-year coastal storm: still-water level in feet (NAVD88) before
// sea level rise, roughly FEMA's 1% annual chance level along Brooklyn's shore.
export const STORM_TIDE_FT = 10;
export const SEWER_CAPACITY = 1.75; // in/hr, NYC storm sewer design standard
const SOIL_INFILTRATION = 1.0; // in/hr for fully pervious ground
const PONDING_FLOOD_IN = 4; // inches of standing water that counts as flooded
const MAX_POND_DEPTH_IN = 18;
const MIN_HABITAT_HA = 10; // a habitat type counts toward diversity once it covers this much land

export const SCENARIO_PRESETS = {
  rainfall: [
    { value: 1.75, label: 'Sewer design storm (1.75 in/hr)' },
    { value: 2.13, label: 'Moderate stormwater flood (2.13 in/hr)' },
    { value: 3.15, label: 'Hurricane Ida peak hour (3.15 in/hr)' },
    { value: 3.66, label: 'Extreme stormwater flood (3.66 in/hr)' },
  ],
  seaLevelRise: [
    { value: 0, label: 'Today (0 in)' },
    { value: 0.92, label: '2050s middle estimate (11 in)' },
    { value: 2.5, label: '2080s high estimate (30 in)' },
    { value: 4.17, label: '2100 high estimate (50 in)' },
    { value: 6, label: '2100 extreme (72 in)' },
  ],
};

// How much flooding a cell's use puts at risk (people and property).
const EXPOSURE = { built: 1, transportation: 0.5, open: 0.1, water: 0 };

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

class MaxHeap {
  constructor() { this.keys = []; this.vals = []; }
  get size() { return this.keys.length; }
  push(k, v) {
    const { keys, vals } = this;
    let i = keys.length;
    keys.push(k); vals.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] >= k) break;
      keys[i] = keys[p]; vals[i] = vals[p];
      i = p;
    }
    keys[i] = k; vals[i] = v;
  }
  pop() {
    const { keys, vals } = this;
    const top = vals[0], topKey = keys[0];
    const k = keys.pop(), v = vals.pop();
    if (keys.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= keys.length) break;
        if (c + 1 < keys.length && keys[c + 1] > keys[c]) c++;
        if (keys[c] <= k) break;
        keys[i] = keys[c]; vals[i] = vals[c];
        i = c;
      }
      keys[i] = k; vals[i] = v;
    }
    return [topKey, top];
  }
}

// Neighbor lists are fixed for a grid, so build them once.
export function prepare(world) {
  const N = world.cells.count;
  const nbr = new Int32Array(N * 8).fill(-1);
  const tmp = [];
  for (let i = 0; i < N; i++) neighbors(world, i, tmp).forEach((j, k) => { nbr[i * 8 + k] = j; });
  // Cells outside the borough's land are the open water that storm surge comes from.
  const sea = new Uint8Array(N);
  for (let i = 0; i < N; i++) sea[i] = world.cells.land[i] < 0.5 ? 1 : 0;
  // Downhill order for stormwater routing.
  const order = Int32Array.from({ length: N }, (_, i) => i).sort((a, b) => world.cells.elevation[b] - world.cells.elevation[a]);
  world.model = { nbr, sea, order };
}

// Coastal flooding: storm tide spreads inland from the sea over every cell lower
// than the water. Shoreline structures stop it until overtopped; wetlands and
// living shorelines absorb some of the surge as it crosses them.
function coastal(world, types, seaLevelRise) {
  const { nbr, sea } = world.model;
  const { elevation, count } = world.cells;
  const level = new Float64Array(count).fill(-Infinity);
  const depth = new Float32Array(count);
  const heap = new MaxHeap();
  const tide = STORM_TIDE_FT + seaLevelRise;
  for (let i = 0; i < count; i++) if (sea[i]) { level[i] = tide; heap.push(tide, i); }
  while (heap.size) {
    const [l, i] = heap.pop();
    if (l < level[i]) continue;
    for (let k = 0; k < 8; k++) {
      const j = nbr[i * 8 + k];
      if (j < 0 || sea[j]) continue;
      const type = ECOSYSTEMS[types[j]];
      const ground = elevation[j];
      if (l <= ground + type.barrier) continue; // stays dry, or the structure holds
      const next = l - type.attenuation * (CELL / 100); // attenuation is per 100 m crossed
      if (next <= ground || next <= level[j]) continue;
      level[j] = next;
      depth[j] = next - ground;
      heap.push(next, j);
    }
  }
  return depth; // feet
}

// A cell's paved and planted shares: as measured from the air where a vision
// leaves the cell as it is today, and its type's typical values where it changes.
function surface(world, types, i) {
  const c = world.cells;
  if (types[i] !== c.existing[i] || !(c.paved?.[i] >= 0)) return ECOSYSTEMS[types[i]];
  return { imperviousness: c.paved[i], vegetation: c.tree[i] + c.grass[i] };
}

// Stormwater flooding: rain that the ground, plants and sewers can't take runs
// downhill and ponds in low spots.
function stormwater(world, types, rainfall) {
  const { nbr, order } = world.model;
  const { elevation, count } = world.cells;
  const spare = new Float32Array(count);
  const flow = new Float32Array(count); // inches over one cell
  const pond = new Float32Array(count);
  const isWater = (i) => ECOSYSTEMS[types[i]].id === 'water';
  for (let i = 0; i < count; i++) {
    const t = ECOSYSTEMS[types[i]];
    if (isWater(i)) { spare[i] = Infinity; continue; }
    const { imperviousness } = surface(world, types, i);
    const capacity = t.storage + (1 - imperviousness) * SOIL_INFILTRATION + SEWER_CAPACITY * t.sewered * imperviousness;
    flow[i] = Math.max(0, rainfall - capacity);
    spare[i] = Math.max(0, capacity - rainfall);
  }
  for (const i of order) {
    const out = Math.max(0, flow[i] - spare[i]);
    if (!out) continue;
    let low = -1;
    for (let k = 0; k < 8; k++) {
      const j = nbr[i * 8 + k];
      if (j >= 0 && elevation[j] < elevation[i] && (low < 0 || elevation[j] < elevation[low])) low = j;
    }
    if (low >= 0) flow[low] += out;
    else pond[i] += out;
  }
  // Spread each low spot's water over the lowest surrounding cells.
  const depth = new Float32Array(count);
  for (let s = 0; s < count; s++) {
    let volume = pond[s];
    if (volume <= 0) continue;
    const seen = new Set([s]);
    const heap = new MaxHeap(); // keyed by negative elevation: lowest first
    heap.push(-elevation[s], s);
    while (heap.size && volume > 0) {
      const [, i] = heap.pop();
      if (isWater(i)) break; // drains into a water body
      const take = Math.min(volume, MAX_POND_DEPTH_IN - depth[i]);
      if (take > 0) { depth[i] += take; volume -= take; }
      for (let k = 0; k < 8; k++) {
        const j = nbr[i * 8 + k];
        if (j >= 0 && !seen.has(j) && elevation[j] < elevation[s] + 3) { seen.add(j); heap.push(-elevation[j], j); }
      }
    }
  }
  return depth; // inches
}

function heat(world, types) {
  const { nbr } = world.model;
  const N = world.cells.count;
  const raw = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = ECOSYSTEMS[types[i]];
    const { imperviousness, vegetation } = surface(world, types, i);
    raw[i] = t.id === 'water' ? -4 : 10 * imperviousness - 8 * vegetation + (t.size === 'high' ? 1 : 0);
  }
  // Cool parks and water spill over onto their neighbors, and vice versa.
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let sum = 0, m = 0;
    for (let k = 0; k < 8; k++) { const j = nbr[i * 8 + k]; if (j >= 0) { sum += raw[j]; m++; } }
    out[i] = m ? 0.5 * raw[i] + (0.5 * sum) / m : raw[i];
  }
  return out; // °F above a fully vegetated landscape baseline
}

function habitat(world, types) {
  const { nbr } = world.model;
  const N = world.cells.count;
  const out = new Float32Array(N);
  let connected = 0;
  for (let i = 0; i < N; i++) {
    const hv = ECOSYSTEMS[types[i]].habitat;
    let good = 0, m = 0;
    for (let k = 0; k < 8; k++) {
      const j = nbr[i * 8 + k];
      if (j >= 0) { m++; if (ECOSYSTEMS[types[j]].habitat >= 5) good++; }
    }
    const f = m ? good / m : 0;
    out[i] = hv * (0.6 + 0.4 * f);
    if (hv >= 5 && good >= 3 && world.cells.land[i] >= 0.5) connected++;
  }
  return { value: out, connected };
}

export function runModels(world, types, scenario) {
  const { cells } = world;
  const N = cells.count;
  const coastalDepth = coastal(world, types, scenario.seaLevelRise);
  const stormDepth = stormwater(world, types, scenario.rainfall);
  const heatMap = heat(world, types);
  const hab = habitat(world, types);

  let land = 0, flooded = 0, exposed = 0, coastalCells = 0, stormCells = 0;
  let heatSum = 0, hot = 0, habSum = 0, carbon = 0;
  const natural = new Map();
  for (let i = 0; i < N; i++) {
    const t = ECOSYSTEMS[types[i]];
    carbon += t.carbon * HA_PER_CELL;
    if (cells.land[i] < 0.5) continue;
    land++;
    const c = coastalDepth[i] > 0, s = stormDepth[i] >= PONDING_FLOOD_IN;
    if (c) coastalCells++;
    if (s) stormCells++;
    if (c || s) { flooded++; exposed += EXPOSURE[t.category]; }
    heatSum += heatMap[i];
    if (heatMap[i] >= 6) hot++;
    habSum += hab.value[i];
    if (t.habitat >= 4) natural.set(t.id, (natural.get(t.id) ?? 0) + 1);
  }
  land ||= 1;
  const ha = HA_PER_CELL;
  const meanHeat = heatSum / land;
  const meanHabitat = habSum / land;
  const diversity = [...natural.values()].filter((n) => n * ha >= MIN_HABITAT_HA).length;

  const metrics = {
    flooding: {
      score: clamp(100 * (1 - exposed / (land * 0.3))),
      floodedHa: flooded * ha, exposedHa: exposed * ha, coastalHa: coastalCells * ha, stormHa: stormCells * ha,
    },
    biodiversity: {
      score: clamp(meanHabitat * 10 + Math.min(10, diversity * 2)),
      meanHabitat, connectedHa: hab.connected * ha, habitatTypes: diversity,
    },
    heat: {
      score: clamp((100 * (9 - meanHeat)) / 14),
      meanAnomaly: meanHeat, hotHa: hot * ha,
    },
    carbon: {
      score: clamp((100 * (carbon / (land * ha))) / 60),
      totalTonnes: carbon, perHa: carbon / (land * ha),
    },
  };
  const overall = (metrics.flooding.score + metrics.biodiversity.score + metrics.heat.score + metrics.carbon.score) / 4;
  return { overall, metrics, perCell: { coastalDepth, stormDepth, heat: heatMap, habitat: hab.value } };
}
