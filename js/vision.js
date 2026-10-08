// A Vision is the set of changes a user makes to the existing borough.

import { ECOSYSTEMS, TYPE_INDEX } from './ecosystems.js';
import { CELL, cellAt, cellCenter, cellsInSquare } from './grid.js';
import { NO_POLICIES } from './models.js';

const STORE = 'brooklyn-vision:visions';

export class Vision {
  // Visions saved before cellSize was recorded were painted on the 100 m grid.
  constructor(world, { name = 'Untitled vision', created = new Date().toISOString(), changes = [], cellSize = 100, policies = {} } = {}) {
    this.world = world;
    this.name = name;
    this.created = created;
    // Policies the vision adopts, on top of the defaults for any left out.
    this.policies = Object.fromEntries(Object.entries(NO_POLICIES).map(([k, v]) => [k, { ...v, ...policies[k] }]));
    this.current = Uint8Array.from(world.cells.existing); // current ecosystem type of every cell
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
    // Changes are stored by cell center, so saved visions survive a rebuilt grid.
    // A change from a coarser grid fills every smaller cell inside the old one.
    for (const { center, type } of changes) {
      if (!(type in TYPE_INDEX)) continue;
      const cells = cellSize > CELL ? cellsInSquare(world, center[0], center[1], cellSize) : [cellAt(world, center[0], center[1])];
      for (const cell of cells) if (cell >= 0) this.current[cell] = TYPE_INDEX[type];
    }
  }

  // List of changed cell ids.
  get changedCells() {
    const out = [];
    const { existing } = this.world.cells;
    for (let i = 0; i < this.current.length; i++) if (this.current[i] !== existing[i]) out.push(i);
    return out;
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(ids) { for (const fn of this.listeners) fn(ids); }

  // Edits are grouped into strokes, so one drag of the brush undoes in one step.
  beginStroke() { this.stroke = new Map(); }
  set(i, type) {
    if (i < 0 || this.current[i] === type) return false;
    if (this.stroke && !this.stroke.has(i)) this.stroke.set(i, this.current[i]);
    this.current[i] = type;
    return true;
  }
  endStroke() {
    if (this.stroke?.size) {
      const after = new Map([...this.stroke.keys()].map((i) => [i, this.current[i]]));
      this.undoStack.push({ before: this.stroke, after });
      this.redoStack = [];
      if (this.undoStack.length > 200) this.undoStack.shift();
    }
    this.stroke = null;
  }

  apply(ids, type) {
    this.beginStroke();
    const changed = ids.filter((i) => this.set(i, type));
    this.endStroke();
    if (changed.length) this.emit(changed);
    return changed;
  }

  undo() { this.#replay(this.undoStack, this.redoStack, 'before'); }
  redo() { this.#replay(this.redoStack, this.undoStack, 'after'); }
  #replay(from, to, key) {
    const step = from.pop();
    if (!step) return;
    for (const [i, t] of step[key]) this.current[i] = t;
    to.push(step);
    this.emit([...step[key].keys()]);
  }

  toJSON() {
    return {
      name: this.name,
      created: this.created,
      cellSize: CELL,
      policies: this.policies,
      changes: this.changedCells.map((i) => ({
        center: cellCenter(this.world, i).map((v) => +v.toFixed(6)),
        from: ECOSYSTEMS[this.world.cells.existing[i]].id,
        type: ECOSYSTEMS[this.current[i]].id,
      })),
    };
  }
}

export function savedVisions() {
  try {
    return JSON.parse(localStorage.getItem(STORE)) ?? [];
  } catch {
    return [];
  }
}

export function saveVision(vision) {
  const all = savedVisions().filter((v) => v.created !== vision.created);
  all.unshift(vision.toJSON());
  try {
    localStorage.setItem(STORE, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

export function deleteVision(created) {
  try {
    localStorage.setItem(STORE, JSON.stringify(savedVisions().filter((v) => v.created !== created)));
  } catch { /* storage unavailable */ }
}
