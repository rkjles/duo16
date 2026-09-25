// Builds the built-in "Paddle Duel" demo ROM from tools/demo.asm
const fs = require('fs'); const path = require('path');
const { assemble } = require('./asm');

function rgb15(r, g, b) { return (r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10); }
function words(arr) { const o = []; for (const w of arr) { o.push(w & 0xFF, w >> 8); } return o; }

// 4bpp tile from 8x8 array of color indices
function tile4(px) {
  const out = new Array(32).fill(0);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const c = px[y][x]; const bit = 7 - x;
    if (c & 1) out[y * 2] |= 1 << bit;
    if (c & 2) out[y * 2 + 1] |= 1 << bit;
    if (c & 4) out[16 + y * 2] |= 1 << bit;
    if (c & 8) out[16 + y * 2 + 1] |= 1 << bit;
  }
  return out;
}
const grid = (fn) => Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => fn(x, y)));

// palette: BG palette 0
const palette = words([
  rgb15(16, 20, 44),   // 0 backdrop: deep blue-black
  rgb15(214, 222, 240),// 1 wall
  rgb15(70, 84, 130),  // 2 center line
  rgb15(250, 206, 90), // 3 score digits
]);
const spalette = words([
  0, rgb15(96, 220, 255), rgb15(40, 120, 200), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,    // pal 0: player 1 (cyan)
  0, rgb15(255, 110, 150), rgb15(190, 50, 90), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,   // pal 1: player 2 (pink)
  0, rgb15(255, 255, 255), rgb15(180, 180, 190), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,// pal 2: ball
]);

const FONT = {
  0: ['111', '101', '101', '101', '111'], 1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'], 3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'], 5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'], 7: ['111', '001', '010', '010', '010'],
  8: ['111', '101', '111', '101', '111'], 9: ['111', '101', '111', '001', '111'],
};
let bg = [];
bg.push(...tile4(grid(() => 0)));                       // 0 blank
bg.push(...tile4(grid(() => 1)));                       // 1 wall
bg.push(...tile4(grid((x, y) => (x >= 3 && x <= 4 && y < 5) ? 2 : 0))); // 2 center dash
for (let d = 0; d < 10; d++) {
  // 6x10 digit inside an 8x16 block (two tiles), 1px left pad, 3px top pad
  const big = Array.from({ length: 16 }, () => new Array(8).fill(0));
  for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) {
    if (FONT[d][r][c] === '1') for (let yy = 0; yy < 2; yy++) for (let xx = 0; xx < 2; xx++) big[3 + r * 2 + yy][1 + c * 2 + xx] = 3;
  }
  bg.push(...tile4(big.slice(0, 8)));
  bg.push(...tile4(big.slice(8, 16)));
}
let obj = [];
obj.push(...tile4(grid((x) => (x >= 2 && x <= 5) ? (x === 2 || x === 5 ? 2 : 1) : 0)));  // paddle segment
obj.push(...tile4(grid((x, y) => { const dx = x - 3.5, dy = y - 3.5; const d = dx * dx + dy * dy; return d < 9 ? (d < 5 ? 1 : 2) : 0; })));

// tilemap 32x32
const map = new Array(1024).fill(0);
for (let x = 0; x < 32; x++) { map[1 * 32 + x] = 1; map[26 * 32 + x] = 1; }
for (let y = 2; y < 26; y++) map[y * 32 + 16] = 2;
map[2 * 32 + 12] = 3; map[3 * 32 + 12] = 4; map[2 * 32 + 19] = 3; map[3 * 32 + 19] = 4;
const tilemap = words(map);

// sound driver (SPC700 machine code) at $0200, DIR at $0300, sample at $0400
const spc = new Array(0x20A).fill(0);
const prog = [
  0x8F, 0x6C, 0xF2, 0x8F, 0x20, 0xF3,  // FLG = $20
  0x8F, 0x5D, 0xF2, 0x8F, 0x03, 0xF3,  // DIR = $03
  0x8F, 0x00, 0xF2, 0x8F, 0x50, 0xF3,  // V0 VOL L
  0x8F, 0x01, 0xF2, 0x8F, 0x50, 0xF3,  // V0 VOL R
  0x8F, 0x02, 0xF2, 0x8F, 0x00, 0xF3,  // pitch lo
  0x8F, 0x03, 0xF2, 0x8F, 0x08, 0xF3,  // pitch hi
  0x8F, 0x04, 0xF2, 0x8F, 0x00, 0xF3,  // SRCN 0
  0x8F, 0x05, 0xF2, 0x8F, 0xFF, 0xF3,  // ADSR1
  0x8F, 0x06, 0xF2, 0x8F, 0x3C, 0xF3,  // ADSR2
  0x8F, 0x0C, 0xF2, 0x8F, 0x7F, 0xF3,  // MVOL L
  0x8F, 0x1C, 0xF2, 0x8F, 0x7F, 0xF3,  // MVOL R
  0x8F, 0x2C, 0xF2, 0x8F, 0x00, 0xF3,  // EVOL L
  0x8F, 0x3C, 0xF2, 0x8F, 0x00, 0xF3,  // EVOL R
  0x8F, 0x6D, 0xF2, 0x8F, 0x7F, 0xF3,  // ESA
  0x8F, 0x7D, 0xF2, 0x8F, 0x00, 0xF3,  // EDL
  0x8F, 0x5C, 0xF2, 0x8F, 0x00, 0xF3,  // KOFF
  0xE4, 0xF4, 0xC4, 0x00,              // last = port0
  // loop:
  0xE4, 0xF4, 0x64, 0x00, 0xF0, 0xFA,  // wait for port0 change
  0xC4, 0x00,                          // last = A
  0xE4, 0xF5,                          // A = port1 (pitch)
  0x8F, 0x03, 0xF2, 0xC4, 0xF3,        // V0 pitch hi = A
  0x8F, 0x4C, 0xF2, 0x8F, 0x01, 0xF3,  // KON voice 0
  0x2F, 0x00,                          // bra loop (patched)
];
const loopStart = prog.length - 23;
prog[prog.length - 1] = (loopStart - prog.length) & 0xFF;
for (let i = 0; i < prog.length; i++) spc[i] = prog[i];
spc[0x100] = 0x00; spc[0x101] = 0x04; spc[0x102] = 0x00; spc[0x103] = 0x04; // DIR entry 0
const brr = [0xB3, 0x77, 0x77, 0x77, 0x77, 0x88, 0x88, 0x88, 0x88];
for (let i = 0; i < 9; i++) spc[0x200 + i] = brr[i];

const blobs = { palette, spalette, bgtiles: bg, objtiles: obj, tilemap, spcblob: spc };
const defines = { PAL_LEN: palette.length, SPAL_LEN: spalette.length, BGT_LEN: bg.length, OBJT_LEN: obj.length, SPC_LEN: spc.length };
const src = fs.readFileSync(path.join(__dirname, 'demo.asm'), 'utf8');
const { bytes, syms } = assemble(src, { blobs, defines, size: 0x8000 });
// fix checksum
let sum = 0; for (let i = 0; i < bytes.length; i++) if (i < 0x7FDC || i > 0x7FDF) sum += bytes[i];
sum += 0xFF * 2; sum &= 0xFFFF;
bytes[0x7FDE] = sum & 0xFF; bytes[0x7FDF] = sum >> 8; bytes[0x7FDC] = (~sum) & 0xFF; bytes[0x7FDD] = ((~sum) >> 8) & 0xFF;
module.exports = { buildDemo: () => bytes };
if (require.main === module) {
  const out = process.argv[2] || path.join(__dirname, 'out', 'paddle-duel.sfc');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, bytes);
  console.log('wrote', out, bytes.length, 'bytes; code ends near', (syms.palette || 0).toString(16));
}
