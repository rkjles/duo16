// ===== 65816 CPU =====
class CPU65816 {
  constructor(bus) { this.bus = bus; this.powerOn(); }

  powerOn() {
    this.a = 0; this.x = 0; this.y = 0; this.s = 0x1FF; this.d = 0;
    this.dbr = 0; this.pbr = 0; this.pc = 0;
    this.fN = 0; this.fV = 0; this.fM = 1; this.fX = 1; this.fD = 0; this.fI = 1; this.fZ = 0; this.fC = 0;
    this.e = 1;
    this.waiting = false; this.stopped = false;
    this.nmiPending = false; this.irqLine = false;
    this.bankWrap = false;
  }

  reset() {
    this.e = 1; this.fM = 1; this.fX = 1; this.fD = 0; this.fI = 1;
    this.s = 0x100 | (this.s & 0xFF); this.x &= 0xFF; this.y &= 0xFF;
    this.d = 0; this.dbr = 0; this.pbr = 0;
    this.waiting = false; this.stopped = false; this.nmiPending = false;
    this.pc = this.bus.read(0xFFFC) | (this.bus.read(0xFFFD) << 8);
  }

  // ---- state for save states ----
  saveState() {
    return [this.a, this.x, this.y, this.s, this.d, this.dbr, this.pbr, this.pc, this.getP(), this.e,
      this.waiting ? 1 : 0, this.stopped ? 1 : 0, this.nmiPending ? 1 : 0, this.irqLine ? 1 : 0];
  }
  loadState(st) {
    [this.a, this.x, this.y, this.s, this.d, this.dbr, this.pbr, this.pc] = st;
    this.e = st[9]; this.setPraw(st[8]);
    this.waiting = !!st[10]; this.stopped = !!st[11]; this.nmiPending = !!st[12]; this.irqLine = !!st[13];
  }

  getP() {
    return (this.fN << 7) | (this.fV << 6) | (this.fM << 5) | (this.fX << 4) | (this.fD << 3) | (this.fI << 2) | (this.fZ << 1) | this.fC;
  }
  setPraw(v) {
    this.fN = (v >> 7) & 1; this.fV = (v >> 6) & 1; this.fM = (v >> 5) & 1; this.fX = (v >> 4) & 1;
    this.fD = (v >> 3) & 1; this.fI = (v >> 2) & 1; this.fZ = (v >> 1) & 1; this.fC = v & 1;
  }
  setP(v) {
    this.setPraw(v);
    if (this.e) { this.fM = 1; this.fX = 1; }
    if (this.fX) { this.x &= 0xFF; this.y &= 0xFF; }
  }

  // ---- memory helpers ----
  rd(a) { return this.bus.read(a & 0xFFFFFF); }
  wr(a, v) { this.bus.write(a & 0xFFFFFF, v & 0xFF); }
  idle() { this.bus.idle(); }
  next(a) { return this.bankWrap ? ((a & 0xFF0000) | ((a + 1) & 0xFFFF)) : ((a + 1) & 0xFFFFFF); }
  rd16(a) { const lo = this.rd(a); return lo | (this.rd(this.next(a)) << 8); }
  wr16(a, v) { this.wr(a, v); this.wr(this.next(a), v >> 8); }
  rdM(a) { return this.fM ? this.rd(a) : this.rd16(a); }
  wrM(a, v) { if (this.fM) this.wr(a, v); else this.wr16(a, v); }
  rdX(a) { return this.fX ? this.rd(a) : this.rd16(a); }
  wrX(a, v) { if (this.fX) this.wr(a, v); else this.wr16(a, v); }

  fetch8() { const v = this.rd((this.pbr << 16) | this.pc); this.pc = (this.pc + 1) & 0xFFFF; return v; }
  fetch16() { const lo = this.fetch8(); return lo | (this.fetch8() << 8); }
  fetch24() { const lo = this.fetch16(); return lo | (this.fetch8() << 16); }
  immM() { return this.fM ? this.fetch8() : this.fetch16(); }
  immX() { return this.fX ? this.fetch8() : this.fetch16(); }

  push8(v) {
    this.wr(this.s, v);
    this.s = this.e ? (0x100 | ((this.s - 1) & 0xFF)) : ((this.s - 1) & 0xFFFF);
  }
  pull8() {
    this.s = this.e ? (0x100 | ((this.s + 1) & 0xFF)) : ((this.s + 1) & 0xFFFF);
    return this.rd(this.s);
  }
  push16(v) { this.push8(v >> 8); this.push8(v & 0xFF); }
  pull16() { const lo = this.pull8(); return lo | (this.pull8() << 8); }
  // "new" 65816 instructions use 16-bit stack pointer even in emulation mode
  pushN8(v) { this.wr(this.s, v); this.s = (this.s - 1) & 0xFFFF; }
  pullN8() { this.s = (this.s + 1) & 0xFFFF; return this.rd(this.s); }
  pushN16(v) { this.pushN8(v >> 8); this.pushN8(v & 0xFF); }
  pullN16() { const lo = this.pullN8(); return lo | (this.pullN8() << 8); }
  fixS() { if (this.e) this.s = 0x100 | (this.s & 0xFF); }

  // ---- addressing modes ----
  dpIdle() { if (this.d & 0xFF) this.idle(); }
  aDP() { const o = this.fetch8(); this.dpIdle(); this.bankWrap = true; return (this.d + o) & 0xFFFF; }
  aDPi(r) {
    const o = this.fetch8(); this.dpIdle(); this.idle(); this.bankWrap = true;
    if (this.e && (this.d & 0xFF) === 0) return (this.d & 0xFF00) | ((o + r) & 0xFF);
    return (this.d + o + r) & 0xFFFF;
  }
  ptr16(p) {
    const lo = this.rd(p);
    const p2 = (this.e && (this.d & 0xFF) === 0) ? ((p & 0xFF00) | ((p + 1) & 0xFF)) : ((p + 1) & 0xFFFF);
    return lo | (this.rd(p2) << 8);
  }
  aDPInd() { const p = this.aDP(); const q = this.ptr16(p); this.bankWrap = false; return (this.dbr << 16) | q; }
  aDPIndX() { const p = this.aDPi(this.x); const q = this.ptr16(p); this.bankWrap = false; return (this.dbr << 16) | q; }
  aDPIndY(write) {
    const p = this.aDP(); const q = this.ptr16(p); this.bankWrap = false;
    const base = (this.dbr << 16) | q; const ad = (base + this.y) & 0xFFFFFF;
    if (write || !this.fX || ((base ^ ad) & 0xFF00)) this.idle();
    return ad;
  }
  aDPIndL() {
    const p = this.aDP(); const lo = this.rd(p); const mid = this.rd((p + 1) & 0xFFFF); const hi = this.rd((p + 2) & 0xFFFF);
    this.bankWrap = false; return lo | (mid << 8) | (hi << 16);
  }
  aDPIndLY() { return (this.aDPIndL() + this.y) & 0xFFFFFF; }
  aAbs() { const o = this.fetch16(); this.bankWrap = false; return (this.dbr << 16) | o; }
  aAbsI(r, write) {
    const o = this.fetch16(); this.bankWrap = false;
    const base = (this.dbr << 16) | o; const ad = (base + r) & 0xFFFFFF;
    if (write || !this.fX || ((base ^ ad) & 0xFF00)) this.idle();
    return ad;
  }
  aLong() { this.bankWrap = false; return this.fetch24(); }
  aLongX() { this.bankWrap = false; return (this.fetch24() + this.x) & 0xFFFFFF; }
  aSR() { const o = this.fetch8(); this.idle(); this.bankWrap = true; return (this.s + o) & 0xFFFF; }
  aSRIY() {
    const o = this.fetch8(); this.idle(); const p = (this.s + o) & 0xFFFF;
    const q = this.rd(p) | (this.rd((p + 1) & 0xFFFF) << 8); this.idle(); this.bankWrap = false;
    return (((this.dbr << 16) | q) + this.y) & 0xFFFFFF;
  }

  // ---- flag helpers ----
  nz8(v) { this.fN = (v >> 7) & 1; this.fZ = (v & 0xFF) === 0 ? 1 : 0; }
  nz16(v) { this.fN = (v >> 15) & 1; this.fZ = (v & 0xFFFF) === 0 ? 1 : 0; }
  nzM(v) { if (this.fM) this.nz8(v); else this.nz16(v); }
  nzX(v) { if (this.fX) this.nz8(v); else this.nz16(v); }
  setA(v) { if (this.fM) { this.a = (this.a & 0xFF00) | (v & 0xFF); this.nz8(v); } else { this.a = v & 0xFFFF; this.nz16(v); } }
  setXr(v) { if (this.fX) { this.x = v & 0xFF; this.nz8(v); } else { this.x = v & 0xFFFF; this.nz16(v); } }
  setYr(v) { if (this.fX) { this.y = v & 0xFF; this.nz8(v); } else { this.y = v & 0xFFFF; this.nz16(v); } }

  // ---- ALU ----
  ORA(v) { this.setA(this.a | v); }
  AND(v) { this.setA(this.a & (v | (this.fM ? 0xFF00 : 0))); }
  EOR(v) { this.setA(this.a ^ v); }
  ADC(v) {
    if (this.fM) {
      const a = this.a & 0xFF; let r;
      if (!this.fD) r = a + v + this.fC;
      else {
        r = (a & 0x0F) + (v & 0x0F) + this.fC;
        if (r > 0x09) r += 0x06;
        const c = r > 0x0F ? 1 : 0;
        r = (a & 0xF0) + (v & 0xF0) + (c << 4) + (r & 0x0F);
      }
      this.fV = (~(a ^ v) & (a ^ r) & 0x80) ? 1 : 0;
      if (this.fD && r > 0x9F) r += 0x60;
      this.fC = r > 0xFF ? 1 : 0;
      this.setA(r & 0xFF);
    } else {
      const a = this.a; let r;
      if (!this.fD) r = a + v + this.fC;
      else {
        let c;
        r = (a & 0x000F) + (v & 0x000F) + this.fC;
        if (r > 0x0009) r += 0x0006; c = r > 0x000F ? 1 : 0;
        r = (a & 0x00F0) + (v & 0x00F0) + (c << 4) + (r & 0x000F);
        if (r > 0x009F) r += 0x0060; c = r > 0x00FF ? 1 : 0;
        r = (a & 0x0F00) + (v & 0x0F00) + (c << 8) + (r & 0x00FF);
        if (r > 0x09FF) r += 0x0600; c = r > 0x0FFF ? 1 : 0;
        r = (a & 0xF000) + (v & 0xF000) + (c << 12) + (r & 0x0FFF);
      }
      this.fV = (~(a ^ v) & (a ^ r) & 0x8000) ? 1 : 0;
      if (this.fD && r > 0x9FFF) r += 0x6000;
      this.fC = r > 0xFFFF ? 1 : 0;
      this.setA(r & 0xFFFF);
    }
  }
  SBC(v) {
    if (this.fM) {
      const a = this.a & 0xFF; v = (~v) & 0xFF; let r;
      if (!this.fD) r = a + v + this.fC;
      else {
        r = (a & 0x0F) + (v & 0x0F) + this.fC;
        if (r <= 0x0F) r -= 0x06;
        const c = r > 0x0F ? 1 : 0;
        r = (a & 0xF0) + (v & 0xF0) + (c << 4) + (r & 0x0F);
      }
      this.fV = (~(a ^ v) & (a ^ r) & 0x80) ? 1 : 0;
      if (this.fD && r <= 0xFF) r -= 0x60;
      this.fC = r > 0xFF ? 1 : 0;
      this.setA(r & 0xFF);
    } else {
      const a = this.a; v = (~v) & 0xFFFF; let r;
      if (!this.fD) r = a + v + this.fC;
      else {
        let c;
        r = (a & 0x000F) + (v & 0x000F) + this.fC;
        if (r <= 0x000F) r -= 0x0006; c = r > 0x000F ? 1 : 0;
        r = (a & 0x00F0) + (v & 0x00F0) + (c << 4) + (r & 0x000F);
        if (r <= 0x00FF) r -= 0x0060; c = r > 0x00FF ? 1 : 0;
        r = (a & 0x0F00) + (v & 0x0F00) + (c << 8) + (r & 0x00FF);
        if (r <= 0x0FFF) r -= 0x0600; c = r > 0x0FFF ? 1 : 0;
        r = (a & 0xF000) + (v & 0xF000) + (c << 12) + (r & 0x0FFF);
      }
      this.fV = (~(a ^ v) & (a ^ r) & 0x8000) ? 1 : 0;
      if (this.fD && r <= 0xFFFF) r -= 0x6000;
      this.fC = r > 0xFFFF ? 1 : 0;
      this.setA(r & 0xFFFF);
    }
  }
  CMPw(reg, v, eight) {
    if (eight) { const r = (reg & 0xFF) - v; this.fC = r >= 0 ? 1 : 0; this.nz8(r & 0xFF); }
    else { const r = (reg & 0xFFFF) - v; this.fC = r >= 0 ? 1 : 0; this.nz16(r & 0xFFFF); }
  }
  CMP(v) { this.CMPw(this.a, v, this.fM); }
  CPX(v) { this.CMPw(this.x, v, this.fX); }
  CPY(v) { this.CMPw(this.y, v, this.fX); }
  BIT(v, imm) {
    const a = this.fM ? (this.a & 0xFF) : this.a;
    this.fZ = (a & v) === 0 ? 1 : 0;
    if (!imm) {
      if (this.fM) { this.fN = (v >> 7) & 1; this.fV = (v >> 6) & 1; }
      else { this.fN = (v >> 15) & 1; this.fV = (v >> 14) & 1; }
    }
  }
  // shifts operate on values of M width
  ASLv(v) { if (this.fM) { this.fC = (v >> 7) & 1; v = (v << 1) & 0xFF; } else { this.fC = (v >> 15) & 1; v = (v << 1) & 0xFFFF; } this.nzM(v); return v; }
  LSRv(v) { this.fC = v & 1; v >>= 1; this.nzM(v); return v; }
  ROLv(v) { const c = this.fC; if (this.fM) { this.fC = (v >> 7) & 1; v = ((v << 1) | c) & 0xFF; } else { this.fC = (v >> 15) & 1; v = ((v << 1) | c) & 0xFFFF; } this.nzM(v); return v; }
  RORv(v) { const c = this.fC; this.fC = v & 1; v = (v >> 1) | (c << (this.fM ? 7 : 15)); this.nzM(v); return v; }
  INCv(v) { v = (v + 1) & (this.fM ? 0xFF : 0xFFFF); this.nzM(v); return v; }
  DECv(v) { v = (v - 1) & (this.fM ? 0xFF : 0xFFFF); this.nzM(v); return v; }
  TSBv(v) { const a = this.fM ? this.a & 0xFF : this.a; this.fZ = (a & v) === 0 ? 1 : 0; return v | a; }
  TRBv(v) { const a = this.fM ? this.a & 0xFF : this.a; this.fZ = (a & v) === 0 ? 1 : 0; return v & ~a & (this.fM ? 0xFF : 0xFFFF); }

  rmw(addr, fn) {
    let v = this.rdM(addr); this.idle(); v = fn.call(this, v);
    if (this.fM) this.wr(addr, v); else { this.wr(this.next(addr), v >> 8); this.wr(addr, v); }
  }
  accOp(fn) { this.idle(); const v = this.fM ? this.a & 0xFF : this.a; const r = fn.call(this, v); if (this.fM) this.a = (this.a & 0xFF00) | r; else this.a = r; }

  branch(cond) {
    const off = this.fetch8();
    if (cond) {
      this.idle();
      const npc = (this.pc + ((off << 24) >> 24)) & 0xFFFF;
      if (this.e && ((npc ^ this.pc) & 0xFF00)) this.idle();
      this.pc = npc;
    }
  }

  interrupt(nativeVec, emuVec, isBrk) {
    if (!this.e) this.push8(this.pbr);
    this.push16(this.pc);
    let p = this.getP();
    if (this.e) p = (p & ~0x10) | (isBrk ? 0x10 : 0) | 0x20;
    this.push8(p);
    this.fI = 1; this.fD = 0; this.pbr = 0;
    const v = this.e ? emuVec : nativeVec;
    this.pc = this.rd(v) | (this.rd(v + 1) << 8);
  }

  // Run one instruction (or service an interrupt). Returns nothing; bus tracks time.
  step() {
    if (this.stopped) { this.idle(); return; }
    if (this.waiting) {
      if (this.nmiPending || this.irqLine) { this.waiting = false; this.idle(); }
      else { this.idle(); return; }
    }
    if (this.nmiPending) {
      this.nmiPending = false; this.idle(); this.idle();
      this.interrupt(0xFFEA, 0xFFFA, false); return;
    }
    if (this.irqLine && !this.fI) {
      this.idle(); this.idle();
      this.interrupt(0xFFEE, 0xFFFE, false); return;
    }
    const op = this.fetch8();
    this.exec(op);
  }

  exec(op) {
    let ad, v;
    switch (op) {
      // ---- ORA ----
      case 0x09: this.ORA(this.immM()); break;
      case 0x05: this.ORA(this.rdM(this.aDP())); break;
      case 0x15: this.ORA(this.rdM(this.aDPi(this.x))); break;
      case 0x12: this.ORA(this.rdM(this.aDPInd())); break;
      case 0x01: this.ORA(this.rdM(this.aDPIndX())); break;
      case 0x11: this.ORA(this.rdM(this.aDPIndY(false))); break;
      case 0x07: this.ORA(this.rdM(this.aDPIndL())); break;
      case 0x17: this.ORA(this.rdM(this.aDPIndLY())); break;
      case 0x0D: this.ORA(this.rdM(this.aAbs())); break;
      case 0x1D: this.ORA(this.rdM(this.aAbsI(this.x, false))); break;
      case 0x19: this.ORA(this.rdM(this.aAbsI(this.y, false))); break;
      case 0x0F: this.ORA(this.rdM(this.aLong())); break;
      case 0x1F: this.ORA(this.rdM(this.aLongX())); break;
      case 0x03: this.ORA(this.rdM(this.aSR())); break;
      case 0x13: this.ORA(this.rdM(this.aSRIY())); break;
      // ---- AND ----
      case 0x29: this.AND(this.immM()); break;
      case 0x25: this.AND(this.rdM(this.aDP())); break;
      case 0x35: this.AND(this.rdM(this.aDPi(this.x))); break;
      case 0x32: this.AND(this.rdM(this.aDPInd())); break;
      case 0x21: this.AND(this.rdM(this.aDPIndX())); break;
      case 0x31: this.AND(this.rdM(this.aDPIndY(false))); break;
      case 0x27: this.AND(this.rdM(this.aDPIndL())); break;
      case 0x37: this.AND(this.rdM(this.aDPIndLY())); break;
      case 0x2D: this.AND(this.rdM(this.aAbs())); break;
      case 0x3D: this.AND(this.rdM(this.aAbsI(this.x, false))); break;
      case 0x39: this.AND(this.rdM(this.aAbsI(this.y, false))); break;
      case 0x2F: this.AND(this.rdM(this.aLong())); break;
      case 0x3F: this.AND(this.rdM(this.aLongX())); break;
      case 0x23: this.AND(this.rdM(this.aSR())); break;
      case 0x33: this.AND(this.rdM(this.aSRIY())); break;
      // ---- EOR ----
      case 0x49: this.EOR(this.immM()); break;
      case 0x45: this.EOR(this.rdM(this.aDP())); break;
      case 0x55: this.EOR(this.rdM(this.aDPi(this.x))); break;
      case 0x52: this.EOR(this.rdM(this.aDPInd())); break;
      case 0x41: this.EOR(this.rdM(this.aDPIndX())); break;
      case 0x51: this.EOR(this.rdM(this.aDPIndY(false))); break;
      case 0x47: this.EOR(this.rdM(this.aDPIndL())); break;
      case 0x57: this.EOR(this.rdM(this.aDPIndLY())); break;
      case 0x4D: this.EOR(this.rdM(this.aAbs())); break;
      case 0x5D: this.EOR(this.rdM(this.aAbsI(this.x, false))); break;
      case 0x59: this.EOR(this.rdM(this.aAbsI(this.y, false))); break;
      case 0x4F: this.EOR(this.rdM(this.aLong())); break;
      case 0x5F: this.EOR(this.rdM(this.aLongX())); break;
      case 0x43: this.EOR(this.rdM(this.aSR())); break;
      case 0x53: this.EOR(this.rdM(this.aSRIY())); break;
      // ---- ADC ----
      case 0x69: this.ADC(this.immM()); break;
      case 0x65: this.ADC(this.rdM(this.aDP())); break;
      case 0x75: this.ADC(this.rdM(this.aDPi(this.x))); break;
      case 0x72: this.ADC(this.rdM(this.aDPInd())); break;
      case 0x61: this.ADC(this.rdM(this.aDPIndX())); break;
      case 0x71: this.ADC(this.rdM(this.aDPIndY(false))); break;
      case 0x67: this.ADC(this.rdM(this.aDPIndL())); break;
      case 0x77: this.ADC(this.rdM(this.aDPIndLY())); break;
      case 0x6D: this.ADC(this.rdM(this.aAbs())); break;
      case 0x7D: this.ADC(this.rdM(this.aAbsI(this.x, false))); break;
      case 0x79: this.ADC(this.rdM(this.aAbsI(this.y, false))); break;
      case 0x6F: this.ADC(this.rdM(this.aLong())); break;
      case 0x7F: this.ADC(this.rdM(this.aLongX())); break;
      case 0x63: this.ADC(this.rdM(this.aSR())); break;
      case 0x73: this.ADC(this.rdM(this.aSRIY())); break;
      // ---- SBC ----
      case 0xE9: this.SBC(this.immM()); break;
      case 0xE5: this.SBC(this.rdM(this.aDP())); break;
      case 0xF5: this.SBC(this.rdM(this.aDPi(this.x))); break;
      case 0xF2: this.SBC(this.rdM(this.aDPInd())); break;
      case 0xE1: this.SBC(this.rdM(this.aDPIndX())); break;
      case 0xF1: this.SBC(this.rdM(this.aDPIndY(false))); break;
      case 0xE7: this.SBC(this.rdM(this.aDPIndL())); break;
      case 0xF7: this.SBC(this.rdM(this.aDPIndLY())); break;
      case 0xED: this.SBC(this.rdM(this.aAbs())); break;
      case 0xFD: this.SBC(this.rdM(this.aAbsI(this.x, false))); break;
      case 0xF9: this.SBC(this.rdM(this.aAbsI(this.y, false))); break;
      case 0xEF: this.SBC(this.rdM(this.aLong())); break;
      case 0xFF: this.SBC(this.rdM(this.aLongX())); break;
      case 0xE3: this.SBC(this.rdM(this.aSR())); break;
      case 0xF3: this.SBC(this.rdM(this.aSRIY())); break;
      // ---- CMP ----
      case 0xC9: this.CMP(this.immM()); break;
      case 0xC5: this.CMP(this.rdM(this.aDP())); break;
      case 0xD5: this.CMP(this.rdM(this.aDPi(this.x))); break;
      case 0xD2: this.CMP(this.rdM(this.aDPInd())); break;
      case 0xC1: this.CMP(this.rdM(this.aDPIndX())); break;
      case 0xD1: this.CMP(this.rdM(this.aDPIndY(false))); break;
      case 0xC7: this.CMP(this.rdM(this.aDPIndL())); break;
      case 0xD7: this.CMP(this.rdM(this.aDPIndLY())); break;
      case 0xCD: this.CMP(this.rdM(this.aAbs())); break;
      case 0xDD: this.CMP(this.rdM(this.aAbsI(this.x, false))); break;
      case 0xD9: this.CMP(this.rdM(this.aAbsI(this.y, false))); break;
      case 0xCF: this.CMP(this.rdM(this.aLong())); break;
      case 0xDF: this.CMP(this.rdM(this.aLongX())); break;
      case 0xC3: this.CMP(this.rdM(this.aSR())); break;
      case 0xD3: this.CMP(this.rdM(this.aSRIY())); break;
      // ---- CPX / CPY ----
      case 0xE0: this.CPX(this.immX()); break;
      case 0xE4: this.CPX(this.rdX(this.aDP())); break;
      case 0xEC: this.CPX(this.rdX(this.aAbs())); break;
      case 0xC0: this.CPY(this.immX()); break;
      case 0xC4: this.CPY(this.rdX(this.aDP())); break;
      case 0xCC: this.CPY(this.rdX(this.aAbs())); break;
      // ---- BIT ----
      case 0x89: this.BIT(this.immM(), true); break;
      case 0x24: this.BIT(this.rdM(this.aDP()), false); break;
      case 0x34: this.BIT(this.rdM(this.aDPi(this.x)), false); break;
      case 0x2C: this.BIT(this.rdM(this.aAbs()), false); break;
      case 0x3C: this.BIT(this.rdM(this.aAbsI(this.x, false)), false); break;
      // ---- LDA ----
      case 0xA9: this.setA(this.immM()); break;
      case 0xA5: this.setA(this.rdM(this.aDP())); break;
      case 0xB5: this.setA(this.rdM(this.aDPi(this.x))); break;
      case 0xB2: this.setA(this.rdM(this.aDPInd())); break;
      case 0xA1: this.setA(this.rdM(this.aDPIndX())); break;
      case 0xB1: this.setA(this.rdM(this.aDPIndY(false))); break;
      case 0xA7: this.setA(this.rdM(this.aDPIndL())); break;
      case 0xB7: this.setA(this.rdM(this.aDPIndLY())); break;
      case 0xAD: this.setA(this.rdM(this.aAbs())); break;
      case 0xBD: this.setA(this.rdM(this.aAbsI(this.x, false))); break;
      case 0xB9: this.setA(this.rdM(this.aAbsI(this.y, false))); break;
      case 0xAF: this.setA(this.rdM(this.aLong())); break;
      case 0xBF: this.setA(this.rdM(this.aLongX())); break;
      case 0xA3: this.setA(this.rdM(this.aSR())); break;
      case 0xB3: this.setA(this.rdM(this.aSRIY())); break;
      // ---- LDX / LDY ----
      case 0xA2: this.setXr(this.immX()); break;
      case 0xA6: this.setXr(this.rdX(this.aDP())); break;
      case 0xB6: this.setXr(this.rdX(this.aDPi(this.y))); break;
      case 0xAE: this.setXr(this.rdX(this.aAbs())); break;
      case 0xBE: this.setXr(this.rdX(this.aAbsI(this.y, false))); break;
      case 0xA0: this.setYr(this.immX()); break;
      case 0xA4: this.setYr(this.rdX(this.aDP())); break;
      case 0xB4: this.setYr(this.rdX(this.aDPi(this.x))); break;
      case 0xAC: this.setYr(this.rdX(this.aAbs())); break;
      case 0xBC: this.setYr(this.rdX(this.aAbsI(this.x, false))); break;
      // ---- STA ----
      case 0x85: this.wrM(this.aDP(), this.a); break;
      case 0x95: this.wrM(this.aDPi(this.x), this.a); break;
      case 0x92: this.wrM(this.aDPInd(), this.a); break;
      case 0x81: this.wrM(this.aDPIndX(), this.a); break;
      case 0x91: this.wrM(this.aDPIndY(true), this.a); break;
      case 0x87: this.wrM(this.aDPIndL(), this.a); break;
      case 0x97: this.wrM(this.aDPIndLY(), this.a); break;
      case 0x8D: this.wrM(this.aAbs(), this.a); break;
      case 0x9D: this.wrM(this.aAbsI(this.x, true), this.a); break;
      case 0x99: this.wrM(this.aAbsI(this.y, true), this.a); break;
      case 0x8F: this.wrM(this.aLong(), this.a); break;
      case 0x9F: this.wrM(this.aLongX(), this.a); break;
      case 0x83: this.wrM(this.aSR(), this.a); break;
      case 0x93: this.wrM(this.aSRIY(), this.a); break;
      // ---- STX / STY / STZ ----
      case 0x86: this.wrX(this.aDP(), this.x); break;
      case 0x96: this.wrX(this.aDPi(this.y), this.x); break;
      case 0x8E: this.wrX(this.aAbs(), this.x); break;
      case 0x84: this.wrX(this.aDP(), this.y); break;
      case 0x94: this.wrX(this.aDPi(this.x), this.y); break;
      case 0x8C: this.wrX(this.aAbs(), this.y); break;
      case 0x64: this.wrM(this.aDP(), 0); break;
      case 0x74: this.wrM(this.aDPi(this.x), 0); break;
      case 0x9C: this.wrM(this.aAbs(), 0); break;
      case 0x9E: this.wrM(this.aAbsI(this.x, true), 0); break;
      // ---- shifts / inc / dec ----
      case 0x0A: this.accOp(this.ASLv); break;
      case 0x06: this.rmw(this.aDP(), this.ASLv); break;
      case 0x16: this.rmw(this.aDPi(this.x), this.ASLv); break;
      case 0x0E: this.rmw(this.aAbs(), this.ASLv); break;
      case 0x1E: this.rmw(this.aAbsI(this.x, true), this.ASLv); break;
      case 0x4A: this.accOp(this.LSRv); break;
      case 0x46: this.rmw(this.aDP(), this.LSRv); break;
      case 0x56: this.rmw(this.aDPi(this.x), this.LSRv); break;
      case 0x4E: this.rmw(this.aAbs(), this.LSRv); break;
      case 0x5E: this.rmw(this.aAbsI(this.x, true), this.LSRv); break;
      case 0x2A: this.accOp(this.ROLv); break;
      case 0x26: this.rmw(this.aDP(), this.ROLv); break;
      case 0x36: this.rmw(this.aDPi(this.x), this.ROLv); break;
      case 0x2E: this.rmw(this.aAbs(), this.ROLv); break;
      case 0x3E: this.rmw(this.aAbsI(this.x, true), this.ROLv); break;
      case 0x6A: this.accOp(this.RORv); break;
      case 0x66: this.rmw(this.aDP(), this.RORv); break;
      case 0x76: this.rmw(this.aDPi(this.x), this.RORv); break;
      case 0x6E: this.rmw(this.aAbs(), this.RORv); break;
      case 0x7E: this.rmw(this.aAbsI(this.x, true), this.RORv); break;
      case 0x1A: this.accOp(this.INCv); break;
      case 0xE6: this.rmw(this.aDP(), this.INCv); break;
      case 0xF6: this.rmw(this.aDPi(this.x), this.INCv); break;
      case 0xEE: this.rmw(this.aAbs(), this.INCv); break;
      case 0xFE: this.rmw(this.aAbsI(this.x, true), this.INCv); break;
      case 0x3A: this.accOp(this.DECv); break;
      case 0xC6: this.rmw(this.aDP(), this.DECv); break;
      case 0xD6: this.rmw(this.aDPi(this.x), this.DECv); break;
      case 0xCE: this.rmw(this.aAbs(), this.DECv); break;
      case 0xDE: this.rmw(this.aAbsI(this.x, true), this.DECv); break;
      case 0x04: this.rmw(this.aDP(), this.TSBv); break;
      case 0x0C: this.rmw(this.aAbs(), this.TSBv); break;
      case 0x14: this.rmw(this.aDP(), this.TRBv); break;
      case 0x1C: this.rmw(this.aAbs(), this.TRBv); break;
      case 0xE8: this.idle(); this.setXr(this.x + 1); break;
      case 0xC8: this.idle(); this.setYr(this.y + 1); break;
      case 0xCA: this.idle(); this.setXr(this.x - 1); break;
      case 0x88: this.idle(); this.setYr(this.y - 1); break;
      // ---- branches ----
      case 0x10: this.branch(!this.fN); break;
      case 0x30: this.branch(this.fN); break;
      case 0x50: this.branch(!this.fV); break;
      case 0x70: this.branch(this.fV); break;
      case 0x90: this.branch(!this.fC); break;
      case 0xB0: this.branch(this.fC); break;
      case 0xD0: this.branch(!this.fZ); break;
      case 0xF0: this.branch(this.fZ); break;
      case 0x80: this.branch(true); break;
      case 0x82: { const off = this.fetch16(); this.idle(); this.pc = (this.pc + ((off << 16) >> 16)) & 0xFFFF; break; }
      // ---- jumps ----
      case 0x4C: this.pc = this.fetch16(); break;
      case 0x5C: { const t = this.fetch24(); this.pc = t & 0xFFFF; this.pbr = t >> 16; break; }
      case 0x6C: { const p = this.fetch16(); this.pc = this.rd(p) | (this.rd((p + 1) & 0xFFFF) << 8); break; }
      case 0x7C: { const p = (this.fetch16() + this.x) & 0xFFFF; this.idle(); const b = this.pbr << 16; this.pc = this.rd(b | p) | (this.rd(b | ((p + 1) & 0xFFFF)) << 8); break; }
      case 0xDC: { const p = this.fetch16(); this.pc = this.rd(p) | (this.rd((p + 1) & 0xFFFF) << 8); this.pbr = this.rd((p + 2) & 0xFFFF); break; }
      case 0x20: { const t = this.fetch16(); this.idle(); this.push16((this.pc - 1) & 0xFFFF); this.pc = t; break; }
      case 0xFC: { const lo = this.fetch8(); this.pushN16(this.pc); const hi = this.fetch8(); const p = ((hi << 8 | lo) + this.x) & 0xFFFF; this.idle(); const b = this.pbr << 16; this.pc = this.rd(b | p) | (this.rd(b | ((p + 1) & 0xFFFF)) << 8); this.fixS(); break; }
      case 0x22: { const lo = this.fetch16(); this.pushN8(this.pbr); this.idle(); const bank = this.fetch8(); this.pushN16((this.pc - 1) & 0xFFFF); this.pc = lo; this.pbr = bank; this.fixS(); break; }
      case 0x60: { this.idle(); this.idle(); this.pc = (this.pull16() + 1) & 0xFFFF; this.idle(); break; }
      case 0x6B: { this.idle(); this.idle(); this.pc = (this.pullN16() + 1) & 0xFFFF; this.pbr = this.pullN8(); this.fixS(); break; }
      case 0x40: { this.idle(); this.idle(); this.setP(this.pull8()); this.pc = this.pull16(); if (!this.e) this.pbr = this.pull8(); break; }
      case 0x00: this.fetch8(); this.interrupt(0xFFE6, 0xFFFE, true); break;
      case 0x02: this.fetch8(); this.interrupt(0xFFE4, 0xFFF4, false); break;
      // ---- stack ----
      case 0x48: this.idle(); if (this.fM) this.push8(this.a); else this.push16(this.a); break;
      case 0x68: this.idle(); this.idle(); this.setA(this.fM ? this.pull8() : this.pull16()); break;
      case 0xDA: this.idle(); if (this.fX) this.push8(this.x); else this.push16(this.x); break;
      case 0xFA: this.idle(); this.idle(); this.setXr(this.fX ? this.pull8() : this.pull16()); break;
      case 0x5A: this.idle(); if (this.fX) this.push8(this.y); else this.push16(this.y); break;
      case 0x7A: this.idle(); this.idle(); this.setYr(this.fX ? this.pull8() : this.pull16()); break;
      case 0x08: this.idle(); this.push8(this.e ? (this.getP() | 0x30) : this.getP()); break;
      case 0x28: this.idle(); this.idle(); this.setP(this.pull8()); break;
      case 0x8B: this.idle(); this.push8(this.dbr); break;
      case 0xAB: this.idle(); this.idle(); this.dbr = this.pullN8(); this.nz8(this.dbr); this.fixS(); break;
      case 0x0B: this.idle(); this.pushN16(this.d); this.fixS(); break;
      case 0x2B: this.idle(); this.idle(); this.d = this.pullN16(); this.nz16(this.d); this.fixS(); break;
      case 0x4B: this.idle(); this.push8(this.pbr); break;
      case 0xF4: this.pushN16(this.fetch16()); this.fixS(); break;
      case 0xD4: { const p = this.aDP(); this.pushN16(this.ptr16(p)); this.fixS(); break; }
      case 0x62: { const off = this.fetch16(); this.idle(); this.pushN16((this.pc + off) & 0xFFFF); this.fixS(); break; }
      // ---- transfers ----
      case 0xAA: this.idle(); this.setXr(this.a); break;
      case 0xA8: this.idle(); this.setYr(this.a); break;
      case 0x8A: this.idle(); this.setA(this.x); break;
      case 0x98: this.idle(); this.setA(this.y); break;
      case 0x9B: this.idle(); this.setYr(this.x); break;
      case 0xBB: this.idle(); this.setXr(this.y); break;
      case 0xBA: this.idle(); this.setXr(this.s); break;
      case 0x9A: this.idle(); this.s = this.e ? (0x100 | (this.x & 0xFF)) : this.x; break;
      case 0x1B: this.idle(); this.s = this.e ? (0x100 | (this.a & 0xFF)) : this.a; break;
      case 0x3B: this.idle(); this.a = this.s; this.nz16(this.a); break;
      case 0x5B: this.idle(); this.d = this.a; this.nz16(this.d); break;
      case 0x7B: this.idle(); this.a = this.d; this.nz16(this.a); break;
      case 0xEB: this.idle(); this.idle(); this.a = ((this.a >> 8) | (this.a << 8)) & 0xFFFF; this.nz8(this.a & 0xFF); break;
      // ---- flags ----
      case 0x18: this.idle(); this.fC = 0; break;
      case 0x38: this.idle(); this.fC = 1; break;
      case 0x58: this.idle(); this.fI = 0; break;
      case 0x78: this.idle(); this.fI = 1; break;
      case 0xB8: this.idle(); this.fV = 0; break;
      case 0xD8: this.idle(); this.fD = 0; break;
      case 0xF8: this.idle(); this.fD = 1; break;
      case 0xC2: { const m = this.fetch8(); this.idle(); this.setP(this.getP() & ~m); break; }
      case 0xE2: { const m = this.fetch8(); this.idle(); this.setP(this.getP() | m); break; }
      case 0xFB: {
        this.idle(); const c = this.fC; this.fC = this.e; this.e = c;
        if (this.e) { this.fM = 1; this.fX = 1; this.x &= 0xFF; this.y &= 0xFF; this.s = 0x100 | (this.s & 0xFF); }
        break;
      }
      // ---- block moves ----
      case 0x54: case 0x44: {
        const dst = this.fetch8(), src = this.fetch8();
        this.dbr = dst;
        v = this.rd((src << 16) | this.x); this.wr((dst << 16) | this.y, v);
        this.idle(); this.idle();
        const inc = op === 0x54 ? 1 : -1;
        const mask = this.fX ? 0xFF : 0xFFFF;
        this.x = (this.x + inc) & mask; this.y = (this.y + inc) & mask;
        this.a = (this.a - 1) & 0xFFFF;
        if (this.a !== 0xFFFF) this.pc = (this.pc - 3) & 0xFFFF;
        break;
      }
      // ---- misc ----
      case 0xEA: this.idle(); break;
      case 0x42: this.fetch8(); break; // WDM
      case 0xCB: this.idle(); this.idle(); this.waiting = true; break;
      case 0xDB: this.idle(); this.idle(); this.stopped = true; break;
      default: this.idle(); break;
    }
  }
}
