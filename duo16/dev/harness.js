// Node harness: loads the emulator core (app/renderer/emu) into one context for tests
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const EMU = path.join(__dirname, '..', 'app', 'renderer', 'emu');
const SRC = ['cpu.js', 'ppu.js', 'apu.js', 'snes.js', 'state.js', 'cheats.js', 'machine.js', 'session.js'];
function loadEmu() {
  const ctx = { console, Math, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Float32Array, Array, Object, JSON, Date, TextEncoder, TextDecoder, ArrayBuffer, Map, Set, String, Number, Error };
  ctx.performance = { now: () => (ctx.__clock != null ? ctx.__clock : Date.now()) };
  vm.createContext(ctx);
  for (const f of SRC) vm.runInContext(fs.readFileSync(path.join(EMU, f), 'utf8'), ctx, { filename: f });
  vm.runInContext('Object.assign(globalThis, { SNES, Cartridge, APU, Machine, Session, parseCheat, serializeState, deserializeState, snapshotSNES, restoreSNES, stateChecksum });', ctx);
  return ctx;
}
module.exports = { loadEmu };
