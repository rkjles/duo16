// ===== SNES system: bus, cartridge, timing, DMA/HDMA, CPU I/O registers =====
const DMA_OFFSETS = [[0], [0, 1], [0, 0], [0, 0, 1, 1], [0, 1, 2, 3], [0, 1, 0, 1], [0, 0], [0, 0, 1, 1]];

function romMirror(addr, size) {
  if (!size) return 0;
  let base = 0, mask = 1 << 24;
  while (addr >= size) {
    while (!(addr & mask)) mask >>>= 1;
    addr -= mask;
    if (size > mask) { size -= mask; base += mask; }
    mask >>>= 1;
  }
  return base + addr;
}

class Cartridge {
  constructor(data) {
    if ((data.length & 0x3FF) === 0x200) data = data.subarray(0x200); // strip copier header
    this.raw = data;
    const cand = [
      { type: 'lorom', off: 0x7FC0 },
      { type: 'hirom', off: 0xFFC0 },
      { type: 'exhirom', off: 0x40FFC0 },
    ];
    let best = null, bestScore = -1e9;
    for (const c of cand) {
      if (c.off + 0x40 > data.length) continue;
      const s = Cartridge.score(data, c.off, c.type);
      if (s > bestScore) { bestScore = s; best = c; }
    }
    if (!best) best = { type: 'lorom', off: 0x7FC0 };
    this.mapping = best.type;
    const h = best.off;
    const hb = (i) => (h + i < data.length ? data[h + i] : 0);
    let title = '';
    for (let i = 0; i < 21; i++) { const ch = hb(i); title += ch >= 0x20 && ch < 0x7F ? String.fromCharCode(ch) : ' '; }
    this.title = title.trim() || 'Untitled';
    this.mapMode = hb(0x15);
    this.chipset = hb(0x16);
    const ramSz = hb(0x18);
    this.sramSize = ramSz > 0 && ramSz <= 0x0C ? (1024 << ramSz) : 0;
    const region = hb(0x19);
    this.pal = (region >= 0x02 && region <= 0x0C) || region === 0x11;
    // Expanded ROM image, power-of-two sized, filled by the hardware mirroring rule
    let size = 1; while (size < data.length) size <<= 1;
    if (size < 0x8000) size = 0x8000;
    this.rom = new Uint8Array(size);
    for (let i = 0; i < size; i++) this.rom[i] = data[romMirror(i, data.length)];
    this.romMask = size - 1;
    this.sram = new Uint8Array(Math.max(this.sramSize, 1));
    if (this.sramSize === 0) this.sram.fill(0xFF);
    const coprocessor = (this.chipset & 0xF0) >> 4;
    this.unsupportedChip = null;
    if ((this.chipset & 0x0F) >= 3) {
      const names = { 0: 'DSP', 1: 'Super FX', 2: 'OBC1', 3: 'SA-1', 4: 'S-DD1', 5: 'S-RTC', 0xE: 'Other', 0xF: 'Custom' };
      this.unsupportedChip = names[coprocessor] || 'coprocessor';
    }
  }

  static score(d, off, type) {
    let s = 0;
    const mode = d[off + 0x15];
    const chk = d[off + 0x1E] | (d[off + 0x1F] << 8);
    const cmp = d[off + 0x1C] | (d[off + 0x1D] << 8);
    if (((chk ^ cmp) & 0xFFFF) === 0xFFFF) s += 8;
    const m = mode & 0x2F;
    if (type === 'lorom' && (m === 0x20 || m === 0x22 || m === 0x30 || m === 0x32 || (mode & 0x0F) === 0)) s += 4;
    if (type === 'hirom' && ((mode & 0x0F) === 1 || (mode & 0x0F) === 0x0A)) s += 4;
    if (type === 'exhirom' && (mode & 0x0F) === 5) s += 4;
    const reset = d[off + 0x3C] | (d[off + 0x3D] << 8);
    if (reset < 0x8000) s -= 8;
    else {
      // first instruction at reset vector: typical SEI / CLC / SEP / REP / JML / JMP
      const base = type === 'lorom' ? (off & ~0x7FFF) : (off & ~0xFFFF);
      const ro = type === 'lorom' ? base + (reset & 0x7FFF) : base + reset;
      const op = ro < d.length ? d[ro] : 0;
      if ([0x78, 0x18, 0x38, 0x9C, 0x4C, 0x5C, 0xC2, 0xE2, 0xAD, 0xAE, 0xAC, 0xAF, 0xA9, 0xA2, 0xA0, 0x20, 0x22].includes(op)) s += 6;
      if ([0x00, 0xFF, 0xDB, 0x02, 0x42].includes(op)) s -= 6;
    }
    let printable = 0;
    for (let i = 0; i < 21; i++) { const c = d[off + i]; if (c >= 0x20 && c < 0x7F) printable++; }
    s += printable > 15 ? 2 : 0;
    if (type === 'exhirom') s -= 1;
    return s;
  }
}

class SNES {
  constructor() {
    this.wram = new Uint8Array(0x20000);
    this.cpu = new CPU65816(this);
    this.ppu = new PPU(this);
    this.apu = new APU();
    this.cart = null;
    // page tables: 2048 pages of 8KB across the 24-bit bus
    this.pageMem = new Array(2048).fill(null);
    this.pageOff = new Int32Array(2048);
    this.pageWritable = new Uint8Array(2048);
    this.pageSpeed = new Uint8Array(2048);
    this.dma = [];
    for (let i = 0; i < 8; i++) this.dma.push(new DMAChannel());
    this.pads = [0, 0, 0, 0];
    this.frameCount = 0;
    this.resetState();
  }

  resetState() {
    this.hc = 0; this.vc = 0;
    this.totalCycles = 0;
    this.mdr = 0;
    this.nmitimen = 0; this.wrio = 0xFF; this.htime = 0x1FF; this.vtime = 0x1FF;
    this.nmiFlag = 0; this.irqFlag = 0; this.inVblank = 0; this.autoJoyBusy = 0;
    this.memsel = 0;
    this.wrmpya = 0xFF; this.wrmpyb = 0; this.wrdiv = 0xFFFF; this.rddiv = 0; this.rdmpy = 0;
    this.joyRead = new Uint16Array(4);
    this.joyLatch = 0; this.joyShift = [0, 0];
    this.wmadd = 0;
    this.hdmaen = 0;
    this.frameDone = false;
    this.lineEventDone = false;
    this.irqFiredThisLine = false;
    this.openBusDMA = 0;
    for (const ch of this.dma) ch.reset();
  }

  loadROM(data) {
    this.cart = new Cartridge(data);
    this.lines = this.cart.pal ? 312 : 262;
    this.buildPageTables();
    this.powerOn();
  }

  powerOn() {
    this.wram.fill(0x55);
    this.resetState();
    this.ppu.reset();
    this.apu.reset();
    this.cpu.powerOn();
    this.cpu.reset();
  }

  softReset() {
    this.resetState();
    this.ppu.reset();
    this.apu.reset();
    this.cpu.reset();
  }

  buildPageTables() {
    const c = this.cart;
    for (let p = 0; p < 2048; p++) {
      const bank = p >> 3, addr = (p & 7) << 13;
      let mem = null, off = 0, w = 0;
      const b = bank & 0x7F;
      if (bank === 0x7E || bank === 0x7F) {
        mem = this.wram; off = ((bank & 1) << 16) | addr; w = 1;
      } else if (b < 0x40 && addr < 0x2000) {
        mem = this.wram; off = addr; w = 1;
      } else if (b < 0x40 && addr < 0x8000) {
        mem = null; // I/O or SRAM (handled)
      } else {
        // ROM area
        let romOff = -1;
        if (c.mapping === 'lorom') {
          if (addr >= 0x8000) romOff = ((b & 0x7F) << 15) | (addr & 0x7FFF);
          else if (b >= 0x40 && !(b >= 0x70 && b < 0x7E && c.sramSize)) romOff = ((b & 0x7F) << 15) | (addr & 0x7FFF);
        } else if (c.mapping === 'hirom') {
          if (b >= 0x40 || addr >= 0x8000) romOff = ((b & 0x3F) << 16) | addr;
        } else { // exhirom
          if (b >= 0x40 || addr >= 0x8000) romOff = (((b & 0x3F) << 16) | addr) | (bank < 0x80 ? 0x400000 : 0);
        }
        if (romOff >= 0) { mem = c.rom; off = romOff & c.romMask; }
      }
      this.pageMem[p] = mem; this.pageOff[p] = off; this.pageWritable[p] = w;
    }
    this.updateSpeeds();
  }

  updateSpeeds() {
    for (let p = 0; p < 2048; p++) {
      const bank = p >> 3, addr = (p & 7) << 13;
      const b = bank & 0x7F;
      let sp = 8;
      if (b < 0x40) {
        if (addr < 0x2000) sp = 8;
        else if (addr < 0x4000) sp = 6;
        else if (addr < 0x6000) sp = 6; // $4000-41FF is 12, handled in read/write
        else if (addr < 0x8000) sp = 8;
        else sp = (bank >= 0x80 && (this.memsel & 1)) ? 6 : 8;
      } else if (bank >= 0xC0) sp = (this.memsel & 1) ? 6 : 8;
      this.pageSpeed[p] = sp;
    }
  }

  // ---- SRAM mapping for handler path ----
  sramOffset(bank, addr) {
    const c = this.cart; if (!c.sramSize) return -1;
    const b = bank & 0x7F;
    if (c.mapping === 'lorom') {
      if (b >= 0x70 && b < 0x7E && addr < 0x8000) return (((b & 0x0F) << 15) | addr) % c.sramSize;
    } else {
      if (b >= 0x20 && b < 0x40 && addr >= 0x6000 && addr < 0x8000) return (((b & 0x1F) << 13) | (addr - 0x6000)) % c.sramSize;
    }
    return -1;
  }

  // ---- CPU-visible bus ----
  read(addr) {
    const p = addr >>> 13;
    const mem = this.pageMem[p];
    if (mem !== null) {
      this.tick(this.pageSpeed[p]);
      return (this.mdr = mem[this.pageOff[p] + (addr & 0x1FFF)]);
    }
    const a = addr & 0xFFFF;
    this.tick((a & 0xFE00) === 0x4000 ? 12 : this.pageSpeed[p]);
    return (this.mdr = this.readIO(addr));
  }
  write(addr, v) {
    const p = addr >>> 13;
    const mem = this.pageMem[p];
    this.mdr = v;
    if (mem !== null) {
      this.tick(this.pageSpeed[p]);
      if (this.pageWritable[p]) mem[this.pageOff[p] + (addr & 0x1FFF)] = v;
      return;
    }
    const a = addr & 0xFFFF;
    this.tick((a & 0xFE00) === 0x4000 ? 12 : this.pageSpeed[p]);
    this.writeIO(addr, v);
  }
  idle() { this.tick(6); }

  // Raw A-bus access for DMA (no timing, no B-bus registers)
  readA(addr) {
    const p = addr >>> 13; const mem = this.pageMem[p];
    if (mem !== null) return mem[this.pageOff[p] + (addr & 0x1FFF)];
    const a = addr & 0xFFFF;
    if ((a & 0xFF00) === 0x2100 || (a & 0xFF80) === 0x4300 || a === 0x420B || a === 0x420C) return this.mdr;
    return this.readIO(addr);
  }
  writeA(addr, v) {
    const p = addr >>> 13; const mem = this.pageMem[p];
    if (mem !== null) { if (this.pageWritable[p]) mem[this.pageOff[p] + (addr & 0x1FFF)] = v; return; }
    const a = addr & 0xFFFF;
    if ((a & 0xFF00) === 0x2100 || (a & 0xFF80) === 0x4300 || a === 0x420B || a === 0x420C) return;
    this.writeIO(addr, v);
  }
  readB(a) { return this.readIO(0x2100 | (a & 0xFF)); }
  writeB(a, v) { this.writeIO(0x2100 | (a & 0xFF), v); }

  readIO(addr) {
    const bank = addr >>> 16, a = addr & 0xFFFF;
    const b = bank & 0x7F;
    if (b < 0x40) {
      if (a >= 0x2100 && a < 0x2140) return this.ppu.read(a & 0xFF, this.mdr);
      if (a >= 0x2140 && a < 0x2180) { this.syncAPU(); return this.apu.readPort(a & 3); }
      if (a === 0x2180) { const v = this.wram[this.wmadd]; this.wmadd = (this.wmadd + 1) & 0x1FFFF; return v; }
      if (a === 0x4016) {
        const v = this.readSerial(0);
        return (this.mdr & 0xFC) | v;
      }
      if (a === 0x4017) {
        const v = this.readSerial(1);
        return (this.mdr & 0xE0) | 0x1C | v;
      }
      if (a >= 0x4200 && a < 0x4220) return this.readCPUReg(a);
      if (a >= 0x4300 && a < 0x4380) return this.dma[(a >> 4) & 7].read(a & 0xF, this.mdr);
      const so = this.sramOffset(bank, a);
      if (so >= 0) return this.cart.sram[so];
      return this.mdr;
    }
    const so = this.sramOffset(bank, a);
    if (so >= 0) return this.cart.sram[so];
    return this.mdr;
  }

  writeIO(addr, v) {
    const bank = addr >>> 16, a = addr & 0xFFFF;
    const b = bank & 0x7F;
    if (b < 0x40) {
      if (a >= 0x2100 && a < 0x2140) { this.ppu.write(a & 0xFF, v); return; }
      if (a >= 0x2140 && a < 0x2180) { this.syncAPU(); this.apu.writePort(a & 3, v); return; }
      if (a === 0x2180) { this.wram[this.wmadd] = v; this.wmadd = (this.wmadd + 1) & 0x1FFFF; return; }
      if (a === 0x2181) { this.wmadd = (this.wmadd & 0x1FF00) | v; return; }
      if (a === 0x2182) { this.wmadd = (this.wmadd & 0x100FF) | (v << 8); return; }
      if (a === 0x2183) { this.wmadd = (this.wmadd & 0x0FFFF) | ((v & 1) << 16); return; }
      if (a === 0x4016) {
        const nl = v & 1;
        if (this.joyLatch && !nl) { this.joyShift[0] = this.pads[0]; this.joyShift[1] = this.pads[1]; }
        this.joyLatch = nl;
        if (nl) { this.joyShift[0] = this.pads[0]; this.joyShift[1] = this.pads[1]; }
        return;
      }
      if (a >= 0x4200 && a < 0x4220) { this.writeCPUReg(a, v); return; }
      if (a >= 0x4300 && a < 0x4380) { this.dma[(a >> 4) & 7].write(a & 0xF, v); return; }
    }
    const so = this.sramOffset(bank, a);
    if (so >= 0) this.cart.sram[so] = v;
  }

  readSerial(port) {
    if (this.joyLatch) return (this.pads[port] >> 15) & 1;
    const bit = (this.joyShift[port] >> 15) & 1;
    this.joyShift[port] = ((this.joyShift[port] << 1) | 1) & 0xFFFF;
    return bit;
  }

  readCPUReg(a) {
    switch (a) {
      case 0x4210: { const v = (this.nmiFlag << 7) | (this.mdr & 0x70) | 0x02; this.nmiFlag = 0; return v; }
      case 0x4211: { const v = (this.irqFlag << 7) | (this.mdr & 0x7F); this.irqFlag = 0; this.cpu.irqLine = false; return v; }
      case 0x4212: {
        const hb = (this.hc < 4 || this.hc >= 1096) ? 1 : 0;
        return (this.inVblank << 7) | (hb << 6) | (this.mdr & 0x3E) | this.autoJoyBusy;
      }
      case 0x4213: return this.wrio;
      case 0x4214: return this.rddiv & 0xFF;
      case 0x4215: return this.rddiv >> 8;
      case 0x4216: return this.rdmpy & 0xFF;
      case 0x4217: return this.rdmpy >> 8;
      case 0x4218: case 0x421A: case 0x421C: case 0x421E: return this.joyRead[(a - 0x4218) >> 1] & 0xFF;
      case 0x4219: case 0x421B: case 0x421D: case 0x421F: return this.joyRead[(a - 0x4219) >> 1] >> 8;
    }
    return this.mdr;
  }

  writeCPUReg(a, v) {
    switch (a) {
      case 0x4200: {
        const oldNmi = this.nmitimen & 0x80;
        this.nmitimen = v;
        if (!oldNmi && (v & 0x80) && this.nmiFlag) this.cpu.nmiPending = true;
        if (!(v & 0x30)) { this.irqFlag = 0; this.cpu.irqLine = false; }
        break;
      }
      case 0x4201:
        if ((this.wrio & 0x80) && !(v & 0x80)) this.ppu.latchCounters(this.hc, this.vc);
        this.wrio = v; break;
      case 0x4202: this.wrmpya = v; break;
      case 0x4203: this.wrmpyb = v; this.rdmpy = this.wrmpya * v; this.rddiv = v; break;
      case 0x4204: this.wrdiv = (this.wrdiv & 0xFF00) | v; break;
      case 0x4205: this.wrdiv = (this.wrdiv & 0x00FF) | (v << 8); break;
      case 0x4206:
        if (v === 0) { this.rddiv = 0xFFFF; this.rdmpy = this.wrdiv; }
        else { this.rddiv = Math.floor(this.wrdiv / v); this.rdmpy = this.wrdiv % v; }
        break;
      case 0x4207: this.htime = (this.htime & 0x100) | v; break;
      case 0x4208: this.htime = (this.htime & 0xFF) | ((v & 1) << 8); break;
      case 0x4209: this.vtime = (this.vtime & 0x100) | v; break;
      case 0x420A: this.vtime = (this.vtime & 0xFF) | ((v & 1) << 8); break;
      case 0x420B: this.runDMA(v); break;
      case 0x420C: this.hdmaen = v; break;
      case 0x420D: if ((this.memsel ^ v) & 1) { this.memsel = v & 1; this.updateSpeeds(); } break;
    }
  }

  // ---- DMA ----
  runDMA(mask) {
    if (!mask) return;
    this.tick(8);
    for (let i = 0; i < 8; i++) {
      if (!(mask & (1 << i))) continue;
      const ch = this.dma[i];
      this.tick(8);
      const offs = DMA_OFFSETS[ch.params & 7];
      const fromB = ch.params & 0x80;
      const fixed = ch.params & 0x08;
      const dec = ch.params & 0x10;
      let n = 0;
      do {
        const bb = (ch.bbad + offs[n % offs.length]) & 0xFF;
        const aa = (ch.a1b << 16) | ch.a1t;
        if (fromB) this.writeA(aa, this.readB(bb));
        else this.writeB(bb, this.readA(aa));
        this.tick(8);
        if (!fixed) ch.a1t = (ch.a1t + (dec ? -1 : 1)) & 0xFFFF;
        ch.das = (ch.das - 1) & 0xFFFF;
        n++;
      } while (ch.das !== 0);
    }
  }

  hdmaInit() {
    for (let i = 0; i < 8; i++) {
      const ch = this.dma[i];
      ch.hdmaCompleted = false; ch.hdmaDoTransfer = false;
      if (!(this.hdmaen & (1 << i))) continue;
      ch.a2a = ch.a1t;
      ch.ntrl = 0;
      this.hdmaReload(ch);
    }
  }

  hdmaReload(ch) {
    const data = this.readA((ch.a1b << 16) | ch.a2a);
    if ((ch.ntrl & 0x7F) === 0) {
      ch.ntrl = data;
      ch.a2a = (ch.a2a + 1) & 0xFFFF;
      ch.hdmaCompleted = ch.ntrl === 0;
      ch.hdmaDoTransfer = !ch.hdmaCompleted;
      if (ch.params & 0x40) {
        const lo = this.readA((ch.a1b << 16) | ch.a2a); ch.a2a = (ch.a2a + 1) & 0xFFFF;
        if (ch.hdmaCompleted) { ch.das = lo << 8; return; }
        const hi = this.readA((ch.a1b << 16) | ch.a2a); ch.a2a = (ch.a2a + 1) & 0xFFFF;
        ch.das = lo | (hi << 8);
        this.tick(16);
      }
    }
  }

  hdmaRun() {
    let any = false;
    for (let i = 0; i < 8; i++) {
      const ch = this.dma[i];
      if (!(this.hdmaen & (1 << i)) || ch.hdmaCompleted) continue;
      any = true;
      if (ch.hdmaDoTransfer) {
        const offs = DMA_OFFSETS[ch.params & 7];
        const indirect = ch.params & 0x40;
        const fromB = ch.params & 0x80;
        for (let k = 0; k < offs.length; k++) {
          let aa;
          if (indirect) { aa = (ch.dasb << 16) | ch.das; ch.das = (ch.das + 1) & 0xFFFF; }
          else { aa = (ch.a1b << 16) | ch.a2a; ch.a2a = (ch.a2a + 1) & 0xFFFF; }
          const bb = (ch.bbad + offs[k]) & 0xFF;
          if (fromB) this.writeA(aa, this.readB(bb)); else this.writeB(bb, this.readA(aa));
          this.tick(8);
        }
      }
      ch.ntrl = (ch.ntrl - 1) & 0xFF;
      ch.hdmaDoTransfer = (ch.ntrl & 0x80) !== 0;
      this.hdmaReload(ch);
      this.tick(8);
    }
    if (any) this.tick(18);
  }

  // ---- timing ----
  irqTargetH() { return this.htime * 4 + 14; }

  tick(c) {
    const old = this.hc;
    this.hc += c;
    this.totalCycles += c;
    // H/V IRQ
    const mode = (this.nmitimen >> 4) & 3;
    if (mode && !this.irqFiredThisLine) {
      let hit = false;
      if (mode === 1) { const t = this.irqTargetH(); hit = old < t && this.hc >= t && this.htime < 340; }
      else if (mode === 2) { hit = this.vc === this.vtime && old < 10 && this.hc >= 10; }
      else { const t = this.irqTargetH(); hit = this.vc === this.vtime && old < t && this.hc >= t && this.htime < 340; }
      if (hit) { this.irqFlag = 1; this.cpu.irqLine = true; this.irqFiredThisLine = true; }
    }
    if (!this.lineEventDone && this.hc >= 1104) {
      this.lineEventDone = true;
      this.renderAndHdma();
    }
    if (this.hc >= 1364) this.newLine();
  }

  renderAndHdma() {
    const vdisp = this.ppu.overscan ? 240 : 225;
    if (this.vc > 0 && this.vc < vdisp) this.ppu.renderLine(this.vc);
    if (this.vc < vdisp) this.hdmaRun();
  }

  newLine() {
    this.hc -= 1364;
    this.vc++;
    this.lineEventDone = false;
    this.irqFiredThisLine = false;
    const vdisp = this.ppu.overscan ? 240 : 225;
    if (this.vc === vdisp) {
      this.inVblank = 1;
      this.nmiFlag = 1;
      if (this.nmitimen & 0x80) this.cpu.nmiPending = true;
      this.ppu.startVblank();
      if (this.nmitimen & 1) this.autoJoypad();
      this.frameDone = true;
    } else if (this.vc === vdisp + 3) {
      this.autoJoyBusy = 0;
    }
    if (this.vc >= this.lines) {
      this.vc = 0;
      this.inVblank = 0;
      this.nmiFlag = 0;
      this.ppu.startFrame();
      this.hdmaInit();
      this.frameCount++;
    }
    // re-check IRQ at the start of line for V-only mode within same tick
  }

  autoJoypad() {
    this.autoJoyBusy = 1;
    for (let i = 0; i < 4; i++) this.joyRead[i] = this.pads[i] & 0xFFFF;
    // serial port state is left fully shifted after auto-read
    this.joyShift[0] = 0xFFFF; this.joyShift[1] = 0xFFFF;
  }

  syncAPU() { this.apu.catchUp(this.totalCycles); }

  runFrame() {
    this.frameDone = false;
    const cpu = this.cpu;
    let guard = 0;
    while (!this.frameDone) {
      cpu.step();
      if (++guard > 2000000) break;
    }
    this.syncAPU();
    this.apu.endFrame(this.totalCycles);
  }
}

class DMAChannel {
  constructor() { this.reset(); }
  reset() {
    this.params = 0xFF; this.bbad = 0xFF; this.a1t = 0xFFFF; this.a1b = 0xFF; this.das = 0xFFFF; this.dasb = 0xFF;
    this.a2a = 0xFFFF; this.ntrl = 0xFF; this.unused = 0xFF;
    this.hdmaCompleted = false; this.hdmaDoTransfer = false;
  }
  read(r, mdr) {
    switch (r) {
      case 0: return this.params; case 1: return this.bbad;
      case 2: return this.a1t & 0xFF; case 3: return this.a1t >> 8; case 4: return this.a1b;
      case 5: return this.das & 0xFF; case 6: return this.das >> 8; case 7: return this.dasb;
      case 8: return this.a2a & 0xFF; case 9: return this.a2a >> 8; case 0xA: return this.ntrl;
      case 0xB: case 0xF: return this.unused;
    }
    return mdr;
  }
  write(r, v) {
    switch (r) {
      case 0: this.params = v; break; case 1: this.bbad = v; break;
      case 2: this.a1t = (this.a1t & 0xFF00) | v; break; case 3: this.a1t = (this.a1t & 0xFF) | (v << 8); break;
      case 4: this.a1b = v; break;
      case 5: this.das = (this.das & 0xFF00) | v; break; case 6: this.das = (this.das & 0xFF) | (v << 8); break;
      case 7: this.dasb = v; break;
      case 8: this.a2a = (this.a2a & 0xFF00) | v; break; case 9: this.a2a = (this.a2a & 0xFF) | (v << 8); break;
      case 0xA: this.ntrl = v; break;
      case 0xB: case 0xF: this.unused = v; break;
    }
  }
}
