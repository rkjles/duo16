// ===== Cheats: Game Genie and Pro Action Replay =====
const GG_ALPHABET = 'DF4709156BC8A23E';
const GG_SCRAMBLED = 'ijklqrstopabcduvwxefghmn';
const GG_PLAIN = 'abcdefghijklmnopqrstuvwx';

// Parse a code string. Returns {type:'gg'|'par', addr, value, text} or throws with a readable message.
function parseCheat(text, hint = 'auto') {
  const raw = String(text).trim().toUpperCase().replace(/\s+/g, '');
  if (!raw) throw new Error('Enter a code.');
  // "7E0DBE:05" style raw address:value
  let m = raw.match(/^([0-9A-F]{6}):([0-9A-F]{2})$/);
  if (m) return { type: 'par', addr: parseInt(m[1], 16), value: parseInt(m[2], 16), text: raw };
  const compact = raw.replace(/-/g, '');
  const isGGShape = /^[0-9A-F]{4}-[0-9A-F]{4}$/.test(raw);
  if (!/^[0-9A-F]{8}$/.test(compact)) throw new Error('Codes are 8 characters: Game Genie like "C9C8-6FAD", Action Replay like "7E0DBE05".');
  let type = hint;
  if (type === 'auto') {
    if (isGGShape) type = 'gg';
    else if (/^7[EF]/.test(compact)) type = 'par';
    else type = 'par';
  }
  if (type === 'par') {
    return { type: 'par', addr: parseInt(compact.slice(0, 6), 16), value: parseInt(compact.slice(6), 16), text: compact };
  }
  const n = [...compact].map((c) => GG_ALPHABET.indexOf(c));
  if (n.some((x) => x < 0)) throw new Error('That is not a valid Game Genie code.');
  const value = (n[0] << 4) | n[1];
  let scr = 0; for (let i = 2; i < 8; i++) scr = (scr << 4) | n[i];
  let addr = 0;
  for (let p = 0; p < 24; p++) {
    const q = GG_SCRAMBLED.indexOf(GG_PLAIN[p]);
    const bit = (scr >>> (23 - q)) & 1;
    addr |= bit << (23 - p);
  }
  return { type: 'gg', addr: addr >>> 0, value, text: compact.slice(0, 4) + '-' + compact.slice(4) };
}

// A cheat entry can hold several codes joined with '+' (e.g. "7E0F3109+7E0F3209")
function parseCheatCodes(text, hint = 'auto') {
  const parts = String(text).split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('Enter a code.');
  if (parts.length > 32) throw new Error('That cheat has too many codes.');
  return parts.map((p) => parseCheat(p, hint));
}

// Manages active cheats on an emulator instance. All changes must be applied at frame boundaries.
class CheatEngine {
  constructor(snes) {
    this.snes = snes;
    this.list = []; // {id, code, desc, enabled, parsed}
    this.romPatches = new Map(); // romOffset -> original byte
    this.master = true;          // the main on/off switch; off keeps the list but applies nothing
  }
  setMaster(on) { this.master = !!on; this.rebuild(); }
  setList(list) {
    this.list = list.map((c) => ({ ...c, parsed: parseCheatCodes(c.code, c.kind || 'auto') }));
    this.rebuild();
  }
  romOffsetFor(addr) {
    const s = this.snes; const p = addr >>> 13;
    if (s.pageMem[p] === s.cart.rom) return s.pageOff[p] + (addr & 0x1FFF);
    return -1;
  }
  rebuild() {
    const rom = this.snes.cart.rom;
    for (const [off, orig] of this.romPatches) rom[off] = orig;
    this.romPatches.clear();
    this.ramWrites = [];
    for (const c of this.list) {
      if (!this.master || !c.enabled) continue;
      for (const { addr, value } of c.parsed) {
        const off = this.romOffsetFor(addr);
        if (off >= 0) {
          if (!this.romPatches.has(off)) this.romPatches.set(off, rom[off]);
          rom[off] = value;
        } else this.ramWrites.push([addr, value]);
      }
    }
  }
  // Called before every frame (identically on every machine in a session)
  applyFrame() {
    if (!this.ramWrites || !this.ramWrites.length) return;
    const s = this.snes;
    for (const [addr, value] of this.ramWrites) s.writeA(addr, value);
  }
}
