// Minimal two-pass 65816 assembler (build tool; used to make the built-in demo ROM and CPU tests)
'use strict';

const G1 = { ORA: 0x00, AND: 0x20, EOR: 0x40, ADC: 0x60, STA: 0x80, LDA: 0xA0, CMP: 0xC0, SBC: 0xE0 };
const G1OFF = { indx: 1, sr: 3, dp: 5, indl: 7, imm: 9, abs: 0xD, long: 0xF, indy: 0x11, ind: 0x12, sry: 0x13, dpx: 0x15, indly: 0x17, absy: 0x19, absx: 0x1D, longx: 0x1F };

const OPS = {};
function def(m, mode, op) { (OPS[m] = OPS[m] || {})[mode] = op; }
for (const [m, b] of Object.entries(G1)) for (const [mode, o] of Object.entries(G1OFF)) { if (m === 'STA' && mode === 'imm') continue; def(m, mode, b + o); }
const list = `
ASL acc 0A dp 06 dpx 16 abs 0E absx 1E
LSR acc 4A dp 46 dpx 56 abs 4E absx 5E
ROL acc 2A dp 26 dpx 36 abs 2E absx 3E
ROR acc 6A dp 66 dpx 76 abs 6E absx 7E
INC acc 1A dp E6 dpx F6 abs EE absx FE
DEC acc 3A dp C6 dpx D6 abs CE absx DE
BIT immm 89 dp 24 dpx 34 abs 2C absx 3C
TSB dp 04 abs 0C
TRB dp 14 abs 1C
LDX immx A2 dp A6 dpy B6 abs AE absy BE
LDY immx A0 dp A4 dpx B4 abs AC absx BC
STX dp 86 dpy 96 abs 8E
STY dp 84 dpx 94 abs 8C
STZ dp 64 dpx 74 abs 9C absx 9E
CPX immx E0 dp E4 abs EC
CPY immx C0 dp C4 abs CC
BPL rel 10
BMI rel 30
BVC rel 50
BVS rel 70
BCC rel 90
BCS rel B0
BNE rel D0
BEQ rel F0
BRA rel 80
BRL rell 82
JMP abs 4C long 5C ind 6C absxind 7C indlabs DC
JML long 5C indlabs DC
JSR abs 20 absxind FC
JSL long 22
RTS imp 60
RTL imp 6B
RTI imp 40
BRK imm8 00
COP imm8 02
WDM imm8 42
PHA imp 48
PLA imp 68
PHX imp DA
PLX imp FA
PHY imp 5A
PLY imp 7A
PHP imp 08
PLP imp 28
PHB imp 8B
PLB imp AB
PHD imp 0B
PLD imp 2B
PHK imp 4B
PEA abs F4
PEI ind D4
PER rell 62
TAX imp AA
TAY imp A8
TXA imp 8A
TYA imp 98
TXY imp 9B
TYX imp BB
TSX imp BA
TXS imp 9A
TCS imp 1B
TSC imp 3B
TCD imp 5B
TDC imp 7B
XBA imp EB
CLC imp 18
SEC imp 38
CLI imp 58
SEI imp 78
CLV imp B8
CLD imp D8
SED imp F8
REP imm8 C2
SEP imm8 E2
XCE imp FB
MVN mv 54
MVP mv 44
NOP imp EA
WAI imp CB
STP imp DB
INX imp E8
INY imp C8
DEX imp CA
DEY imp 88
`;
for (const line of list.trim().split('\n')) {
  const t = line.trim().split(/\s+/); const m = t[0];
  for (let i = 1; i < t.length; i += 2) def(m, t[i], parseInt(t[i + 1], 16));
}
// immediate width markers
for (const m of Object.keys(G1)) if (OPS[m].imm !== undefined) { OPS[m].immm = OPS[m].imm; delete OPS[m].imm; }

function assemble(src, opts = {}) {
  const lines = src.split('\n');
  const syms = Object.assign({}, opts.defines || {});
  let out, pc, a16, i16, pass, org;
  const errors = [];

  const evalExpr = (e) => {
    e = e.trim();
    // operators: <x low byte, >x high byte, ^x bank
    if (e.startsWith('<')) return evalExpr(e.slice(1)) & 0xFF;
    if (e.startsWith('>')) return (evalExpr(e.slice(1)) >> 8) & 0xFF;
    if (e.startsWith('^')) return (evalExpr(e.slice(1)) >> 16) & 0xFF;
    // tokenize + - * / | & << >>
    const tokens = e.match(/\$[0-9A-Fa-f]+|%[01]+|\d+|[A-Za-z_.@][A-Za-z0-9_.@]*|'.'|<<|>>|[-+*/|&()~]/g);
    if (!tokens) throw new Error('bad expr ' + e);
    let i = 0;
    const prim = () => {
      const t = tokens[i++];
      if (t === '(') { const v = expr(); i++; return v; }
      if (t === '-') return -prim();
      if (t === '~') return ~prim();
      if (t[0] === '$') return parseInt(t.slice(1), 16);
      if (t[0] === '%') return parseInt(t.slice(1), 2);
      if (t[0] === "'") return t.charCodeAt(1);
      if (/^\d/.test(t)) return parseInt(t, 10);
      if (t in syms) return syms[t];
      if (pass === 1) return 0x8000; // forward reference placeholder
      throw new Error('undefined symbol ' + t);
    };
    const mul = () => { let v = prim(); while (tokens[i] === '*' || tokens[i] === '/') { const o = tokens[i++]; const r = prim(); v = o === '*' ? v * r : Math.floor(v / r); } return v; };
    const add = () => { let v = mul(); while (tokens[i] === '+' || tokens[i] === '-') { const o = tokens[i++]; const r = mul(); v = o === '+' ? v + r : v - r; } return v; };
    const sh = () => { let v = add(); while (tokens[i] === '<<' || tokens[i] === '>>') { const o = tokens[i++]; const r = add(); v = o === '<<' ? v << r : v >> r; } return v; };
    const expr = () => { let v = sh(); while (tokens[i] === '|' || tokens[i] === '&') { const o = tokens[i++]; const r = sh(); v = o === '|' ? v | r : v & r; } return v; };
    return expr();
  };

  const emit = (b) => { const off = org(pc); if (pass === 2) { if (off < 0 || off >= out.length) throw new Error('address out of ROM ' + pc.toString(16)); out[off] = b & 0xFF; } pc++; };

  for (const passNo of [1, 1, 2]) {
    pass = passNo;
    out = new Uint8Array(opts.size || 0x8000);
    out.fill(0);
    pc = 0x8000; a16 = false; i16 = false;
    // LoROM: bank b addr a (>=8000) -> ((b&0x7F)<<15)|(a&0x7FFF)
    org = (p) => (((p >> 16) & 0x7F) << 15) | (p & 0x7FFF);
    let lineNo = 0;
    for (let raw of lines) {
      lineNo++;
      let line = raw.replace(/;.*$/, '').trim();
      if (!line) continue;
      try {
        // labels
        let m;
        while ((m = line.match(/^([A-Za-z_.@][A-Za-z0-9_.@]*):\s*(.*)$/))) { syms[m[1]] = pc; line = m[2].trim(); }
        if (!line) continue;
        if ((m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/))) { syms[m[1]] = evalExpr(m[2]); if (/^\$[0-9A-Fa-f]{1,2}$/.test(m[2].trim())) syms['__dp_' + m[1]] = 1; continue; }
        const sp = line.search(/\s/);
        let mn = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
        let arg = sp < 0 ? '' : line.slice(sp).trim();
        if (mn === '.ORG') { pc = evalExpr(arg); continue; }
        if (mn === '.A8') { a16 = false; continue; }
        if (mn === '.A16') { a16 = true; continue; }
        if (mn === '.I8') { i16 = false; continue; }
        if (mn === '.I16') { i16 = true; continue; }
        if (mn === '.DB' || mn === '.DW' || mn === '.DL') {
          const parts = splitArgs(arg);
          for (const p of parts) {
            if (p.startsWith('"')) { for (const ch of p.slice(1, -1)) emit(ch.charCodeAt(0)); continue; }
            const v = evalExpr(p);
            emit(v); if (mn !== '.DB') emit(v >> 8); if (mn === '.DL') emit(v >> 16);
          }
          continue;
        }
        if (mn === '.FILL') { const [n, v] = splitArgs(arg).map(evalExpr); for (let k = 0; k < n; k++) emit(v || 0); continue; }
        if (mn === '.BYTES') { for (const b of opts.blobs[arg]) emit(b); continue; }
        if (mn === '.ALIGN') { const n = evalExpr(arg); while (pc % n) emit(0); continue; }
        // size suffix
        let force = null;
        const dm = mn.match(/^([A-Z]{3})\.([BWL])$/);
        if (dm) { mn = dm[1]; force = dm[2]; }
        const tab = OPS[mn];
        if (!tab) throw new Error('unknown mnemonic ' + mn);
        // track REP/SEP for widths
        let mode, val, val2;
        if (!arg) { mode = tab.acc !== undefined && tab.imp === undefined ? 'acc' : 'imp'; }
        else if (arg.toUpperCase() === 'A') mode = 'acc';
        else if (arg[0] === '#') {
          val = evalExpr(arg.slice(1));
          mode = tab.immm !== undefined ? 'immm' : tab.immx !== undefined ? 'immx' : 'imm8';
        } else if (mn === 'MVN' || mn === 'MVP') {
          const [d, s] = splitArgs(arg); mode = 'mv'; val = evalExpr(d); val2 = evalExpr(s);
        } else if ((m = arg.match(/^\((.+),\s*[sS]\)\s*,\s*[yY]$/))) { mode = 'sry'; val = evalExpr(m[1]); }
        else if ((m = arg.match(/^(.+),\s*[sS]$/))) { mode = 'sr'; val = evalExpr(m[1]); }
        else if ((m = arg.match(/^\((.+),\s*[xX]\)$/))) { val = evalExpr(m[1]); mode = (tab.absxind !== undefined) ? 'absxind' : 'indx'; }
        else if ((m = arg.match(/^\((.+)\)\s*,\s*[yY]$/))) { mode = 'indy'; val = evalExpr(m[1]); }
        else if ((m = arg.match(/^\[(.+)\]\s*,\s*[yY]$/))) { mode = 'indly'; val = evalExpr(m[1]); }
        else if ((m = arg.match(/^\[(.+)\]$/))) { val = evalExpr(m[1]); mode = tab.indlabs !== undefined ? 'indlabs' : 'indl'; }
        else if ((m = arg.match(/^\((.+)\)$/))) { mode = 'ind'; val = evalExpr(m[1]); }
        else {
          let idx = null;
          if ((m = arg.match(/^(.+),\s*([xXyY])$/))) { arg = m[1]; idx = m[2].toLowerCase(); }
          val = evalExpr(arg);
          if (tab.rel !== undefined) mode = 'rel';
          else if (tab.rell !== undefined && mn !== 'PEA') mode = 'rell';
          else {
            let size = force;
            if (!size) {
              size = val > 0xFFFF ? 'L' : (val <= 0xFF && isNumericish(arg, syms) ? 'B' : 'W');
              if (mn === 'JMP' || mn === 'JSR') size = val > 0xFFFF ? 'L' : 'W';
            }
            if (mn === 'JML' || mn === 'JSL') size = 'L';
            if (mn === 'PEA') size = 'W';
            if (idx === 'x') mode = size === 'B' ? 'dpx' : size === 'W' ? 'absx' : 'longx';
            else if (idx === 'y') mode = size === 'B' && tab.dpy !== undefined ? 'dpy' : 'absy';
            else mode = size === 'B' ? 'dp' : size === 'W' ? 'abs' : 'long';
            if (tab[mode] === undefined && mode === 'dp' && tab.abs !== undefined) mode = 'abs';
            if (tab[mode] === undefined && mode === 'dpx' && tab.absx !== undefined) mode = 'absx';
            if (tab[mode] === undefined && mode === 'abs' && tab.long !== undefined) mode = 'long';
          }
        }
        let op = tab[mode];
        if (op === undefined && mode === 'imp' && tab.acc !== undefined) { mode = 'acc'; op = tab.acc; }
        if (op === undefined) throw new Error(`bad mode ${mode} for ${mn}`);
        emit(op);
        switch (mode) {
          case 'imp': case 'acc': break;
          case 'immm': emit(val); if (a16) emit(val >> 8); break;
          case 'immx': emit(val); if (i16) emit(val >> 8); break;
          case 'imm8':
            emit(val);
            if (mn === 'REP') { if (val & 0x20) a16 = true; if (val & 0x10) i16 = true; }
            if (mn === 'SEP') { if (val & 0x20) a16 = false; if (val & 0x10) i16 = false; }
            break;
          case 'dp': case 'dpx': case 'dpy': case 'ind': case 'indx': case 'indy': case 'indl': case 'indly': case 'sr': case 'sry': emit(val); break;
          case 'abs': case 'absx': case 'absy': case 'absxind': case 'indlabs': emit(val); emit(val >> 8); break;
          case 'long': case 'longx': emit(val); emit(val >> 8); emit(val >> 16); break;
          case 'rel': {
            const d = val - (pc + 1);
            if (pass === 2 && (d < -128 || d > 127)) throw new Error('branch out of range');
            emit(d); break;
          }
          case 'rell': { const d = val - (pc + 2); emit(d); emit(d >> 8); break; }
          case 'mv': emit(val); emit(val2); break;
        }
      } catch (e) {
        if (pass === 2) errors.push(`line ${lineNo}: ${e.message}: ${raw.trim()}`);
      }
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return { bytes: out, syms };
}

// Operands written with an explicit '$xx' (2 hex digits) or a symbol defined by '=' with value < 256 are direct page
function isNumericish(arg, syms) {
  arg = arg.trim();
  if (/^\$[0-9A-Fa-f]{1,2}$/.test(arg)) return true;
  if (/^\d+$/.test(arg)) return parseInt(arg, 10) < 256;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg) && syms['__dp_' + arg]) return true;
  return false;
}

function splitArgs(s) {
  const out = []; let cur = '', q = false;
  for (const ch of s) {
    if (ch === '"') q = !q;
    if (ch === ',' && !q) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

module.exports = { assemble };
