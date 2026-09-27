// ===== Network links: WebRTC (connection codes, no server) and Direct TCP (LAN / VPN) =====
// A link exposes: sendFast(obj), sendReliable(obj | Uint8Array), close(), and calls
// handlers.fast(obj), handlers.reliable(obj | Uint8Array), handlers.open(), handlers.close(reason).

const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
const CODE_PREFIX = 'DUO16-';

async function packCode(obj) {
  const text = new TextEncoder().encode(JSON.stringify(obj));
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter(); w.write(text); w.close();
  const bytes = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return CODE_PREFIX + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function unpackCode(code) {
  code = String(code).trim().replace(/\s+/g, '');
  if (!code.startsWith(CODE_PREFIX)) throw new Error('That doesn\'t look like a Duo16 code. It should start with "DUO16-".');
  let b64 = code.slice(CODE_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  let bin;
  try { bin = atob(b64); } catch (_) { throw new Error('The code is incomplete. Copy the whole thing and try again.'); }
  const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  try {
    const ds = new DecompressionStream('deflate-raw');
    const w = ds.writable.getWriter(); w.write(bytes); w.close();
    return JSON.parse(new TextDecoder().decode(await new Response(ds.readable).arrayBuffer()));
  } catch (_) { throw new Error('The code is incomplete or damaged. Copy the whole thing and try again.'); }
}

// Relay (TURN) servers are only used when a direct connection can't be made.
// relay = { servers: [{ urls, username, credential }], force: bool }
function cleanRelayServers(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list.slice(0, 12)) {
    if (!s || typeof s !== 'object') continue;
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).map(String).filter((u) => /^(turns?|stun):/i.test(u)).slice(0, 8);
    if (!urls.length) continue;
    const e = { urls };
    if (s.username != null) e.username = String(s.username).slice(0, 256);
    if (s.credential != null) e.credential = String(s.credential).slice(0, 256);
    out.push(e);
  }
  return out;
}

class RtcLink {
  constructor() {
    this.handlers = {};
    this.pc = null; this.relay = { servers: [], force: false };
    this.fast = null; this.rel = null; this.opened = false; this.closed = false;
  }
  init(relay) {
    const servers = cleanRelayServers(relay && relay.servers);
    this.relay = { servers, force: !!(relay && relay.force && servers.length) };
    this.pc = new RTCPeerConnection({
      iceServers: [...ICE_SERVERS, ...servers],
      iceTransportPolicy: this.relay.force ? 'relay' : 'all',
    });
    this.pc.onconnectionstatechange = () => {
      const st = this.pc.connectionState;
      if (st === 'failed') this.fail(this.relay.servers.length
        ? 'The connection could not be made, even through the relay. Check the relay settings with "Test relay", or try "Connect by IP" with Tailscale.'
        : 'The connection could not be made. Your networks block direct connections. Set up a free relay under "Relay server" in the Online tab, then make a new invite code.');
      else if (st === 'disconnected') { this._dcTimer = setTimeout(() => { if (this.pc.connectionState === 'disconnected') this.fail('Lost connection to your friend.'); }, 5000); }
      else if (st === 'connected' && this._dcTimer) { clearTimeout(this._dcTimer); this._dcTimer = null; }
    };
  }
  wire(ch) {
    ch.binaryType = 'arraybuffer';
    ch.onmessage = (e) => {
      const d = e.data;
      if (typeof d === 'string') {
        let o; try { o = JSON.parse(d); } catch (_) { return; }
        (ch === this.fast ? this.handlers.fast : this.handlers.reliable)?.(o);
      } else this.handlers.reliable?.(new Uint8Array(d));
    };
    ch.onopen = () => this.checkOpen();
    ch.onclose = () => this.fail('Your friend left the session.');
  }
  checkOpen() {
    if (!this.opened && this.fast && this.rel && this.fast.readyState === 'open' && this.rel.readyState === 'open') {
      this.opened = true; this.handlers.open?.();
    }
  }
  async gather() {
    if (this.pc.iceGatheringState === 'complete') return;
    await new Promise((res) => {
      const t = setTimeout(res, this.relay.servers.length ? 6000 : 3000);
      this.pc.addEventListener('icegatheringstatechange', () => { if (this.pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
    });
  }
  // Host side: create the invite code
  async createInvite(relay) {
    this.init(relay);
    this.fast = this.pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 });
    this.rel = this.pc.createDataChannel('rel', { ordered: true });
    this.wire(this.fast); this.wire(this.rel);
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await this.gather();
    const o = { v: 1, r: 'offer', sdp: this.pc.localDescription.sdp };
    // the relay details travel with the invite so the guest needs no setup
    if (this.relay.servers.length) { o.ice = this.relay.servers; if (this.relay.force) o.force = 1; }
    return packCode(o);
  }
  async acceptReply(code) {
    const o = await unpackCode(code);
    if (o.r !== 'answer') throw new Error(o.r === 'offer' ? 'That\'s an invite code. Paste the reply code your friend sent back.' : 'That code isn\'t a reply code.');
    await this.pc.setRemoteDescription({ type: 'answer', sdp: o.sdp });
  }
  // Guest side: turn the host's invite into a reply code
  async createReply(inviteCode, ownRelay) {
    const o = await unpackCode(inviteCode);
    if (o.r !== 'offer') throw new Error('That\'s a reply code. Paste the invite code from the host.');
    const servers = [...cleanRelayServers(o.ice), ...cleanRelayServers(ownRelay && ownRelay.servers)];
    this.init({ servers, force: !!o.force || !!(ownRelay && ownRelay.force) });
    this.pc.ondatachannel = (e) => {
      if (e.channel.label === 'fast') this.fast = e.channel; else this.rel = e.channel;
      this.wire(e.channel); this.checkOpen();
    };
    await this.pc.setRemoteDescription({ type: 'offer', sdp: o.sdp });
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await this.gather();
    return packCode({ v: 1, r: 'answer', sdp: this.pc.localDescription.sdp });
  }
  sendFast(o) { if (this.fast && this.fast.readyState === 'open') try { this.fast.send(JSON.stringify(o)); } catch (_) { } }
  sendReliable(o) {
    if (!this.rel || this.rel.readyState !== 'open') return;
    try { this.rel.send(o instanceof Uint8Array ? o : JSON.stringify(o)); } catch (_) { }
  }
  fail(reason) { if (this.closed) return; this.close(); this.handlers.close?.(reason); }
  close() { this.closed = true; try { this.fast?.close(); this.rel?.close(); this.pc?.close(); } catch (_) { } }
  // 'direct' or 'relay' once connected
  async route() {
    if (!this.pc) return null;
    try {
      const stats = await this.pc.getStats(); let pair = null;
      stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId); });
      if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
      if (!pair) return null;
      const l = stats.get(pair.localCandidateId), rm = stats.get(pair.remoteCandidateId);
      return (l && l.candidateType === 'relay') || (rm && rm.candidateType === 'relay') ? 'relay' : 'direct';
    } catch (_) { return null; }
  }
}

// Checks that a relay server accepts our login: resolves { ok, message }
async function testRelay(servers) {
  servers = cleanRelayServers(servers);
  if (!servers.some((s) => s.urls.some((u) => /^turns?:/i.test(u)))) return { ok: false, message: 'No relay server address entered.' };
  const pc = new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: 'relay' });
  const found = new Set(); const errors = [];
  pc.onicecandidate = (e) => { if (e.candidate && / typ relay /.test(e.candidate.candidate)) found.add(e.candidate.protocol || 'udp'); };
  pc.onicecandidateerror = (e) => { if (e.errorCode) errors.push(`${e.errorCode} ${e.errorText || ''}`.trim()); };
  pc.createDataChannel('test');
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((res) => {
    const t = setTimeout(res, 8000);
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } };
  });
  pc.close();
  if (found.size) return { ok: true, message: 'The relay works. Make a new invite code to use it.' };
  if (errors.some((e) => /^401/.test(e))) return { ok: false, message: 'The relay rejected the username or password. Check them and try again.' };
  return { ok: false, message: 'Couldn\'t reach the relay server. Check the address, or your internet connection.' };
}

class DirectLink {
  constructor() {
    this.handlers = {}; this.closed = false;
    this.unsub = [
      window.duo.on('direct:data', (m) => {
        if (m.bin) { this.handlers.reliable?.(new Uint8Array(m.bin)); return; }
        let o; try { o = JSON.parse(m.json); } catch (_) { return; }
        if (o.__f) this.handlers.fast?.(o.m); else this.handlers.reliable?.(o);
      }),
      window.duo.on('direct:open', () => this.handlers.open?.()),
      window.duo.on('direct:closed', () => this.fail('Your friend left the session.')),
      window.duo.on('direct:error', (e) => this.fail('Connection error: ' + e)),
    ];
  }
  host(port) { return window.duo.direct.host(port); }
  connect(host, port) { return window.duo.direct.connect(host, port); }
  sendFast(o) { window.duo.direct.send({ json: JSON.stringify({ __f: 1, m: o }) }); }
  sendReliable(o) { if (o instanceof Uint8Array) window.duo.direct.send({ bin: o }); else window.duo.direct.send({ json: JSON.stringify(o) }); }
  fail(reason) { if (this.closed) return; this.close(); this.handlers.close?.(reason); }
  close() { this.closed = true; this.unsub.forEach((u) => u()); window.duo.direct.close(); }
}
