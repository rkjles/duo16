// ===== Machine: the deterministic unit every player runs identically =====
// It owns the emulator plus the extra synced state: cheats, pause, speed, rewind history, frame counter.
const REWIND_INTERVAL = 15;      // take a rewind snapshot every 15 emulated frames (4 per second)
const REWIND_SECONDS = 180;      // 3 minutes
const REWIND_MAX = Math.ceil(REWIND_SECONDS * 60 / REWIND_INTERVAL);
const KEYFRAME_EVERY = 20;       // a full snapshot every 5 seconds, compressed differences in between
const MAX_SPEED = 4;

// While rewind is held it speeds up: [ticks held so far, snapshots to step back per tick]
// (1 snapshot = 1/4 second of play). Slow at first for precision, then faster.
const REWIND_RAMP = [[0, 1 / 3], [90, 1 / 2], [180, 1], [360, 2], [600, 4]];
function rewindRate(ticksHeld) {
  let r = REWIND_RAMP[0][1];
  for (const [t, v] of REWIND_RAMP) if (ticksHeld >= t) r = v;
  return r;
}

class Machine {
  constructor() {
    this.snes = new SNES();
    this.cheats = new CheatEngine(this.snes);
    this.settings = { guestCheats: true, guestRewind: true, guestPause: true, guestReset: false, guestFast: true };
    this.clearSessionState();
    this.onEvent = null; // (text) => void, for toasts like "Player 2 rewound"
    this.audioMuted = false;
  }

  clearSessionState() {
    this.emuFrame = 0;
    this.paused = false;
    this.speed = 1;
    this.speedBy = -1;
    this.rewinding = false;
    this.rewindHeldBy = -1;
    this.rewindPos = -1;
    this.rewindTimer = 0;
    this.rewindAcc = 0;
    this.clearHistory();
    this.cheatList = [];
    this.cheatsOn = true;
    if (this.cheats) this.cheats.master = true;
    this.cheatVersion = (this.cheatVersion || 0) + 1;
  }
  clearHistory() { this.history = []; this.lastKey = null; this.sinceKey = 0; }

  loadROM(bytes) {
    this.snes.loadROM(bytes);
    this.romCRC = crc32(bytes);
    this.clearSessionState();
    this.cheats.setList([]);
  }

  // ---- commands (already permission-checked & ordered identically on all machines) ----
  allowed(cmd, slot) {
    if (slot === 0) return true;
    const s = this.settings;
    switch (cmd.k) {
      case 'cheats': case 'cheatsOn': return s.guestCheats;
      case 'rewind': return s.guestRewind;
      case 'pause': return s.guestPause;
      case 'reset': return s.guestReset;
      case 'speed': return s.guestFast !== false;
      case 'settings': return false;
      default: return true;
    }
  }

  applyCommand(cmd, slot) {
    if (!this.allowed(cmd, slot)) {
      // letting go of a held button always works, so nobody gets stuck
      if (!(cmd.k === 'speed' && cmd.v === 1) && !(cmd.k === 'rewind' && !cmd.on)) { this.emit(`Player ${slot + 1} isn't allowed to ${verbFor(cmd)} (host setting).`); return; }
    }
    switch (cmd.k) {
      case 'cheats':
        try {
          this.cheatList = cmd.list.map((c) => ({ code: c.code, desc: c.desc || '', enabled: !!c.enabled, kind: c.kind || 'auto' }));
          this.cheats.setList(this.cheatList);
          this.cheatVersion++;
          if (cmd.note) this.emit(`Player ${slot + 1} ${cmd.note}`);
        } catch (e) { this.emit('Cheat list rejected: ' + e.message); }
        break;
      case 'cheatsOn':
        if (!!cmd.on === this.cheatsOn) break;
        this.cheatsOn = !!cmd.on;
        this.cheats.setMaster(this.cheatsOn);
        this.cheatVersion++;
        this.emit(`Player ${slot + 1} turned cheats ${this.cheatsOn ? 'on' : 'off'}`);
        break;
      case 'rewind':
        if (cmd.on && !this.rewinding) {
          this.rewinding = true; this.rewindHeldBy = slot; this.rewindTimer = 0; this.rewindAcc = 1;
          this.rewindPos = this.history.length; // step happens on first rewind tick
          this.emit(`Player ${slot + 1} is rewinding`);
        } else if (!cmd.on && this.rewinding && (this.rewindHeldBy === slot || slot === 0)) {
          this.finishRewind();
        }
        break;
      case 'speed': {
        const v = Math.max(1, Math.min(MAX_SPEED, cmd.v | 0));
        if (v === this.speed) break;
        if (v === 1 && this.speedBy !== slot && slot !== 0) break; // only whoever sped up (or the host) can slow down
        this.speed = v; this.speedBy = v > 1 ? slot : -1;
        this.emit(v > 1 ? `Player ${slot + 1} is fast-forwarding (${v}×)` : `Normal speed`);
        break;
      }
      case 'pause':
        this.paused = !!cmd.on;
        this.emit(this.paused ? `Paused by player ${slot + 1}` : `Resumed by player ${slot + 1}`);
        break;
      case 'reset':
        this.snes.softReset();
        this.clearHistory();
        this.emit(`Player ${slot + 1} reset the game`);
        break;
      case 'settings':
        Object.assign(this.settings, cmd.settings);
        break;
    }
  }
  emit(t) { if (this.onEvent) this.onEvent(t); }

  // ---- rewind history (compressed) ----
  pushHistory() {
    const snap = snapshotSNES(this.snes);
    let entry;
    if (!this.lastKey || this.sinceKey >= KEYFRAME_EVERY) {
      entry = { frame: this.emuFrame, key: snap };
      this.lastKey = entry; this.sinceKey = 0;
    } else {
      entry = { frame: this.emuFrame, base: this.lastKey, delta: deltaEncodeState(snap, this.lastKey.key) };
      this.sinceKey++;
    }
    this.history.push(entry);
    // Old entries fall off the front; a difference entry keeps its full snapshot alive until it goes too
    if (this.history.length > REWIND_MAX) this.history.shift();
  }
  stateAt(i) { const h = this.history[i]; return h.key || deltaDecodeState(h.delta, h.base.key); }
  rewindSecondsBack() {
    if (!this.rewinding || !this.history.length) return 0;
    const newest = this.history[this.history.length - 1].frame;
    const at = this.rewindPos < this.history.length ? this.history[this.rewindPos].frame : newest;
    return Math.max(0, (newest - at) / 60);
  }
  rewindSecondsAvailable() { return this.history.length ? (this.emuFrame - this.history[0].frame) / 60 : 0; }

  finishRewind() {
    this.rewinding = false; this.rewindHeldBy = -1;
    if (this.rewindPos >= 0 && this.rewindPos < this.history.length) {
      const h = this.history[this.rewindPos];
      restoreSNES(this.snes, this.stateAt(this.rewindPos));
      this.emuFrame = h.frame;
      this.history.length = this.rewindPos + 1;
      // the next snapshot starts a new compression group
      this.lastKey = null; this.sinceKey = 0;
    }
    this.rewindPos = -1;
  }

  // ---- one tick: commands, then `speed` frames (unless paused or rewinding). Returns frames run. ----
  executeTick(pads, cmdsBySlot) {
    for (let s = 0; s < cmdsBySlot.length; s++) {
      const cmds = cmdsBySlot[s];
      if (cmds) for (const c of cmds) this.applyCommand(c, s);
    }
    if (this.rewinding) {
      this.rewindAcc += rewindRate(this.rewindTimer++);
      let steps = Math.floor(this.rewindAcc);
      this.rewindAcc -= steps;
      steps = Math.min(steps, this.rewindPos);
      if (steps > 0) {
        this.rewindPos -= steps;
        const st = this.stateAt(this.rewindPos);
        restoreSNES(this.snes, st);
        // render a preview frame, then put the exact snapshot back
        this.snes.pads.fill(0);
        this.snes.runFrame();
        this.snes.apu.audioLen = 0;
        restoreSNES(this.snes, st);
        this.emuFrame = this.history[this.rewindPos].frame;
      }
      return 0;
    }
    if (this.paused) return 0;
    for (let n = 0; n < this.speed; n++) {
      for (let i = 0; i < 4; i++) this.snes.pads[i] = pads[i] || 0;
      const keepAudio = this.snes.apu.audioLen;
      this.cheats.applyFrame();
      this.snes.runFrame();
      if (n > 0) this.snes.apu.audioLen = keepAudio; // fast-forward plays the sound of one frame per tick
      this.emuFrame++;
      if (this.emuFrame % REWIND_INTERVAL === 0) this.pushHistory();
    }
    return this.speed;
  }

  // ---- full sync package (start of a session, a player joining, or desync repair) ----
  exportSync() {
    return serializeState({
      v: 2,
      emuFrame: this.emuFrame, paused: this.paused ? 1 : 0, speed: this.speed, speedBy: this.speedBy, cheatsOn: this.cheatsOn ? 1 : 0,
      settings: JSON.stringify(this.settings), cheats: JSON.stringify(this.cheatList),
      snes: snapshotSNES(this.snes),
    });
  }
  importSync(buf) {
    const st = deserializeState(buf);
    restoreSNES(this.snes, st.snes);
    this.clearSessionState();
    this.emuFrame = st.emuFrame; this.paused = !!st.paused;
    this.speed = st.speed || 1; this.speedBy = st.speedBy != null ? st.speedBy : -1;
    this.settings = JSON.parse(st.settings);
    this.cheatList = JSON.parse(st.cheats);
    this.cheatsOn = st.cheatsOn !== 0;
    this.cheats.master = this.cheatsOn;
    this.cheats.setList(this.cheatList);
    this.cheatVersion++;
  }
  checksum() { return stateChecksum(this.snes) ^ this.emuFrame ^ (this.paused ? 0x5A5A : 0) ^ (this.speed << 20); }
}

function verbFor(cmd) {
  return { cheats: 'change cheats', rewind: 'rewind', pause: 'pause', reset: 'reset the game', cheatsOn: 'turn cheats on or off', speed: 'fast-forward', settings: 'change settings' }[cmd.k] || 'do that';
}

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
