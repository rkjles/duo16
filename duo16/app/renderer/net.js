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

class RtcLink {
  constructor() {
    this.handlers = {};
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.fast = null; this.rel = null; this.opened = false; this.closed = false;
    this.pc.onconnectionstatechange = () => {
      const st = this.pc.connectionState;
      if (st === 'failed') this.fail('The connection could not be made. Your networks may block direct connections; try "Connect by IP" with a VPN like Tailscale.');
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
      const t = setTimeout(res, 3000);
      this.pc.addEventListener('icegatheringstatechange', () => { if (this.pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
    });
  }
  // Host side: create the invite code
  async createInvite() {
    this.fast = this.pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 });
    this.rel = this.pc.createDataChannel('rel', { ordered: true });
    this.wire(this.fast); this.wire(this.rel);
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await this.gather();
    return packCode({ v: 1, r: 'offer', sdp: this.pc.localDescription.sdp });
  }
  async acceptReply(code) {
    const o = await unpackCode(code);
    if (o.r !== 'answer') throw new Error(o.r === 'offer' ? 'That\'s an invite code. Paste the reply code your friend sent back.' : 'That code isn\'t a reply code.');
    await this.pc.setRemoteDescription({ type: 'answer', sdp: o.sdp });
  }
  // Guest side: turn the host's invite into a reply code
  async createReply(inviteCode) {
    const o = await unpackCode(inviteCode);
    if (o.r !== 'offer') throw new Error('That\'s a reply code. Paste the invite code from the host.');
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
  close() { this.closed = true; try { this.fast?.close(); this.rel?.close(); this.pc.close(); } catch (_) { } }
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
