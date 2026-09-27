// ===== Lockstep session: keeps every player's Machine running the same frames with the same inputs =====
// Transport-agnostic. A link is { sendFast(obj), sendReliable(objOrBytes), close() } and calls
// session.onFast(obj) / session.onReliable(objOrBytes) when data arrives.
const NET_VERSION = 4;

class Session {
  constructor(machine, opts) {
    this.m = machine;
    this.role = opts.role;           // 'solo' | 'host' | 'guest'
    this.slot = opts.role === 'guest' ? 1 : 0;
    this.players = opts.role === 'solo' ? 1 : 2;
    this.delay = opts.delay != null ? opts.delay : (opts.role === 'solo' ? 0 : 3);
    this.link = null;
    this.readInput = opts.readInput || (() => 0);       // () => pad bits for this player
    this.readLocal2 = opts.readLocal2 || (() => 0);     // solo mode: second local controller
    this.onStatus = opts.onStatus || (() => {});
    this.onToast = opts.onToast || (() => {});
    this.epoch = 0;
    this.running = opts.role !== 'guest';   // guest waits for the host's sync package
    this.waitingForAck = false;
    this.resetBuffers(0);
    this.pendingCmds = [];
    this.stats = { rtt: 0, stalls: 0, desyncs: 0, lastRecv: 0 };
    this.sums = new Map();
    this.remoteSums = new Map();
    this.syncChunks = null;
    this.lastResend = 0;
    this.lastPing = 0;
  }

  resetBuffers(tick) {
    this.tick = tick;             // last executed tick
    this.localHead = tick;        // last tick we produced local input for
    this.records = [new Map(), new Map()];   // slot -> Map(tick -> {p, c})
    this.remoteHead = tick;       // last contiguous tick received from the other player
    this.peerAck = tick;          // last of our ticks the other player has confirmed
  }

  attach(link) { this.link = link; }

  // UI: queue a synced command (cheat change, rewind, pause, reset)
  command(cmd) { const c = sanitizeCmds([cmd]); if (c && c.length) this.pendingCmds.push(c[0]); }

  // ---------- local input production ----------
  produceLocal() {
    const target = this.tick + 1 + this.delay;
    let produced = false;
    while (this.localHead < target) {
      this.localHead++;
      const rec = { p: this.readInput() & 0xFFFF };
      if (this.pendingCmds.length) { rec.c = this.pendingCmds; this.pendingCmds = []; }
      this.records[this.slot].set(this.localHead, rec);
      if (this.role === 'solo') this.records[1].set(this.localHead, { p: this.readLocal2() & 0xFFFF });
      produced = true;
    }
    if (produced) this.sendInputs();
  }

  sendInputs() {
    if (!this.link || this.role === 'solo') return;
    const from = Math.max(this.peerAck + 1, this.localHead - 63);
    const r = [];
    for (let t = from; t <= this.localHead; t++) {
      const rec = this.records[this.slot].get(t);
      if (!rec) break;
      r.push(rec.c ? [rec.p, rec.c] : rec.p);
    }
    if (!r.length) return;
    this.link.sendFast({ t: 'in', e: this.epoch, f: from, r, a: this.remoteHead });
    this.lastResend = now();
  }

  // ---------- incoming ----------
  onFast(msg) {
    if (msg.t !== 'in' || msg.e !== this.epoch) return;
    this.stats.lastRecv = now();
    const other = 1 - this.slot;
    const recs = this.records[other];
    for (let i = 0; i < msg.r.length; i++) {
      const t = msg.f + i;
      if (t <= this.tick || recs.has(t)) continue;
      const x = msg.r[i];
      recs.set(t, Array.isArray(x) ? { p: x[0], c: sanitizeCmds(x[1]) } : { p: x });
    }
    while (recs.has(this.remoteHead + 1) || this.remoteHead + 1 <= this.tick) this.remoteHead++;
    if (msg.a > this.peerAck) this.peerAck = Math.min(msg.a, this.localHead);
  }

  onReliable(msg) {
    if (msg instanceof Uint8Array) { this.onSyncChunk(msg); return; }
    switch (msg.t) {
      case 'ping': this.link.sendReliable({ t: 'pong', ts: msg.ts }); break;
      case 'pong': this.stats.rtt = Math.round(now() - msg.ts); break;
      case 'sum':
        if (msg.e !== this.epoch) break;
        this.remoteSums.set(msg.tick, msg.h);
        this.checkSums(msg.tick);
        break;
      case 'sync-begin':
        this.syncChunks = { epoch: msg.e, tick: msg.tick, delay: msg.delay, size: msg.size, parts: [], got: 0 };
        this.onStatus({ syncing: true });
        break;
      case 'synced':
        if (this.role === 'host' && msg.e === this.epoch) { this.waitingForAck = false; this.running = true; this.onStatus({ syncing: false }); }
        break;
      case 'desync':
        if (this.role === 'host' && msg.e === this.epoch) { this.stats.desyncs++; this.sendSync('Fixing a sync error'); }
        break;
      case 'chat': this.onToast(`Player ${this.slot === 0 ? 2 : 1}: ${String(msg.text).slice(0, 200)}`); break;
    }
  }

  onSyncChunk(bytes) {
    const s = this.syncChunks; if (!s) return;
    s.parts.push(bytes); s.got += bytes.length;
    this.onStatus({ syncing: true, progress: s.got / s.size });
    if (s.got < s.size) return;
    const buf = new Uint8Array(s.size); let o = 0;
    for (const p of s.parts) { buf.set(p, o); o += p.length; }
    this.syncChunks = null;
    this.m.importSync(buf);
    this.epoch = s.epoch; this.delay = s.delay;
    this.resetBuffers(s.tick);
    this.sums.clear(); this.remoteSums.clear();
    this.running = true;
    this.link.sendReliable({ t: 'synced', e: this.epoch });
    this.onStatus({ syncing: false, synced: true });
  }

  // Host: send the whole machine state and restart the input streams from this tick
  sendSync(reason) {
    if (this.role !== 'host' || !this.link) return;
    if (this.m.rewinding) this.m.finishRewind();
    const buf = this.m.exportSync();
    this.m.history = [];
    this.epoch++;
    this.resetBuffers(this.tick);
    this.sums.clear(); this.remoteSums.clear();
    this.running = false; this.waitingForAck = true;
    this.link.sendReliable({ t: 'sync-begin', e: this.epoch, tick: this.tick, delay: this.delay, size: buf.length });
    const CH = 16000;
    for (let o = 0; o < buf.length; o += CH) this.link.sendReliable(buf.slice(o, o + CH));
    if (reason) this.onToast(reason);
    this.onStatus({ syncing: true });
  }

  checkSums(tick) {
    if (!this.sums.has(tick) || !this.remoteSums.has(tick)) return;
    const a = this.sums.get(tick), b = this.remoteSums.get(tick);
    this.sums.delete(tick); this.remoteSums.delete(tick);
    if (a !== b) {
      this.stats.desyncs++;
      if (this.role === 'host') this.sendSync('Games drifted apart; resyncing');
      else this.link.sendReliable({ t: 'desync', tick, e: this.epoch });
    }
  }

  // ---------- simulation ----------
  canAdvance() {
    const t = this.tick + 1;
    return this.records[0].has(t) && this.records[1].has(t);
  }

  // Try to run one tick. Returns true if a tick ran.
  step() {
    if (!this.running) return false;
    this.produceLocal();
    if (!this.canAdvance()) { this.stats.stalls++; return false; }
    const t = this.tick + 1;
    const r0 = this.records[0].get(t), r1 = this.records[1].get(t);
    const pads = [r0.p, r1.p, 0, 0];
    this.m.executeTick(pads, [r0.c || null, r1.c || null]);
    this.tick = t;
    this.records[0].delete(t - 120); this.records[1].delete(t - 120);
    if (this.role !== 'solo' && t % 120 === 0) {
      const h = this.m.checksum();
      this.sums.set(t, h);
      this.link.sendReliable({ t: 'sum', e: this.epoch, tick: t, h });
      this.checkSums(t);
    }
    return true;
  }

  // How far ahead the other player's inputs are beyond what we have simulated
  lead() { return this.role === 'solo' ? 0 : this.remoteHead - this.tick; }

  // periodic housekeeping: resend unacknowledged inputs, ping
  maintain() {
    if (this.role === 'solo' || !this.link) return;
    const tnow = now();
    if (tnow - this.lastResend > 34 && this.localHead > this.peerAck) this.sendInputs();
    if (tnow - this.lastPing > 1000) { this.lastPing = tnow; this.link.sendReliable({ t: 'ping', ts: tnow }); }
  }

  status() {
    return {
      role: this.role, tick: this.tick, delay: this.delay, rtt: this.stats.rtt,
      waiting: this.running && !this.canAdvance(), desyncs: this.stats.desyncs,
      lastRecvAgo: this.stats.lastRecv ? now() - this.stats.lastRecv : 0,
    };
  }
}

// Inputs from the network are untrusted: only accept known command shapes
function sanitizeCmds(c) {
  if (!Array.isArray(c)) return null;
  const out = [];
  for (const x of c.slice(0, 8)) {
    if (!x || typeof x !== 'object') continue;
    if (x.k === 'rewind') out.push({ k: 'rewind', on: !!x.on, v: Math.max(0, Math.min(10, x.v | 0)) });
    else if (x.k === 'pause' || x.k === 'cheatsOn') out.push({ k: x.k, on: !!x.on });
    else if (x.k === 'speed') out.push({ k: 'speed', v: Math.max(1, Math.min(10, x.v | 0)) });
    else if (x.k === 'reset') out.push({ k: 'reset' });
    else if (x.k === 'cheats' && Array.isArray(x.list)) {
      out.push({
        k: 'cheats', note: typeof x.note === 'string' ? x.note.slice(0, 80) : undefined,
        list: x.list.slice(0, 200).map((c) => ({ code: String(c.code || '').slice(0, 400), desc: String(c.desc || '').slice(0, 80), enabled: !!c.enabled, kind: ['auto', 'gg', 'par'].includes(c.kind) ? c.kind : 'auto' })),
      });
    } else if (x.k === 'settings' && x.settings && typeof x.settings === 'object') {
      const s = x.settings; out.push({ k: 'settings', settings: { guestCheats: !!s.guestCheats, guestRewind: !!s.guestRewind, guestPause: !!s.guestPause, guestReset: !!s.guestReset, guestFast: s.guestFast !== false } });
    }
  }
  return out;
}

function now() { return (typeof performance !== 'undefined' ? performance.now() : Date.now()); }
