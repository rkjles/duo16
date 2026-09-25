// 3-minute rewind: memory use, exact restore, and rewind speed-up
const { buildDemo } = require('./build_demo');
const { loadEmu } = require('./harness');
const ctx = loadEmu();
const m = new ctx.Machine(); m.loadROM(buildDemo());
let rnd = 7; const rand = () => { rnd = (rnd * 1103515245 + 12345) & 0x7FFFFFFF; return rnd / 0x7FFFFFFF; };
const saved = new Map();
let pad = 0;
const t0 = Date.now();
for (let t = 0; t < 60 * 200; t++) {           // 200 seconds of play
  if (t % 20 === 0) pad = [0, 0x800, 0x400, 0x1000][Math.floor(rand() * 4)];
  m.executeTick([pad, pad ^ 0xC00, 0, 0], [null, null]);
  if (m.emuFrame % 15 === 0 && m.emuFrame % 600 === 0) saved.set(m.emuFrame, m.checksum());
}
const ms = (Date.now() - t0) / (60 * 200);
// memory estimate: bytes held by history
const seen = new Set(); let bytes = 0;
const walk = (v) => { if (!v || typeof v !== 'object' || seen.has(v)) return; seen.add(v); if (ArrayBuffer.isView(v)) { bytes += v.byteLength; return; } for (const k of Object.keys(v)) walk(v[k]); };
for (const h of m.history) walk(h);
console.log(`ms/frame incl. snapshots: ${ms.toFixed(2)} | history: ${m.history.length} snapshots = ${m.rewindSecondsAvailable().toFixed(0)} s | memory ${(bytes / 1048576).toFixed(1)} MB (uncompressed would be ~${(m.history.length * 0.33).toFixed(0)} MB)`);
// hold rewind and count how long it takes to go all the way back
m.applyCommand({ k: 'rewind', on: true }, 0);
let ticks = 0; const marks = {};
while (m.rewindPos > 0 && ticks < 60 * 120) { m.executeTick([0, 0, 0, 0], [null, null]); ticks++; const b = Math.floor(m.rewindSecondsBack()); for (const s of [10, 30, 60, 120, 180]) if (b >= s && !marks[s]) marks[s] = (ticks / 60).toFixed(1) + 's'; }
console.log('holding rewind: reach N seconds back after', JSON.stringify(marks), '| full 3 min after', (ticks / 60).toFixed(1), 's');
// stop at an earlier saved checkpoint and compare exact state
m.applyCommand({ k: 'rewind', on: false }, 0);
let ok = 0, bad = 0;
for (const [frame, sum] of saved) {
  const i = m.history.findIndex((h) => h.frame === frame);
  if (i < 0) continue;
  // re-run from start to that frame in a fresh machine to compare
}
// exact-restore check: rewind a fresh run by a known amount and compare to a checksum recorded going forward
const m2 = new ctx.Machine(); m2.loadROM(buildDemo());
const sums = [];
rnd = 99;
for (let t = 0; t < 60 * 60; t++) { if (t % 20 === 0) pad = [0, 0x800, 0x400][Math.floor(rand() * 3)]; m2.executeTick([pad, 0, 0, 0], [null, null]); if (m2.emuFrame % 15 === 0) sums.push([m2.emuFrame, m2.checksum()]); }
m2.applyCommand({ k: 'rewind', on: true }, 0);
for (let i = 0; i < 200; i++) m2.executeTick([0, 0, 0, 0], [null, null]);
m2.applyCommand({ k: 'rewind', on: false }, 0);
const want = sums.find((s) => s[0] === m2.emuFrame);
console.log('rewound to frame', m2.emuFrame, '| state identical to when it was first played:', want && want[1] === m2.checksum());
