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

export function renderPalette(el, active, onPick) {
  el.innerHTML = CATEGORIES.map((cat) => `
    <div class="cat">
      <h4>${cat.name}</h4>
      ${ECOSYSTEMS.map((t, i) => (t.category === cat.id ? `
        <button data-type="${i}" class="type-button ${i === active ? 'active' : ''}"
          title="${esc(describeType(t))}">
          <span class="swatch" style="background:${t.color}"></span>${esc(t.name)}
        </button>` : '')).join('')}
    </div>`).join('');
  el.onclick = (e) => {
    const b = e.target.closest('[data-type]');
    if (b) onPick(+b.dataset.type);
  };
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
    detail: (m) => `${fmt(m.floodedHa)} ha flooded (${fmt(m.coastalHa)} coastal, ${fmt(m.stormHa)} stormwater); ${fmt(m.exposedHa)} ha of homes, businesses and streets at risk`,
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

// People living with the flooding and heat, shown beside the score but not in it.
const PEOPLE = [
  { name: 'Residents', value: (p) => p.population, digits: -2, unit: '', neutral: true },
  { name: 'Residents flooded', value: (p) => p.floodedPeople, digits: -2, lowerIsBetter: true },
  { name: 'Living in heat islands', value: (p) => p.hotPeople, digits: -2, lowerIsBetter: true },
  { name: '…in heat-vulnerable ZIP codes', value: (p) => p.hotVulnerable, digits: -2, lowerIsBetter: true },
  { name: 'Summer surface where people live', value: (p) => p.peopleTemp, digits: 1, unit: ' °F', lowerIsBetter: true },
];

function renderPeople(today, vision) {
  $('#people').innerHTML = PEOPLE.map((spec) => {
    const t = spec.value(today.people), v = spec.value(vision.people);
    const step = spec.digits < 0 ? 10 ** -spec.digits / 2 : 0.05;
    const d = v - t;
    const cls = spec.neutral ? '' : (spec.lowerIsBetter ? d < 0 : d > 0) ? 'good' : 'bad';
    const change = Math.abs(d) < step ? '' : ` <span class="${cls}">${signed(d, spec.digits)}${spec.unit ?? ''}</span>`;
    return `<tr><th scope="row">${spec.name}</th><td>${fmt(v, spec.digits)}${spec.unit ?? ''}${change}</td></tr>`;
  }).join('');
}

export function renderScore(today, vision) {
  renderPeople(today, vision);
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
        <div class="metric-detail">${spec.detail(v)} ${change}</div>
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
