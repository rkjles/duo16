// Fixed rewind speeds go back N seconds per second; fast-forward runs N frames per tick
const { buildDemo } = require('./build_demo');
const { loadEmu } = require('./harness');
const ctx = loadEmu();
const m = new ctx.Machine(); m.loadROM(buildDemo());
for (let t = 0; t < 60 * 190; t++) m.executeTick([0, 0, 0, 0], [null, null]);
for (const v of [2, 5, 10]) {
  m.applyCommand({ k: 'rewind', on: true, v }, 0);
  for (let t = 0; t < 180; t++) m.executeTick([0, 0, 0, 0], [null, null]); // hold for 3 seconds
  console.log(`rewind ${String(v).padStart(2)}x held 3 s -> ${m.rewindSecondsBack().toFixed(2)} s back (expected ${3 * v})`);
  m.applyCommand({ k: 'rewind', on: false }, 0);
  for (let t = 0; t < 60 * 40; t++) m.executeTick([0, 0, 0, 0], [null, null]);
}
m.applyCommand({ k: 'rewind', on: true, v: 0 }, 0);
for (let t = 0; t < 180; t++) m.executeTick([0, 0, 0, 0], [null, null]);
console.log(`rewind auto held 3 s -> ${m.rewindSecondsBack().toFixed(2)} s back`);
m.applyCommand({ k: 'rewind', on: false }, 0);
for (const v of [5, 8, 10, 11]) {
  m.applyCommand({ k: 'speed', v }, 0);
  const f0 = m.emuFrame; const t0 = Date.now();
  for (let t = 0; t < 60; t++) m.executeTick([0, 0, 0, 0], [null, null]);
  console.log(`fast-forward ${v}x: ${m.emuFrame - f0} frames in 60 ticks, ${((Date.now() - t0) / 60).toFixed(1)} ms per tick here`);
  m.applyCommand({ k: 'speed', v: 1 }, 0);
}
