// ===== Machine: the deterministic unit every player runs identically =====
// It owns the emulator plus the extra synced state: cheats, pause, rewind history, frame counter.
const REWIND_INTERVAL = 15;      // take a rewind snapshot every 15 emulated frames (4 per second)
const REWIND_SECONDS = 45;
const REWIND_MAX = Math.ceil(REWIND_SECONDS * 60 / REWIND_INTERVAL);
const REWIND_STEP_TICKS = 3;      // while rewinding, step back one snapshot every 3 ticks

class Machine {
  constructor() {
    this.snes = new SNES();
    this.cheats = new CheatEngine(this.snes);
    this.settings = { guestCheats: true, guestRewind: true, guestPause: true, guestReset: false };
    this.clearSessionState();
    this.onEvent = null; // (text) => void, for toasts like "Player 2 rewound"
    this.audioMuted = false;
  }

  clearSessionState() {
    this.emuFrame = 0;
    this.paused = false;
    this.rewinding = false;
    this.rewindHeldBy = -1;
    this.rewindPos = -1;
    this.rewindTimer = 0;
    this.history = [];
    this.cheatList = [];
    this.cheatVersion = (this.cheatVersion || 0) + 1;
  }

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
      case 'cheats': return s.guestCheats;
      case 'rewind': return s.guestRewind;
      case 'pause': return s.guestPause;
      case 'reset': return s.guestReset;
      case 'settings': return false;
      default: return true;
    }
  }

  applyCommand(cmd, slot) {
    if (!this.allowed(cmd, slot)) { this.emit(`Player ${slot + 1} isn't allowed to ${verbFor(cmd)} (host setting).`); return; }
    switch (cmd.k) {
      case 'cheats':
        try {
          this.cheatList = cmd.list.map((c) => ({ code: c.code, desc: c.desc || '', enabled: !!c.enabled, kind: c.kind || 'auto' }));
          this.cheats.setList(this.cheatList);
          this.cheatVersion++;
          if (cmd.note) this.emit(`Player ${slot + 1} ${cmd.note}`);
        } catch (e) { this.emit('Cheat list rejected: ' + e.message); }
        break;
      case 'rewind':
        if (cmd.on && !this.rewinding) {
          this.rewinding = true; this.rewindHeldBy = slot; this.rewindTimer = 0;
          this.rewindPos = this.history.length; // step happens on first rewind tick
          this.emit(`Player ${slot + 1} is rewinding`);
        } else if (!cmd.on && this.rewinding && (this.rewindHeldBy === slot || slot === 0)) {
          this.finishRewind();
        }
        break;
      case 'pause':
        this.paused = !!cmd.on;
        this.emit(this.paused ? `Paused by player ${slot + 1}` : `Resumed by player ${slot + 1}`);
        break;
      case 'reset':
        this.snes.softReset();
        this.history = [];
        this.emit(`Player ${slot + 1} reset the game`);
        break;
      case 'settings':
        Object.assign(this.settings, cmd.settings);
        break;
    }
  }
  emit(t) { if (this.onEvent) this.onEvent(t); }

  finishRewind() {
    this.rewinding = false; this.rewindHeldBy = -1;
    if (this.rewindPos >= 0 && this.rewindPos < this.history.length) {
      const h = this.history[this.rewindPos];
      restoreSNES(this.snes, h.state);
      this.emuFrame = h.frame;
      this.history.length = this.rewindPos + 1;
    }
    this.rewindPos = -1;
  }

  // ---- one tick: commands, then one frame (unless paused or rewinding) ----
  executeTick(pads, cmdsBySlot) {
    for (let s = 0; s < cmdsBySlot.length; s++) {
      const cmds = cmdsBySlot[s];
      if (cmds) for (const c of cmds) this.applyCommand(c, s);
    }
    if (this.rewinding) {
      if (this.rewindTimer++ % REWIND_STEP_TICKS === 0 && this.rewindPos > 0) {
        this.rewindPos--;
        const h = this.history[this.rewindPos];
        restoreSNES(this.snes, h.state);
        // render a preview frame, then put the exact snapshot back
        this.snes.pads.fill(0);
        this.snes.runFrame();
        this.snes.apu.audioLen = 0;
        restoreSNES(this.snes, h.state);
        this.emuFrame = h.frame;
      }
      return false;
    }
    if (this.paused) return false;
    for (let i = 0; i < 4; i++) this.snes.pads[i] = pads[i] || 0;
    this.cheats.applyFrame();
    this.snes.runFrame();
    this.emuFrame++;
    if (this.emuFrame % REWIND_INTERVAL === 0) {
      this.history.push({ frame: this.emuFrame, state: snapshotSNES(this.snes) });
      if (this.history.length > REWIND_MAX) this.history.shift();
    }
    return true;
  }

  // ---- full sync package (start of a session, a player joining, or desync repair) ----
  exportSync() {
    return serializeState({
      v: 1,
      emuFrame: this.emuFrame, paused: this.paused ? 1 : 0,
      settings: JSON.stringify(this.settings), cheats: JSON.stringify(this.cheatList),
      snes: snapshotSNES(this.snes),
    });
  }
  importSync(buf) {
    const st = deserializeState(buf);
    restoreSNES(this.snes, st.snes);
    this.clearSessionState();
    this.emuFrame = st.emuFrame; this.paused = !!st.paused;
    this.settings = JSON.parse(st.settings);
    this.cheatList = JSON.parse(st.cheats);
    this.cheats.setList(this.cheatList);
    this.cheatVersion++;
  }
  checksum() { return stateChecksum(this.snes) ^ this.emuFrame ^ (this.paused ? 0x5A5A : 0); }
}

function verbFor(cmd) {
  return { cheats: 'change cheats', rewind: 'rewind', pause: 'pause', reset: 'reset the game', settings: 'change settings' }[cmd.k] || 'do that';
}

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
