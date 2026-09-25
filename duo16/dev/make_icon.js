// 1024x1024 app icon: pixel-art paddles and ball on a rounded tile
const fs = require('fs'); const path = require('path'); const zlib = require('zlib');
function crc32(buf) { let c, crc = 0xFFFFFFFF; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xFF; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
const N = 32, S = 32, W = N * S;
const px = Array.from({ length: N }, () => new Array(N).fill(null));
const hexc = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];
const BG = hexc('#141821'), EDGE = hexc('#262d3d'), P1 = hexc('#4fd1ff'), P1D = hexc('#2a8fb8'), P2 = hexc('#ff6e96'), P2D = hexc('#c2456a'), BALL = hexc('#ffffff'), LINE = hexc('#323a4e');
// rounded tile inset by 2 px (macOS icon grid leaves margin)
for (let y = 2; y < 30; y++) for (let x = 2; x < 30; x++) {
  const cx = Math.min(x - 2, 29 - x), cy = Math.min(y - 2, 29 - y);
  if (cx + cy < 3 && !(cx >= 2 && cy >= 1) && !(cy >= 2 && cx >= 1)) continue;
  const edge = x === 2 || x === 29 || y === 2 || y === 29 || cx + cy === 3;
  px[y][x] = edge ? EDGE : BG;
}
for (let y = 6; y < 27; y += 3) px[y][15] = LINE, px[y + 1] && (px[y + 1][15] = LINE);
for (let y = 8; y < 17; y++) { px[y][6] = P1; px[y][7] = P1; px[y][8] = P1D; }
for (let y = 15; y < 24; y++) { px[y][23] = P2D; px[y][24] = P2; px[y][25] = P2; }
for (const [x, y] of [[18, 10], [19, 10], [18, 11], [19, 11]]) px[y][x] = BALL;
px[9][17] = hexc('#8fe6ff'); // trail
const raw = Buffer.alloc((W * 4 + 1) * W);
for (let y = 0; y < W; y++) { raw[y * (W * 4 + 1)] = 0; for (let x = 0; x < W; x++) { const c = px[Math.floor(y / S)][Math.floor(x / S)] || [0, 0, 0, 0]; raw.set(c, y * (W * 4 + 1) + 1 + x * 4); } }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
const out = path.join(__dirname, '..', 'app', 'buildres', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, png); console.log('icon', out, png.length);
