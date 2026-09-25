const fs = require('fs'); const path = require('path');
const { buildDemo } = require('./build_demo');
const { loadEmu } = require('./harness');
const { encodePNG } = require('./png');
const ctx = loadEmu();
const snes = new ctx.SNES();
snes.loadROM(buildDemo());
const frames = +(process.argv[2] || 120);
let audio = 0, peak = 0;
const t0 = Date.now();
for (let i = 0; i < frames; i++) {
  snes.pads[0] = (i > 70 && i < 100) ? 0x0800 : 0; // P1 up
  snes.pads[1] = (i > 70 && i < 110) ? 0x0400 : 0; // P2 down
  snes.runFrame();
  const a = snes.apu.takeAudio(); audio += a.length / 2; for (const s of a) peak = Math.max(peak, Math.abs(s));
}
console.log('ms/frame', ((Date.now() - t0) / frames).toFixed(2), 'audio samples', audio, 'peak', peak);
console.log('cpu pc', snes.cpu.pc.toString(16), 'spc pc', snes.apu.pc.toString(16), 'ports out', [...snes.apu.portOut]);
const w = snes.wram;
console.log('p1y', w[2], 'p2y', w[3], 'bx', w[4], 'by', w[5], 'score', w[8], w[9]);
fs.writeFileSync(path.join(__dirname, 'out', 'demo.png'), encodePNG(snes.ppu.frame, 256, 224));
