// The lot panel: pick a tax lot with the My lot tool, try private-property
// actions on it, and see what each does for rain, heat, water and carbon.

import { loadLotDetails, loadCensusBlocks } from './data.js';
import { compareLot, lotSite, NO_ACTIONS, TANK_SIZES, LOT, GAL_PER_SQFT_IN } from './lot.js';
import { POLICY, POLICY_OPTIONS } from './models.js';
import { setSelectedLot } from './map.js';
import { $ } from './ui.js';

const fmt = (v, d = 0) => (d < 0 ? Math.round(v / 10 ** -d) * 10 ** -d : Math.abs(v) < 10 ** -d / 2 ? 0 : v).toLocaleString('en-US', { maximumFractionDigits: Math.max(0, d), minimumFractionDigits: Math.max(0, d) });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const gal = (v) => `${fmt(v, v >= 10000 ? -2 : v >= 1000 ? -1 : 0)} gal`;
const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

// PLUTO building classes, by their first letter.
const CLASSES = {
  A: 'One-family house', B: 'Two-family house', C: 'Walk-up apartments', D: 'Elevator apartments', R: 'Condominium',
  S: 'Homes over a store', K: 'Store', O: 'Office', E: 'Warehouse', F: 'Factory', G: 'Garage or gas station',
  H: 'Hotel', I: 'Health care', J: 'Theater', L: 'Loft', M: 'House of worship', N: 'Asylum or home', P: 'Assembly or museum',
  Q: 'Recreation', T: 'Transportation', U: 'Utility', V: 'Vacant land', W: 'School', Y: 'Government', Z: 'Other',
};

// Where the rain on the lot goes, in the order it gets there.
const RAIN = [
  { key: 'greenRoof', name: 'Soaked up by the green roof', color: '#4fa35f' },
  { key: 'tank', name: 'Caught in the rain tank', color: '#5b8fd0' },
  { key: 'garden', name: 'Held in the rain garden', color: '#2f9e6b' },
  { key: 'soil', name: 'Soaked into the yard', color: '#a0784c' },
  { key: 'sewer', name: 'Down the drain to the sewer', color: '#8a96a3' },
];

const SAVED = 'lot-actions';
const loadSaved = () => { try { return JSON.parse(localStorage.getItem(SAVED)) ?? {}; } catch { return {}; } };
const save = (bbl, actions) => {
  try { localStorage.setItem(SAVED, JSON.stringify({ ...loadSaved(), [bbl]: actions })); } catch { /* storage unavailable */ }
};

let census;
async function peoplePerUnit(block) {
  census ??= loadCensusBlocks().then(({ blocks }) => {
    let pop = 0, units = 0;
    for (const [p, u] of Object.values(blocks)) { pop += p; units += u; }
    return { blocks, average: pop / units };
  }).catch(() => ({ blocks: {}, average: 2.6 }));
  const { blocks, average } = await census;
  const [p, u] = blocks[block] ?? [];
  return u ? p / u : average;
}

export function createLotPanel({ world, map, results }) {
  const panel = $('#lot-panel');
  let lot = null, site = null, actions = { ...NO_ACTIONS }, request;

  const close = () => {
    panel.hidden = true;
    lot = null;
    setSelectedLot(map, null);
  };
  $('#lot-close').addEventListener('click', close);

  // Opens the panel on a lot from the Lot tool: { feature, cells, cell }.
  async function open(picked) {
    request?.abort();
    request = new AbortController();
    lot = picked;
    site = null;
    panel.hidden = false;
    panel.style.top = `${$('#toolbar').getBoundingClientRect().bottom + 8}px`;
    setSelectedLot(map, picked.feature);
    // Keep the lot in view beside the panel.
    const ring = picked.feature.geometry.type === 'MultiPolygon' ? picked.feature.geometry.coordinates[0][0] : picked.feature.geometry.coordinates[0];
    const center = ring.reduce(([x, y], [a, b]) => [x + a / ring.length, y + b / ring.length], [0, 0]);
    const edge = panel.getBoundingClientRect().right;
    if (map.project(center).x < edge + 20 && window.innerWidth > 760) map.easeTo({ center: map.unproject([map.getCanvas().clientWidth / 2 - (edge + 40 - map.project(center).x), map.getCanvas().clientHeight / 2]) });
    $('#lot-title').textContent = 'Loading the lot…';
    $('#lot-facts').textContent = '';
    $('#lot-body').hidden = true;
    try {
      const bbl = picked.feature.properties.bbl;
      const details = await loadLotDetails(bbl, request.signal);
      details.residents = details.units * (await peoplePerUnit(details.block));
      if (lot !== picked) return;
      site = lotSite(details, world, picked.cells);
      actions = { ...NO_ACTIONS, ...loadSaved()[site.bbl] };
      renderFacts();
      renderControls();
      refresh();
      $('#lot-body').hidden = false;
    } catch (err) {
      if (err.name === 'AbortError') return;
      $('#lot-title').textContent = 'This lot couldn\'t be loaded';
      $('#lot-facts').textContent = err.message;
    }
  }

  function renderFacts() {
    const kind = CLASSES[site.bldgclass[0]] ?? 'Lot';
    $('#lot-title').textContent = site.address ? titleCase(site.address) : `Lot ${site.bbl}`;
    const bits = [
      kind + (site.yearBuilt ? `, built ${site.yearBuilt}` : ''),
      site.floors ? `${fmt(site.floors)} floor${site.floors === 1 ? '' : 's'}` : '',
      site.units ? `${fmt(site.units)} home${site.units === 1 ? '' : 's'}, about ${fmt(site.residents)} residents` : '',
    ].filter(Boolean);
    $('#lot-facts').innerHTML = `${esc(bits.join(' · '))}<br>Lot ${fmt(site.lot, -1)} sq ft: roof ${fmt(site.roof, -1)}, paved ${fmt(site.paved, -1)}, planted ${fmt(site.planted, -1)}`;
  }

  // Controls ---------------------------------------------------------------------
  const roofKeys = ['green', 'cool', 'solar'];
  function renderControls() {
    for (const k of roofKeys) $(`#lot-${k}`).value = Math.round(100 * actions[k]);
    $('#lot-tank').innerHTML = TANK_SIZES.map((t) => `<option value="${t.value}">${t.label}</option>`).join('');
    $('#lot-tank').value = actions.tank;
    const garden = $('#lot-garden');
    garden.max = Math.max(0, Math.floor(site.paved / 10) * 10);
    garden.disabled = site.paved < 10;
    garden.value = Math.min(actions.garden, garden.max);
    $('#lot-downspouts').checked = actions.downspouts;
    $('#lot-trees').value = actions.trees;
    $('#lot-toilets').checked = actions.toilets;
    $('#lot-gpf').innerHTML = POLICY_OPTIONS.gpf.map((o) => `<option value="${o.value}">${o.label}</option>`).join('');
    $('#lot-gpf').value = actions.gpf;
    $('#lot-toilets-row').hidden = !site.units;
    syncOutputs();
  }
  function syncOutputs() {
    for (const k of roofKeys) $(`#lot-${k}-out`).textContent = `${Math.round(100 * actions[k])}% · ${fmt(actions[k] * site.roof, -1)} sq ft`;
    $('#lot-garden-out').textContent = `${fmt(Math.min(actions.garden, site.paved))} sq ft`;
    $('#lot-gpf').disabled = !actions.toilets;
    $('#lot-downspouts').disabled = !actions.garden;
  }
  const inputs = {
    '#lot-tank': (el) => { actions.tank = +el.value; },
    '#lot-garden': (el) => { actions.garden = +el.value; },
    '#lot-downspouts': (el) => { actions.downspouts = el.checked; },
    '#lot-trees': (el) => { actions.trees = Math.max(0, Math.min(20, Math.round(+el.value || 0))); },
    '#lot-toilets': (el) => { actions.toilets = el.checked; },
    '#lot-gpf': (el) => { actions.gpf = +el.value; },
  };
  // The roof's green, cool and solar shares can't add up to more than all of it.
  for (const k of roofKeys) {
    inputs[`#lot-${k}`] = (el) => {
      const others = roofKeys.filter((o) => o !== k).reduce((s, o) => s + actions[o], 0);
      actions[k] = Math.min(+el.value / 100, Math.max(0, 1 - others));
      el.value = Math.round(100 * actions[k]);
    };
  }
  for (const [id, set] of Object.entries(inputs)) {
    $(id).addEventListener('input', (e) => {
      if (!site) return;
      set(e.target);
      syncOutputs();
      save(site.bbl, actions);
      refresh();
    });
  }
  $('#lot-reset').addEventListener('click', () => {
    if (!site) return;
    actions = { ...NO_ACTIONS };
    save(site.bbl, actions);
    renderControls();
    refresh();
  });

  // Effects ----------------------------------------------------------------------
  const change = (d, digits, unit, better) => {
    if (Math.abs(d) < 10 ** -Math.max(0, digits) / 2) return '';
    return ` <span class="${d * better > 0 ? 'good' : 'bad'}">${d > 0 ? '+' : '−'}${fmt(Math.abs(d), digits)}${unit}</span>`;
  };
  const row = (name, today, after, digits, unit, better) => `<tr><th scope="row">${name}</th><td>${fmt(after, digits)}${unit}${change(after - today, digits, unit, better)}</td></tr>`;

  function refresh() {
    if (!site || panel.hidden) return;
    const { today: modelToday, vision } = results();
    if (!modelToday) return;
    const rainfall = modelToday.rain.rainfall;
    const i = lot.cell;
    const surfaceF = modelToday.perCell.heat[i];
    const { today, after } = compareLot(site, actions, rainfall, surfaceF);

    // One storm.
    const s = after.storm;
    $('#lot-storm-note').textContent = `An hour of rain at ${fmt(rainfall, 2)} in/hr drops ${gal(s.rain)} on the lot (set the storm under Climate scenario).`;
    $('#lot-rain-bar').innerHTML = RAIN.filter((r) => s[r.key] > 0).map((r) => `<div style="flex-basis:${(100 * s[r.key]) / (s.rain || 1)}%;background:${r.color}" title="${r.name}"></div>`).join('');
    $('#lot-storm').innerHTML = RAIN.filter((r) => s[r.key] > 0 || today.storm[r.key] > 0).map((r) => {
      const d = s[r.key] - today.storm[r.key];
      const better = r.key === 'sewer' ? -1 : 1;
      const delta = Math.abs(d) < 1 ? '' : ` <span class="${d * better > 0 ? 'good' : 'bad'}">${d > 0 ? '+' : '−'}${gal(Math.abs(d))}</span>`;
      return `<tr><th scope="row"><span class="key" style="background:${r.color}"></span>${r.name}</th><td>${gal(s[r.key])}${delta}</td></tr>`;
    }).join('');
    const p = vision.perCell;
    $('#lot-flood').textContent = p.stormFrac[i]
      ? `Stormwater floods ${fmt(100 * p.stormFrac[i])}% of the 50 m around this lot, ${fmt(p.stormDepth[i])} in deep, in this storm. Every gallon kept out of the sewer leaves room for the street's water.`
      : 'The streets around this lot don\'t flood in this storm on the city\'s maps, but the sewer water still adds to overflows into the harbor.';

    // The rest.
    const y0 = today.year, y1 = after.year;
    $('#lot-year').innerHTML = row('Rain kept out of the sewer', y0.held, y1.held, -2, ' gal', 1)
      + row('…share of the lot\'s rain', (100 * y0.held) / (y0.rain || 1), (100 * y1.held) / (y1.rain || 1), 0, '%', 1)
      + row('Rain sent to the sewer', y0.sewer, y1.sewer, -2, ' gal', -1);
    $('#lot-heat').innerHTML = row('Lot surface, summer afternoon', today.heat.lotF, after.heat.lotF, 1, ' °F', -1)
      + `<tr><th scope="row">Roof surface</th><td>${Math.abs(after.heat.roofDeltaF) < 0.05 ? 'no change' : `<span class="${after.heat.roofDeltaF < 0 ? 'good' : 'bad'}">${after.heat.roofDeltaF < 0 ? '−' : '+'}${fmt(Math.abs(after.heat.roofDeltaF), 1)} °F</span>`}</td></tr>`
      + row('Planted area', today.plantedSqft, after.plantedSqft, -1, ' sq ft', 1)
      + row('Tree canopy', today.canopySqft, after.canopySqft, -1, ' sq ft', 1);
    $('#lot-energy').innerHTML = row('Solar power', 0, after.solar.kwh, -2, ' kWh/yr', 1)
      + row('CO₂ avoided by solar', 0, after.solar.co2, 1, ' t/yr', 1)
      + row('CO₂ taken up by new trees', 0, after.treesCo2, 2, ' t/yr', 1)
      + (site.units ? row('Toilet flushing', today.toiletsGalDay, after.toiletsGalDay, 0, ' gal/day', -1) : '');
  }

  $('#lot-notes').textContent = `The lot is modeled with the same rules as the borough. Rain: a ${LOT.greenRoofIn} in deep sedum green roof soaks up `
    + `its first ${LOT.greenRoofIn} in; the tank catches roof water up to its size; a rain garden ponds ${LOT.rainGardenIn} in and soaks in 1 in/hr; `
    + 'a planted yard holds 2.2 in like a garden cell; roofs and paving drain to the sewer. A year\'s share comes from how much of each storm a place can hold, '
    + `calibrated so 1.5 in keeps ${Math.round(100 * POLICY.annualCapture)}% of a ${POLICY.annualRainIn} in year, and assumes tanks are used or emptied between storms. `
    + 'Heat: the InVEST cooling capacity (shade, albedo, evapotranspiration) of each surface, scaled as in the borough model, starting from the cell\'s Landsat summer temperature; '
    + 'a white roof itself can be 50 °F cooler than a black one at noon, but the satellite sees the lot as a whole. '
    + `Solar: ${LOT.solarWPerSqft} W per sq ft of panels making ${fmt(LOT.solarKwhPerKw)} kWh per kW a year, against NYC grid power at Local Law 97's `
    + `${fmt(LOT.gridCo2PerKwh * 1e6)} g CO₂ per kWh. Trees: each grows a ${fmt(LOT.treeCrownSqft)} sq ft crown and takes up about ${fmt(LOT.treeCo2Tonnes * 2204.6)} lb CO₂ a year once mature. `
    + `Residents: the lot's homes times its 2020 census block's people per home. Toilets: ${POLICY.flushesPerDay} flushes a day at ${POLICY.toiletGpfToday} gal today. `
    + `An inch of rain on a square foot is ${GAL_PER_SQFT_IN.toFixed(2)} gal.`;

  return { open, close, refresh, get lot() { return lot; } };
}
