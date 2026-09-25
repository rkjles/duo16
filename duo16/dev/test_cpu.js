const fs = require('fs'); const path = require('path');
const { assemble } = require('./asm');
const { loadEmu } = require('./harness');
const src = fs.readFileSync(path.join(__dirname, 'cputest.asm'), 'utf8');
const { bytes } = assemble(src, { size: 0x8000 });
const ctx = loadEmu();
const snes = new ctx.SNES();
snes.loadROM(bytes);
for (let i = 0; i < 5; i++) snes.runFrame();
const w = snes.wram;
const R = 0x1000;
const expect = {
  0: 0x12, 1: 0x47, 2: 0x49, 3: 0x34, 4: 0x12, 5: 0x00, 6: 0x80, 7: 0xC0,
  8: 0xAB, 9: 0x11, 10: 0x44, 11: 0x42, 12: 0x43, 13: 0x55, 14: 0x33, 15: 132,
  16: 142, 17: 6, 18: 0x22, 19: 0x44, 20: 0x00, 21: 0x20, 22: 0x99, 23: 0x09,
  24: 0xF0, 25: 0x00, 26: 0x81, 27: 0x03, 28: 0xFF, 29: 0xCF, 30: 0x55, 31: 0x77, 32: 0x00,
  33: 0xEF, 34: 0xBE, 35: 0x11, 36: 0x44, 37: 0x02, 38: 0x00, 39: 0x01, 63: 0xA5,
};
let fails = 0;
for (const [k, v] of Object.entries(expect)) {
  const got = w[R + +k];
  if (got !== v) { fails++; console.log(`FAIL R+${k}: got $${got.toString(16)} expected $${v.toString(16)}`); }
}
console.log('nmi count', w[R + 40], 'PC', snes.cpu.pc.toString(16));
console.log(fails ? `${fails} failures` : 'ALL CPU TESTS PASSED');
