// Direct PPU register tests: renders scenes without CPU code and saves PNGs for inspection
const fs = require('fs'); const path = require('path');
const { loadEmu } = require('./harness'); const { encodePNG } = require('./png');
const { buildDemo } = require('./build_demo');
const ctx = loadEmu(); const snes = new ctx.SNES(); snes.loadROM(buildDemo());
const ppu = snes.ppu; const W = (r, v) => ppu.write(r, v);
const rgb = (r, g, b) => (r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10);
const setCG = (i, c) => { ppu.cgram[i] = c; };
function render(name) { for (let y = 1; y <= 224; y++) ppu.renderLine(y); fs.writeFileSync(path.join(__dirname, 'out', name), encodePNG(ppu.frame, 256, 224)); }

// ---- Scene 1: Mode 7 perspective-ish (rotated + scaled checkerboard with a marker tile)
ppu.reset(); W(0x00, 0x0F);
for (let t = 0; t < 128 * 128; t++) { const x = t & 127, y = t >> 7; ppu.vram[t] = (ppu.vram[t] & 0xFF00) | (((x ^ y) & 1) + (x === 64 && y === 64 ? 2 : 0) + 1); }
for (let tile = 1; tile <= 3; tile++) for (let p = 0; p < 64; p++) { const a = tile * 64 + p; const px = p & 7, py = p >> 3; const edge = px === 0 || py === 0; ppu.vram[a] = (ppu.vram[a] & 0xFF) | ((edge ? 4 : tile) << 8); }
setCG(0, rgb(10, 10, 30)); setCG(1, rgb(60, 160, 90)); setCG(2, rgb(40, 110, 60)); setCG(3, rgb(250, 200, 60)); setCG(4, rgb(20, 60, 30));
W(0x05, 7); W(0x2C, 0x01);
const ang = 0.5, sc = 0.5; const a = Math.round(Math.cos(ang) * 256 * sc), b = Math.round(Math.sin(ang) * 256 * sc);
const w16 = (r, v) => { W(r, v & 0xFF); W(r, (v >> 8) & 0xFF); };
w16(0x1B, a); w16(0x1C, b); w16(0x1D, -b & 0xFFFF); w16(0x1E, a); w16(0x1F, 512); w16(0x20, 512); w16(0x0D, 512 - 128); w16(0x0E, 512 - 112);
render('ppu-mode7.png');

// ---- Scene 2: Mode 1, BG1 16x16 tiles + BG2 with color math add (half) + window cutting BG1 + sprites of two sizes
ppu.reset(); W(0x00, 0x0F);
const tile4 = (base, idx, fn) => { for (let y = 0; y < 8; y++) { let p0 = 0, p1 = 0, p2 = 0, p3 = 0; for (let x = 0; x < 8; x++) { const c = fn(x, y); const bit = 7 - x; p0 |= (c & 1) << bit; p1 |= ((c >> 1) & 1) << bit; p2 |= ((c >> 2) & 1) << bit; p3 |= ((c >> 3) & 1) << bit; } ppu.vram[base + idx * 16 + y] = p0 | (p1 << 8); ppu.vram[base + idx * 16 + 8 + y] = p2 | (p3 << 8); } };
// BG1 chars at $1000: tiles 0..17 make a 16x16 "diamond" using tiles 1,2,17,18
tile4(0x1000, 0, () => 0);
for (const [t, ox, oy] of [[1, 0, 0], [2, 8, 0], [17, 0, 8], [18, 8, 8]]) tile4(0x1000, t, (x, y) => { const dx = Math.abs(x + ox - 7.5), dy = Math.abs(y + oy - 7.5); return dx + dy < 7 ? 1 + ((x + ox + y + oy) >> 3 & 1) : 0; });
for (let i = 0; i < 32 * 32; i++) ppu.vram[i] = (i & 1) === 0 && ((i >> 5) & 1) === 0 ? 1 : 0; // tilemap @0
// BG2 chars at $2000: solid tile 1 color 1 palette 1; tilemap @ $0800 : vertical stripes
tile4(0x2000, 0, () => 0); tile4(0x2000, 1, () => 1);
for (let i = 0; i < 1024; i++) ppu.vram[0x800 + i] = ((i & 31) % 6 < 3) ? (1 | (1 << 10)) : 0;
setCG(0, rgb(20, 20, 40)); setCG(1, rgb(230, 80, 80)); setCG(2, rgb(250, 160, 60)); setCG(17, rgb(40, 90, 240));
// sprites: palette 4 (math-eligible) at CG 192, chars at $4000
tile4(0x4000, 0, (x, y) => ((x - 3.5) ** 2 + (y - 3.5) ** 2 < 12) ? 1 : 0);
for (let t of [1, 16, 17]) tile4(0x4000, t, (x, y) => 2);
setCG(193, rgb(255, 255, 255)); setCG(194, rgb(120, 255, 180));
W(0x01, 0x02 | (0 << 5)); // obj base $4000 (2<<13), sizes 8/16
for (let n = 0; n < 128; n++) { ppu.oam[n * 4 + 1] = 240; }
ppu.oam[0] = 40; ppu.oam[1] = 60; ppu.oam[2] = 0; ppu.oam[3] = 0x38; // small, pal 4, prio 3
ppu.oam[4] = 200; ppu.oam[5] = 150; ppu.oam[6] = 0; ppu.oam[7] = 0x38; ppu.oam[512] = 0x08; // sprite 1 large (16x16)
W(0x05, 0x01 | 0x10); // mode 1, BG1 16x16 tiles
W(0x07, 0x00); W(0x08, 0x08); W(0x0B, 0x21);
W(0x2C, 0x13); W(0x2D, 0x02); // main: BG1 BG2 OBJ, sub: BG2
W(0x30, 0x02); W(0x31, 0x41 | 0x10); // add subscreen, half, on BG1 + OBJ
// window 1 x=96..160 masks BG1 on main
W(0x26, 96); W(0x27, 160); W(0x23, 0x02); W(0x2E, 0x01);
render('ppu-mode1.png');
console.log('rendered');
