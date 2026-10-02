// Simple climate models. Each takes the grid and an array of ecosystem type
// indexes (one per cell) and returns borough-wide metrics plus per-cell values
// for the map. Running them on the existing types gives "today"; running them
// on a vision's types gives the vision.

import { ECOSYSTEMS, WATER } from './ecosystems.js';
import { neighbors, CELL, HA_PER_CELL } from './grid.js';

// A design 100-year coastal storm: still-water level in feet (NAVD88) before
// sea level rise, roughly FEMA's 1% annual chance level along Brooklyn's shore.
export const STORM_TIDE_FT = 10;
export const SEWER_CAPACITY = 1.75; // in/hr, NYC storm sewer design standard
const SOIL_INFILTRATION = 1.0; // in/hr for fully pervious ground
const PONDING_FLOOD_IN = 4; // inches of standing water that counts as flooded
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
  // Each cell's lowest lower neighbor, where its runoff goes.
  const down = new Int32Array(N).fill(-1);
  const { elevation } = world.cells;
  for (let i = 0; i < N; i++) for (let k = 0; k < 8; k++) {
    const j = nbr[i * 8 + k];
    if (j >= 0 && elevation[j] < elevation[i] && (down[i] < 0 || elevation[j] < elevation[down[i]])) down[i] = j;
  }
  world.model = { nbr, sea, order, down, runoffToday: {}, cooling: coolingKernels(world) };
  world.model.heatToday = heat(world, world.cells.existing);
  // Average residents per cell of each type today, for cells a vision changes.
  const sum = new Float64Array(ECOSYSTEMS.length), n = new Float64Array(ECOSYSTEMS.length);
  for (let i = 0; i < N; i++) { sum[world.cells.existing[i]] += world.cells.residents[i]; n[world.cells.existing[i]]++; }
  world.model.density = Float32Array.from(sum, (v, t) => (n[t] ? v / n[t] : 0));
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

// Rain the ground, plants and sewers can't take, routed downhill: for each
// cell, the inches of excess runoff (over one cell's area) that reach it.
function runoff(world, types, rainfall) {
  const { down, order } = world.model;
  const { count } = world.cells;
  const spare = new Float32Array(count);
  const flow = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const t = ECOSYSTEMS[types[i]];
    if (types[i] === WATER) { spare[i] = Infinity; continue; }
    const { imperviousness } = surface(world, types, i);
    const capacity = t.storage + (1 - imperviousness) * SOIL_INFILTRATION + SEWER_CAPACITY * t.sewered * imperviousness;
    flow[i] = Math.max(0, rainfall - capacity);
    spare[i] = Math.max(0, capacity - rainfall);
  }
  for (const i of order) {
    const out = Math.max(0, flow[i] - spare[i]);
    if (out && down[i] >= 0) flow[down[i]] += out;
  }
  return flow;
}

// Stormwater flooding. Today's flooding comes from NYC's Stormwater Flood Maps,
// made with the city's sewer and surface model, for a moderate (2.13 in/hr) and
// an extreme (3.66 in/hr) storm; other intensities are interpolated, from no
// flooding at 1.5 in/hr. A vision changes how much runoff reaches each flooded
// spot, and the spot's flooding scales with it. Returns the share of each cell
// flooded and the depth in inches where it is.
const STORMS = [2.13, 3.66];
const DRY_BELOW = 1.5; // in/hr
const RUNOFF_FLOOR = 0.25; // inches of runoff, so tiny catchments don't swing wildly
const MAX_STORM_DEPTH_IN = 36;
function stormwater(world, types, rainfall) {
  const { count, stormFrac, stormDepth, existing } = world.cells;
  const cache = world.model.runoffToday;
  if (cache.rainfall !== rainfall) Object.assign(cache, { rainfall, flow: runoff(world, existing, rainfall) });
  const vision = types === existing ? cache.flow : runoff(world, types, rainfall);

  // Interpolate between the mapped storms.
  let a = 0, b = 0, t = 0, scale = 1;
  if (rainfall <= STORMS[0]) { b = 0; t = Math.max(0, (rainfall - DRY_BELOW) / (STORMS[0] - DRY_BELOW)); a = -1; }
  else if (rainfall <= STORMS[1]) { a = 0; b = 1; t = (rainfall - STORMS[0]) / (STORMS[1] - STORMS[0]); }
  else { a = 1; b = 1; t = 0; scale = (rainfall - DRY_BELOW) / (STORMS[1] - DRY_BELOW); }
  const frac = new Float32Array(count), depth = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const fa = a < 0 ? 0 : stormFrac[a][i], fb = stormFrac[b][i];
    let f = fa + (fb - fa) * t;
    if (!f || types[i] === WATER) continue;
    const da = a < 0 ? stormDepth[b][i] : stormDepth[a][i], db = stormDepth[b][i] || da;
    let d = (da || db) + (db - (da || db)) * t;
    const ratio = scale * (vision[i] + RUNOFF_FLOOR) / (cache.flow[i] + RUNOFF_FLOOR);
    // More water spreads wider and deeper; less shrinks both.
    f = Math.min(1, f * Math.sqrt(ratio));
    d = Math.min(MAX_STORM_DEPTH_IN, d * Math.sqrt(ratio));
    if (d < PONDING_FLOOD_IN) continue;
    frac[i] = f;
    depth[i] = d;
  }
  return { frac, depth };
}

// Heat: the InVEST Urban Cooling model (Natural Capital Project). Each cell's
// cooling capacity comes from shade, albedo and evapotranspiration; parks of
// 2 ha or more cool the cells around them; then air mixes over a few hundred
// meters. Temperature is tRef + (1 − heat mitigation) × uhiMax.
// https://storage.googleapis.com/releases.naturalcapitalproject.org/invest-userguide/latest/en/urban_cooling_model.html
// The model's output, 1 − heat mitigation, is scaled to Landsat's summer
// surface temperature: across Brooklyn's land cells, measured temperature ≈
// tRef + uhiMax × (1 − heat mitigation) (r = 0.70, see tools/README.md).
export const HEAT = {
  tRef: 79, // °F, a fully cooled landscape
  uhiMax: 28.4, // °F, the most a fully paved, unshaded place exceeds it
  hotF: 105, // °F, a heat island
  coolDistance: 450, // m, how far a park's cooling reaches
  mixDistance: 500, // m, how far air mixes
  minParkHa: 2,
};

// Park cooling is smooth over hundreds of meters, so it's computed on blocks of
// 2 × 2 cells. Air mixing is a Gaussian, approximated by three box blurs.
const BLOCK = 2;
export function coolingKernels(world) {
  const step = CELL * BLOCK, r = Math.floor(HEAT.coolDistance / step);
  const park = [];
  let parkSum = 0;
  for (let dr = -r; dr <= r; dr++) for (let dc = -r; dc <= r; dc++) {
    const d = Math.hypot(dr, dc) * step;
    if (d > HEAT.coolDistance) continue;
    park.push(dr, dc, Math.exp(-d / HEAT.coolDistance));
    parkSum += Math.exp(-d / HEAT.coolDistance);
  }
  const sigma = HEAT.mixDistance / 3 / CELL;
  const box = Math.max(0, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2)); // radius of each box pass
  // The blurred mask of cells in the grid, which air mixing divides by.
  const { cols, rows } = world.grid;
  const weight = new Float32Array(cols * rows), tmp = new Float32Array(cols * rows);
  for (let i = 0; i < world.cells.count; i++) weight[world.cells.row[i] * cols + world.cells.col[i]] = 1;
  for (let pass = 0; pass < 3; pass++) boxBlur(weight, tmp, cols, rows, box);
  return { park: Float32Array.from(park), parkSum, box, weight };
}

// Cooling capacity of a cell: 0.6 shade + 0.2 albedo + 0.2 evapotranspiration.
export function coolingCapacity(t, canopy) {
  const shade = t.category === 'water' ? t.shade : t.category === 'open' ? Math.max(t.shade, canopy) : Math.min(1, t.shade + canopy);
  return 0.6 * shade + 0.2 * t.albedo + 0.2 * t.kc;
}

// Running-sum box blur of a raster, rows then columns. Columns are swept a row
// at a time so memory is read in order.
function boxBlur(src, out, cols, rows, r) {
  for (let y = 0; y < rows; y++) {
    const base = y * cols;
    let sum = 0;
    for (let x = 0; x <= Math.min(r, cols - 1); x++) sum += src[base + x];
    for (let x = 0; x < cols; x++) {
      out[base + x] = sum;
      if (x + r + 1 < cols) sum += src[base + x + r + 1];
      if (x - r >= 0) sum -= src[base + x - r];
    }
  }
  const sums = new Float32Array(cols);
  for (let y = 0; y <= Math.min(r, rows - 1); y++) for (let x = 0; x < cols; x++) sums[x] += out[y * cols + x];
  for (let y = 0; y < rows; y++) {
    const add = y + r + 1 < rows ? (y + r + 1) * cols : -1, sub = y - r >= 0 ? (y - r) * cols : -1;
    for (let x = 0; x < cols; x++) {
      src[y * cols + x] = sums[x];
      if (add >= 0) sums[x] += out[add + x];
      if (sub >= 0) sums[x] -= out[sub + x];
    }
  }
}

function heat(world, types) {
  const { count, canopy, col, row } = world.cells;
  const { cols, rows } = world.grid;
  const { park, parkSum, box, weight } = world.model.cooling;
  const cc = new Float32Array(count), green = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const t = ECOSYSTEMS[types[i]];
    // Measured tree canopy and grass where a vision leaves the cell as it is.
    const measured = types[i] === world.cells.existing[i] && world.cells.tree?.[i] >= 0;
    cc[i] = measured ? 0.6 * world.cells.tree[i] + 0.2 * t.albedo + 0.2 * Math.min(1, world.cells.tree[i] + 0.8 * world.cells.grass[i])
      : coolingCapacity(t, canopy[i]);
    green[i] = surface(world, types, i).vegetation >= 0.5 ? 1 : 0;
  }

  // Green area and its cooling capacity, summed per block.
  const bc = Math.ceil(cols / BLOCK), br = Math.ceil(rows / BLOCK);
  const greenCC = new Float32Array(bc * br), greenHa = new Float32Array(bc * br);
  for (let i = 0; i < count; i++) {
    if (!green[i]) continue;
    const b = Math.floor(row[i] / BLOCK) * bc + Math.floor(col[i] / BLOCK);
    greenCC[b] += cc[i] / (BLOCK * BLOCK);
    greenHa[b] += HA_PER_CELL;
  }
  // Spread each green block's cooling, and its area, over the blocks within reach.
  const near = new Float32Array(bc * br), nearHa = new Float32Array(bc * br);
  for (let b = 0; b < bc * br; b++) {
    if (!greenHa[b]) continue;
    const r = Math.floor(b / bc), c = b % bc;
    for (let k = 0; k < park.length; k += 3) {
      const rr = r + park[k], cc2 = c + park[k + 1];
      if (rr < 0 || cc2 < 0 || rr >= br || cc2 >= bc) continue;
      near[rr * bc + cc2] += (greenCC[b] * park[k + 2]) / parkSum;
      nearHa[rr * bc + cc2] += greenHa[b];
    }
  }

  // Heat mitigation, then the unmixed temperature anomaly, on the full raster.
  const raster = new Float32Array(cols * rows);
  for (let i = 0; i < count; i++) {
    const b = Math.floor(row[i] / BLOCK) * bc + Math.floor(col[i] / BLOCK);
    // Open water holds air near the reference temperature on a summer day.
    const hm = types[i] === WATER ? 1 : nearHa[b] < HEAT.minParkHa || cc[i] >= near[b] ? cc[i] : near[b];
    const k = row[i] * cols + col[i];
    raster[k] = (1 - hm) * HEAT.uhiMax;
  }
  // Air mixing. Dividing by the blurred cell mask keeps cells next to the
  // grid's edge unbiased.
  const tmp = new Float32Array(cols * rows);
  for (let pass = 0; pass < 3; pass++) boxBlur(raster, tmp, cols, rows, box);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const k = row[i] * cols + col[i];
    out[i] = raster[k] / weight[k];
  }
  return out; // °F above the reference temperature
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

// Residents of each cell: the census count where the cell is unchanged, and
// today's average for its type where a vision changed it, so building homes
// adds people and replacing them moves people out.
function residents(world, types) {
  const { existing, residents: today } = world.cells;
  const { density } = world.model;
  return Float32Array.from(types, (t, i) => (t === existing[i] ? today[i] : density[t]));
}

// Summer surface temperature: Landsat's measurement where there is one, plus
// the model's change from today; the model alone elsewhere.
function surfaceTemperature(world, types, anomaly) {
  const { surfaceTemp, existing } = world.cells;
  const today = world.model.heatToday;
  return Float32Array.from(anomaly, (a, i) => (
    Number.isFinite(surfaceTemp[i]) && existing[i] !== WATER ? surfaceTemp[i] + a - today[i] : HEAT.tRef + a
  ));
}

export function runModels(world, types, scenario) {
  const { cells } = world;
  const N = cells.count;
  const coastalDepth = coastal(world, types, scenario.seaLevelRise);
  const storm = stormwater(world, types, scenario.rainfall);
  const heatMap = surfaceTemperature(world, types, heat(world, types));
  const hab = habitat(world, types);
  const people = residents(world, types);

  let land = 0, flooded = 0, exposed = 0, coastalCells = 0, stormCells = 0;
  let heatSum = 0, hot = 0, habSum = 0, carbon = 0;
  let population = 0, floodedPeople = 0, hotPeople = 0, hotVulnerable = 0, heatPeople = 0;
  const natural = new Map();
  for (let i = 0; i < N; i++) {
    const t = ECOSYSTEMS[types[i]];
    carbon += t.carbon * HA_PER_CELL;
    if (cells.land[i] < 0.5) continue;
    land++;
    const p = people[i];
    population += p;
    // Coastal flooding covers whole cells; stormwater, part of a cell.
    const share = coastalDepth[i] > 0 ? 1 : storm.frac[i];
    if (coastalDepth[i] > 0) coastalCells++;
    stormCells += storm.frac[i];
    if (share) { flooded += share; exposed += share * EXPOSURE[t.category]; floodedPeople += share * p; }
    heatSum += heatMap[i];
    heatPeople += heatMap[i] * p;
    if (heatMap[i] >= HEAT.hotF) { hot++; hotPeople += p; if (cells.hvi[i] >= 4) hotVulnerable += p; }
    habSum += hab.value[i];
    if (t.habitat >= 4) natural.set(t.id, (natural.get(t.id) ?? 0) + 1);
  }
  land ||= 1;
  population ||= 1;
  const ha = HA_PER_CELL;
  const meanHeat = heatSum / land, peopleHeat = heatPeople / population;
  const meanHabitat = habSum / land;
  const diversity = [...natural.values()].filter((n) => n * ha >= MIN_HABITAT_HA).length;

  const metrics = {
    flooding: {
      // Half for homes, businesses and streets flooded, half for residents.
      score: clamp(100 * (1 - 0.5 * exposed / (land * 0.3) - 0.5 * floodedPeople / (population * 0.3))),
      floodedHa: flooded * ha, exposedHa: exposed * ha, coastalHa: coastalCells * ha, stormHa: stormCells * ha,
      floodedPeople, population,
    },
    biodiversity: {
      score: clamp(meanHabitat * 10 + Math.min(10, diversity * 2)),
      meanHabitat, connectedHa: hab.connected * ha, habitatTypes: diversity,
    },
    heat: {
      // Half for the land's average temperature, half for where people live.
      score: clamp(100 * (1 - (0.5 * (meanHeat - HEAT.tRef) + 0.5 * (peopleHeat - HEAT.tRef)) / HEAT.uhiMax)),
      meanTemp: meanHeat, peopleTemp: peopleHeat, hotHa: hot * ha, hotPeople, hotVulnerable,
    },
    carbon: {
      score: clamp((100 * (carbon / (land * ha))) / 60),
      totalTonnes: carbon, perHa: carbon / (land * ha),
    },
  };
  const overall = (metrics.flooding.score + metrics.biodiversity.score + metrics.heat.score + metrics.carbon.score) / 4;
  return { overall, metrics, perCell: { coastalDepth, stormDepth: storm.depth, stormFrac: storm.frac, heat: heatMap, habitat: hab.value, residents: people } };
}
