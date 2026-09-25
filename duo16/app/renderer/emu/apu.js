// ===== APU: SPC700 CPU + S-DSP =====
const IPL_ROM = new Uint8Array([
  0xCD, 0xEF, 0xBD, 0xE8, 0x00, 0xC6, 0x1D, 0xD0, 0xFC, 0x8F, 0xAA, 0xF4, 0x8F, 0xBB, 0xF5, 0x78,
  0xCC, 0xF4, 0xD0, 0xFB, 0x2F, 0x19, 0xEB, 0xF4, 0xD0, 0xFC, 0x7E, 0xF4, 0xD0, 0x0B, 0xE4, 0xF5,
  0xCB, 0xF4, 0xD7, 0x00, 0xFC, 0xD0, 0xF3, 0xAB, 0x01, 0x10, 0xEF, 0x7E, 0xF4, 0x10, 0xEB, 0xBA,
  0xF6, 0xDA, 0x00, 0xBA, 0xF4, 0xC4, 0xF4, 0xDD, 0x5D, 0xD0, 0xDB, 0x1F, 0x00, 0x00, 0xC0, 0xFF,
]);

const SPC_CYCLES = new Uint8Array([
  2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 4, 6, 8,
  2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 6, 5, 2, 2, 4, 6,
  2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 4, 5, 4,
  2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 6, 5, 2, 2, 3, 8,
  2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 4, 6, 6,
  2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 4, 5, 2, 2, 4, 3,
  2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 4, 5, 5,
  2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 3, 6,
  2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 2, 4, 5,
  2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 12, 5,
  3, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 2, 4, 4,
  2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 3, 4,
  3, 8, 4, 5, 4, 5, 4, 7, 2, 5, 6, 4, 5, 2, 4, 9,
  2, 8, 4, 5, 5, 6, 6, 7, 4, 5, 5, 5, 2, 2, 6, 3,
  2, 8, 4, 5, 3, 4, 3, 6, 2, 4, 5, 3, 4, 3, 4, 3,
  2, 8, 4, 5, 4, 5, 5, 6, 3, 4, 5, 4, 2, 2, 4, 3,
]);

const DSP_COUNTER_RATES = [30721, 2048, 1536, 1280, 1024, 768, 640, 512, 384, 320, 256, 192, 160, 128, 96, 80,
  64, 48, 40, 32, 24, 20, 16, 12, 10, 8, 6, 5, 4, 3, 2, 1];
const DSP_COUNTER_OFFSETS = [1, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536,
  0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 0, 0];

// NTSC master clock and SPC clock (Hz)
const MASTER_HZ = 21477272;
const SPC_HZ = 1024000;

class DSPVoice {
  constructor() { this.reset(); }
  reset() {
    this.brrAddr = 0; this.brrOffset = 1; this.brrHeader = 0;
    this.buf = new Int16Array(16); this.bufPos = 16; // decoded block samples, index of next sample to shift in
    this.hist = new Int32Array(4); // last 4 samples for interpolation (hist[3] newest)
    this.p1 = 0; this.p2 = 0; // BRR filter history
    this.pos = 0; // pitch counter fraction (12 bits)
    this.env = 0; this.hiddenEnv = 0; this.envMode = 0; // 0 release,1 attack,2 decay,3 sustain
    this.konDelay = 0; this.out = 0;
    this.endPending = false; this.stopped = true;
  }
}

class APU {
  constructor() {
    this.ram = new Uint8Array(0x10000);
    this.dspRegs = new Uint8Array(128);
    this.voices = [];
    for (let i = 0; i < 8; i++) this.voices.push(new DSPVoice());
    this.echoHistL = new Int32Array(8); this.echoHistR = new Int32Array(8);
    this.audioBuf = new Int16Array(4096 * 2);
    this.audioLen = 0;
    this.reset();
  }

  reset() {
    this.ram.fill(0);
    this.a = 0; this.x = 0; this.y = 0; this.sp = 0xEF; this.pc = 0xFFC0;
    this.fN = 0; this.fV = 0; this.fP = 0; this.fB = 0; this.fH = 0; this.fI = 0; this.fZ = 0; this.fC = 0;
    this.portIn = new Uint8Array(4); this.portOut = new Uint8Array(4);
    this.control = 0x80; this.dspAddr = 0;
    this.timerTarget = new Uint16Array([256, 256, 256]);
    this.timerStage = new Int32Array(3); this.timerOut = new Uint8Array(3); this.timerEnable = new Uint8Array(3);
    this.timerDiv = new Int32Array(3);
    this.halted = false;
    this.cycleDebt = 0; // spc cycles owed (negative = ahead)
    this.masterAcc = 0; this.lastMaster = 0;
    this.dspCycle = 0;
    // DSP state
    this.dspRegs.fill(0);
    this.dspRegs[0x6C] = 0xE0;
    for (const v of this.voices) v.reset();
    this.counter = 0; this.everyOther = 0;
    this.konPending = 0; this.noise = 0x4000;
    this.echoPos = 0; this.echoLen = 0; this.echoHistPos = 0;
    this.echoHistL.fill(0); this.echoHistR.fill(0);
    this.audioLen = 0;
  }

  // ---- CPU-side ports ----
  readPort(i) { return this.portOut[i]; }
  writePort(i, v) { this.portIn[i] = v; }

  // ---- timing ----
  catchUp(totalMaster) {
    const delta = totalMaster - this.lastMaster;
    this.lastMaster = totalMaster;
    this.masterAcc += delta * SPC_HZ;
    const cyc = Math.floor(this.masterAcc / MASTER_HZ);
    this.masterAcc -= cyc * MASTER_HZ;
    this.cycleDebt += cyc;
    while (this.cycleDebt > 0) {
      const c = this.halted ? 2 : this.step();
      this.cycleDebt -= c;
      this.advance(c);
    }
  }
  endFrame() { }

  advance(c) {
    // timers
    for (let t = 0; t < 3; t++) {
      if (!this.timerEnable[t]) continue;
      this.timerDiv[t] += c;
      const period = t === 2 ? 16 : 128;
      while (this.timerDiv[t] >= period) {
        this.timerDiv[t] -= period;
        this.timerStage[t]++;
        if (this.timerStage[t] >= this.timerTarget[t]) {
          this.timerStage[t] = 0;
          this.timerOut[t] = (this.timerOut[t] + 1) & 0xF;
        }
      }
    }
    this.dspCycle += c;
    while (this.dspCycle >= 32) { this.dspCycle -= 32; this.dspSample(); }
  }

  // ---- SPC memory ----
  read(a) {
    a &= 0xFFFF;
    if (a >= 0xF0 && a <= 0xFF) {
      switch (a) {
        case 0xF2: return this.dspAddr;
        case 0xF3: return this.dspRead(this.dspAddr & 0x7F);
        case 0xF4: case 0xF5: case 0xF6: case 0xF7: return this.portIn[a - 0xF4];
        case 0xFD: case 0xFE: case 0xFF: { const t = a - 0xFD; const v = this.timerOut[t]; this.timerOut[t] = 0; return v; }
        case 0xF0: case 0xF1: case 0xFA: case 0xFB: case 0xFC: return 0;
        default: return this.ram[a];
      }
    }
    if (a >= 0xFFC0 && (this.control & 0x80)) return IPL_ROM[a - 0xFFC0];
    return this.ram[a];
  }
  write(a, v) {
    a &= 0xFFFF;
    if (a >= 0xF0 && a <= 0xFF) {
      switch (a) {
        case 0xF1:
          for (let t = 0; t < 3; t++) {
            const en = (v >> t) & 1;
            if (en && !this.timerEnable[t]) { this.timerStage[t] = 0; this.timerOut[t] = 0; }
            this.timerEnable[t] = en;
          }
          if (v & 0x10) { this.portIn[0] = 0; this.portIn[1] = 0; }
          if (v & 0x20) { this.portIn[2] = 0; this.portIn[3] = 0; }
          this.control = v;
          break;
        case 0xF2: this.dspAddr = v; break;
        case 0xF3: if (this.dspAddr < 0x80) this.dspWrite(this.dspAddr, v); break;
        case 0xF4: case 0xF5: case 0xF6: case 0xF7: this.portOut[a - 0xF4] = v; break;
        case 0xFA: case 0xFB: case 0xFC: this.timerTarget[a - 0xFA] = v === 0 ? 256 : v; break;
      }
    }
    this.ram[a] = v;
  }
  dp(o) { return (this.fP << 8) | (o & 0xFF); }
  rdDP(o) { return this.read(this.dp(o)); }
  wrDP(o, v) { this.write(this.dp(o), v); }
  fetch() { const v = this.read(this.pc); this.pc = (this.pc + 1) & 0xFFFF; return v; }
  fetch16() { const lo = this.fetch(); return lo | (this.fetch() << 8); }
  push(v) { this.ram[0x100 | this.sp] = v; this.sp = (this.sp - 1) & 0xFF; }
  pop() { this.sp = (this.sp + 1) & 0xFF; return this.ram[0x100 | this.sp]; }
  getPSW() { return (this.fN << 7) | (this.fV << 6) | (this.fP << 5) | (this.fB << 4) | (this.fH << 3) | (this.fI << 2) | (this.fZ << 1) | this.fC; }
  setPSW(v) { this.fN = (v >> 7) & 1; this.fV = (v >> 6) & 1; this.fP = (v >> 5) & 1; this.fB = (v >> 4) & 1; this.fH = (v >> 3) & 1; this.fI = (v >> 2) & 1; this.fZ = (v >> 1) & 1; this.fC = v & 1; }
  nz(v) { this.fN = (v >> 7) & 1; this.fZ = (v & 0xFF) === 0 ? 1 : 0; return v & 0xFF; }

  // addressing: return address
  aDPX() { return this.dp((this.fetch() + this.x) & 0xFF); }
  aDPY() { return this.dp((this.fetch() + this.y) & 0xFF); }
  aAbs() { return this.fetch16(); }
  aAbsX() { return (this.fetch16() + this.x) & 0xFFFF; }
  aAbsY() { return (this.fetch16() + this.y) & 0xFFFF; }
  aIX() { return this.dp(this.x); }
  aIndX() { const o = (this.fetch() + this.x) & 0xFF; return this.rdDP(o) | (this.rdDP((o + 1) & 0xFF) << 8); }
  aIndY() { const o = this.fetch(); return ((this.rdDP(o) | (this.rdDP((o + 1) & 0xFF) << 8)) + this.y) & 0xFFFF; }

  adc(a, b) {
    const r = a + b + this.fC;
    this.fV = (~(a ^ b) & (a ^ r) & 0x80) ? 1 : 0;
    this.fH = ((a ^ b ^ r) & 0x10) ? 1 : 0;
    this.fC = r > 0xFF ? 1 : 0;
    return this.nz(r);
  }
  sbc(a, b) { return this.adc(a, (~b) & 0xFF); }
  cmp(a, b) { const r = a - b; this.fC = r >= 0 ? 1 : 0; this.nz(r & 0xFF); }
  asl(v) { this.fC = (v >> 7) & 1; return this.nz(v << 1); }
  lsr(v) { this.fC = v & 1; return this.nz(v >> 1); }
  rol(v) { const c = this.fC; this.fC = (v >> 7) & 1; return this.nz((v << 1) | c); }
  ror(v) { const c = this.fC; this.fC = v & 1; return this.nz((v >> 1) | (c << 7)); }
  branch(cond, off) { if (cond) { this.pc = (this.pc + ((off << 24) >> 24)) & 0xFFFF; return 2; } return 0; }
  rd16dp(o) { return this.rdDP(o) | (this.rdDP((o + 1) & 0xFF) << 8); }
  wr16dp(o, v) { this.wrDP(o, v & 0xFF); this.wrDP((o + 1) & 0xFF, (v >> 8) & 0xFF); }
  memBit() { const w = this.fetch16(); return [w & 0x1FFF, w >> 13]; }

  // ALU op by index: 0 OR, 1 AND, 2 EOR, 3 CMP, 4 ADC, 5 SBC
  alu(op, a, b) {
    switch (op) {
      case 0: return this.nz(a | b);
      case 1: return this.nz(a & b);
      case 2: return this.nz(a ^ b);
      case 3: this.cmp(a, b); return a;
      case 4: return this.adc(a, b);
      default: return this.sbc(a, b);
    }
  }

  step() {
    const op = this.fetch();
    let extra = 0;
    const hi = op >> 4, lo = op & 0xF;
    // Regular ALU block: columns 4-9 for rows 0x0-0xB (even/odd patterns)
    if (hi < 0xC && lo >= 4 && lo <= 8 && !(lo === 8 && (hi & 1))) {
      const aluOp = hi >> 1;
      if (!(hi & 1)) {
        let v;
        switch (lo) {
          case 4: v = this.rdDP(this.fetch()); break;
          case 5: v = this.read(this.aAbs()); break;
          case 6: v = this.read(this.aIX()); break;
          case 7: v = this.read(this.aIndX()); break;
          case 8: v = this.fetch(); break;
        }
        this.a = this.alu(aluOp, this.a, v);
      } else {
        let v;
        switch (lo) {
          case 4: v = this.read(this.aDPX()); break;
          case 5: v = this.read(this.aAbsX()); break;
          case 6: v = this.read(this.aAbsY()); break;
          case 7: v = this.read(this.aIndY()); break;
        }
        this.a = this.alu(aluOp, this.a, v);
      }
      return SPC_CYCLES[op];
    }
    // dp,dp / (X),(Y) / dp,#imm forms
    if (hi < 0xC && ((lo === 9) || (lo === 8 && (hi & 1)))) {
      const aluOp = hi >> 1;
      let dstAddr, s, d;
      if (lo === 9 && !(hi & 1)) { const so = this.fetch(); s = this.rdDP(so); const dO = this.fetch(); dstAddr = this.dp(dO); }
      else if (lo === 9) { s = this.read(this.dp(this.y)); dstAddr = this.dp(this.x); }
      else { s = this.fetch(); dstAddr = this.dp(this.fetch()); }
      d = this.read(dstAddr);
      const r = this.alu(aluOp, d, s);
      if (aluOp !== 3) this.write(dstAddr, r);
      return SPC_CYCLES[op];
    }
    if (lo === 1) { // TCALL
      this.push(this.pc >> 8); this.push(this.pc & 0xFF);
      const va = 0xFFDE - (hi << 1);
      this.pc = this.read(va) | (this.read(va + 1) << 8);
      return 8;
    }
    if (lo === 2) { // SET1 / CLR1
      const o = this.fetch(); const bit = hi >> 1; let v = this.rdDP(o);
      if (hi & 1) v &= ~(1 << bit); else v |= 1 << bit;
      this.wrDP(o, v); return 4;
    }
    if (lo === 3) { // BBS / BBC
      const o = this.fetch(); const r = this.fetch(); const bit = hi >> 1; const v = this.rdDP(o);
      const set = (v >> bit) & 1;
      extra = this.branch((hi & 1) ? !set : !!set, r);
      return 5 + extra;
    }
    switch (op) {
      case 0x00: break;
      case 0x10: extra = this.branch(!this.fN, this.fetch()); break;
      case 0x30: extra = this.branch(this.fN, this.fetch()); break;
      case 0x50: extra = this.branch(!this.fV, this.fetch()); break;
      case 0x70: extra = this.branch(this.fV, this.fetch()); break;
      case 0x90: extra = this.branch(!this.fC, this.fetch()); break;
      case 0xB0: extra = this.branch(this.fC, this.fetch()); break;
      case 0xD0: extra = this.branch(!this.fZ, this.fetch()); break;
      case 0xF0: extra = this.branch(this.fZ, this.fetch()); break;
      case 0x2F: this.branch(true, this.fetch()); break;
      case 0x20: this.fP = 0; break;
      case 0x40: this.fP = 1; break;
      case 0x60: this.fC = 0; break;
      case 0x80: this.fC = 1; break;
      case 0xA0: this.fI = 1; break;
      case 0xC0: this.fI = 0; break;
      case 0xE0: this.fV = 0; this.fH = 0; break;
      case 0xED: this.fC ^= 1; break;
      // MOV stores
      case 0xC4: this.wrDP(this.fetch(), this.a); break;
      case 0xD4: this.write(this.aDPX(), this.a); break;
      case 0xC5: this.write(this.aAbs(), this.a); break;
      case 0xD5: this.write(this.aAbsX(), this.a); break;
      case 0xC6: this.write(this.aIX(), this.a); break;
      case 0xD6: this.write(this.aAbsY(), this.a); break;
      case 0xC7: this.write(this.aIndX(), this.a); break;
      case 0xD7: this.write(this.aIndY(), this.a); break;
      case 0xD8: this.wrDP(this.fetch(), this.x); break;
      case 0xD9: this.write(this.aDPY(), this.x); break;
      case 0xC9: this.write(this.aAbs(), this.x); break;
      case 0xCB: this.wrDP(this.fetch(), this.y); break;
      case 0xDB: this.write(this.aDPX(), this.y); break;
      case 0xCC: this.write(this.aAbs(), this.y); break;
      case 0xAF: this.write(this.aIX(), this.a); this.x = (this.x + 1) & 0xFF; break;
      case 0x8F: { const i = this.fetch(); this.wrDP(this.fetch(), i); break; }
      case 0xFA: { const s = this.rdDP(this.fetch()); this.wrDP(this.fetch(), s); break; }
      // MOV loads
      case 0xE4: this.a = this.nz(this.rdDP(this.fetch())); break;
      case 0xF4: this.a = this.nz(this.read(this.aDPX())); break;
      case 0xE5: this.a = this.nz(this.read(this.aAbs())); break;
      case 0xF5: this.a = this.nz(this.read(this.aAbsX())); break;
      case 0xE6: this.a = this.nz(this.read(this.aIX())); break;
      case 0xF6: this.a = this.nz(this.read(this.aAbsY())); break;
      case 0xE7: this.a = this.nz(this.read(this.aIndX())); break;
      case 0xF7: this.a = this.nz(this.read(this.aIndY())); break;
      case 0xE8: this.a = this.nz(this.fetch()); break;
      case 0xBF: this.a = this.nz(this.read(this.aIX())); this.x = (this.x + 1) & 0xFF; break;
      case 0xF8: this.x = this.nz(this.rdDP(this.fetch())); break;
      case 0xF9: this.x = this.nz(this.read(this.aDPY())); break;
      case 0xE9: this.x = this.nz(this.read(this.aAbs())); break;
      case 0xCD: this.x = this.nz(this.fetch()); break;
      case 0xEB: this.y = this.nz(this.rdDP(this.fetch())); break;
      case 0xFB: this.y = this.nz(this.read(this.aDPX())); break;
      case 0xEC: this.y = this.nz(this.read(this.aAbs())); break;
      case 0x8D: this.y = this.nz(this.fetch()); break;
      // register transfers
      case 0x5D: this.x = this.nz(this.a); break;
      case 0x7D: this.a = this.nz(this.x); break;
      case 0xDD: this.a = this.nz(this.y); break;
      case 0xFD: this.y = this.nz(this.a); break;
      case 0x9D: this.x = this.nz(this.sp); break;
      case 0xBD: this.sp = this.x; break;
      // compares with X/Y
      case 0xC8: this.cmp(this.x, this.fetch()); break;
      case 0x3E: this.cmp(this.x, this.rdDP(this.fetch())); break;
      case 0x1E: this.cmp(this.x, this.read(this.aAbs())); break;
      case 0xAD: this.cmp(this.y, this.fetch()); break;
      case 0x7E: this.cmp(this.y, this.rdDP(this.fetch())); break;
      case 0x5E: this.cmp(this.y, this.read(this.aAbs())); break;
      // shifts / inc / dec
      case 0x0B: { const o = this.fetch(); this.wrDP(o, this.asl(this.rdDP(o))); break; }
      case 0x1B: { const a = this.aDPX(); this.write(a, this.asl(this.read(a))); break; }
      case 0x0C: { const a = this.aAbs(); this.write(a, this.asl(this.read(a))); break; }
      case 0x1C: this.a = this.asl(this.a); break;
      case 0x2B: { const o = this.fetch(); this.wrDP(o, this.rol(this.rdDP(o))); break; }
      case 0x3B: { const a = this.aDPX(); this.write(a, this.rol(this.read(a))); break; }
      case 0x2C: { const a = this.aAbs(); this.write(a, this.rol(this.read(a))); break; }
      case 0x3C: this.a = this.rol(this.a); break;
      case 0x4B: { const o = this.fetch(); this.wrDP(o, this.lsr(this.rdDP(o))); break; }
      case 0x5B: { const a = this.aDPX(); this.write(a, this.lsr(this.read(a))); break; }
      case 0x4C: { const a = this.aAbs(); this.write(a, this.lsr(this.read(a))); break; }
      case 0x5C: this.a = this.lsr(this.a); break;
      case 0x6B: { const o = this.fetch(); this.wrDP(o, this.ror(this.rdDP(o))); break; }
      case 0x7B: { const a = this.aDPX(); this.write(a, this.ror(this.read(a))); break; }
      case 0x6C: { const a = this.aAbs(); this.write(a, this.ror(this.read(a))); break; }
      case 0x7C: this.a = this.ror(this.a); break;
      case 0x8B: { const o = this.fetch(); this.wrDP(o, this.nz(this.rdDP(o) - 1)); break; }
      case 0x9B: { const a = this.aDPX(); this.write(a, this.nz(this.read(a) - 1)); break; }
      case 0x8C: { const a = this.aAbs(); this.write(a, this.nz(this.read(a) - 1)); break; }
      case 0x9C: this.a = this.nz(this.a - 1); break;
      case 0xAB: { const o = this.fetch(); this.wrDP(o, this.nz(this.rdDP(o) + 1)); break; }
      case 0xBB: { const a = this.aDPX(); this.write(a, this.nz(this.read(a) + 1)); break; }
      case 0xAC: { const a = this.aAbs(); this.write(a, this.nz(this.read(a) + 1)); break; }
      case 0xBC: this.a = this.nz(this.a + 1); break;
      case 0x1D: this.x = this.nz(this.x - 1); break;
      case 0x3D: this.x = this.nz(this.x + 1); break;
      case 0xDC: this.y = this.nz(this.y - 1); break;
      case 0xFC: this.y = this.nz(this.y + 1); break;
      // 16-bit
      case 0x1A: { const o = this.fetch(); const v = (this.rd16dp(o) - 1) & 0xFFFF; this.wr16dp(o, v); this.fN = v >> 15; this.fZ = v === 0 ? 1 : 0; break; }
      case 0x3A: { const o = this.fetch(); const v = (this.rd16dp(o) + 1) & 0xFFFF; this.wr16dp(o, v); this.fN = v >> 15; this.fZ = v === 0 ? 1 : 0; break; }
      case 0x5A: { const v = this.rd16dp(this.fetch()); const ya = (this.y << 8) | this.a; const r = ya - v; this.fC = r >= 0 ? 1 : 0; this.fN = (r >> 15) & 1; this.fZ = (r & 0xFFFF) === 0 ? 1 : 0; break; }
      case 0x7A: {
        const v = this.rd16dp(this.fetch()); const ya = (this.y << 8) | this.a; const r = ya + v;
        this.fV = (~(ya ^ v) & (ya ^ r) & 0x8000) ? 1 : 0; this.fH = ((ya ^ v ^ r) & 0x1000) ? 1 : 0;
        this.fC = r > 0xFFFF ? 1 : 0; const rr = r & 0xFFFF; this.a = rr & 0xFF; this.y = rr >> 8; this.fN = rr >> 15; this.fZ = rr === 0 ? 1 : 0; break;
      }
      case 0x9A: {
        const v = this.rd16dp(this.fetch()); const ya = (this.y << 8) | this.a; const r = ya - v;
        this.fV = ((ya ^ v) & (ya ^ r) & 0x8000) ? 1 : 0; this.fH = ((ya ^ v ^ r) & 0x1000) ? 0 : 1;
        this.fC = r >= 0 ? 1 : 0; const rr = r & 0xFFFF; this.a = rr & 0xFF; this.y = rr >> 8; this.fN = rr >> 15; this.fZ = rr === 0 ? 1 : 0; break;
      }
      case 0xBA: { const v = this.rd16dp(this.fetch()); this.a = v & 0xFF; this.y = v >> 8; this.fN = v >> 15; this.fZ = v === 0 ? 1 : 0; break; }
      case 0xDA: { const o = this.fetch(); this.wr16dp(o, (this.y << 8) | this.a); break; }
      case 0xCF: { const r = this.y * this.a; this.a = r & 0xFF; this.y = (r >> 8) & 0xFF; this.nz(this.y); break; }
      case 0x9E: {
        const ya = (this.y << 8) | this.a; const x = this.x;
        this.fH = (this.y & 15) >= (x & 15) ? 1 : 0;
        this.fV = this.y >= x ? 1 : 0;
        if (this.y < (x << 1)) { this.a = Math.floor(ya / x) & 0xFF; this.y = (ya % x) & 0xFF; }
        else { this.a = (255 - Math.floor((ya - (x << 9)) / (256 - x))) & 0xFF; this.y = (x + ((ya - (x << 9)) % (256 - x))) & 0xFF; }
        this.nz(this.a); break;
      }
      case 0xDF: {
        if (this.fC || this.a > 0x99) { this.a = (this.a + 0x60) & 0xFF; this.fC = 1; }
        if (this.fH || (this.a & 15) > 9) this.a = (this.a + 6) & 0xFF;
        this.nz(this.a); break;
      }
      case 0xBE: {
        if (!this.fC || this.a > 0x99) { this.a = (this.a - 0x60) & 0xFF; this.fC = 0; }
        if (!this.fH || (this.a & 15) > 9) this.a = (this.a - 6) & 0xFF;
        this.nz(this.a); break;
      }
      case 0x9F: this.a = this.nz(((this.a >> 4) | (this.a << 4)) & 0xFF); break;
      // bit ops on m.b
      case 0x0E: case 0x4E: { const a = this.aAbs(); const v = this.read(a); this.nz((this.a - v) & 0xFF); this.write(a, op === 0x0E ? (v | this.a) : (v & ~this.a & 0xFF)); break; }
      case 0x0A: { const [a, b] = this.memBit(); this.fC |= (this.read(a) >> b) & 1; break; }
      case 0x2A: { const [a, b] = this.memBit(); this.fC |= ((this.read(a) >> b) & 1) ^ 1; break; }
      case 0x4A: { const [a, b] = this.memBit(); this.fC &= (this.read(a) >> b) & 1; break; }
      case 0x6A: { const [a, b] = this.memBit(); this.fC &= ((this.read(a) >> b) & 1) ^ 1; break; }
      case 0x8A: { const [a, b] = this.memBit(); this.fC ^= (this.read(a) >> b) & 1; break; }
      case 0xAA: { const [a, b] = this.memBit(); this.fC = (this.read(a) >> b) & 1; break; }
      case 0xCA: { const [a, b] = this.memBit(); let v = this.read(a); v = this.fC ? (v | (1 << b)) : (v & ~(1 << b)); this.write(a, v & 0xFF); break; }
      case 0xEA: { const [a, b] = this.memBit(); this.write(a, this.read(a) ^ (1 << b)); break; }
      // branches with memory
      case 0x2E: { const v = this.rdDP(this.fetch()); const r = this.fetch(); extra = this.branch(this.a !== v, r); break; }
      case 0xDE: { const v = this.read(this.aDPX()); const r = this.fetch(); extra = this.branch(this.a !== v, r); break; }
      case 0x6E: { const o = this.fetch(); const v = (this.rdDP(o) - 1) & 0xFF; this.wrDP(o, v); const r = this.fetch(); extra = this.branch(v !== 0, r); break; }
      case 0xFE: { this.y = (this.y - 1) & 0xFF; extra = this.branch(this.y !== 0, this.fetch()); break; }
      // jumps / calls
      case 0x5F: this.pc = this.fetch16(); break;
      case 0x1F: { const a = this.aAbsX(); this.pc = this.read(a) | (this.read((a + 1) & 0xFFFF) << 8); break; }
      case 0x3F: { const t = this.fetch16(); this.push(this.pc >> 8); this.push(this.pc & 0xFF); this.pc = t; break; }
      case 0x4F: { const t = this.fetch(); this.push(this.pc >> 8); this.push(this.pc & 0xFF); this.pc = 0xFF00 | t; break; }
      case 0x6F: { const l = this.pop(); this.pc = l | (this.pop() << 8); break; }
      case 0x7F: { this.setPSW(this.pop()); const l = this.pop(); this.pc = l | (this.pop() << 8); break; }
      case 0x0F: {
        this.push(this.pc >> 8); this.push(this.pc & 0xFF); this.push(this.getPSW());
        this.fB = 1; this.fI = 0; this.pc = this.read(0xFFDE) | (this.read(0xFFDF) << 8); break;
      }
      // stack
      case 0x0D: this.push(this.getPSW()); break;
      case 0x2D: this.push(this.a); break;
      case 0x4D: this.push(this.x); break;
      case 0x6D: this.push(this.y); break;
      case 0x8E: this.setPSW(this.pop()); break;
      case 0xAE: this.a = this.pop(); break;
      case 0xCE: this.x = this.pop(); break;
      case 0xEE: this.y = this.pop(); break;
      case 0xEF: case 0xFF: this.halted = true; break;
      default: break;
    }
    return SPC_CYCLES[op] + extra;
  }

  // ================= DSP =================
  dspRead(r) { return this.dspRegs[r]; }
  dspWrite(r, v) {
    this.dspRegs[r] = v;
    if (r === 0x4C) this.konPending = v;
    else if (r === 0x7C) this.dspRegs[0x7C] = 0;
  }

  readCounter(rate) {
    return ((this.counter + DSP_COUNTER_OFFSETS[rate]) % DSP_COUNTER_RATES[rate]) !== 0;
  }

  decodeBRRBlock(v) {
    const ram = this.ram;
    const header = ram[v.brrAddr];
    v.brrHeader = header;
    const shift = header >> 4, filter = header & 0x0C;
    for (let i = 0; i < 16; i++) {
      const byte = ram[(v.brrAddr + 1 + (i >> 1)) & 0xFFFF];
      let s = (i & 1) ? (byte & 0xF) : (byte >> 4);
      if (s >= 8) s -= 16;
      s = (s << shift) >> 1;
      if (shift >= 0xD) s = s < 0 ? -2048 : 0;
      const p1 = v.p1, p2 = v.p2 >> 1;
      if (filter >= 8) {
        s += p1; s -= p2;
        if (filter === 8) { s += p2 >> 4; s += (p1 * -3) >> 6; }
        else { s += (p1 * -13) >> 7; s += (p2 * 3) >> 4; }
      } else if (filter) { s += p1 >> 1; s += (-p1) >> 5; }
      if (s > 32767) s = 32767; else if (s < -32768) s = -32768;
      s = ((s * 2) << 16) >> 16;
      v.p2 = v.p1; v.p1 = s;
      v.buf[i] = s;
    }
    v.bufPos = 0;
  }

  dirEntry(srcn, loop) {
    const a = ((this.dspRegs[0x5D] << 8) + srcn * 4 + (loop ? 2 : 0)) & 0xFFFF;
    return this.ram[a] | (this.ram[(a + 1) & 0xFFFF] << 8);
  }

  nextSample(v, idx) {
    if (v.bufPos >= 16) {
      // advance to next block
      if (v.brrHeader & 1) {
        this.dspRegs[0x7C] |= 1 << idx;
        if (v.brrHeader & 2) {
          v.brrAddr = this.dirEntry(this.dspRegs[idx * 16 + 4], true);
        } else {
          v.envMode = 0; v.env = 0; v.stopped = true;
          v.brrAddr = (v.brrAddr + 9) & 0xFFFF;
        }
      } else v.brrAddr = (v.brrAddr + 9) & 0xFFFF;
      this.decodeBRRBlock(v);
    }
    const s = v.buf[v.bufPos++];
    v.hist[0] = v.hist[1]; v.hist[1] = v.hist[2]; v.hist[2] = v.hist[3]; v.hist[3] = s;
  }

  runEnvelope(v, idx) {
    const regs = this.dspRegs; const base = idx * 16;
    let env = v.env;
    if (v.envMode === 0) { env -= 8; if (env < 0) env = 0; v.env = env; return; }
    let rate;
    const adsr1 = regs[base + 5];
    let envData = regs[base + 6];
    if (adsr1 & 0x80) {
      if (v.envMode >= 2) {
        env--; env -= env >> 8;
        rate = envData & 0x1F;
        if (v.envMode === 2) rate = ((adsr1 >> 3) & 0x0E) + 0x10;
      } else {
        rate = (adsr1 & 0x0F) * 2 + 1;
        env += rate < 31 ? 0x20 : 0x400;
      }
    } else {
      envData = regs[base + 7];
      const mode = envData >> 5;
      if (mode < 4) { env = envData * 0x10; rate = 31; }
      else {
        rate = envData & 0x1F;
        if (mode === 4) env -= 0x20;
        else if (mode < 6) { env--; env -= env >> 8; }
        else { env += 0x20; if (mode > 6 && (v.hiddenEnv >>> 0) >= 0x600) env += 0x8 - 0x20; }
      }
    }
    if ((env >> 8) === (envData >> 5) && v.envMode === 2) v.envMode = 3;
    v.hiddenEnv = env;
    if (env < 0 || env > 0x7FF) { env = env < 0 ? 0 : 0x7FF; if (v.envMode === 1) v.envMode = 2; }
    if (!this.readCounter(rate)) v.env = env;
  }

  dspSample() {
    const regs = this.dspRegs;
    // global counter
    if (--this.counter < 0) this.counter = 0x77FF;
    this.everyOther ^= 1;
    const flg = regs[0x6C];
    // key on / key off
    if (this.everyOther) {
      const kon = this.konPending; this.konPending = 0;
      if (kon) {
        for (let i = 0; i < 8; i++) {
          if (!(kon & (1 << i))) continue;
          const v = this.voices[i];
          v.brrAddr = this.dirEntry(regs[i * 16 + 4], false);
          v.p1 = 0; v.p2 = 0; v.hist.fill(0); v.pos = 0;
          v.konDelay = 5; v.env = 0; v.hiddenEnv = 0; v.envMode = 1; v.stopped = false;
          this.decodeBRRBlock(v);
          regs[0x7C] &= ~(1 << i);
        }
      }
      const koff = regs[0x5C];
      for (let i = 0; i < 8; i++) if ((koff & (1 << i)) && this.voices[i].konDelay === 0) this.voices[i].envMode = 0;
    }
    if (flg & 0x80) { for (const v of this.voices) { v.envMode = 0; v.env = 0; } }
    // noise
    if (!this.readCounter(flg & 0x1F)) {
      const fb = (this.noise << 13) ^ (this.noise << 14);
      this.noise = (fb & 0x4000) ^ (this.noise >> 1);
    }
    let mainL = 0, mainR = 0, echoL = 0, echoR = 0;
    const pmon = regs[0x2D], non = regs[0x3D], eon = regs[0x4D];
    let prevOut = 0;
    for (let i = 0; i < 8; i++) {
      const v = this.voices[i]; const base = i * 16;
      let pitch = (regs[base + 2] | (regs[base + 3] << 8)) & 0x3FFF;
      if ((pmon & (1 << i)) && i > 0) pitch += ((prevOut >> 5) * pitch) >> 10;
      let out = 0;
      if (v.konDelay > 0) {
        v.konDelay--;
        v.env = 0;
      } else if (!v.stopped || v.env > 0) {
        // interpolation (4-point cubic)
        const f = (v.pos >> 4) & 0xFF;
        const s0 = v.hist[0], s1 = v.hist[1], s2 = v.hist[2], s3 = v.hist[3];
        // Catmull-Rom in fixed point (f/256)
        const t = f;
        const a0 = -s0 + 3 * s1 - 3 * s2 + s3;
        const a1 = 2 * s0 - 5 * s1 + 4 * s2 - s3;
        const a2 = -s0 + s2;
        let smp = ((((((a0 * t) >> 8) + a1) * t >> 8) + a2) * t >> 9) + s1;
        if (smp > 32767) smp = 32767; else if (smp < -32768) smp = -32768;
        smp >>= 1; // 15-bit
        if (non & (1 << i)) smp = ((this.noise << 17) >> 16) >> 1;
        out = ((smp * v.env) >> 11) & ~1;
        this.runEnvelope(v, i);
        // advance pitch
        v.pos += pitch;
        while (v.pos >= 0x1000) { v.pos -= 0x1000; this.nextSample(v, i); }
      }
      if (v.konDelay === 0 && v.stopped && v.env === 0) out = 0;
      v.out = out;
      prevOut = out;
      regs[base + 8] = (v.env >> 4) & 0xFF;
      regs[base + 9] = (out >> 8) & 0xFF;
      const vl = (regs[base] << 24) >> 24, vr = (regs[base + 1] << 24) >> 24;
      const l = (out * vl) >> 7, r = (out * vr) >> 7;
      mainL += l; mainR += r;
      if (eon & (1 << i)) { echoL += l; echoR += r; }
    }
    const clamp16 = (x) => x > 32767 ? 32767 : x < -32768 ? -32768 : x;
    mainL = clamp16(mainL); mainR = clamp16(mainR);
    echoL = clamp16(echoL); echoR = clamp16(echoR);
    // echo
    const esa = regs[0x6D] << 8;
    const edl = regs[0x7D] & 0x0F;
    if (this.echoPos === 0) this.echoLen = edl ? edl * 0x800 : 4;
    const ea = (esa + this.echoPos) & 0xFFFF;
    const ram = this.ram;
    const rl = ((ram[ea] | (ram[(ea + 1) & 0xFFFF] << 8)) << 16) >> 16;
    const rr = ((ram[(ea + 2) & 0xFFFF] | (ram[(ea + 3) & 0xFFFF] << 8)) << 16) >> 16;
    this.echoHistPos = (this.echoHistPos + 1) & 7;
    this.echoHistL[this.echoHistPos] = rl >> 1; this.echoHistR[this.echoHistPos] = rr >> 1;
    let fl = 0, fr = 0;
    for (let i = 0; i < 8; i++) {
      const c = (regs[i * 16 + 0x0F] << 24) >> 24;
      const hp = (this.echoHistPos + 1 + i) & 7;
      fl += (this.echoHistL[hp] * c) >> 6; fr += (this.echoHistR[hp] * c) >> 6;
    }
    fl = clamp16((fl << 16) >> 16) & ~1; fr = clamp16((fr << 16) >> 16) & ~1;
    const efb = (regs[0x0D] << 24) >> 24;
    const inL = clamp16(echoL + ((fl * efb) >> 7)) & ~1;
    const inR = clamp16(echoR + ((fr * efb) >> 7)) & ~1;
    if (!(flg & 0x20)) {
      ram[ea] = inL & 0xFF; ram[(ea + 1) & 0xFFFF] = (inL >> 8) & 0xFF;
      ram[(ea + 2) & 0xFFFF] = inR & 0xFF; ram[(ea + 3) & 0xFFFF] = (inR >> 8) & 0xFF;
    }
    this.echoPos += 4;
    if (this.echoPos >= this.echoLen) this.echoPos = 0;
    const mvl = (regs[0x0C] << 24) >> 24, mvr = (regs[0x1C] << 24) >> 24;
    const evl = (regs[0x2C] << 24) >> 24, evr = (regs[0x3C] << 24) >> 24;
    let outL = clamp16(((mainL * mvl) >> 7) + ((fl * evl) >> 7));
    let outR = clamp16(((mainR * mvr) >> 7) + ((fr * evr) >> 7));
    if (flg & 0x40) { outL = 0; outR = 0; }
    if (this.audioLen < this.audioBuf.length / 2) {
      this.audioBuf[this.audioLen * 2] = outL; this.audioBuf[this.audioLen * 2 + 1] = outR;
      this.audioLen++;
    }
  }

  takeAudio() {
    const out = this.audioBuf.slice(0, this.audioLen * 2);
    this.audioLen = 0;
    return out;
  }
}
