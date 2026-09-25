// ===== Save states: snapshot / restore / binary serialization =====
const STATE_EXCLUDE = {
  SNES: new Set(['cpu', 'ppu', 'apu', 'cart', 'wramRef', 'pageMem', 'pageOff', 'pageWritable', 'pageSpeed', 'dma', 'lines', 'pads']),
  CPU: new Set(['bus']),
  PPU: new Set(['snes', 'frame', 'bgCol', 'bgPri', 'hiCol', 'hiPri', 'objCol', 'objPri', 'objMath', 'mainCol', 'mainZ', 'mainLayer',
    'subCol', 'subZ', 'subLayer', 'winTmp', 'winMasks', 'rowBuf', 'bright']),
  APU: new Set(['voices', 'audioBuf', 'audioLen']),
  DMA: new Set([]),
  VOICE: new Set([]),
};

function snapObj(o, exclude) {
  const s = {};
  for (const k of Object.keys(o)) {
    if (exclude.has(k)) continue;
    const v = o[k];
    const t = typeof v;
    if (t === 'number' || t === 'boolean') s[k] = v;
    else if (ArrayBuffer.isView(v)) s[k] = v.slice();
    else if (Array.isArray(v) && v.every((x) => typeof x === 'number')) s[k] = v.slice();
  }
  return s;
}
function restoreObj(o, s) {
  for (const k of Object.keys(s)) {
    const v = s[k];
    if (ArrayBuffer.isView(v)) {
      if (ArrayBuffer.isView(o[k]) && o[k].length === v.length) o[k].set(v);
      else o[k] = v.slice();
    } else if (Array.isArray(v)) o[k] = v.slice();
    else o[k] = v;
  }
}

function snapshotSNES(snes) {
  return {
    snes: snapObj(snes, STATE_EXCLUDE.SNES),
    cpu: snapObj(snes.cpu, STATE_EXCLUDE.CPU),
    ppu: snapObj(snes.ppu, STATE_EXCLUDE.PPU),
    apu: snapObj(snes.apu, STATE_EXCLUDE.APU),
    voices: snes.apu.voices.map((v) => snapObj(v, STATE_EXCLUDE.VOICE)),
    dma: snes.dma.map((d) => snapObj(d, STATE_EXCLUDE.DMA)),
    sram: snes.cart.sram.slice(),
  };
}
function restoreSNES(snes, st) {
  restoreObj(snes, st.snes);
  restoreObj(snes.cpu, st.cpu);
  restoreObj(snes.ppu, st.ppu);
  restoreObj(snes.apu, st.apu);
  st.voices.forEach((v, i) => restoreObj(snes.apu.voices[i], v));
  st.dma.forEach((d, i) => restoreObj(snes.dma[i], d));
  if (st.sram && st.sram.length === snes.cart.sram.length) snes.cart.sram.set(st.sram);
  snes.updateSpeeds();
  snes.apu.audioLen = 0;
}

// ---- binary format: 'D16S' | u32 jsonLen | json | blobs ----
const TA_TYPES = { Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array };
function serializeState(st) {
  const blobs = []; let offset = 0;
  const walk = (v) => {
    if (ArrayBuffer.isView(v)) {
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      // align each blob to 4 bytes
      const pad = (4 - (offset & 3)) & 3; if (pad) { blobs.push(new Uint8Array(pad)); offset += pad; }
      const ref = { __ta: v.constructor.name, o: offset, n: v.length };
      blobs.push(bytes); offset += bytes.length;
      return ref;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = walk(v[k]); return o; }
    return v;
  };
  const tree = walk(st);
  const json = new TextEncoder().encode(JSON.stringify(tree));
  const head = 8 + json.length; const headPad = (4 - (head & 3)) & 3;
  const out = new Uint8Array(head + headPad + offset);
  out.set([0x44, 0x31, 0x36, 0x53], 0);
  new DataView(out.buffer).setUint32(4, json.length, true);
  out.set(json, 8);
  let p = head + headPad;
  for (const b of blobs) { out.set(b, p); p += b.length; }
  return out;
}
function deserializeState(buf) {
  if (buf[0] !== 0x44 || buf[1] !== 0x31 || buf[2] !== 0x36 || buf[3] !== 0x53) throw new Error('Not a save state file');
  const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(4, true);
  const tree = JSON.parse(new TextDecoder().decode(buf.subarray(8, 8 + len)));
  const head = 8 + len; const base = head + ((4 - (head & 3)) & 3);
  const walk = (v) => {
    if (v && typeof v === 'object' && v.__ta) {
      const T = TA_TYPES[v.__ta];
      const bytes = buf.slice(base + v.o, base + v.o + v.n * T.BYTES_PER_ELEMENT);
      return new T(bytes.buffer);
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = walk(v[k]); return o; }
    return v;
  };
  return walk(tree);
}

// Fast deterministic checksum of the parts of state that matter for sync
function stateChecksum(snes) {
  let h = 0x811C9DC5 | 0;
  const mix = (arr) => { for (let i = 0; i < arr.length; i++) { h ^= arr[i]; h = Math.imul(h, 16777619); } };
  mix(snes.wram);
  mix(snes.apu.ram.subarray(0, 0x100));
  const c = snes.cpu;
  mix([c.a, c.x, c.y, c.s, c.d, c.dbr, c.pbr, c.pc, c.getP(), snes.vc, snes.hc & 0xFFFF]);
  return h >>> 0;
}

// ---- compact differences between two snapshots (for a long rewind history) ----
// Large arrays are stored as XOR-against-base with runs of unchanged bytes skipped.
const DELTA_MIN = 2048;
function bytesOf(v) { return new Uint8Array(v.buffer, v.byteOffset, v.byteLength); }
function xorRle(cur, base) {
  const n = cur.length; const out = []; let i = 0; let chunk = new Uint8Array(4096); let len = 0;
  const put = (b) => { if (len === chunk.length) { out.push(chunk); chunk = new Uint8Array(4096); len = 0; } chunk[len++] = b; };
  const putVar = (v) => { while (v >= 0x80) { put((v & 0x7F) | 0x80); v >>>= 7; } put(v); };
  while (i < n) {
    let z = i; while (z < n && cur[z] === base[z]) z++;
    putVar(z - i); i = z;
    if (i >= n) { putVar(0); break; }
    let e = i;
    // a literal run ends at the first stretch of 4 unchanged bytes
    while (e < n) { if (cur[e] === base[e] && e + 3 < n && cur[e + 1] === base[e + 1] && cur[e + 2] === base[e + 2] && cur[e + 3] === base[e + 3]) break; e++; }
    putVar(e - i);
    for (let k = i; k < e; k++) put(cur[k] ^ base[k]);
    i = e;
  }
  const total = out.length * 4096 + len; const res = new Uint8Array(total); let o = 0;
  for (const c of out) { res.set(c, o); o += 4096; }
  res.set(chunk.subarray(0, len), o);
  return res;
}
function xorRleDecode(enc, base) {
  const out = base.slice(); let p = 0, i = 0;
  const getVar = () => { let v = 0, sh = 0, b; do { b = enc[p++]; v |= (b & 0x7F) << sh; sh += 7; } while (b & 0x80); return v >>> 0; };
  while (p < enc.length) {
    i += getVar();
    if (p >= enc.length) break;
    const lit = getVar();
    for (let k = 0; k < lit; k++, i++) out[i] ^= enc[p++];
  }
  return out;
}
function deltaEncodeState(cur, base) {
  if (ArrayBuffer.isView(cur)) {
    if (cur.byteLength >= DELTA_MIN && base && ArrayBuffer.isView(base) && base.byteLength === cur.byteLength && base.constructor === cur.constructor)
      return { __x: xorRle(bytesOf(cur), bytesOf(base)), t: cur.constructor.name };
    return cur;
  }
  if (Array.isArray(cur)) return cur.map((v, i) => deltaEncodeState(v, base ? base[i] : undefined));
  if (cur && typeof cur === 'object') { const o = {}; for (const k of Object.keys(cur)) o[k] = deltaEncodeState(cur[k], base ? base[k] : undefined); return o; }
  return cur;
}
function deltaDecodeState(d, base) {
  if (d && d.__x) { const bytes = xorRleDecode(d.__x, bytesOf(base)); return new TA_TYPES[d.t](bytes.buffer); }
  if (ArrayBuffer.isView(d)) return d;
  if (Array.isArray(d)) return d.map((v, i) => deltaDecodeState(v, base ? base[i] : undefined));
  if (d && typeof d === 'object') { const o = {}; for (const k of Object.keys(d)) o[k] = deltaDecodeState(d[k], base ? base[k] : undefined); return o; }
  return d;
}
