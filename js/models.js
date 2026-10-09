// Simple climate models. Each takes the grid and an array of ecosystem type
// indexes (one per cell) and returns borough-wide metrics plus per-cell values
// for the map. Running them on the existing types gives "today"; running them
// on a vision's types gives the vision.

import { ECOSYSTEMS, WATER, SEQUESTRATION, sequestrationOf } from './ecosystems.js';
import { neighbors, CELL, CELL_AREA, HA_PER_CELL, TOWER_FLOORS } from './grid.js';

// A design 100-year coastal storm: still-water level in feet (NAVD88) before
// sea level rise, roughly FEMA's 1% annual chance level along Brooklyn's shore.
export const STORM_TIDE_FT = 10;
export const SEWER_CAPACITY = 1.75; // in/hr, NYC storm sewer design standard
export const SOIL_INFILTRATION = 1.0; // in/hr for fully pervious ground
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

// Emissions. Car and truck travel: NYC's greenhouse gas inventory puts on-road
// emissions at about 15 million t CO2e a year (2016), about 1.75 t per New
// Yorker; Brooklyn households own fewer cars than the city's, so a rough
// 1.4 t CO2e per resident a year. Stored carbon is tonnes of carbon; × 44/12
// gives the CO2 it would become.
export const VEHICLE_T_PER_RESIDENT = 1.4;
export const CO2_PER_C = 44 / 12;

// Policies a vision can adopt. Today has none of them.
//
// Low-flow toilets: every toilet is replaced with one that uses `gpf` gallons a
// flush. Brooklyn's toilets average about 2.2 gallons today (a mix of 1.6 gpf
// toilets, required since 1994, older 3.5 gpf ones, and newer 1.28 gpf ones);
// people flush about 5 times a day at home (AWWA Residential End Uses of Water,
// 2016). Only residents are counted, not workers.
//
// Unified Stormwater Rule (NYC DEP, in force since February 2022): new
// development that disturbs 20,000 sq ft or more, or adds 5,000 sq ft or more
// of hard surface, must manage the first 1.5 in of rain on site, retention
// (tanks, green roofs, soil) first. Each painted cell (2,500 m², about
// 27,000 sq ft) counts as one site, so every painted building, parking lot,
// port or plaza is covered, holding the rule's depth of rain from its hard
// surface. The rule leaves existing buildings alone; `retrofit` asks what if
// buildings over 20 floors ('towers') or all buildings ('all') did it too.
// Tower roofs are PLUTO floor area over floors. A site that holds 1.5 in per
// storm, emptied between storms, keeps about 80% of a year's rain out of the sewers.
export const POLICY = {
  toiletGpfToday: 2.2,
  flushesPerDay: 5,
  indoorGpcd: 55, // gallons per resident per day that go down the drain at home
  sanitaryPeak: 1.5, // daytime sewage flow over the daily average, when a storm hits
  annualRainIn: 46.2, // NYC's normal year, Central Park
  annualCapture: 0.8,
};

// Share of a year's rain a place keeps out of the sewers when it can hold
// `inches` of each storm and empties between storms. Calibrated so 1.5 in
// keeps the Unified Stormwater Rule's 80% (most storms are small).
const CAPTURE_K = 1.5 / -Math.log(1 - POLICY.annualCapture);
export const annualCapture = (inches) => (inches > 0 ? 1 - Math.exp(-inches / CAPTURE_K) : 0);

// Roofs, shared by the roof policies and My lot. Today's roofs are taken to be
// dark. Surfaces are albedo and evapotranspiration (× lawn), for the InVEST
// cooling capacity; a green roof also soaks up the first inches of a storm.
export const ROOFS = {
  surface: {
    dark: { albedo: 0.15, kc: 0 }, // tar, asphalt or modified bitumen
    cool: { albedo: 0.65, kc: 0 }, // white coating, aged (NYC CoolRoofs)
    green: { albedo: 0.2, kc: 0.7 },
    solar: { albedo: 0.15, kc: 0 }, // counted as no change in heat
  },
  greenRoofIn: 0.75, // inches a 3–4 in extensive (sedum) green roof soaks up in a storm
  solarWPerSqft: 18, // modern panels, about 19% efficient
  solarKwhPerKw: 1200, // a year's output per kW of panels in New York City
  gridCo2PerKwh: 0.000288962, // tonnes CO₂ per kWh of NYC grid power (Local Law 97)
};
const SQFT_PER_M2 = 10.7639;
// Change in a roof's cooling capacity (0.2 albedo + 0.2 evapotranspiration) from dark.
const roofGain = (k) => 0.2 * (ROOFS.surface[k].albedo - ROOFS.surface.dark.albedo) + 0.2 * (ROOFS.surface[k].kc - ROOFS.surface.dark.kc);

// Roof policies. Cool roofs (Local Law 21 of 2011, in the building code):
// new roofs and roof replacements must be white or reflective. Green or solar
// roofs (Local Laws 92 and 94 of 2019): new buildings and full roof
// replacements must cover the roof's "sustainable roofing zone" (what is left
// after setbacks, equipment and access) with plants, solar panels, or both.
// Both apply as roofs are replaced, so `scope: 'all'` is the long run, when
// every roof has been redone; 'new' is buildings painted in the vision only.
// Where both are on, the rest of each roof outside the green/solar zone is cool.
export const NO_POLICIES = {
  toilets: { on: false, gpf: 1.28 },
  stormwaterRule: { on: false, inches: 1.5, retrofit: 'none' },
  coolRoofs: { on: false, scope: 'all' },
  greenRoofs: { on: false, mix: 'green', zone: 0.5, scope: 'all' },
};
export const POLICY_OPTIONS = {
  gpf: [{ value: 1.28, label: '1.28 gal (WaterSense)' }, { value: 0.8, label: '0.8 gal (ultra-low)' }],
  inches: [1, 1.5, 2, 3].map((v) => ({ value: v, label: `First ${v} in of rain${v === 1.5 ? ' (the rule)' : ''}` })),
  retrofit: [
    { value: 'none', label: 'New construction only (the rule)' },
    { value: 'towers', label: `Also retrofit buildings over ${TOWER_FLOORS} floors` },
    { value: 'all', label: 'Also retrofit every building' },
  ],
  scope: [
    { value: 'all', label: 'Every roof, once replaced (the law)' },
    { value: 'new', label: 'New construction only' },
  ],
  mix: [
    { value: 'green', label: 'All green roof' },
    { value: 'half', label: 'Half green, half solar' },
    { value: 'solar', label: 'All solar panels' },
  ],
  zone: [0.25, 0.5, 0.75, 1].map((v) => ({ value: v, label: `On ${Math.round(100 * v)}% of each roof` })),
};

// Green, cool and solar roof area (m²) in each cell under the roof policies.
// Unchanged cells use their buildings' roofs; painted buildings get today's
// average roof share for their type.
function roofs(world, types, policies) {
  const N = world.cells.count;
  const out = { green: new Float32Array(N), cool: new Float32Array(N), solar: new Float32Array(N) };
  const { coolRoofs: c, greenRoofs: g } = policies;
  if (!c.on && !g.on) return out;
  const { existing, roof } = world.cells;
  const { roofShare } = world.model;
  const greenShare = g.on ? g.zone * (g.mix === 'green' ? 1 : g.mix === 'half' ? 0.5 : 0) : 0;
  const solarShare = g.on ? g.zone - greenShare : 0;
  for (let i = 0; i < N; i++) {
    if (ECOSYSTEMS[types[i]].category !== 'built') continue;
    const changed = types[i] !== existing[i];
    const area = changed ? roofShare[types[i]] * CELL_AREA : roof[i];
    if (!area) continue;
    let rest = area;
    if (g.on && (changed || g.scope === 'all')) {
      out.green[i] = greenShare * area;
      out.solar[i] = solarShare * area;
      rest -= out.green[i] + out.solar[i];
    }
    if (c.on && (changed || c.scope === 'all')) out.cool[i] = rest;
  }
  return out;
}
const COVERED = new Set(ECOSYSTEMS.flatMap((t, i) => (t.category === 'built' || ['parking', 'port', 'plaza'].includes(t.id) ? [i] : [])));
const GAL = 0.00378541; // m³
const inPerHr = (galPerDay, peak = 1) => (galPerDay * peak * GAL) / 24 / CELL_AREA / 0.0254; // over one cell

// Sewage each cell's residents send into the sewers, gallons a day.
function sewage(residents, policies) {
  const saved = policies.toilets.on ? Math.max(0, POLICY.toiletGpfToday - policies.toilets.gpf) * POLICY.flushesPerDay : 0;
  return Float32Array.from(residents, (p) => p * (POLICY.indoorGpcd - saved));
}

// Inches of rain over each cell held on site: by the Unified Stormwater Rule's
// retention, and by green roofs.
function heldOnSite(retained, roof, policies) {
  const r = policies.stormwaterRule.inches;
  return Float32Array.from(retained, (a, i) => (a * r + roof.green[i] * ROOFS.greenRoofIn) / CELL_AREA);
}

// Hard surface (m²) in each cell whose first inches of rain are held on site.
function retainedArea(world, types, policies) {
  const out = new Float32Array(world.cells.count);
  const p = policies.stormwaterRule;
  if (!p.on) return out;
  const { existing } = world.cells;
  const { towerRoof } = world.cells;
  for (let i = 0; i < out.length; i++) {
    const built = ECOSYSTEMS[types[i]].category === 'built';
    if (types[i] !== existing[i]) out[i] = COVERED.has(types[i]) ? ECOSYSTEMS[types[i]].imperviousness * CELL_AREA : 0;
    else if (p.retrofit === 'all' && built) out[i] = surface(world, types, i).imperviousness * CELL_AREA;
    else if (p.retrofit === 'towers' && built) out[i] = Math.min(CELL_AREA, towerRoof[i]);
  }
  return out;
}

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
  // Only buildings house people: a painted park, marsh or street holds none
  // (today's averages for those come from cells that also cover homes).
  const sum = new Float64Array(ECOSYSTEMS.length), n = new Float64Array(ECOSYSTEMS.length);
  for (let i = 0; i < N; i++) { sum[world.cells.existing[i]] += world.cells.residents[i]; n[world.cells.existing[i]]++; }
  world.model.density = Float32Array.from(sum, (v, t) => (n[t] && ECOSYSTEMS[t].category === 'built' ? v / n[t] : 0));
  // Average share of a cell under roofs, for each building type today.
  const roofSum = new Float64Array(ECOSYSTEMS.length);
  for (let i = 0; i < N; i++) roofSum[world.cells.existing[i]] += world.cells.roof?.[i] ?? 0;
  world.model.roofShare = Float32Array.from(roofSum, (v, t) => (n[t] && ECOSYSTEMS[t].category === 'built' ? v / n[t] / CELL_AREA : 0));
  // Average building emissions per cell of each built type today, likewise.
  const emit = new Float64Array(ECOSYSTEMS.length);
  for (let i = 0; i < N; i++) emit[world.cells.existing[i]] += world.cells.emissions?.[i] ?? 0;
  world.model.emitRate = Float32Array.from(emit, (v, t) => (n[t] && ECOSYSTEMS[t].category === 'built' ? v / n[t] : 0));
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
// Sewage takes up part of the sewers' capacity (most of Brooklyn has combined
// sewers), and sites under the stormwater rule hold their first inches.
// Also returns where the storm's rain goes, in inches over one cell summed over
// cells: the water reaching each cell (its rain plus what runs onto it) fills
// on-site retention, then storage, then soaks in, then goes down the sewers,
// and the rest runs on downhill.
function runoff(world, types, rainfall, sanitary, held) {
  const { down, order } = world.model;
  const { count } = world.cells;
  const spare = new Float32Array(count);
  const flow = new Float32Array(count);
  const fill = new Float32Array(count * 4); // tanks, storage, soil, sewer: inches each cell can take
  for (let i = 0; i < count; i++) {
    const t = ECOSYSTEMS[types[i]];
    if (types[i] === WATER) { spare[i] = Infinity; continue; }
    const { imperviousness } = surface(world, types, i);
    const sewer = Math.max(0, SEWER_CAPACITY * imperviousness - inPerHr(sanitary[i], POLICY.sanitaryPeak)) * t.sewered;
    const tanks = held[i];
    const soil = (1 - imperviousness) * SOIL_INFILTRATION;
    fill.set([tanks, t.storage, soil, sewer], i * 4);
    const capacity = t.storage + tanks + soil + sewer;
    flow[i] = Math.max(0, rainfall - capacity);
    spare[i] = Math.max(0, capacity - rainfall);
  }
  const budget = { rain: 0, tanks: 0, storage: 0, soil: 0, sewer: 0 };
  const keys = ['tanks', 'storage', 'soil', 'sewer'];
  const inflow = new Float32Array(count);
  for (const i of order) {
    const out = Math.max(0, flow[i] - spare[i]);
    if (out && down[i] >= 0) { flow[down[i]] += out; inflow[down[i]] += out; }
    if (types[i] === WATER) continue;
    budget.rain += rainfall;
    let left = rainfall + inflow[i];
    for (let k = 0; k < 4; k++) {
      const take = Math.min(left, fill[i * 4 + k]);
      budget[keys[k]] += take;
      left -= take;
    }
  }
  return { flow, budget };
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
function stormwater(world, types, rainfall, policies, sanitary, held) {
  const { count, stormFrac, stormDepth, existing } = world.cells;
  const cache = world.model.runoffToday;
  if (cache.rainfall !== rainfall) {
    const none = new Float32Array(count);
    Object.assign(cache, { rainfall, ...runoff(world, existing, rainfall, sewage(world.cells.residents, NO_POLICIES), none) });
  }
  const unchanged = types === existing && !policies.toilets.on && held.every((v) => !v);
  const routed = unchanged ? cache : runoff(world, types, rainfall, sanitary, held);
  const vision = routed.flow;

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
  return { frac, depth, budget: routed.budget };
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

function heat(world, types, roof = null) {
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
    if (roof) cc[i] += (roof.green[i] * roofGain('green') + roof.cool[i] * roofGain('cool')) / CELL_AREA;
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

// Yearly building emissions of each cell, t CO2e: today's (reported or
// estimated) where the cell is unchanged, today's average for its type where a
// vision changed it. Parks, streets and water have no buildings.
function buildingEmissions(world, types) {
  const { existing, emissions } = world.cells;
  const { emitRate } = world.model;
  return Float32Array.from(types, (t, i) => (t === existing[i] ? emissions?.[i] ?? emitRate[t] : emitRate[t]));
}

// Yearly carbon uptake of each cell, t CO2e: from measured tree and grass cover
// where the cell is unchanged, from its type (plus street trees) elsewhere.
function sequestration(world, types) {
  const { existing, tree, grass, canopy } = world.cells;
  return Float32Array.from(types, (ti, i) => {
    const t = ECOSYSTEMS[ti];
    let rate;
    if (ti === existing[i] && tree?.[i] >= 0 && t.category !== 'water') {
      rate = SEQUESTRATION.tree * tree[i] + SEQUESTRATION.grass * grass[i];
    } else {
      rate = sequestrationOf(t);
      if (t.category === 'built' || t.category === 'transportation') rate += SEQUESTRATION.tree * canopy[i];
    }
    return rate * HA_PER_CELL;
  });
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

export function runModels(world, types, scenario, policies = NO_POLICIES) {
  const { cells } = world;
  const N = cells.count;
  const residentsMap = residents(world, types);
  const sanitary = sewage(residentsMap, policies);
  const retained = retainedArea(world, types, policies);
  const roof = roofs(world, types, policies);
  const held = heldOnSite(retained, roof, policies);
  const coastalDepth = coastal(world, types, scenario.seaLevelRise);
  const storm = stormwater(world, types, scenario.rainfall, policies, sanitary, held);
  const heatMap = surfaceTemperature(world, types, heat(world, types, roof));
  const hab = habitat(world, types);
  const buildingMap = buildingEmissions(world, types);
  const uptakeMap = sequestration(world, types);

  let land = 0, flooded = 0, exposed = 0, coastalCells = 0, stormCells = 0;
  let heatSum = 0, hot = 0, habSum = 0, carbon = 0, buildingTonnes = 0, uptake = 0;
  let population = 0, floodedPeople = 0, hotPeople = 0, hotVulnerable = 0, heatPeople = 0;
  const natural = new Map();
  for (let i = 0; i < N; i++) {
    const t = ECOSYSTEMS[types[i]];
    carbon += t.carbon * HA_PER_CELL;
    buildingTonnes += buildingMap[i];
    uptake += uptakeMap[i];
    if (cells.land[i] < 0.5) continue;
    land++;
    const p = residentsMap[i];
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

  const vehicleTonnes = population * VEHICLE_T_PER_RESIDENT;
  let solarM2 = 0;
  for (const a of roof.solar) solarM2 += a;
  const solarKw = (solarM2 * SQFT_PER_M2 * ROOFS.solarWPerSqft) / 1000;
  const solarTonnes = solarKw * ROOFS.solarKwhPerKw * ROOFS.gridCo2PerKwh;
  const emittedTonnes = buildingTonnes - solarTonnes + vehicleTonnes;
  const metrics = {
    flooding: {
      // Homes, businesses and streets flooded. Residents are reported in
      // people, not scored, so the score doesn't depend on where people live.
      score: clamp(100 * (1 - exposed / (land * 0.3))),
      floodedHa: flooded * ha, exposedHa: exposed * ha, coastalHa: coastalCells * ha, stormHa: stormCells * ha,
      floodedPeople, population,
    },
    biodiversity: {
      score: clamp(meanHabitat * 10 + Math.min(10, diversity * 2)),
      meanHabitat, connectedHa: hab.connected * ha, habitatTypes: diversity,
    },
    heat: {
      // The land's average temperature; where people live is reported in people.
      score: clamp(100 * (1 - (meanHeat - HEAT.tRef) / HEAT.uhiMax)),
      meanTemp: meanHeat, peopleTemp: peopleHeat, hotHa: hot * ha, hotPeople, hotVulnerable,
    },
    carbon: {
      score: clamp((100 * (carbon / (land * ha))) / 60),
      totalTonnes: carbon, perHa: carbon / (land * ha),
    },
  };
  // Carbon emitted and taken up each year, t CO2e. Not part of the climate score.
  const emissions = {
    buildings: buildingTonnes, solar: solarTonnes, vehicles: vehicleTonnes, emitted: emittedTonnes,
    uptake, net: emittedTonnes - uptake, storedCO2e: carbon * CO2_PER_C,
  };
  // Who lives with the flooding and heat. Not part of the climate score.
  const people = { population, floodedPeople, hotPeople, hotVulnerable, peopleTemp: peopleHeat };
  const water = waterUse(world, types, residentsMap, sanitary, retained, roof, policies, scenario.rainfall, solarKw);
  const rain = rainBudget(world, types, storm, coastalDepth, scenario.rainfall, sanitary);
  const overall = (metrics.flooding.score + metrics.biodiversity.score + metrics.heat.score + metrics.carbon.score) / 4;
  return {
    overall, metrics, people, water, rain, emissions,
    perCell: {
      retained, roof, coastalDepth, stormDepth: storm.depth, stormFrac: storm.frac, heat: heatMap, habitat: hab.value, residents: residentsMap,
      buildingEmissions: buildingMap, uptake: uptakeMap,
    },
  };
}

// Water: what residents draw and send to the treatment plants each day, and the
// rain held on site (by the stormwater rule and green roofs), per storm and per
// year. In million gallons. Also the roof areas the roof policies change.
function waterUse(world, types, residentsMap, sanitary, retained, roof, policies, rainfall, solarKw) {
  let people = 0, sewer = 0, area = 0, green = 0, cool = 0;
  for (let i = 0; i < residentsMap.length; i++) {
    people += residentsMap[i];
    sewer += sanitary[i];
    area += retained[i];
    green += roof.green[i];
    cool += roof.cool[i];
  }
  const toilets = policies.toilets.on ? policies.toilets.gpf : POLICY.toiletGpfToday;
  const m3ToMg = 1 / GAL / 1e6;
  const r = policies.stormwaterRule.inches, g = ROOFS.greenRoofIn, Y = POLICY.annualRainIn;
  // A one-hour storm fills them no deeper than the rain.
  const stormIn = area * Math.min(r, rainfall) + green * Math.min(g, rainfall);
  const yearIn = Y * (area * annualCapture(r) + green * annualCapture(g));
  return {
    toiletMgd: (people * POLICY.flushesPerDay * toilets) / 1e6,
    sewageMgd: sewer / 1e6,
    retainedHa: area / 1e4,
    greenRoofHa: green / 1e4,
    coolRoofHa: cool / 1e4,
    solarMw: solarKw / 1000,
    stormMg: stormIn * 0.0254 * m3ToMg,
    yearMg: yearIn * 0.0254 * m3ToMg,
  };
}

// Where the storm's rain goes, in million gallons. The routing above splits the
// rain into on-site retention, storage, soil, sewers and runoff. Of the runoff, the
// water standing in the mapped flooded areas is counted as flooding (the flooded
// share of each cell times its depth), and the rest as running off to the
// harbor, creeks and canals. Stormwater is the rain that runs off rather than
// staying where it fell: the sewer, flooding and runoff shares together. Sewage
// sharing the combined sewers during the storm hour, and seawater the coastal
// storm pushes onto land, are reported beside it, apart from the rain.
function rainBudget(world, types, storm, coastalDepth, rainfall, sanitary) {
  const inches = CELL_AREA * 0.0254 / GAL / 1e6; // million gallons in an inch over one cell
  const b = storm.budget;
  let flood = 0, surge = 0;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === WATER) continue;
    flood += storm.frac[i] * storm.depth[i];
    if (world.cells.land[i] >= 0.5) surge += coastalDepth[i] * 12;
  }
  const surface = Math.max(0, b.rain - b.tanks - b.storage - b.soil - b.sewer);
  flood = Math.min(flood, surface);
  let sewage = 0;
  for (const g of sanitary) sewage += g;
  return {
    rainfall,
    total: b.rain * inches,
    tanks: b.tanks * inches,
    stored: b.storage * inches,
    infiltrated: b.soil * inches,
    sewers: b.sewer * inches,
    flooding: flood * inches,
    runoff: (surface - flood) * inches,
    stormwater: (b.sewer + surface) * inches,
    sewage: (sewage * POLICY.sanitaryPeak) / 24 / 1e6, // gallons a day at the daytime peak, for one hour
    surge: surge * inches,
  };
}
