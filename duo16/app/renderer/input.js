// ===== Controllers: keyboard + gamepads =====
const BUTTONS = [
  { id: 'up', label: 'Up', bit: 0x0800 }, { id: 'down', label: 'Down', bit: 0x0400 },
  { id: 'left', label: 'Left', bit: 0x0200 }, { id: 'right', label: 'Right', bit: 0x0100 },
  { id: 'a', label: 'A', bit: 0x0080 }, { id: 'b', label: 'B', bit: 0x8000 },
  { id: 'x', label: 'X', bit: 0x0040 }, { id: 'y', label: 'Y', bit: 0x4000 },
  { id: 'l', label: 'L', bit: 0x0020 }, { id: 'r', label: 'R', bit: 0x0010 },
  { id: 'start', label: 'Start', bit: 0x1000 }, { id: 'select', label: 'Select', bit: 0x2000 },
];
const HOTKEYS = [
  { id: 'rewind', label: 'Rewind (hold)' }, { id: 'pause', label: 'Pause' },
  { id: 'fast', label: 'Fast-forward (hold)' }, { id: 'save', label: 'Save state' }, { id: 'load', label: 'Load state' },
];
const DEFAULT_KEYS = {
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  a: 'KeyX', b: 'KeyZ', x: 'KeyS', y: 'KeyA', l: 'KeyQ', r: 'KeyW', start: 'Enter', select: 'ShiftRight',
  rewind: 'Backspace', pause: 'KeyP', fast: 'Tab', save: 'F5', load: 'F7',
};
// A pad binding is one of:
//   { t: 'b', i }                 button i pressed
//   { t: 'a', i, d, r }           axis i moved past rest value r in direction d (+1/-1)
//   { t: 'h', i, dir }            hat switch on axis i pointing dir ('up'|'down'|'left'|'right')
const std = (i) => ({ t: 'b', i });
// Xbox / PlayStation style controllers the browser recognises ("standard" layout).
// Face buttons by position: bottom = B, right = A, left = Y, top = X.
const STANDARD_MAP = {
  b: [std(0)], a: [std(1)], y: [std(2)], x: [std(3)], l: [std(4)], r: [std(5)], select: [std(8)], start: [std(9)],
  up: [std(12), { t: 'a', i: 1, d: -1, r: 0 }], down: [std(13), { t: 'a', i: 1, d: 1, r: 0 }],
  left: [std(14), { t: 'a', i: 0, d: -1, r: 0 }], right: [std(15), { t: 'a', i: 0, d: 1, r: 0 }],
  rewind: [std(6), std(10)], fast: [std(7), std(11)],
};
// Best guess for other USB controllers (most USB SNES-style pads use this order)
const GENERIC_MAP = {
  x: [std(0)], a: [std(1)], b: [std(2)], y: [std(3)], l: [std(4)], r: [std(5)], select: [std(8)], start: [std(9)],
  up: [{ t: 'a', i: 1, d: -1, r: 0 }, { t: 'h', i: 9, dir: 'up' }], down: [{ t: 'a', i: 1, d: 1, r: 0 }, { t: 'h', i: 9, dir: 'down' }],
  left: [{ t: 'a', i: 0, d: -1, r: 0 }, { t: 'h', i: 9, dir: 'left' }], right: [{ t: 'a', i: 0, d: 1, r: 0 }, { t: 'h', i: 9, dir: 'right' }],
  rewind: [], fast: [],
};
const HAT_DIRS = [['up'], ['up', 'right'], ['right'], ['down', 'right'], ['down'], ['down', 'left'], ['left'], ['up', 'left']];
function hatDirs(v) {
  if (v == null || v > 1.05 || v < -1.05) return []; // neutral on most controllers is about 1.29
  return HAT_DIRS[Math.round((v + 1) * 3.5) & 7] || [];
}
function padName(gp) { return (gp.id || 'Controller').replace(/\s*\((?:STANDARD GAMEPAD\s*)?Vendor: (\w+) Product: (\w+)\)/i, '').replace(/\s*\(.*\)$/, '').trim() || 'Controller'; }

class Input {
  constructor() {
    this.keys = { ...DEFAULT_KEYS };
    this.down = new Set();
    this.onHotkey = null; // (id, pressed) => void
    this.capture = null;  // (code) => void when rebinding
    this.padHot = {};
    this.padMaps = {}; this.padChoice = ''; this.padCapture = null; this.combos = true;
    addEventListener('keydown', (e) => this.key(e, true));
    addEventListener('keyup', (e) => this.key(e, false));
    addEventListener('blur', () => { this.down.clear(); for (const id of Object.keys(this.padHot)) if (this.padHot[id]) { this.padHot[id] = false; this.onHotkey?.(id, false); } });
  }
  setKeys(k) { this.keys = { ...DEFAULT_KEYS, ...(k || {}) }; }
  key(e, pressed) {
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (this.capture && pressed) {
      e.preventDefault();
      const cb = this.capture; this.capture = null; cb(e.code === 'Escape' ? null : e.code); return;
    }
    if (typing) return;
    const hot = HOTKEYS.find((h) => this.keys[h.id] === e.code);
    const isGameKey = BUTTONS.some((b) => this.keys[b.id] === e.code);
    if (hot || isGameKey || e.code === 'Tab' || e.code === 'Space') e.preventDefault();
    if (hot) { if (!(pressed && e.repeat)) this.onHotkey?.(hot.id, pressed); }
    if (pressed) this.down.add(e.code); else this.down.delete(e.code);
  }
  pads() { return navigator.getGamepads ? [...navigator.getGamepads()].filter((p) => p && p.connected) : []; }
  setPadMaps(maps) { this.padMaps = maps || {}; }
  setPadChoice(id) { this.padChoice = id || ''; }
  defaultMap(gp) { return gp && gp.mapping === 'standard' ? STANDARD_MAP : GENERIC_MAP; }
  mapFor(gp) { const d = this.defaultMap(gp); const c = gp && this.padMaps && this.padMaps[gp.id]; return c ? { ...d, ...c } : d; }
  hasCustomMap(gp) { return !!(gp && this.padMaps && this.padMaps[gp.id]); }
  // The controller for this computer's player: the one chosen in Controls, else the first one connected
  p1Pad() {
    const pads = this.pads();
    return (this.padChoice && pads.find((p) => p.id === this.padChoice)) || pads[0] || null;
  }
  p2Pad() { const p1 = this.p1Pad(); return this.pads().find((p) => p !== p1) || null; }
  bindingActive(gp, bnd) {
    if (bnd.t === 'b') { const b = gp.buttons[bnd.i]; return !!(b && (b.pressed || b.value > 0.5)); }
    if (bnd.t === 'a') { const v = gp.axes[bnd.i]; return v != null && (v - (bnd.r || 0)) * bnd.d > 0.5; }
    if (bnd.t === 'h') return hatDirs(gp.axes[bnd.i]).includes(bnd.dir);
    return false;
  }
  isDown(gp, id) {
    const list = this.mapFor(gp)[id];
    return !!(list && list.some((bnd) => this.bindingActive(gp, bnd)));
  }
  // Select + L / Select + R shortcuts (for controllers without spare buttons)
  combo(gp) {
    if (!this.combos || !gp || !this.isDown(gp, 'select')) return null;
    const l = this.isDown(gp, 'l'), r = this.isDown(gp, 'r');
    return l || r ? { rewind: l, fast: r } : null;
  }
  readPad(gp) {
    if (!gp) return 0;
    let bits = 0;
    for (const b of BUTTONS) if (this.isDown(gp, b.id)) bits |= b.bit;
    // while a shortcut is held, the game doesn't see Select, L or R
    if (this.combo(gp)) bits &= ~(0x2000 | 0x0020 | 0x0010);
    return bits;
  }
  pollPadHotkeys(gp) {
    if (!gp || this.padCapture) return;
    const c = this.combo(gp);
    for (const id of ['rewind', 'fast']) {
      const on = this.isDown(gp, id) || !!(c && c[id]);
      if (!!this.padHot[id] !== on) { this.padHot[id] = on; this.onHotkey?.(id, on); }
    }
  }
  // ---- binding a controller button: call startPadCapture(cb); cb(binding|null) on the next press ----
  startPadCapture(cb) {
    const gp = this.p1Pad();
    if (!gp) { cb(null, 'Connect a controller first.'); return; }
    const rest = gp.axes.map((v) => v);
    const held = gp.buttons.map((b) => b.pressed || b.value > 0.5);
    this.padCapture = { cb, id: gp.id, rest, held, started: performance.now() };
  }
  cancelPadCapture() { if (this.padCapture) { const c = this.padCapture; this.padCapture = null; c.cb(null); } }
  pollPadCapture() {
    const c = this.padCapture; if (!c) return;
    const gp = this.pads().find((p) => p.id === c.id);
    if (!gp) { this.cancelPadCapture(); return; }
    if (performance.now() - c.started > 10000) { this.cancelPadCapture(); return; }
    let found = null;
    gp.buttons.forEach((b, i) => { const down = b.pressed || b.value > 0.5; if (down && !c.held[i] && !found) found = { t: 'b', i }; if (!down) c.held[i] = false; });
    if (!found) {
      gp.axes.forEach((v, i) => {
        if (found) return;
        const r = c.rest[i] || 0;
        if (Math.abs(r) > 1.05) { const d = hatDirs(v); if (d.length === 1) found = { t: 'h', i, dir: d[0] }; return; }
        if (Math.abs(v - r) > 0.6) found = { t: 'a', i, d: v > r ? 1 : -1, r: Math.abs(r) > 0.9 ? r : 0 };
      });
    }
    if (found) { this.padCapture = null; c.cb(found, null, gp); }
  }
  describeBinding(bnd) {
    if (!bnd) return 'None';
    if (bnd.t === 'b') return `Button ${bnd.i + 1}`;
    if (bnd.t === 'h') return `D-pad ${bnd.dir}`;
    return `Stick ${bnd.i + 1}${bnd.d > 0 ? '+' : '−'}`;
  }
  clean(bits) {
    if ((bits & 0x0300) === 0x0300) bits &= ~0x0300; // left+right
    if ((bits & 0x0C00) === 0x0C00) bits &= ~0x0C00; // up+down
    return bits;
  }
  // Player 1: keyboard + first gamepad
  readP1() {
    let bits = 0;
    for (const b of BUTTONS) if (this.down.has(this.keys[b.id])) bits |= b.bit;
    const gp = this.p1Pad();
    if (!this.padCapture) { bits |= this.readPad(gp); this.pollPadHotkeys(gp); }
    return this.clean(bits);
  }
  // Second local player (solo play only): second gamepad
  readP2() { return this.clean(this.readPad(this.p2Pad())); }
  keyName(code) {
    if (!code) return 'None';
    return code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Arrow/, '').replace('Right', ' Right').replace('Left', ' Left').replace(/^Shift /, 'Shift ').trim();
  }
}
