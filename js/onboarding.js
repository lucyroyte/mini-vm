// Onboarding: a welcome card on first visit, a guided tour of the toolbar and
// report card, and an About page on why you might use the tool. The Help
// button in the toolbar reopens any of them.

import { TYPE_INDEX } from './ecosystems.js';
import { cellsInSquare, HA_PER_CELL } from './grid.js';
import { $ } from './ui.js';

const SEEN_KEY = 'brooklyn-vision:welcomed';

// The tour's demo repaints a square of the Gowanus neighborhood as forest.
const DEMO = { center: [-73.9905, 40.6745], side: 800, type: 'forest' };

const seen = () => { try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return false; } };
const markSeen = () => { try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* storage is optional */ } };

const scoreText = () => `${$('#score-vision').textContent} (today ${$('#score-today').textContent}, ${$('#score-delta').textContent})`;
const nextFrame = () => new Promise((r) => setTimeout(r, 250));

export function initOnboarding({ world, map, getVision }) {
  // Modals -----------------------------------------------------------------------
  const modal = (id) => {
    const el = $(id);
    const close = () => { el.hidden = true; };
    el.addEventListener('click', (e) => {
      if (e.target === el || e.target.closest('[data-close]')) close();
    });
    return { el, open: () => { el.hidden = false; (el.querySelector('.primary') ?? el.querySelector('button'))?.focus(); }, close };
  };
  const welcome = modal('#welcome');
  const about = modal('#about');
  const closeAll = () => { welcome.close(); about.close(); };

  $('#welcome-tour').addEventListener('click', () => { markSeen(); closeAll(); tour.start(); });
  $('#welcome-about').addEventListener('click', () => { markSeen(); welcome.close(); about.open(); });
  $('#welcome-start').addEventListener('click', () => { markSeen(); welcome.close(); });
  $('#about-tour').addEventListener('click', () => { closeAll(); tour.start(); });

  // Help menu ------------------------------------------------------------------
  const menu = $('#help-menu');
  const toggleMenu = (open = menu.hidden) => {
    menu.hidden = !open;
    $('#help-toggle').setAttribute('aria-expanded', open);
  };
  $('#help-toggle').addEventListener('click', () => toggleMenu());
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-help]');
    if (!b) return;
    toggleMenu(false);
    closeAll();
    if (b.dataset.help === 'welcome') welcome.open();
    if (b.dataset.help === 'tour') tour.start();
    if (b.dataset.help === 'about') about.open();
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#help')) toggleMenu(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      toggleMenu(false);
      if (tour.active) tour.end(); else closeAll();
      return;
    }
    if (tour.active && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { tour.go(e.key === 'ArrowRight' ? 1 : -1); return; }
    if (e.key === '?' && !e.target.matches('input, select, textarea')) { closeAll(); welcome.open(); }
  });

  // Tour demos --------------------------------------------------------------------
  // Each demo does something real in the app, so the report card moves. The tour
  // puts everything back when it ends.
  const demos = { paint: null, policy: null, display: null, hectares: 0 };
  const demoPaint = async () => {
    const vision = getVision();
    if (demos.paint && vision.undoStack.at(-1) === demos.paint) return;
    // Leave the canal itself as water.
    const cells = cellsInSquare(world, DEMO.center[0], DEMO.center[1], DEMO.side).filter((i) => world.cells.existing[i] !== TYPE_INDEX.water);
    demos.hectares = Math.round(cells.length * HA_PER_CELL);
    map.flyTo({ center: DEMO.center, zoom: 14, duration: 1200 });
    vision.apply(cells, TYPE_INDEX[DEMO.type]);
    demos.paint = vision.undoStack.at(-1);
    await nextFrame();
  };
  const demoUndo = async () => {
    const vision = getVision();
    if (demos.paint && vision.undoStack.at(-1) === demos.paint) { $('#undo').click(); demos.paint = null; }
    await nextFrame();
  };
  const setDisplay = (mode) => {
    const select = $('#display');
    if (demos.display === null) demos.display = select.value;
    select.value = mode;
    select.dispatchEvent(new Event('change'));
  };
  // The rule only covers painted cells unless existing buildings retrofit, so
  // the demo asks every building to meet it.
  const setPolicy = async (on) => {
    const box = $('#policy-swr'), retrofit = $('#policy-retrofit');
    if (on && !demos.policy) demos.policy = { checked: box.checked, retrofit: retrofit.value };
    const want = on ? { checked: true, retrofit: 'all' } : demos.policy;
    if (!want) return;
    if (box.checked !== want.checked) box.click();
    if (retrofit.value !== want.retrofit) { retrofit.value = want.retrofit; retrofit.dispatchEvent(new Event('change')); }
    if (!on) demos.policy = null;
    await nextFrame();
  };
  const cleanUp = () => {
    const vision = getVision();
    if (demos.paint && vision.undoStack.at(-1) === demos.paint) vision.undo();
    demos.paint = null;
    if (demos.policy) setPolicy(false);
    if (demos.display !== null) {
      $('#display').value = demos.display;
      $('#display').dispatchEvent(new Event('change'));
      demos.display = null;
    }
  };

  // Steps ------------------------------------------------------------------------
  // target: what to highlight (none centers the card). demo: a "Show me" action.
  // after: text added once the demo has run, so it can quote the new numbers.
  const STEPS = [
    {
      title: 'Brooklyn, cell by cell',
      text: 'The map divides Brooklyn into 50 m cells. Each one is colored by what is there today, from NYC Open Data: buildings, streets, parks, water and more. Your <b>vision</b> is the set of cells you change.',
    },
    {
      target: '.score-card .score-row',
      title: 'The report card',
      text: 'The climate score rates your vision out of 100 next to Brooklyn <b>today</b>. They start out equal because nothing has changed yet. The number in the middle is the difference.',
    },
    {
      target: '#metrics',
      title: 'Four climate measures',
      text: 'The score is built from flooding, biodiversity, heat and carbon. The bar is your vision and the dark tick is today, so you can see which way each one moves.',
    },
    {
      target: '#palette-toggle',
      title: 'Pick what to paint',
      text: 'This button opens the palette of 28 ecosystem types, from high-rise buildings to forest, salt marsh and green streets. It also has a <b>Compare values</b> tab with the numbers behind each type.',
    },
    {
      target: '#tools',
      title: 'Painting tools',
      text: '<b>Inspect</b> pans and shows a cell\'s details. <b>Brush</b>, <b>Rectangle</b>, <b>Lot</b> and <b>Fill</b> repaint cells with the chosen type. <b>Restore</b> paints cells back to how they are today. <b>My lot</b> opens one tax lot so you can try a green roof, rain tank, cool roof and more on it.',
    },
    {
      target: '.score-card',
      title: 'Watch the score change',
      text: 'Press <b>Show me</b> to turn the blocks around the Gowanus Canal into forest.',
      demo: demoPaint,
      demoLabel: 'Show me',
      after: () => `That painted ${demos.hectares} hectares. The score is now ${scoreText()}. More trees and soil mean less runoff, cooler streets, more habitat and more carbon stored, and each bar shows it.`,
    },
    {
      target: '#undo',
      title: 'Undo and redo',
      text: 'Every stroke can be undone. Press <b>Show me</b> to undo the forest and watch the score go back.',
      demo: demoUndo,
      demoLabel: 'Show me',
      after: () => `Back to ${scoreText()}. Ctrl+Z and Ctrl+Shift+Z work too.`,
    },
    {
      target: '.rain-budget',
      title: 'Where the rain goes',
      text: 'This bar splits the rain from the chosen storm into what soaks in, what plants and ponds hold, what the sewers carry, and what floods the streets.',
    },
    {
      target: '.policies-card',
      title: 'Policies',
      text: 'Policies change rules across the whole borough instead of painting cells. Press <b>Show me</b> to adopt the Unified Stormwater Rule and have every existing building meet it too.',
      demo: () => setPolicy(true),
      demoLabel: 'Show me',
      after: () => `With the rule the score is ${scoreText()}, and the rain bar shows more water held on site. The tour turns it back off when it ends.`,
    },
    {
      target: '#rain-buttons',
      title: 'The storm you plan for',
      text: 'Rainfall intensity and sea level rise set the scenario. Changing them moves both today and your vision, since both face the same storm.',
    },
    {
      target: '.people-card',
      title: 'People',
      text: 'How many residents live where it floods or overheats, from the 2020 Census. This isn\'t part of the score, but it shows who a change helps.',
    },
    {
      target: '#display',
      title: 'See the results on the map',
      text: 'Switch the map from your vision to today, just your changes, or the model results for flooding, heat, habitat and residents. Press <b>Show me</b> to see flooding.',
      demo: async () => { setDisplay('flood'); await nextFrame(); },
      demoLabel: 'Show me',
      after: () => 'Darker blue is deeper water in the chosen storm. The tour switches the map back when it ends.',
    },
    {
      target: '#layers',
      title: 'Layers and 3D',
      text: '<b>Layers</b> adds reference data such as the FEMA floodplain, parks and FloodNet sensors. <b>3D</b> tilts the map to show buildings in Downtown Brooklyn.',
      extra: '#view-3d',
    },
    {
      target: '#vision-save',
      title: 'Save and share',
      text: 'Name your vision, save it in this browser, or <b>Export</b> it as a file to share. <b>Import</b> opens someone else\'s.',
      extra: '#vision-import',
    },
    {
      target: '#help-toggle',
      title: 'Help is here',
      text: 'The <b>?</b> button reopens the welcome card, this tour, and the About page on ways to use Brooklyn Vision. The tour has put the map back the way it was.',
    },
  ];

  // Tour UI ----------------------------------------------------------------------
  const spot = $('#tour-spot');
  const card = $('#tour-card');
  let index = 0;
  let frame;

  const targetOf = (step) => (step.target ? $(step.target) : null);
  const rectOf = (step) => {
    const els = [step.target, step.extra].filter(Boolean).map((s) => $(s)).filter((el) => el && el.offsetParent !== null);
    if (!els.length) return null;
    const rs = els.map((el) => el.getBoundingClientRect());
    const left = Math.min(...rs.map((r) => r.left)), top = Math.min(...rs.map((r) => r.top));
    const right = Math.max(...rs.map((r) => r.right)), bottom = Math.max(...rs.map((r) => r.bottom));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  };

  const place = () => {
    const r = rectOf(STEPS[index]);
    const vw = window.innerWidth, vh = window.innerHeight, pad = 6, gap = 12;
    const cw = card.offsetWidth, ch = card.offsetHeight;
    let x, y;
    if (!r) {
      spot.hidden = true;
      x = (vw - cw) / 2; y = (vh - ch) / 2;
    } else {
      spot.hidden = false;
      Object.assign(spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px` });
      // Try below, left, above, then right of the target; else pin to the bottom.
      const options = [
        [r.left, r.bottom + pad + gap],
        [r.left - pad - gap - cw, r.top],
        [r.left, r.top - pad - gap - ch],
        [r.right + pad + gap, r.top],
      ];
      const fits = ([px, py]) => px >= 8 && py >= 8 && px + cw <= vw - 8 && py + ch <= vh - 8;
      const clampX = (px) => Math.min(Math.max(px, 8), vw - cw - 8);
      const clampY = (py) => Math.min(Math.max(py, 8), vh - ch - 8);
      const pick = options.find(([px, py]) => fits([clampX(px), py]) && (px === clampX(px) || py > r.bottom || py + ch < r.top))
        ?? options.find(([px, py]) => fits([px, clampY(py)]));
      if (pick) { x = clampX(pick[0]); y = clampY(pick[1]); } else { x = (vw - cw) / 2; y = vh - ch - 8; }
    }
    card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    frame = requestAnimationFrame(place);
  };

  const render = () => {
    const step = STEPS[index];
    const target = targetOf(step);
    if (target?.closest('#panel') && document.body.classList.contains('panel-collapsed')) $('#panel-toggle').click();
    target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    card.innerHTML = `
      <div class="tour-count">${index + 1} of ${STEPS.length}</div>
      <h3 id="tour-title">${step.title}</h3>
      <p>${step.text}</p>
      <p class="tour-after" hidden></p>
      <div class="tour-buttons">
        <button data-tour="end" class="link">End tour</button>
        <span class="spacer"></span>
        ${index ? '<button data-tour="back">Back</button>' : ''}
        ${step.demo ? `<button data-tour="demo">${step.demoLabel}</button>` : ''}
        <button data-tour="next" class="primary">${index === STEPS.length - 1 ? 'Done' : 'Next'}</button>
      </div>`;
    (card.querySelector('[data-tour="demo"]') ?? card.querySelector('[data-tour="next"]')).focus();
  };

  card.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-tour]');
    if (!b) return;
    const action = b.dataset.tour;
    if (action === 'end') tour.end();
    if (action === 'back') tour.go(-1);
    if (action === 'next') tour.go(1);
    if (action === 'demo') {
      const step = STEPS[index];
      b.disabled = true;
      await step.demo();
      const after = card.querySelector('.tour-after');
      after.innerHTML = step.after();
      after.hidden = false;
      b.remove();
      card.querySelector('[data-tour="next"]').focus();
    }
  });

  const tour = {
    active: false,
    start() {
      markSeen();
      tour.active = true;
      index = 0;
      card.hidden = false;
      document.body.classList.add('touring');
      render();
      cancelAnimationFrame(frame);
      place();
    },
    go(d) {
      const n = index + d;
      if (n >= STEPS.length) { tour.end(); return; }
      if (n < 0) return;
      // Leaving a demo step puts that demo back, so each step starts from the same map.
      // except the forest, which the next step undoes.
      if (!(d > 0 && STEPS[index].demo === demoPaint)) cleanUp();
      index = n;
      render();
    },
    end() {
      tour.active = false;
      cancelAnimationFrame(frame);
      card.hidden = true;
      spot.hidden = true;
      document.body.classList.remove('touring');
      cleanUp();
    },
  };

  if (!seen()) welcome.open();
  return { welcome, about, tour };
}
