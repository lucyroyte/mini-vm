import { ECOSYSTEMS, TYPE_INDEX } from './ecosystems.js';
import { LAYERS, loadLayer, loadLots, loadLotAt, loadStreetTrees, loadHeatVulnerability, loadCensusBlocks } from './data.js';
import { loadElevation, ELEVATION_SOURCE } from './elevation.js';
import { loadSurfaceTemperature, loadStormwaterMaps, SURFACE_TEMP_SOURCE, STORMWATER_SOURCE } from './rasters.js';
import { loadLandCover, LANDCOVER_SOURCE } from './landcover.js';
import { buildGrid, cellAt, cellBoundary, cellsInPolygon, CELL, HA_PER_CELL } from './grid.js';
import { bboxOf, containsPoint, polygonsOf } from './geo.js';
import { prepare, runModels, SCENARIO_PRESETS, POLICY, POLICY_OPTIONS } from './models.js';
import { Vision, savedVisions, saveVision, deleteVision } from './vision.js';
import { createMap, paintCells, paintSome, setCursor } from './map.js';
import { set3D } from './model3d.js';
import { cacheGet, cacheSet, cacheClear } from './store.js';
import {
  $, renderPalette, renderScore, renderInspector, renderBorough, renderLegend, renderVisionList,
} from './ui.js';

const CACHE_KEY = 'world-v8';
const CACHE_DAYS = 30;

// Loading ------------------------------------------------------------------------

function step(label) {
  const li = document.createElement('li');
  li.textContent = label;
  li.className = 'pending';
  $('#load-steps').append(li);
  return {
    progress: (n) => { li.textContent = `${label} (${n.toLocaleString()})`; },
    done: (note) => { li.className = 'done'; if (note) li.textContent = `${label} — ${note}`; },
    fail: (err) => { li.className = 'failed'; li.textContent = `${label} — ${err.message ?? err}`; },
  };
}

async function loadWorld() {
  const cached = await cacheGet(CACHE_KEY);
  if (cached && Date.now() - cached.saved < CACHE_DAYS * 864e5) {
    step('Using Brooklyn data saved in this browser').done();
    return cached.world;
  }

  const sources = [];
  const s = step(LAYERS.boundary.label);
  const boundary = await loadLayer('boundary', s.progress).catch((err) => { s.fail(err); throw err; });
  if (!boundary.features.length) throw new Error('The borough boundary dataset has no Brooklyn feature.');
  s.done();
  sources.push({ label: LAYERS.boundary.label, url: boundary.source, name: boundary.name, ok: true });
  const bbox = bboxOf(boundary.features);

  // Everything else is optional: the grid is built from whatever loads.
  const optional = async (key, label, load) => {
    const st = step(label);
    try {
      const result = await load(st.progress);
      st.done();
      sources.push({ label, url: result.source, name: result.name, ok: true });
      return result;
    } catch (err) {
      st.fail(err);
      sources.push({ label, ok: false, error: err.message });
      return null;
    }
  };
  const [parks, hydrography, shoreline, floodplain, wetlands, lots, elevation, landcover, trees, hvi, census, surfaceTemp, stormwater] = await Promise.all([
    optional('parks', LAYERS.parks.label, (p) => loadLayer('parks', p, bbox)),
    optional('hydrography', LAYERS.hydrography.label, (p) => loadLayer('hydrography', p, bbox)),
    optional('shoreline', LAYERS.shoreline.label, (p) => loadLayer('shoreline', p, bbox)),
    optional('floodplain', LAYERS.floodplain.label, (p) => loadLayer('floodplain', p, bbox)),
    optional('wetlands', LAYERS.wetlands.label, (p) => loadLayer('wetlands', p, bbox)),
    optional('landcover', LAYERS.landcover.label, (p) => loadLots(p)),
    optional('elevation', 'Ground elevation (USGS 3DEP)', async () => ({ fn: await loadElevation(bbox), source: ELEVATION_SOURCE, name: 'AWS Terrain Tiles' })),
    optional('aerial', 'Tree, grass and paving (2017 lidar and aerial imagery)', async () => ({ raster: await loadLandCover(), source: LANDCOVER_SOURCE, name: 'NYC Land Cover 2017, 6 in' })),
    optional('streetTrees', LAYERS.streetTrees.label, (p) => loadStreetTrees(p)),
    optional('heatVulnerability', LAYERS.heatVulnerability.label, () => loadHeatVulnerability()),
    optional('census', 'Residents (2020 Census blocks)', () => loadCensusBlocks()),
    optional('surfaceTemp', 'Summer surface temperature (Landsat)', async () => ({ fn: await loadSurfaceTemperature(), source: SURFACE_TEMP_SOURCE, name: 'Landsat 8/9 surface temperature, summers 2023–2025' })),
    optional('stormwater', 'Stormwater flood maps (NYC DEP)', async () => ({ fn: await loadStormwaterMaps(), source: STORMWATER_SOURCE, name: 'NYC Stormwater Flood Maps' })),
  ]);
  sources.push({ label: LAYERS.buildings.label, url: 'https://data.cityofnewyork.us/d/5zhs-2jue', name: 'Loaded for the map view when zoomed in', ok: true });

  const b = step(`Building the ${CELL} m grid`);
  await new Promise((r) => setTimeout(r, 30));
  const built = buildGrid({
    boundary: boundary.features,
    parks: parks?.features,
    hydrography: hydrography?.features,
    shoreline: shoreline?.features,
    floodplain: floodplain?.features,
    wetlands: wetlands?.features,
    lots: lots?.lots,
    elevation: elevation?.fn,
    landcover: landcover?.raster,
    surfaceTemp: surfaceTemp?.fn,
    stormwater: stormwater?.fn,
    trees: trees?.trees,
    census: census?.blocks,
    hvi: hvi?.byZip,
  });
  b.done(`${built.cells.count.toLocaleString()} cells`);

  const world = {
    ...built,
    bbox,
    sources,
    layers: {
      boundary: boundary.features,
      parks: parks?.features ?? [],
      hydrography: hydrography?.features ?? [],
      shoreline: shoreline?.features ?? [],
      floodplain: floodplain?.features ?? [],
      wetlands: wetlands?.features ?? [],
    },
  };
  // Only cache a complete load, so a partial one is retried next time.
  if (sources.every((x) => x.ok)) cacheSet(CACHE_KEY, { saved: Date.now(), world });
  return world;
}

// App ----------------------------------------------------------------------------

const state = {
  tool: 'inspect',
  type: TYPE_INDEX.forest,
  brush: 2,
  mode: 'vision',
  scenario: { rainfall: 2.13, seaLevelRise: 0.92 },
  selected: -1,
};

async function start() {
  $('#load-error').hidden = true;
  $('#load-steps').innerHTML = '';
  let world;
  try {
    world = await loadWorld();
  } catch (err) {
    console.error(err);
    $('#load-error').hidden = false;
    $('#load-error p').textContent = `Brooklyn's data couldn't be loaded from NYC Open Data: ${err.message}`;
    return;
  }
  prepare(world);
  const map = await createMap('map', world);
  $('#loading').hidden = true;
  app(world, map);
}

function app(world, map) {
  let vision = new Vision(world);
  let today, todayKey, results;
  window.brooklynVision = { world, map, state, get vision() { return vision; } };

  // Models --------------------------------------------------------------------
  let modelTimer;
  const recompute = (immediate) => {
    clearTimeout(modelTimer);
    const run = () => {
      // Today only changes with the scenario, so it isn't rerun on every edit.
      const key = `${state.scenario.rainfall}/${state.scenario.seaLevelRise}`;
      if (key !== todayKey) { today = runModels(world, world.cells.existing, state.scenario); todayKey = key; }
      results = runModels(world, vision.current, state.scenario, vision.policies);
      renderScore(today, results);
      renderInspector(world, vision, results, state.selected);
      if (!['vision', 'today', 'changes', 'cover', 'elevation'].includes(state.mode)) paintCells(map, world, state.mode, vision, results);
    };
    if (immediate) run(); else modelTimer = setTimeout(run, 120);
  };

  const repaint = () => { paintCells(map, world, state.mode, vision, results); renderLegend(state.mode); };

  const updateVisionStats = () => {
    const n = vision.changedCells.length;
    $('#vision-stats').textContent = n ? `${n.toLocaleString()} cells changed (${(n * HA_PER_CELL).toLocaleString('en-US', { maximumFractionDigits: 2 })} ha). Created ${new Date(vision.created).toLocaleString()}.` : 'No changes yet. Pick a tool and an ecosystem type, then paint on the map.';
    $('#vision-name').value = vision.name;
    $('#undo').disabled = !vision.undoStack.length;
    $('#redo').disabled = !vision.redoStack.length;
  };

  const bindVision = (v) => {
    vision = v;
    vision.onChange((ids) => {
      if (state.mode === 'vision') paintSome(map, vision, ids);
      else if (state.mode === 'changes') paintCells(map, world, 'changes', vision, results);
      updateVisionStats();
      recompute();
    });
    renderPolicies();
    recompute(true);
    repaint();
    updateVisionStats();
    renderVisions();
  };

  // Toolbar -------------------------------------------------------------------
  const setTool = (tool) => {
    state.tool = tool;
    document.querySelectorAll('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.tool === tool));
    map.dragPan[tool === 'inspect' ? 'enable' : 'disable']();
    map.getCanvas().style.cursor = tool === 'inspect' ? '' : 'crosshair';
    setCursor(map, []);
  };
  document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

  const setType = (i) => {
    state.type = i;
    $('#active-swatch').style.background = ECOSYSTEMS[i].color;
    $('#active-name').textContent = ECOSYSTEMS[i].name;
    renderPalette($('#palette'), i, (t) => { setType(t); togglePalette(false); if (state.tool === 'inspect' || state.tool === 'restore') setTool('brush'); });
  };
  const togglePalette = (open = $('#palette').hidden) => {
    $('#palette').hidden = !open;
    $('#palette-toggle').setAttribute('aria-expanded', open);
  };
  $('#palette-toggle').addEventListener('click', () => togglePalette());
  setType(state.type);

  // Brush sizes are radii in cells; the labels give the brush width on the ground.
  $('#brush').innerHTML = [0, 1, 2, 4, 8].map((r) => `<option value="${r}" ${r === state.brush ? 'selected' : ''}>${(2 * r + 1) * CELL} m</option>`).join('');
  $('#brush').addEventListener('change', (e) => { state.brush = +e.target.value; });
  $('#undo').addEventListener('click', () => vision.undo());
  $('#redo').addEventListener('click', () => vision.redo());
  $('#display').addEventListener('change', (e) => { state.mode = e.target.value; repaint(); });

  $('#layers-toggle').addEventListener('click', () => {
    const menu = $('#layers-menu');
    menu.hidden = !menu.hidden;
    $('#layers-toggle').setAttribute('aria-expanded', !menu.hidden);
  });
  document.querySelectorAll('[data-layer]').forEach((input) => {
    const apply = () => {
      map.setLayoutProperty(input.dataset.layer, 'visibility', input.checked ? 'visible' : 'none');
      if (input.dataset.layer === 'buildings' && input.checked) map.refreshBuildings();
      if (input.dataset.layer === 'floodnet' && input.checked) map.showFloodNet();
    };
    input.addEventListener('change', apply);
    apply();
  });
  $('#view-3d').addEventListener('click', async (e) => {
    const button = e.currentTarget;
    const on = button.getAttribute('aria-pressed') !== 'true';
    button.setAttribute('aria-pressed', on);
    try {
      await set3D(map, on);
    } catch (err) {
      console.error(err);
      button.setAttribute('aria-pressed', false);
      alert(`The 3D buildings couldn't be loaded: ${err.message}`);
    }
  });
  $('#opacity').addEventListener('input', (e) => map.setPaintProperty('cells', 'fill-opacity', +e.target.value));

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#palette, #palette-toggle')) togglePalette(false);
    if (!e.target.closest('#layers')) { $('#layers-menu').hidden = true; $('#layers-toggle').setAttribute('aria-expanded', false); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? vision.redo() : vision.undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); vision.redo(); return; }
    if (mod) return;
    const keys = { i: 'inspect', b: 'brush', r: 'rect', l: 'lot', f: 'fill', e: 'restore' };
    if (keys[e.key]) setTool(keys[e.key]);
    if (e.key === 'Escape') { togglePalette(false); setCursor(map, []); drag = null; }
  });

  // Painting ------------------------------------------------------------------
  const brushCells = (center) => {
    if (center < 0) return [];
    const { cols, rows } = world.grid;
    const c0 = world.cells.col[center], r0 = world.cells.row[center];
    const out = [];
    for (let dr = -state.brush; dr <= state.brush; dr++) for (let dc = -state.brush; dc <= state.brush; dc++) {
      const r = r0 + dr, c = c0 + dc;
      if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
      const j = world.index[r * cols + c];
      if (j >= 0) out.push(j);
    }
    return out;
  };
  const rectCells = (a, b) => {
    const { cols } = world.grid;
    const [ca, cb] = [world.cells.col[a], world.cells.col[b]].sort((x, y) => x - y);
    const [ra, rb] = [world.cells.row[a], world.cells.row[b]].sort((x, y) => x - y);
    const out = [];
    for (let r = ra; r <= rb; r++) for (let c = ca; c <= cb; c++) {
      const j = world.index[r * cols + c];
      if (j >= 0) out.push(j);
    }
    return out;
  };
  const fillCells = (start) => {
    const type = vision.current[start];
    const out = [start];
    const seen = new Set(out);
    const { cols, rows } = world.grid;
    for (let k = 0; k < out.length && out.length < 20000 / HA_PER_CELL; k++) {
      const i = out[k];
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const r = world.cells.row[i] + dr, c = world.cells.col[i] + dc;
        if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
        const j = world.index[r * cols + c];
        if (j >= 0 && !seen.has(j) && vision.current[j] === type) { seen.add(j); out.push(j); }
      }
    }
    return out;
  };
  // Lot tool: the tax lot under the pointer, fetched on demand and kept for reuse.
  const lots = [];
  let lotRequest, lotTimer;
  const lotAt = async (lon, lat) => {
    const hit = lots.find((l) => containsPoint(l.feature, lon, lat));
    if (hit) return hit;
    lotRequest?.abort();
    lotRequest = new AbortController();
    const feature = await loadLotAt(lon, lat, lotRequest.signal);
    if (!feature) return null;
    const lot = { feature, cells: cellsInPolygon(world, feature) };
    // A lot smaller than a cell still paints the cell it sits in.
    if (!lot.cells.length) { const i = cellAt(world, lon, lat); if (i >= 0) lot.cells.push(i); }
    lots.push(lot);
    if (lots.length > 500) lots.shift();
    return lot;
  };
  const lotOutline = (lot) => [...outline(lot.cells), ...polygonsOf(lot.feature.geometry).map((rings) => rings[0])];
  const showLot = (e) => {
    clearTimeout(lotTimer);
    const { lng, lat } = e.lngLat;
    const cached = lots.find((l) => containsPoint(l.feature, lng, lat));
    if (cached) { setCursor(map, lotOutline(cached), toolColor()); return; }
    lotTimer = setTimeout(async () => {
      try {
        const lot = await lotAt(lng, lat);
        if (state.tool === 'lot') setCursor(map, lot ? lotOutline(lot) : [], toolColor());
      } catch (err) {
        if (err.name !== 'AbortError') console.warn('Tax lot unavailable:', err.message);
      }
    }, 120);
  };

  const paint = (ids) => {
    const changed = [];
    for (const i of ids) {
      const type = state.tool === 'restore' ? world.cells.existing[i] : state.type;
      if (vision.set(i, type)) changed.push(i);
    }
    return changed;
  };
  const outline = (ids) => ids.map((i) => cellBoundary(world, i));
  const toolColor = () => (state.tool === 'restore' ? '#ffffff' : ECOSYSTEMS[state.type].color);

  let drag = null;
  const cellOf = (e) => cellAt(world, e.lngLat.lng, e.lngLat.lat);

  map.on('mousedown', (e) => {
    if (state.tool === 'inspect' || e.originalEvent.button !== 0) return;
    const i = cellOf(e);
    if (i < 0) return;
    if (state.tool === 'lot') {
      const { lng, lat } = e.lngLat;
      lotAt(lng, lat).then((lot) => {
        if (!lot) return;
        vision.beginStroke();
        const changed = paint(lot.cells);
        vision.endStroke();
        if (changed.length) vision.emit(changed);
        updateVisionStats();
      }).catch((err) => { if (err.name !== 'AbortError') alert(`The tax lot couldn't be loaded: ${err.message}`); });
      return;
    }
    if (state.tool === 'fill') {
      const ids = fillCells(i);
      vision.beginStroke();
      const changed = paint(ids);
      vision.endStroke();
      if (changed.length) vision.emit(changed);
      return;
    }
    drag = { start: i };
    vision.beginStroke();
    if (state.tool === 'brush' || state.tool === 'restore') {
      const changed = paint(brushCells(i));
      if (changed.length) vision.emit(changed);
    }
  });
  map.on('mousemove', (e) => {
    const i = cellOf(e);
    showTooltip(e, i);
    if (state.tool === 'inspect') { setCursor(map, i >= 0 ? outline([i]) : []); return; }
    if (state.tool === 'lot') { showLot(e); return; }
    if (state.tool === 'rect' && drag) { setCursor(map, i >= 0 ? [rectOutline(drag.start, i)] : [], toolColor()); return; }
    const ids = state.tool === 'fill' ? [i].filter((x) => x >= 0) : brushCells(i);
    setCursor(map, outline(ids), toolColor());
    if (drag && (state.tool === 'brush' || state.tool === 'restore')) {
      const changed = paint(ids);
      if (changed.length) vision.emit(changed);
    }
  });
  const finish = (e) => {
    if (!drag) return;
    if (state.tool === 'rect') {
      const i = e ? cellOf(e) : -1;
      if (i >= 0) {
        const changed = paint(rectCells(drag.start, i));
        if (changed.length) vision.emit(changed);
      }
      setCursor(map, []);
    }
    vision.endStroke();
    updateVisionStats();
    drag = null;
  };
  map.on('mouseup', finish);
  window.addEventListener('mouseup', () => finish());
  map.on('mouseout', () => { $('#tooltip').hidden = true; });

  const rectOutline = (a, b) => {
    const ra = cellBoundary(world, a), rb = cellBoundary(world, b);
    const xs = [...ra, ...rb].map((p) => p[0]), ys = [...ra, ...rb].map((p) => p[1]);
    const [w, e, s, n] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    return [[w, s], [e, s], [e, n], [w, n], [w, s]];
  };

  // Touch: one-finger painting on phones and tablets.
  map.on('touchstart', (e) => {
    if (state.tool === 'inspect' || e.points.length !== 1) return;
    e.preventDefault();
    map.fire('mousedown', { lngLat: e.lngLat, originalEvent: { button: 0 } });
  });
  map.on('touchmove', (e) => {
    if (!drag || e.points.length !== 1) return;
    e.preventDefault();
    map.fire('mousemove', { lngLat: e.lngLat, point: e.point, originalEvent: e.originalEvent });
  });
  map.on('touchend', (e) => finish(e.lngLat ? e : undefined));

  map.on('click', (e) => {
    if (state.tool !== 'inspect') return;
    state.selected = cellOf(e);
    renderInspector(world, vision, results, state.selected);
  });

  const showTooltip = (e, i) => {
    const tip = $('#tooltip');
    if (i < 0 || drag) { tip.hidden = true; return; }
    const cur = ECOSYSTEMS[vision.current[i]], ex = ECOSYSTEMS[world.cells.existing[i]];
    tip.innerHTML = `<b>${cur.name}</b>${cur === ex ? '' : `<br><span class="note">was ${ex.name}</span>`}<br>${world.cells.elevation[i].toFixed(0)} ft${world.cells.inFloodplain[i] ? ' · floodplain' : ''}${world.cells.onShoreline[i] ? ' · shoreline' : ''}`;
    tip.hidden = false;
    const { x, y } = e.point;
    tip.style.transform = `translate(${x + 14}px, ${y + 14}px)`;
  };

  // Scenario ------------------------------------------------------------------
  const rain = $('#rain');
  rain.value = state.scenario.rainfall;
  $('#rain-presets').innerHTML = SCENARIO_PRESETS.rainfall.map((p) => `<option value="${p.value}"></option>`).join('');
  $('#rain-buttons').innerHTML = SCENARIO_PRESETS.rainfall.map((p) => `<button data-rain="${p.value}" title="${p.label}">${p.value}</button>`).join('');
  const setRain = (v) => {
    state.scenario.rainfall = +v;
    rain.value = v;
    $('#rain-out').textContent = `${(+v).toFixed(2)} in/hr`;
    document.querySelectorAll('[data-rain]').forEach((b) => b.classList.toggle('active', +b.dataset.rain === +v));
    recompute();
  };
  rain.addEventListener('input', (e) => setRain(e.target.value));
  $('#rain-buttons').addEventListener('click', (e) => { const b = e.target.closest('[data-rain]'); if (b) setRain(b.dataset.rain); });
  $('#slr').innerHTML = SCENARIO_PRESETS.seaLevelRise.map((p) => `<option value="${p.value}" ${p.value === state.scenario.seaLevelRise ? 'selected' : ''}>${p.label}</option>`).join('');
  $('#slr').addEventListener('change', (e) => { state.scenario.seaLevelRise = +e.target.value; recompute(); });
  $('#rain-out').textContent = `${state.scenario.rainfall.toFixed(2)} in/hr`;
  document.querySelectorAll('[data-rain]').forEach((b) => b.classList.toggle('active', +b.dataset.rain === state.scenario.rainfall));

  // Policies ------------------------------------------------------------------
  const options = (el, list) => { el.innerHTML = list.map((o) => `<option value="${o.value}">${o.label}</option>`).join(''); };
  options($('#policy-gpf'), POLICY_OPTIONS.gpf);
  options($('#policy-inches'), POLICY_OPTIONS.inches);
  options($('#policy-retrofit'), POLICY_OPTIONS.retrofit);
  const renderPolicies = () => {
    const { toilets, stormwaterRule } = vision.policies;
    $('#policy-toilets').checked = toilets.on;
    $('#policy-gpf').value = toilets.gpf;
    $('#policy-gpf').disabled = !toilets.on;
    $('#policy-swr').checked = stormwaterRule.on;
    $('#policy-inches').value = stormwaterRule.inches;
    $('#policy-retrofit').value = stormwaterRule.retrofit;
    for (const id of ['#policy-inches', '#policy-retrofit']) $(id).disabled = !stormwaterRule.on;
  };
  const policyInputs = {
    '#policy-toilets': (p, el) => { p.toilets.on = el.checked; },
    '#policy-gpf': (p, el) => { p.toilets.gpf = +el.value; },
    '#policy-swr': (p, el) => { p.stormwaterRule.on = el.checked; },
    '#policy-inches': (p, el) => { p.stormwaterRule.inches = +el.value; },
    '#policy-retrofit': (p, el) => { p.stormwaterRule.retrofit = el.value; },
  };
  for (const [id, set] of Object.entries(policyInputs)) {
    $(id).addEventListener('change', (e) => { set(vision.policies, e.target); renderPolicies(); recompute(true); });
  }
  $('#policy-notes').textContent = `Low-flow toilets: Brooklyn's toilets are taken to average ${POLICY.toiletGpfToday} gallons a flush today, `
    + `and residents flush ${POLICY.flushesPerDay} times a day at home; workers and visitors aren't counted. Less sewage leaves a little more room `
    + 'in the combined sewers for rain. Unified Stormwater Rule: new development that disturbs 20,000 sq ft or adds 5,000 sq ft of hard surface '
    + 'must hold the first 1.5 in of rain on site. Each painted cell counts as one site, so every painted building, parking lot, port or plaza holds '
    + `that rain from its hard surface, which keeps about ${Math.round(100 * POLICY.annualCapture)}% of a ${POLICY.annualRainIn} in year out of the sewers. `
    + 'The rule leaves existing buildings alone; the retrofit options ask what if they did it too.';

  // Visions -------------------------------------------------------------------
  const renderVisions = () => renderVisionList(savedVisions(), vision.created, {
    onLoad: (created) => {
      const v = savedVisions().find((x) => x.created === created);
      if (v) bindVision(new Vision(world, v));
    },
    onDelete: (created) => {
      if (confirm('Delete this saved vision?')) { deleteVision(created); renderVisions(); }
    },
  });
  $('#vision-name').addEventListener('input', (e) => { vision.name = e.target.value || 'Untitled vision'; });
  $('#vision-save').addEventListener('click', () => {
    if (!saveVision(vision)) alert('This browser could not save the vision. Use Export to keep a copy.');
    renderVisions();
  });
  $('#vision-new').addEventListener('click', () => {
    if (vision.changedCells.length && !confirm('Start a new vision? Unsaved changes will be lost.')) return;
    bindVision(new Vision(world));
  });
  $('#vision-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(vision.toJSON(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${vision.name.replace(/[^\w-]+/g, '-').toLowerCase() || 'vision'}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#vision-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      if (!Array.isArray(json.changes)) throw new Error('missing a list of changes');
      bindVision(new Vision(world, json));
    } catch (err) {
      alert(`That file isn't a Brooklyn Vision export: ${err.message}`);
    }
    e.target.value = '';
  });

  // Panel ---------------------------------------------------------------------
  $('#panel-toggle').addEventListener('click', () => {
    const collapsed = document.body.classList.toggle('panel-collapsed');
    $('#panel-toggle').setAttribute('aria-expanded', !collapsed);
    $('#panel-toggle').textContent = collapsed ? '⟨' : '⟩';
  });
  $('#reload-data').addEventListener('click', async () => {
    await cacheClear();
    location.reload();
  });

  renderBorough(world);
  setTool('inspect');
  bindVision(vision);
}

$('#retry').addEventListener('click', start);
start();
