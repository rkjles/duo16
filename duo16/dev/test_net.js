// Simulates two players over a lossy, laggy network and checks they stay in sync
const { buildDemo } = require('./build_demo');
const { loadEmu } = require('./harness');
const ctxA = loadEmu(), ctxB = loadEmu();
let clock = 0; ctxA.__clock = 0; ctxB.__clock = 0;
const rom = buildDemo();
const mA = new ctxA.Machine(); mA.loadROM(rom);
const mB = new ctxB.Machine(); mB.loadROM(rom);
const toasts = [];
mA.onEvent = (t) => toasts.push('A: ' + t); mB.onEvent = (t) => toasts.push('B: ' + t);
let rnd = 12345; const rand = () => { rnd = (rnd * 1103515245 + 12345) & 0x7FFFFFFF; return rnd / 0x7FFFFFFF; };
let padA = 0, padB = 0;
const sA = new ctxA.Session(mA, { role: 'host', delay: +(process.argv[5] || 3), readInput: () => padA, onToast: (t) => toasts.push('A toast: ' + t) });
const sB = new ctxB.Session(mB, { role: 'guest', readInput: () => padB, onToast: (t) => toasts.push('B toast: ' + t) });
const queue = [];
const LOSS = +(process.argv[2] || 0.1), LAT = +(process.argv[3] || 40);
function mkLink(dst) {
  let lastReliable = 0;
  const clone = (o) => o instanceof Uint8Array ? o.slice() : JSON.parse(JSON.stringify(o));
  return {
    sendFast: (o) => { if (rand() < LOSS) return; queue.push({ at: clock + LAT * (0.6 + rand() * 0.8), fn: () => dst.onFast(clone(o)) }); },
    sendReliable: (o) => { lastReliable = Math.max(lastReliable, clock + LAT * (0.8 + rand() * 0.6)); queue.push({ at: lastReliable, fn: () => dst.onReliable(clone(o)) }); },
  };
}
sA.attach(mkLink(sB)); sB.attach(mkLink(sA));
// host starts by syncing (as when a friend connects)
sA.sendSync();
const FRAME = 1000 / 60;
const seconds = +(process.argv[4] || 60);
let cheatDone = false, rewindOn = false, rewindOff = false;
for (let step = 0; step < seconds * 60; step++) {
  clock += FRAME; ctxA.__clock = clock; ctxB.__clock = clock;
  queue.sort((a, b) => a.at - b.at);
  while (queue.length && queue[0].at <= clock) queue.shift().fn();
  if (step % 20 === 0) { padA = [0, 0x800, 0x400, 0x1000][Math.floor(rand() * 4)]; padB = [0, 0x800, 0x400][Math.floor(rand() * 3)]; }
  if (step === 900 && !cheatDone) { cheatDone = true; sB.command({ k: 'cheats', note: 'added a cheat', list: [{ code: '7E000807', enabled: true }] }); }
  if (step === 1100) sA.command({ k: 'cheatsOn', on: false });
  if (step === 1300) { console.log('cheats off -> engine writes:', mA.cheats.ramWrites.length, mB.cheats.ramWrites.length, '| list kept:', mA.cheatList.length, mB.cheatList.length); sB.command({ k: 'cheatsOn', on: true }); }
  if (step === 1450) console.log('cheats back on -> engine writes:', mA.cheats.ramWrites.length, mB.cheats.ramWrites.length);
  if (step === 1500) sA.command({ k: 'rewind', on: true });
  if (step === 1560) sA.command({ k: 'rewind', on: false });
  if (step === 1200 && process.env.CORRUPT) mB.snes.wram[0x1234] ^= 0xFF;
  if (step === 1700) sB.command({ k: 'speed', v: 3 });
  if (step === 1850) sB.command({ k: 'speed', v: 1 });
  if (step === 2000) sB.command({ k: 'pause', on: true });
  if (step === 2060) sB.command({ k: 'pause', on: false });
  for (const s of [sA, sB]) {
    s.maintain();
    s.step();
    if (s.lead() > s.delay + 2) s.step();
  }
}
console.log('ticks', sA.tick, sB.tick, 'emuFrames', mA.emuFrame, mB.emuFrame);
console.log('desyncs', sA.stats.desyncs, sB.stats.desyncs, 'stalls', sA.stats.stalls, sB.stats.stalls);
console.log('score (cheat forces p1 to 7):', mA.snes.wram[8], mB.snes.wram[8], 'p2:', mA.snes.wram[9], mB.snes.wram[9]);
// compare at same tick
const t = Math.min(sA.tick, sB.tick);
while (sA.tick > t || sB.tick > t) break;
console.log('checksums equal at end?', sA.tick === sB.tick ? (mA.checksum() === mB.checksum()) : `(different ticks ${sA.tick} vs ${sB.tick})`);
console.log(toasts.slice(0, 12).join('\n'));
