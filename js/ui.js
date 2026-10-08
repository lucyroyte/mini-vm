// Rendering for the side panel, palette, legend and inspector.

import { CATEGORIES, ECOSYSTEMS, BUILDING_SIZES, USES } from './ecosystems.js';
import { SCALES } from './map.js';
import { CELL, CELL_AREA, HA_PER_CELL } from './grid.js';

export const $ = (sel) => document.querySelector(sel);

// Negative digits round to tens, hundreds, thousands.
const fmt = (v, d = 0) => (d < 0 ? Math.round(v / 10 ** -d) * 10 ** -d : v).toLocaleString('en-US', { maximumFractionDigits: Math.max(0, d), minimumFractionDigits: Math.max(0, d) });
const signed = (v, d = 0) => (v > 0 ? '+' : v < 0 ? '−' : '±') + fmt(Math.abs(v), d);
const pct = (v) => `${Math.round(100 * v)}%`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Labels and explanations for ecosystem values, shown in the info box on each
// column heading of the values table. `about` says what the value is; `used`
// says how the climate scores use it. Any other numeric field an ecosystem
// defines is shown too, under its own name, so new model parameters appear
// without edits here.
const VALUE_INFO = {
  imperviousness: {
    label: 'Impervious', name: 'Imperviousness', share: true,
    about: 'The share of the ground covered by roofs, pavement and other hard surfaces that rain can\'t soak into. 100% is fully paved.',
    used: 'Stormwater: rain on the pervious part soaks in at about 1 inch per hour; rain on hard surfaces runs off unless storm sewers take it. Where a vision leaves a cell as it is, the paved share measured from 2017 aerial imagery is used instead.',
  },
  vegetation: {
    label: 'Vegetation', name: 'Vegetation cover', share: true,
    about: 'The share of the ground covered by trees, shrubs, grass or other plants. Plants shade and cool the ground and help rain soak in.',
    used: 'Heat: a cell that is at least half planted counts as green space, which cools the blocks around it up to about 450 m away. Where a vision leaves a cell as it is, the tree and grass cover measured from 2017 aerial imagery is used instead.',
  },
  habitat: {
    label: 'Habitat', unit: '/10', name: 'Habitat value', digits: 1,
    about: 'How much the place offers wildlife (food, shelter and places to nest for birds, insects and other animals), from 0 for a parking lot to 10 for salt marsh. These are typical values for each ecosystem, not field surveys.',
    used: 'Biodiversity: a cell counts for more when its neighbors are good habitat too (5 or more). A cell of 5 or more with at least 3 such neighbors counts as connected habitat, and every ecosystem of 4 or more that covers 10 ha adds to habitat variety.',
  },
  carbon: {
    label: 'Carbon', unit: 't/ha', name: 'Carbon stored',
    about: 'Carbon held in the soil and plants, in tonnes per hectare (a hectare is about 2.5 acres). Wetlands and forests store the most; buildings and pavement store almost none. These are rough typical values for comparing ecosystems.',
    used: 'Carbon: the borough total adds up every cell. An average of 60 t/ha across Brooklyn would score 100.',
  },
  storage: {
    label: 'Storage', unit: 'in', name: 'Rain storage', digits: 1,
    about: 'Inches of rain the place can hold during a storm, in soil, plants, ponds or rain gardens, on top of what soaks into the ground. Green streets hold 1.5 in in their bioswales; freshwater wetlands hold the most.',
    used: 'Stormwater: each hour a cell can take its storage, plus what soaks in, plus what the sewers carry. Rain beyond that runs downhill and collects in low spots; 4 in or more of standing water counts as flooded.',
  },
  sewered: {
    label: 'Sewered', name: 'Sewered share', share: true,
    about: 'The share of the hard surface that drains into storm sewers. Streets and buildings are fully sewered; parks, wetlands and beaches drain naturally.',
    used: 'Stormwater: sewers carry up to 1.75 in of rain per hour, the city\'s design standard, from the sewered hard surface. Heavier rain overflows.',
  },
  barrier: {
    label: 'Barrier', unit: 'ft', name: 'Shoreline barrier', digits: 1,
    about: 'How many feet a shoreline structure (a bulkhead, seawall, dune or riprap) raises the water\'s edge above the ground. It is 0 for everything that isn\'t a shoreline structure.',
    used: 'Coastal flooding: storm water stops at a cell unless it rises above the ground plus the barrier. The design storm is a 10 ft tide plus the sea level rise you pick.',
  },
  attenuation: {
    label: 'Surge cut', unit: 'ft/100 m', name: 'Storm surge reduction', digits: 2,
    about: 'How many feet a storm surge drops for every 100 m it crosses this ecosystem. Marshes, living shorelines and forests slow waves and lower the water behind them; hard surfaces don\'t.',
    used: 'Coastal flooding: the water level falls by this much as it spreads across each cell, so a wide marsh can keep the land behind it dry.',
  },
  shade: {
    label: 'Shade', name: 'Tree shade', share: true,
    about: 'The share of the ground shaded by tree canopy. For buildings and streets it counts only backyards and courtyards; each cell\'s street trees come from the city\'s tree census.',
    used: 'Heat: shade makes up 60% of a cell\'s cooling in the InVEST Urban Cooling model.',
  },
  albedo: {
    label: 'Albedo', name: 'Albedo (reflectance)', share: true,
    about: 'The share of sunlight a surface reflects instead of absorbing. Sand and light roofs reflect more; asphalt and water reflect less.',
    used: 'Heat: reflectance makes up 20% of a cell\'s cooling in the InVEST Urban Cooling model.',
  },
  kc: {
    label: 'Water use', unit: '× lawn', name: 'Evapotranspiration', digits: 2,
    about: 'How much water the plants and soil give off to the air compared with a watered lawn (1.0). Evaporating water cools the air around it.',
    used: 'Heat: evapotranspiration makes up 20% of a cell\'s cooling in the InVEST Urban Cooling model.',
  },
};

export const valueFields = () => {
  const keys = [];
  for (const t of ECOSYSTEMS) for (const [k, v] of Object.entries(t)) if (typeof v === 'number' && !keys.includes(k)) keys.push(k);
  const order = Object.keys(VALUE_INFO);
  return keys.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)).map((key) => {
    const info = VALUE_INFO[key] ?? { label: key, name: key };
    const max = Math.max(...ECOSYSTEMS.map((t) => t[key] ?? 0));
    return { key, ...info, max };
  });
};

const fmtValue = (f, v) => (v == null ? '–' : f.share ? pct(v) : fmt(v, Number.isInteger(v) ? 0 : f.digits ?? 2));

let paletteView = 'brushes';

export function renderPalette(el, active, onPick) {
  const tabs = `
    <div class="palette-tabs" role="tablist">
      ${[['brushes', 'Brushes'], ['values', 'Compare values']].map(([v, label]) => `
        <button role="tab" data-view="${v}" aria-selected="${paletteView === v}" class="${paletteView === v ? 'active' : ''}">${label}</button>`).join('')}
    </div>`;
  el.innerHTML = tabs + (paletteView === 'values' ? valuesTable(active) : `
    <div class="palette-grid">${CATEGORIES.map((cat) => `
      <div class="cat">
        <h4>${cat.name}</h4>
        ${ECOSYSTEMS.map((t, i) => (t.category === cat.id ? `
          <button data-type="${i}" class="type-button ${i === active ? 'active' : ''}"
            title="${esc(describeType(t))}">
            <span class="swatch" style="background:${t.color}"></span>${esc(t.name)}
          </button>` : '')).join('')}
      </div>`).join('')}
    </div>`);
  el.onclick = (e) => {
    const tab = e.target.closest('[data-view]');
    // Stop the click here: re-rendering detaches the tab, and the document's
    // outside-click handler would then close the palette.
    if (tab) { e.stopPropagation(); paletteView = tab.dataset.view; renderPalette(el, active, onPick); return; }
    const b = e.target.closest('[data-type]');
    if (b) onPick(+b.dataset.type);
  };
  bindInfoBoxes(el);
}

function valuesTable(active) {
  const fields = valueFields();
  const head = fields.map((f) => `
    <th scope="col"><button class="info-head" data-info="${esc(f.key)}" aria-describedby="value-info">
      ${esc(f.label)} <span class="info-icon" aria-hidden="true">i</span>${f.unit ? `<small>${esc(f.unit)}</small>` : ''}
    </button></th>`).join('');
  const rows = CATEGORIES.map((cat) => `
    <tr class="cat-row"><th scope="rowgroup" colspan="${fields.length + 1}"><span>${cat.name}</span></th></tr>
    ${ECOSYSTEMS.map((t, i) => (t.category === cat.id ? `
      <tr data-type="${i}" class="${i === active ? 'active' : ''}" title="Paint with ${esc(t.name)}">
        <th scope="row"><span class="swatch" style="background:${t.color}"></span>${esc(t.name)}</th>
        ${fields.map((f) => {
          const v = t[f.key];
          const w = f.max > 0 && v > 0 ? Math.round((100 * v) / f.max) : 0;
          return `<td style="--w:${w}%">${fmtValue(f, v)}</td>`;
        }).join('')}
      </tr>` : '')).join('')}`).join('');
  return `
    <div class="values-wrap">
      <table class="values">
        <thead><tr><th scope="col">Ecosystem</th>${head}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="note">Bars compare each value with the highest in its column. Hover or tap a heading to see what it means; click a row to paint with it.</p>
    <div id="value-info" role="tooltip" hidden></div>`;
}

// The info box under a values table heading: what the value means, how the
// scores use it, and which ecosystems rank highest and lowest.
function infoBox(f) {
  const ranked = ECOSYSTEMS.filter((t) => t[f.key] != null).sort((a, b) => b[f.key] - a[f.key]);
  const top = ranked.slice(0, 3).map((t) => `${esc(t.name)} ${fmtValue(f, t[f.key])}`).join(', ');
  const lowest = ranked[ranked.length - 1][f.key];
  const low = ranked.filter((t) => t[f.key] === lowest);
  const lowNames = esc(low[0].name) + (low.length > 1 ? ` and ${low.length - 1} other${low.length > 2 ? 's' : ''}` : '');
  return `
    <strong>${esc(f.name ?? f.label)}${f.unit ? ` (${esc(f.unit)})` : ''}</strong>
    ${f.about ? `<p>${esc(f.about)}</p>` : ''}
    ${f.used ? `<p>${esc(f.used)}</p>` : ''}
    <p class="info-range">Highest: ${top}. Lowest: ${lowNames} ${fmtValue(f, lowest)}.</p>`;
}

function bindInfoBoxes(el) {
  const box = el.querySelector('#value-info');
  if (!box) return;
  const fields = Object.fromEntries(valueFields().map((f) => [f.key, f]));
  let pinned = null;
  const show = (btn) => {
    box.innerHTML = infoBox(fields[btn.dataset.info]);
    box.hidden = false;
    const r = btn.getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 20);
    box.style.width = `${w}px`;
    box.style.left = `${Math.max(10, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 10))}px`;
    box.style.top = `${r.bottom + 6}px`;
  };
  const hide = () => { box.hidden = true; pinned = null; };
  el.querySelectorAll('[data-info]').forEach((btn) => {
    btn.addEventListener('mouseenter', () => { if (!pinned) show(btn); });
    btn.addEventListener('mouseleave', () => { if (!pinned) box.hidden = true; });
    btn.addEventListener('focus', () => show(btn));
    btn.addEventListener('blur', hide);
    // Tapping (or clicking) keeps the box open until the next tap, for touch screens.
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (pinned === btn) { hide(); return; }
      pinned = btn; show(btn);
    });
  });
  el.querySelector('.values-wrap').addEventListener('scroll', hide);
  el.addEventListener('scroll', hide);
}

export function describeType(t) {
  const lines = [
    t.name,
    `Imperviousness ${fmt(t.imperviousness, 2)} · Vegetation ${fmt(t.vegetation, 2)}`,
    `Habitat ${fmt(t.habitat, 1)}/10 · Carbon ${t.carbon} t/ha`,
  ];
  if (t.size) lines.push(`${BUILDING_SIZES[t.size]} · ${USES[t.use]}`);
  return lines.join('\n');
}

const METRICS = [
  {
    key: 'flooding', name: 'Flooding',
    detail: (m, r) => `${fmt(m.floodedHa)} ha flooded (${fmt(m.coastalHa)} coastal, ${fmt(m.stormHa)} stormwater); ${fmt(m.exposedHa)} ha of homes, businesses and streets at risk; ${gallons(r.rain.flooding)} of rain standing in the streets`,
    value: (m) => m.exposedHa, unit: 'ha at risk', lowerIsBetter: true,
  },
  {
    key: 'biodiversity', name: 'Biodiversity',
    detail: (m) => `Average habitat ${fmt(m.meanHabitat, 1)}/10; ${fmt(m.connectedHa)} ha of connected habitat; ${m.habitatTypes} habitat types`,
    value: (m) => m.connectedHa, unit: 'ha connected habitat',
  },
  {
    key: 'heat', name: 'Heat',
    detail: (m) => `Summer surfaces average ${fmt(m.meanTemp, 1)} °F; ${fmt(m.hotHa)} ha of heat islands (105 °F or more)`,
    value: (m) => m.meanTemp, unit: '°F', digits: 1, lowerIsBetter: true,
  },
  {
    key: 'carbon', name: 'Carbon',
    detail: (m) => `${fmt(m.totalTonnes / 1000, 1)} thousand tonnes of carbon stored in soil and plants (${fmt(m.perHa, 1)} t/ha)`,
    value: (m) => m.totalTonnes / 1000, unit: 'kt C', digits: 1,
  },
];

// Million gallons, in words that fit the size: 2.6 billion gal, 340 million gal, 52,000 gal.
function gallons(mg, sign = false) {
  const a = Math.abs(mg);
  const text = a >= 1000 ? `${fmt(a / 1000, a >= 10000 ? 0 : 1)} billion gal`
    : a >= 1 ? `${fmt(a, a >= 100 ? 0 : 1)} million gal`
      : `${fmt(a * 1e6, -3)} gal`;
  return sign ? (mg > 0 ? '+' : '−') + text : text;
}

// Where a storm's rain goes, in gallons. Colors key the stacked bar.
const RAIN = [
  { key: 'tanks', name: 'Held in rooftop tanks', color: '#5b8fd0', better: 1 },
  { key: 'stored', name: 'Held by soil, plants and ponds', color: '#2f9e6b', better: 1 },
  { key: 'infiltrated', name: 'Soaked into the ground', color: '#a0784c', better: 1 },
  { key: 'sewers', name: 'Carried by sewers', color: '#8a96a3', better: -1 },
  { key: 'flooding', name: 'Flooding streets and buildings', color: '#d1453b', better: -1 },
  { key: 'runoff', name: 'Running off to waterways', color: '#e9a23b', better: -1 },
];

function renderRain(today, vision) {
  const t = today.rain, v = vision.rain;
  $('#rain-note').textContent = `One hour of rain at ${fmt(v.rainfall, 2)} in/hr drops ${gallons(v.total)} on Brooklyn. Most sewers here are combined, so sewer water past the treatment plants' capacity overflows into the harbor.`;
  const shown = RAIN.filter((r) => v[r.key] > 0 || t[r.key] > 0);
  $('#rain-bar').innerHTML = shown.map((r) => `<div style="flex-basis:${(100 * v[r.key]) / (v.total || 1)}%;background:${r.color}" title="${r.name}"></div>`).join('');
  $('#rain-bar').setAttribute('aria-label', shown.map((r) => `${r.name} ${pct(v[r.key] / (v.total || 1))}`).join(', '));
  const row = (name, key, value, d, better, cls = '') => {
    const change = Math.abs(d) < 0.0005 ? '' : ` <span class="${d * better > 0 ? 'good' : 'bad'}">${gallons(d, true)}</span>`;
    return `<tr class="${cls}"><th scope="row">${key}${name}</th><td>${gallons(value)}${change}</td></tr>`;
  };
  $('#rain').innerHTML = shown.map((r) => row(r.name, `<span class="key" style="background:${r.color}"></span>`, v[r.key], v[r.key] - t[r.key], r.better)).join('')
    + (v.surge || t.surge ? row('Seawater on land (coastal storm)', '', v.surge, v.surge - t.surge, -1, 'aside') : '');
}

// People living with the flooding and heat, shown beside the score but not in it.
const PEOPLE = [
  { name: 'Residents', value: (r) => r.people.population, digits: -2, unit: '', neutral: true },
  { name: 'Residents flooded', value: (r) => r.people.floodedPeople, digits: -2, lowerIsBetter: true },
  { name: 'Living in heat islands', value: (r) => r.people.hotPeople, digits: -2, lowerIsBetter: true },
  { name: '…in heat-vulnerable ZIP codes', value: (r) => r.people.hotVulnerable, digits: -2, lowerIsBetter: true },
  { name: 'Summer surface where people live', value: (r) => r.people.peopleTemp, digits: 1, unit: ' °F', lowerIsBetter: true },
];

// Water use and rain capture, which the policies change. Not part of the climate score.
const WATER_ROWS = [
  { name: 'Toilet flushing at home', value: (r) => r.water.toiletMgd, digits: 1, unit: ' MGD', lowerIsBetter: true },
  { name: 'Sewage from homes', value: (r) => r.water.sewageMgd, digits: 1, unit: ' MGD', lowerIsBetter: true },
  { name: 'Roofs capturing rain', value: (r) => r.water.roofHa, digits: 1, unit: ' ha' },
  { name: 'Rain held in tanks, this storm', value: (r) => r.water.stormMg, digits: 1, unit: ' Mgal' },
  { name: '…in a normal year', value: (r) => r.water.yearMg, digits: 0, unit: ' Mgal' },
  { name: 'Stormwater flooding', value: (r) => r.metrics.flooding.stormHa, digits: 1, unit: ' ha', lowerIsBetter: true },
];

// A table of today's and the vision's values, with the change where there is one.
function renderRows(el, specs, today, vision) {
  el.innerHTML = specs.map((spec) => {
    const t = spec.value(today), v = spec.value(vision);
    const d = v - t;
    const cls = spec.neutral ? '' : (spec.lowerIsBetter ? d < 0 : d > 0) ? 'good' : 'bad';
    const change = Math.abs(d) < 10 ** -spec.digits / 2 ? '' : ` <span class="${cls}">${signed(d, spec.digits)}${spec.unit ?? ''}</span>`;
    return `<tr><th scope="row">${spec.name}</th><td>${fmt(v, spec.digits)}${spec.unit ?? ''}${change}</td></tr>`;
  }).join('');
}

export function renderScore(today, vision) {
  renderRows($('#people'), PEOPLE, today, vision);
  renderRows($('#water'), WATER_ROWS, today, vision);
  renderRain(today, vision);
  // Each 1 ha cell moves the borough-wide score by only a few thousandths of a
  // point, so whole numbers hide most edits: show a decimal and an unrounded delta.
  $('#score-vision').textContent = fmt(vision.overall, 1);
  $('#score-today').textContent = fmt(today.overall, 1);
  const d = vision.overall - today.overall;
  const delta = $('#score-delta');
  delta.textContent = Math.abs(d) < 0.005 ? 'no change' : signed(d, Math.abs(d) < 1 ? 2 : 1);
  delta.className = `delta ${d >= 0.005 ? 'good' : d <= -0.005 ? 'bad' : ''}`;

  $('#metrics').innerHTML = METRICS.map((spec) => {
    const t = today.metrics[spec.key], v = vision.metrics[spec.key];
    const dv = spec.value(v) - spec.value(t);
    const better = spec.lowerIsBetter ? dv < 0 : dv > 0;
    const change = Math.abs(dv) < 0.05 ? '' : `<span class="${better ? 'good' : 'bad'}">${signed(dv, spec.digits ?? 0)} ${spec.unit}</span>`;
    return `
      <div class="metric">
        <div class="metric-head"><span>${spec.name}</span><span class="metric-score">${Math.round(v.score)}</span></div>
        <div class="bar" role="img" aria-label="${spec.name}: vision ${Math.round(v.score)}, today ${Math.round(t.score)} out of 100">
          <div class="fill" style="width:${v.score}%"></div>
          <div class="mark" style="left:${t.score}%" title="Today: ${Math.round(t.score)}"></div>
        </div>
        <div class="metric-detail">${spec.detail(v, vision)} ${change}</div>
      </div>`;
  }).join('');
}

export function renderInspector(world, vision, results, i) {
  const section = $('#inspector');
  if (i < 0) { section.hidden = true; return; }
  section.hidden = false;
  const c = world.cells;
  const ex = ECOSYSTEMS[c.existing[i]], cur = ECOSYSTEMS[vision.current[i]];
  const p = results.perCell;
  const rows = [
    ['Cell', `#${i} (column ${c.col[i]}, row ${c.row[i]})`],
    ['Area', `${fmt(CELL_AREA)} m² (${fmt(HA_PER_CELL, 2)} ha)`],
    ['Elevation', `${fmt(c.elevation[i], 1)} ft`],
    ['In floodplain', c.inFloodplain[i] ? 'Yes' : 'No'],
    ['On shoreline', c.onShoreline[i] ? 'Yes' : 'No'],
    ['Measured cover', c.tree?.[i] >= 0 ? `${pct(c.tree[i])} trees, ${pct(c.grass[i])} grass, ${pct(c.paved[i])} paved or roofed` : 'Not measured'],
    ['Existing type', swatch(ex)],
    ['Current type', swatch(cur) + (ex === cur ? '' : ' <em>(changed)</em>')],
    ['Coastal flood', p.coastalDepth[i] > 0 ? `${fmt(p.coastalDepth[i], 1)} ft deep` : 'Dry'],
    ['Stormwater', p.stormFrac[i] ? `${fmt(100 * p.stormFrac[i])}% of the cell, ${fmt(p.stormDepth[i])} in deep` : 'Drains'],
    ['Summer surface', `${fmt(p.heat[i], 1)} °F` + (Number.isFinite(c.surfaceTemp[i]) ? ` (measured ${fmt(c.surfaceTemp[i], 1)} °F)` : ' (modeled)')],
    ['Street trees', `${fmt(100 * c.canopy[i])}% shade`],
    ['Residents', `${fmt(p.residents[i])}` + (Math.round(p.residents[i]) !== Math.round(c.residents[i]) ? ` <em>(${fmt(c.residents[i])} today)</em>` : '')],
    ['Heat vulnerability', c.hvi[i] ? `${fmt(c.hvi[i], 1)} / 5 (ZIP code)` : 'Unknown'],
    ['Habitat', `${fmt(p.habitat[i], 1)} / 10`],
  ];
  if (p.roof[i]) rows.push(['Rain capture', `${fmt(p.roof[i], -1)} m² of tower roof with rain tanks`]);
  $('#cell-info').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

const swatch = (t) => `<span class="swatch" style="background:${t.color}"></span>${esc(t.name)}`;

export function renderBorough(world) {
  const counts = new Map();
  for (const t of world.cells.existing) counts.set(t, (counts.get(t) ?? 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5);
  $('#borough-info').innerHTML = `
    <dt>Name</dt><dd>${world.borough.name}</dd>
    <dt>Total area</dt><dd>${fmt(world.borough.totalArea / 1e6, 1)} km² (${fmt(world.borough.totalArea / 2.58999e6, 1)} sq mi) of land</dd>
    <dt>Cells</dt><dd>${fmt(world.cells.count)} cells of ${CELL} m × ${CELL} m</dd>
    <dt>Most common</dt><dd>${top.map(([t, n]) => `${swatch(ECOSYSTEMS[t])} ${fmt(n)}`).join('<br>')}</dd>`;
  $('#sources').innerHTML = world.sources.map((s) => `
    <li class="${s.ok ? '' : 'warn'}">${esc(s.label)}: ${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name ?? s.url)}</a>` : ''} ${s.ok ? '' : `<em>unavailable (${esc(s.error)})</em>`}</li>`).join('');
}

export function renderLegend(mode) {
  const el = $('#legend');
  const scale = SCALES[mode];
  if (!scale) { el.hidden = true; return; }
  el.hidden = false;
  if (scale.swatches) {
    el.innerHTML = `<div class="legend-title">${scale.label}</div>${scale.swatches.map(([name, color]) => `<div><span class="swatch" style="background:${color}"></span>${name}</div>`).join('')}`;
    return;
  }
  const stops = scale.stops;
  el.innerHTML = `
    <div class="legend-title">${scale.label}</div>
    <div class="legend-ramp" style="background:linear-gradient(to right, ${stops.map(([, c]) => c).join(',')})"></div>
    <div class="legend-labels"><span>${stops[0][0]} ${scale.unit}</span><span>${stops[stops.length - 1][0]} ${scale.unit}</span></div>`;
}

export function renderVisionList(list, currentCreated, { onLoad, onDelete }) {
  const ul = $('#vision-list');
  ul.innerHTML = list.map((v) => `
    <li class="${v.created === currentCreated ? 'current' : ''}">
      <button class="link" data-load="${esc(v.created)}">${esc(v.name)}</button>
      <span class="note">${new Date(v.created).toLocaleDateString()} · ${v.changes.length} cells</span>
      <button class="icon" data-delete="${esc(v.created)}" title="Delete">×</button>
    </li>`).join('');
  ul.onclick = (e) => {
    const load = e.target.closest('[data-load]');
    const del = e.target.closest('[data-delete]');
    if (load) onLoad(load.dataset.load);
    if (del) onDelete(del.dataset.delete);
  };
}
