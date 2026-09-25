// ===== PPU (picture processing) =====
// z-priority tables per mode: [bg1L, bg1H, bg2L, bg2H, bg3L, bg3H, bg4L, bg4H, obj0, obj1, obj2, obj3]
const PRIO_TABLES = {
  0: [8, 11, 7, 10, 2, 5, 1, 4, 3, 6, 9, 12],
  1: [6, 9, 5, 8, 1, 3, 0, 0, 2, 4, 7, 10],
  '1b': [5, 8, 4, 7, 1, 10, 0, 0, 2, 3, 6, 9],
  2: [3, 7, 1, 5, 0, 0, 0, 0, 2, 4, 6, 8],
  7: [3, 3, 1, 5, 0, 0, 0, 0, 2, 4, 6, 7],
};
const MODE_BPP = [
  [2, 2, 2, 2], [4, 4, 2, 0], [4, 4, 0, 0], [8, 4, 0, 0],
  [8, 2, 0, 0], [4, 2, 0, 0], [4, 0, 0, 0], [8, 0, 0, 0],
];
const OBJ_SIZES = [
  [[8, 8], [16, 16]], [[8, 8], [32, 32]], [[8, 8], [64, 64]], [[16, 16], [32, 32]],
  [[16, 16], [64, 64]], [[32, 32], [64, 64]], [[16, 32], [32, 64]], [[16, 32], [32, 32]],
];

class PPU {
  constructor(snes) {
    this.snes = snes;
    this.vram = new Uint16Array(0x8000);
    this.cgram = new Uint16Array(256);
    this.oam = new Uint8Array(544);
    this.frame = new Uint32Array(256 * 240);
    this.frameHeight = 224;
    // scratch line buffers
    this.bgCol = [new Int32Array(256), new Int32Array(256), new Int32Array(256), new Int32Array(256)];
    this.bgPri = [new Uint8Array(256), new Uint8Array(256), new Uint8Array(256), new Uint8Array(256)];
    this.hiCol = [new Int32Array(512), new Int32Array(512)];
    this.hiPri = [new Uint8Array(512), new Uint8Array(512)];
    this.objCol = new Int32Array(256); this.objPri = new Uint8Array(256); this.objMath = new Uint8Array(256);
    this.mainCol = new Int32Array(256); this.mainZ = new Int8Array(256); this.mainLayer = new Uint8Array(256);
    this.subCol = new Int32Array(256); this.subZ = new Int8Array(256); this.subLayer = new Uint8Array(256);
    this.winTmp = new Uint8Array(256);
    this.winMasks = [new Uint8Array(256), new Uint8Array(256), new Uint8Array(256), new Uint8Array(256), new Uint8Array(256), new Uint8Array(256)];
    this.rowBuf = new Uint8Array(8);
    // 5-bit channel -> 8-bit with brightness
    this.bright = [];
    for (let b = 0; b < 16; b++) {
      const t = new Uint8Array(32);
      for (let c = 0; c < 32; c++) t[c] = Math.round(((c << 3) | (c >> 2)) * (b + 1) / 16);
      this.bright.push(t);
    }
    this.reset();
  }

  reset() {
    this.vram.fill(0); this.cgram.fill(0); this.oam.fill(0);
    this.inidisp = 0x80; this.forcedBlank = 1; this.brightness = 0;
    this.obsel = 0; this.oamaddr = 0; this.oamReload = 0; this.oamPriority = 0; this.oamLatch = 0;
    this.bgmode = 0; this.mosaic = 0; this.mosaicStart = 1;
    this.bgsc = [0, 0, 0, 0]; this.bgnba = [0, 0, 0, 0];
    this.hofs = [0, 0, 0, 0]; this.vofs = [0, 0, 0, 0];
    this.ofsLatch1 = 0; this.ofsLatch2 = 0; this.m7latch = 0;
    this.vmain = 0x80; this.vmaddr = 0; this.vmbuf = 0;
    this.m7sel = 0; this.m7a = 0; this.m7b = 0; this.m7c = 0; this.m7d = 0; this.m7x = 0; this.m7y = 0; this.m7hofs = 0; this.m7vofs = 0;
    this.cgaddr = 0; this.cgLatch = 0; this.cgFlip = 0;
    this.w12sel = 0; this.w34sel = 0; this.wobjsel = 0; this.wh0 = 0; this.wh1 = 0; this.wh2 = 0; this.wh3 = 0;
    this.wbglog = 0; this.wobjlog = 0; this.tm = 0; this.ts = 0; this.tmw = 0; this.tsw = 0;
    this.cgwsel = 0; this.cgadsub = 0; this.fixedColor = 0; this.setini = 0; this.overscan = 0;
    this.hlatch = 0; this.vlatch = 0; this.hFlip = 0; this.vFlip = 0; this.counterLatched = 0;
    this.rangeOver = 0; this.timeOver = 0; this.field = 0;
    this.ppu1mdr = 0; this.ppu2mdr = 0;
    this.frame.fill(0xFF000000);
  }

  // ---------- registers ----------
  vramStep() { const s = this.vmain & 3; return s === 0 ? 1 : s === 1 ? 32 : 128; }
  vramRemap(a) {
    switch ((this.vmain >> 2) & 3) {
      case 0: return a & 0x7FFF;
      case 1: return ((a & 0xFF00) | ((a & 0x1F) << 3) | ((a >> 5) & 7)) & 0x7FFF;
      case 2: return ((a & 0xFE00) | ((a & 0x3F) << 3) | ((a >> 6) & 7)) & 0x7FFF;
      default: return ((a & 0xFC00) | ((a & 0x7F) << 3) | ((a >> 7) & 7)) & 0x7FFF;
    }
  }

  write(r, v) {
    switch (r) {
      case 0x00:
        if (this.forcedBlank && !(v & 0x80) && this.snes.vc === (this.overscan ? 240 : 225)) this.oamaddr = this.oamReload;
        this.inidisp = v; this.forcedBlank = (v >> 7) & 1; this.brightness = v & 0xF; break;
      case 0x01: this.obsel = v; break;
      case 0x02: this.oamReload = (this.oamReload & 0x200) | (v << 1); this.oamaddr = this.oamReload; break;
      case 0x03: this.oamReload = (this.oamReload & 0x1FE) | ((v & 1) << 9); this.oamPriority = v >> 7; this.oamaddr = this.oamReload; break;
      case 0x04: {
        const a = this.oamaddr;
        if (a >= 0x200) this.oam[0x200 | (a & 0x1F)] = v;
        else if (!(a & 1)) this.oamLatch = v;
        else { this.oam[a - 1] = this.oamLatch; this.oam[a] = v; }
        this.oamaddr = (a + 1) & 0x3FF;
        break;
      }
      case 0x05: this.bgmode = v; break;
      case 0x06: this.mosaic = v; this.mosaicStart = this.snes.vc; break;
      case 0x07: case 0x08: case 0x09: case 0x0A: this.bgsc[r - 7] = v; break;
      case 0x0B: this.bgnba[0] = v & 0xF; this.bgnba[1] = v >> 4; break;
      case 0x0C: this.bgnba[2] = v & 0xF; this.bgnba[3] = v >> 4; break;
      case 0x0D: case 0x0F: case 0x11: case 0x13: {
        const n = (r - 0x0D) >> 1;
        if (n === 0) { this.m7hofs = ((v << 8) | this.m7latch) & 0x1FFF; this.m7latch = v; }
        this.hofs[n] = ((v << 8) | (this.ofsLatch1 & ~7) | (this.ofsLatch2 & 7)) & 0x3FF;
        this.ofsLatch1 = v; this.ofsLatch2 = v;
        break;
      }
      case 0x0E: case 0x10: case 0x12: case 0x14: {
        const n = (r - 0x0E) >> 1;
        if (n === 0) { this.m7vofs = ((v << 8) | this.m7latch) & 0x1FFF; this.m7latch = v; }
        this.vofs[n] = ((v << 8) | this.ofsLatch1) & 0x3FF;
        this.ofsLatch1 = v;
        break;
      }
      case 0x15: this.vmain = v; break;
      case 0x16: this.vmaddr = (this.vmaddr & 0xFF00) | v; this.vmbuf = this.vram[this.vramRemap(this.vmaddr)]; break;
      case 0x17: this.vmaddr = (this.vmaddr & 0x00FF) | (v << 8); this.vmbuf = this.vram[this.vramRemap(this.vmaddr)]; break;
      case 0x18: {
        const a = this.vramRemap(this.vmaddr);
        this.vram[a] = (this.vram[a] & 0xFF00) | v;
        if (!(this.vmain & 0x80)) this.vmaddr = (this.vmaddr + this.vramStep()) & 0xFFFF;
        break;
      }
      case 0x19: {
        const a = this.vramRemap(this.vmaddr);
        this.vram[a] = (this.vram[a] & 0x00FF) | (v << 8);
        if (this.vmain & 0x80) this.vmaddr = (this.vmaddr + this.vramStep()) & 0xFFFF;
        break;
      }
      case 0x1A: this.m7sel = v; break;
      case 0x1B: this.m7a = ((v << 8) | this.m7latch); this.m7latch = v; break;
      case 0x1C: this.m7b = ((v << 8) | this.m7latch); this.m7latch = v; break;
      case 0x1D: this.m7c = ((v << 8) | this.m7latch); this.m7latch = v; break;
      case 0x1E: this.m7d = ((v << 8) | this.m7latch); this.m7latch = v; break;
      case 0x1F: this.m7x = ((v << 8) | this.m7latch) & 0x1FFF; this.m7latch = v; break;
      case 0x20: this.m7y = ((v << 8) | this.m7latch) & 0x1FFF; this.m7latch = v; break;
      case 0x21: this.cgaddr = v; this.cgFlip = 0; break;
      case 0x22:
        if (!this.cgFlip) this.cgLatch = v;
        else { this.cgram[this.cgaddr] = ((v & 0x7F) << 8) | this.cgLatch; this.cgaddr = (this.cgaddr + 1) & 0xFF; }
        this.cgFlip ^= 1; break;
      case 0x23: this.w12sel = v; break;
      case 0x24: this.w34sel = v; break;
      case 0x25: this.wobjsel = v; break;
      case 0x26: this.wh0 = v; break;
      case 0x27: this.wh1 = v; break;
      case 0x28: this.wh2 = v; break;
      case 0x29: this.wh3 = v; break;
      case 0x2A: this.wbglog = v; break;
      case 0x2B: this.wobjlog = v; break;
      case 0x2C: this.tm = v; break;
      case 0x2D: this.ts = v; break;
      case 0x2E: this.tmw = v; break;
      case 0x2F: this.tsw = v; break;
      case 0x30: this.cgwsel = v; break;
      case 0x31: this.cgadsub = v; break;
      case 0x32: {
        const val = v & 0x1F;
        if (v & 0x20) this.fixedColor = (this.fixedColor & ~0x001F) | val;
        if (v & 0x40) this.fixedColor = (this.fixedColor & ~0x03E0) | (val << 5);
        if (v & 0x80) this.fixedColor = (this.fixedColor & ~0x7C00) | (val << 10);
        break;
      }
      case 0x33: this.setini = v; this.overscan = (v >> 2) & 1; break;
    }
  }

  read(r, mdr) {
    switch (r) {
      case 0x34: { const p = ((this.m7a << 16) >> 16) * ((this.m7b << 16) >> 24); return (this.ppu1mdr = p & 0xFF); }
      case 0x35: { const p = ((this.m7a << 16) >> 16) * ((this.m7b << 16) >> 24); return (this.ppu1mdr = (p >> 8) & 0xFF); }
      case 0x36: { const p = ((this.m7a << 16) >> 16) * ((this.m7b << 16) >> 24); return (this.ppu1mdr = (p >> 16) & 0xFF); }
      case 0x37: if (this.snes.wrio & 0x80) this.latchCounters(this.snes.hc, this.snes.vc); return mdr;
      case 0x38: {
        const a = this.oamaddr; let v;
        if (a >= 0x200) v = this.oam[0x200 | (a & 0x1F)]; else v = this.oam[a];
        this.oamaddr = (a + 1) & 0x3FF;
        return (this.ppu1mdr = v);
      }
      case 0x39: {
        const v = this.vmbuf & 0xFF;
        if (!(this.vmain & 0x80)) { this.vmbuf = this.vram[this.vramRemap(this.vmaddr)]; this.vmaddr = (this.vmaddr + this.vramStep()) & 0xFFFF; }
        return (this.ppu1mdr = v);
      }
      case 0x3A: {
        const v = this.vmbuf >> 8;
        if (this.vmain & 0x80) { this.vmbuf = this.vram[this.vramRemap(this.vmaddr)]; this.vmaddr = (this.vmaddr + this.vramStep()) & 0xFFFF; }
        return (this.ppu1mdr = v);
      }
      case 0x3B: {
        let v;
        if (!this.cgFlip) v = this.cgram[this.cgaddr] & 0xFF;
        else { v = (this.cgram[this.cgaddr] >> 8) | (this.ppu2mdr & 0x80); this.cgaddr = (this.cgaddr + 1) & 0xFF; }
        this.cgFlip ^= 1;
        return (this.ppu2mdr = v);
      }
      case 0x3C: {
        let v = this.hFlip ? ((this.hlatch >> 8) & 1) | (this.ppu2mdr & 0xFE) : this.hlatch & 0xFF;
        this.hFlip ^= 1; return (this.ppu2mdr = v);
      }
      case 0x3D: {
        let v = this.vFlip ? ((this.vlatch >> 8) & 1) | (this.ppu2mdr & 0xFE) : this.vlatch & 0xFF;
        this.vFlip ^= 1; return (this.ppu2mdr = v);
      }
      case 0x3E: return (this.ppu1mdr = (this.timeOver << 7) | (this.rangeOver << 6) | (this.ppu1mdr & 0x10) | 0x01);
      case 0x3F: {
        const v = (this.field << 7) | (this.counterLatched << 6) | (this.ppu2mdr & 0x20) | (this.snes.cart && this.snes.cart.pal ? 0x10 : 0) | 0x03;
        this.hFlip = 0; this.vFlip = 0;
        if (this.snes.wrio & 0x80) this.counterLatched = 0;
        return (this.ppu2mdr = v);
      }
      case 0x04: case 0x05: case 0x06: case 0x08: case 0x09: case 0x0A: case 0x14: case 0x15: case 0x16:
      case 0x18: case 0x19: case 0x1A: case 0x24: case 0x25: case 0x26: case 0x28: case 0x29: case 0x2A:
        return this.ppu1mdr;
    }
    return mdr;
  }

  latchCounters(hc, vc) { this.hlatch = (hc >> 2) & 0x1FF; this.vlatch = vc & 0x1FF; this.counterLatched = 1; }

  startVblank() {
    if (!this.forcedBlank) this.oamaddr = this.oamReload;
    this.frameHeight = this.overscan ? 239 : 224;
  }
  startFrame() {
    this.rangeOver = 0; this.timeOver = 0;
    this.field ^= 1;
    this.mosaicStart = 1;
  }

  // ---------- windows ----------
  // bits: 4-bit nibble (bit0 w1 invert, bit1 w1 enable, bit2 w2 invert, bit3 w2 enable), logic 0..3
  computeWindow(bits, logic, out) {
    const e1 = bits & 2, e2 = bits & 8;
    if (!e1 && !e2) { out.fill(0); return false; }
    const i1 = bits & 1 ? 1 : 0, i2 = bits & 4 ? 1 : 0;
    const l1 = this.wh0, r1 = this.wh1, l2 = this.wh2, r2 = this.wh3;
    for (let x = 0; x < 256; x++) {
      const w1 = ((x >= l1 && x <= r1) ? 1 : 0) ^ i1;
      const w2 = ((x >= l2 && x <= r2) ? 1 : 0) ^ i2;
      let m;
      if (e1 && !e2) m = w1;
      else if (!e1 && e2) m = w2;
      else switch (logic) {
        case 0: m = w1 | w2; break;
        case 1: m = w1 & w2; break;
        case 2: m = w1 ^ w2; break;
        default: m = (w1 ^ w2) ^ 1; break;
      }
      out[x] = m;
    }
    return true;
  }

  // ---------- rendering ----------
  renderLine(line) {
    const row = line - 1;
    if (row < 0 || row >= 239) return;
    const fb = this.frame; const base = row * 256;
    if (this.forcedBlank) { for (let x = 0; x < 256; x++) fb[base + x] = 0xFF000000; return; }
    const mode = this.bgmode & 7;
    const hires = mode === 5 || mode === 6;
    const layersOn = this.tm | this.ts;
    let prio;
    if (mode === 0) prio = PRIO_TABLES[0];
    else if (mode === 1) prio = (this.bgmode & 8) ? PRIO_TABLES['1b'] : PRIO_TABLES[1];
    else if (mode === 7) prio = PRIO_TABLES[7];
    else prio = PRIO_TABLES[2];

    const nLayers = mode === 7 ? ((this.setini & 0x40) ? 2 : 1) : 4;
    const active = [false, false, false, false];
    for (let l = 0; l < nLayers; l++) {
      if (!(layersOn & (1 << l))) continue;
      if (mode === 7) { this.renderMode7(line, l); active[l] = true; continue; }
      const bpp = MODE_BPP[mode][l];
      if (!bpp) continue;
      if (hires) this.renderBGHires(line, l, bpp);
      else this.renderBG(line, l, bpp, mode);
      active[l] = true;
    }
    const objOn = !!(layersOn & 0x10);
    if (objOn) this.renderSprites(line);

    // windows
    const wm = this.winMasks;
    const wsel = [this.w12sel & 0xF, this.w12sel >> 4, this.w34sel & 0xF, this.w34sel >> 4, this.wobjsel & 0xF, this.wobjsel >> 4];
    const wlog = [this.wbglog & 3, (this.wbglog >> 2) & 3, (this.wbglog >> 4) & 3, (this.wbglog >> 6) & 3, this.wobjlog & 3, (this.wobjlog >> 2) & 3];
    const wHas = [false, false, false, false, false, false];
    for (let i = 0; i < 6; i++) wHas[i] = this.computeWindow(wsel[i], wlog[i], wm[i]);

    // compose main and sub screens
    this.compose(this.mainCol, this.mainZ, this.mainLayer, this.tm, this.tmw, active, objOn, prio, wHas, mode, false);
    this.compose(this.subCol, this.subZ, this.subLayer, this.ts, this.tsw, active, objOn, prio, wHas, mode, true);

    // color math
    const colorWin = wm[5]; const colorWinOn = wHas[5];
    const clipMode = (this.cgwsel >> 6) & 3, preventMode = (this.cgwsel >> 4) & 3;
    const useSub = this.cgwsel & 2;
    const sub = this.cgadsub & 0x80, half = this.cgadsub & 0x40;
    const br = this.bright[this.brightness];
    const fixed = this.fixedColor;
    const mc = this.mainCol, ml = this.mainLayer, sc = this.subCol, sl = this.subLayer;
    for (let x = 0; x < 256; x++) {
      const inWin = colorWinOn ? colorWin[x] : 0;
      let c = mc[x];
      let clipped = false;
      if (clipMode === 3 || (clipMode === 1 && !inWin) || (clipMode === 2 && inWin)) { c = 0; clipped = true; }
      const prevent = preventMode === 3 || (preventMode === 1 && !inWin) || (preventMode === 2 && inWin);
      const layer = ml[x];
      let mathOn = 0;
      if (!prevent) {
        if (layer < 4) mathOn = this.cgadsub & (1 << layer);
        else if (layer === 6) mathOn = this.cgadsub & 0x10;
        else if (layer === 5) mathOn = this.cgadsub & 0x20;
      }
      if (mathOn) {
        let o, halve = half && !clipped;
        if (useSub) { if (sl[x] === 5) { o = fixed; halve = false; } else o = sc[x]; }
        else o = fixed;
        let r = c & 31, g = (c >> 5) & 31, b = (c >> 10) & 31;
        const or = o & 31, og = (o >> 5) & 31, ob = (o >> 10) & 31;
        if (sub) {
          r -= or; g -= og; b -= ob;
          if (r < 0) r = 0; if (g < 0) g = 0; if (b < 0) b = 0;
          if (halve) { r >>= 1; g >>= 1; b >>= 1; }
        } else {
          r += or; g += og; b += ob;
          if (halve) { r >>= 1; g >>= 1; b >>= 1; }
          if (r > 31) r = 31; if (g > 31) g = 31; if (b > 31) b = 31;
        }
        c = r | (g << 5) | (b << 10);
      }
      fb[base + x] = 0xFF000000 | (br[(c >> 10) & 31] << 16) | (br[(c >> 5) & 31] << 8) | br[c & 31];
    }
  }

  compose(col, zb, lay, enable, winEnable, active, objOn, prio, wHas, mode, isSub) {
    const back = isSub ? this.fixedColor : this.cgram[0];
    col.fill(back); zb.fill(-1); lay.fill(5);
    const wm = this.winMasks;
    for (let l = 0; l < 4; l++) {
      if (!active[l] || !(enable & (1 << l))) continue;
      const zl = prio[l * 2], zh = prio[l * 2 + 1];
      const bc = this.bgCol[l], bp = this.bgPri[l];
      const useWin = (winEnable & (1 << l)) && wHas[l];
      const w = wm[l];
      for (let x = 0; x < 256; x++) {
        const c = bc[x];
        if (c < 0) continue;
        if (useWin && w[x]) continue;
        const z = bp[x] ? zh : zl;
        if (z > zb[x]) { zb[x] = z; col[x] = c; lay[x] = l; }
      }
    }
    if (objOn && (enable & 0x10)) {
      const useWin = (winEnable & 0x10) && wHas[4];
      const w = wm[4];
      const oc = this.objCol, op = this.objPri, om = this.objMath;
      for (let x = 0; x < 256; x++) {
        const c = oc[x];
        if (c < 0) continue;
        if (useWin && w[x]) continue;
        const z = prio[8 + op[x]];
        if (z > zb[x]) { zb[x] = z; col[x] = c; lay[x] = om[x] ? 6 : 4; }
      }
    }
  }

  decodeRow(addr, bpp, out, hflip) {
    const v = this.vram;
    const w0 = v[addr & 0x7FFF];
    let p0 = w0 & 0xFF, p1 = w0 >> 8, p2 = 0, p3 = 0, p4 = 0, p5 = 0, p6 = 0, p7 = 0;
    if (bpp >= 4) { const w1 = v[(addr + 8) & 0x7FFF]; p2 = w1 & 0xFF; p3 = w1 >> 8; }
    if (bpp === 8) {
      const w2 = v[(addr + 16) & 0x7FFF], w3 = v[(addr + 24) & 0x7FFF];
      p4 = w2 & 0xFF; p5 = w2 >> 8; p6 = w3 & 0xFF; p7 = w3 >> 8;
    }
    for (let i = 0; i < 8; i++) {
      const bit = hflip ? i : 7 - i;
      out[i] = ((p0 >> bit) & 1) | (((p1 >> bit) & 1) << 1) | (((p2 >> bit) & 1) << 2) | (((p3 >> bit) & 1) << 3) |
        (((p4 >> bit) & 1) << 4) | (((p5 >> bit) & 1) << 5) | (((p6 >> bit) & 1) << 6) | (((p7 >> bit) & 1) << 7);
    }
  }

  directColor(c, pal) {
    const r = ((c & 7) << 2) | ((pal & 1) << 1);
    const g = (((c >> 3) & 7) << 2) | (pal & 2);
    const b = (((c >> 6) & 3) << 3) | (pal & 4);
    return r | (g << 5) | (b << 10);
  }

  mapEntry(layer, tx, ty) {
    const sc = this.bgsc[layer];
    const base = (sc & 0xFC) << 8;
    let a = base + ((ty & 31) << 5) + (tx & 31);
    if ((sc & 1) && (tx & 32)) a += 0x400;
    if ((sc & 2) && (ty & 32)) a += (sc & 1) ? 0x800 : 0x400;
    return this.vram[a & 0x7FFF];
  }

  renderBG(line, l, bpp, mode) {
    const out = this.bgCol[l], pri = this.bgPri[l];
    const big = (this.bgmode >> (4 + l)) & 1;
    const tsize = big ? 16 : 8, tshift = big ? 4 : 3;
    const chrBase = this.bgnba[l] << 12;
    const tileWords = bpp * 4;
    const mosaicOn = (this.mosaic >> l) & 1;
    const msize = mosaicOn ? (this.mosaic >> 4) + 1 : 1;
    let y = line;
    if (msize > 1) y = line - ((line - this.mosaicStart) % msize + msize) % msize;
    const palBase = mode === 0 ? l * 32 : 0;
    const direct = bpp === 8 && (this.cgwsel & 1);
    const opt = (mode === 2 || mode === 4 || mode === 6) && l < 2;
    const cg = this.cgram;
    const row = this.rowBuf;
    let lastKey = -1, entry = 0, pal = 0, prio = 0;
    const hofs0 = this.hofs[l], vofs0 = this.vofs[l];
    for (let x = 0; x < 256; x++) {
      let hofs = hofs0, vofs = vofs0;
      if (opt) {
        const col = (x + (hofs0 & 7)) >> 3;
        if (col > 0) {
          const h3 = this.hofs[2], v3 = this.vofs[2];
          const tx = ((col - 1) * 8 + (h3 & ~7)) >> 3;
          const ty = v3 >> 3;
          const bit = 0x2000 << l;
          if (mode === 4) {
            const e = this.mapEntry(2, tx, ty);
            if (e & bit) { if (e & 0x8000) vofs = e & 0x3FF; else hofs = (hofs0 & 7) | (e & 0x3F8); }
          } else {
            const eh = this.mapEntry(2, tx, ty), ev = this.mapEntry(2, tx, ty + 1);
            if (eh & bit) hofs = (hofs0 & 7) | (eh & 0x3F8);
            if (ev & bit) vofs = ev & 0x3FF;
          }
        }
      }
      let sx = x;
      if (msize > 1) sx = x - (x % msize);
      const vx = (sx + hofs) & 0xFFFF, vy = (y + vofs) & 0xFFFF;
      const tx = (vx >> tshift) & 63, ty = (vy >> tshift) & 63;
      let px = vx & (tsize - 1), py = vy & (tsize - 1);
      const key = (tx << 16) | (ty << 8) | ((px >> 3) << 5) | py;
      if (key !== lastKey || opt) {
        lastKey = key;
        entry = this.mapEntry(l, tx, ty);
        let tile = entry & 0x3FF;
        pal = (entry >> 10) & 7; prio = (entry >> 13) & 1;
        const hf = (entry >> 14) & 1, vf = (entry >> 15) & 1;
        let tpx = hf ? (tsize - 1 - px) : px;
        let tpy = vf ? (tsize - 1 - py) : py;
        if (big) { tile += (tpx >> 3) + ((tpy >> 3) << 4); }
        const addr = chrBase + ((tile & 0x3FF) * tileWords) + (tpy & 7);
        // decode full 8 pixel row, index by (tpx & 7)
        this.decodeRow(addr, bpp, row, hf);
        // row[] is in screen order for the 8 px sliver; figure the sub-tile sliver order
      }
      // position within 8px sliver in screen order
      const i = px & 7;
      const c = row[i];
      if (c === 0) { out[x] = -1; continue; }
      let color;
      if (direct) color = this.directColor(c, pal);
      else if (bpp === 2) color = cg[(palBase + pal * 4 + c) & 0xFF];
      else if (bpp === 4) color = cg[(pal * 16 + c) & 0xFF];
      else color = cg[c];
      out[x] = color; pri[x] = prio;
    }
  }

  renderBGHires(line, l, bpp) {
    // Mode 5/6: 512-wide, tiles are 16 pixels wide. Main screen gets odd, sub gets even pixels;
    // we render 512 px and fold into 256 by taking odd (main) pixels, with even stored for blending.
    const out = this.bgCol[l], pri = this.bgPri[l];
    const big = (this.bgmode >> (4 + l)) & 1;
    const th = big ? 16 : 8;
    const chrBase = this.bgnba[l] << 12;
    const tileWords = bpp * 4;
    const cg = this.cgram; const row = this.rowBuf;
    const hofs = this.hofs[l], vofs = this.vofs[l];
    const mode = this.bgmode & 7;
    for (let x = 0; x < 256; x++) {
      const hx = x * 2 + 1;
      const vx = (hx + hofs * 2) & 0xFFFF, vy = (line + vofs) & 0xFFFF;
      const tx = (vx >> 4) & 63, ty = (vy >> (big ? 4 : 3)) & 63;
      const px = vx & 15, py = vy & (th - 1);
      const entry = this.mapEntry(l, tx, ty);
      let tile = entry & 0x3FF;
      const pal = (entry >> 10) & 7, prio = (entry >> 13) & 1, hf = (entry >> 14) & 1, vf = (entry >> 15) & 1;
      const tpx = hf ? 15 - px : px, tpy = vf ? th - 1 - py : py;
      tile += (tpx >> 3) + ((tpy >> 3) << 4);
      this.decodeRow(chrBase + (tile & 0x3FF) * tileWords + (tpy & 7), bpp, row, 0);
      const c = row[tpx & 7];
      if (c === 0) { out[x] = -1; continue; }
      out[x] = bpp === 2 ? cg[pal * 4 + c] : cg[(pal * 16 + c) & 0xFF];
      pri[x] = prio;
    }
    void mode;
  }

  renderMode7(line, l) {
    const out = this.bgCol[l], pri = this.bgPri[l];
    const sext13 = (v) => (v << 19) >> 19;
    const a = (this.m7a << 16) >> 16, b = (this.m7b << 16) >> 16, c = (this.m7c << 16) >> 16, d = (this.m7d << 16) >> 16;
    const cx = sext13(this.m7x), cy = sext13(this.m7y);
    const hofs = sext13(this.m7hofs), vofs = sext13(this.m7vofs);
    const flipY = this.m7sel & 2, flipX = this.m7sel & 1;
    const over = (this.m7sel >> 6) & 3;
    const mosaicOn = (this.mosaic >> l) & 1 || ((this.mosaic & 1) && l === 1);
    const msize = mosaicOn ? (this.mosaic >> 4) + 1 : 1;
    let y = line;
    if (msize > 1) y = line - ((line - this.mosaicStart) % msize + msize) % msize;
    const sy = flipY ? 255 - y : y;
    const clip = (v) => (v & 0x2000) ? (v | ~0x3FF) : (v & 0x3FF);
    const hx = clip(hofs - cx), vy = clip(vofs - cy);
    const baseX = ((a * hx) & ~63) + ((b * sy) & ~63) + ((b * vy) & ~63) + (cx << 8);
    const baseY = ((c * hx) & ~63) + ((d * sy) & ~63) + ((d * vy) & ~63) + (cy << 8);
    const vram = this.vram, cg = this.cgram;
    const direct = this.cgwsel & 1;
    const ext = l === 1;
    for (let x = 0; x < 256; x++) {
      let sx = x;
      if (msize > 1) sx = x - (x % msize);
      if (flipX) sx = 255 - sx;
      let px = (baseX + a * sx) >> 8, py = (baseY + c * sx) >> 8;
      let color;
      const outside = (px | py) & ~0x3FF;
      let tile;
      if (outside && over >= 2) {
        if (over === 2) { out[x] = -1; continue; }
        tile = 0;
      } else {
        tile = vram[((py >> 3) & 127) * 128 + ((px >> 3) & 127)] & 0xFF;
      }
      color = vram[(tile << 6) + ((py & 7) << 3) + (px & 7)] >> 8;
      if (ext) {
        const p = color >> 7; color &= 0x7F;
        if (!color) { out[x] = -1; continue; }
        out[x] = cg[color]; pri[x] = p; continue;
      }
      if (!color) { out[x] = -1; continue; }
      out[x] = direct ? this.directColor(color, 0) : cg[color];
      pri[x] = 0;
    }
  }

  renderSprites(line) {
    const oc = this.objCol, op = this.objPri, om = this.objMath;
    oc.fill(-1);
    const oam = this.oam;
    const sizes = OBJ_SIZES[(this.obsel >> 5) & 7];
    const nameBase = (this.obsel & 7) << 13;
    const nameSel = ((this.obsel >> 3) & 3) + 1 << 12;
    const first = this.oamPriority ? ((this.oamReload >> 2) & 0x7F) : 0;
    const list = [];
    for (let i = 0; i < 128; i++) {
      const n = (first + i) & 127;
      const hi = (oam[0x200 + (n >> 2)] >> ((n & 3) * 2)) & 3;
      const sz = sizes[(hi >> 1) & 1];
      const w = sz[0], h = sz[1];
      let x = oam[n * 4] | ((hi & 1) << 8);
      if (x >= 256) x -= 512;
      const y = oam[n * 4 + 1];
      const dy = (line - y) & 0xFF;
      if (dy >= h) continue;
      if (x <= -w || x >= 256) { if (x !== -256) continue; }
      if (x === -256 && w) { /* hardware treats x=-256 as on-range for counting */ }
      if (list.length >= 32) { this.rangeOver = 1; break; }
      list.push(n);
    }
    let slivers = 0;
    for (let k = 0; k < list.length; k++) {
      const n = list[k];
      const hi = (oam[0x200 + (n >> 2)] >> ((n & 3) * 2)) & 3;
      const sz = sizes[(hi >> 1) & 1];
      const w = sz[0], h = sz[1];
      let x = oam[n * 4] | ((hi & 1) << 8);
      if (x >= 256) x -= 512;
      const y = oam[n * 4 + 1];
      const tileLo = oam[n * 4 + 2], attr = oam[n * 4 + 3];
      const pal = (attr >> 1) & 7, prio = (attr >> 4) & 3, hf = (attr >> 6) & 1, vf = (attr >> 7) & 1;
      let dy = (line - y) & 0xFF;
      if (vf) {
        // rectangular sprites flip within their own height
        dy = h - 1 - dy;
      }
      const tileRow = dy >> 3, py = dy & 7;
      const base = nameBase + ((attr & 1) ? nameSel : 0);
      const cols = w >> 3;
      for (let cIdx = 0; cIdx < cols; cIdx++) {
        const sxBase = x + cIdx * 8;
        if (sxBase <= -8 || sxBase >= 256) continue;
        if (++slivers > 34) { this.timeOver = 1; break; }
        const tcol = hf ? (cols - 1 - cIdx) : cIdx;
        const t = ((tileLo & 0xF0) + (tileRow << 4) & 0xF0) | ((tileLo + tcol) & 0x0F);
        const addr = (base + t * 16 + py) & 0x7FFF;
        this.decodeRow(addr, 4, this.rowBuf, hf);
        const row = this.rowBuf;
        for (let i = 0; i < 8; i++) {
          const sx = sxBase + i;
          if (sx < 0 || sx >= 256) continue;
          if (oc[sx] >= 0) continue;
          const c = row[i];
          if (!c) continue;
          oc[sx] = this.cgram[128 + pal * 16 + c];
          op[sx] = prio; om[sx] = pal >= 4 ? 1 : 0;
        }
      }
      if (slivers > 34) break;
    }
  }
}
