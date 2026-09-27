// Minimal TURN relay server (UDP, long-term credentials) for testing Duo16's relay support locally.
// Implements Allocate, Refresh, CreatePermission, ChannelBind, Send/Data indications and ChannelData.
// Usage: node turn_server.js [port] [user] [pass]
const dgram = require('dgram');
const crypto = require('crypto');

const PORT = +(process.argv[2] || 3478), USER = process.argv[3] || 'duo', PASS = process.argv[4] || 'secret';
const REALM = 'duo16.test', COOKIE = 0x2112A442;
const KEY = crypto.createHash('md5').update(`${USER}:${REALM}:${PASS}`).digest();
const A = { USERNAME: 0x0006, MI: 0x0008, ERROR: 0x0009, CHANNEL: 0x000C, LIFETIME: 0x000D, PEER: 0x0012, DATA: 0x0013, REALM: 0x0014, NONCE: 0x0015, RELAYED: 0x0016, TRANSPORT: 0x0019, MAPPED: 0x0020, FINGERPRINT: 0x8028 };
const stats = { allocations: 0, relayedPackets: 0, authFailures: 0 };

function parse(buf) {
  if (buf.length < 20 || (buf[0] & 0xC0) !== 0 || buf.readUInt32BE(4) !== COOKIE) return null;
  const type = buf.readUInt16BE(0), len = buf.readUInt16BE(2);
  const attrs = []; let p = 20;
  while (p + 4 <= 20 + len && p + 4 <= buf.length) {
    const t = buf.readUInt16BE(p), l = buf.readUInt16BE(p + 2);
    attrs.push({ t, v: buf.subarray(p + 4, p + 4 + l), off: p });
    p += 4 + l + ((4 - (l % 4)) % 4);
  }
  return { type, method: (type & 0x000F) | ((type & 0x00E0) >> 1) | ((type & 0x3E00) >> 2), cls: type & 0x0110, tid: buf.subarray(8, 20), attrs, raw: buf };
}
const get = (m, t) => { const a = m.attrs.find((x) => x.t === t); return a ? a.v : null; };
function xorAddr(v, tid) {
  const port = v.readUInt16BE(2) ^ (COOKIE >>> 16);
  const ip = [0, 1, 2, 3].map((i) => v[4 + i] ^ ((COOKIE >>> (24 - 8 * i)) & 0xFF)).join('.');
  return { ip, port };
}
function encXorAddr(ip, port) {
  const b = Buffer.alloc(8); b[1] = 0x01; b.writeUInt16BE(port ^ (COOKIE >>> 16), 2);
  ip.split('.').map(Number).forEach((n, i) => { b[4 + i] = n ^ ((COOKIE >>> (24 - 8 * i)) & 0xFF); });
  return b;
}
function build(method, cls, tid, attrs, integrity) {
  const type = (method & 0x000F) | ((method & 0x0070) << 1) | ((method & 0x0F80) << 2) | cls;
  const parts = [];
  for (const [t, v] of attrs) {
    const h = Buffer.alloc(4); h.writeUInt16BE(t, 0); h.writeUInt16BE(v.length, 2);
    parts.push(h, v, Buffer.alloc((4 - (v.length % 4)) % 4));
  }
  let body = Buffer.concat(parts);
  const head = Buffer.alloc(20); head.writeUInt16BE(type, 0); head.writeUInt32BE(COOKIE, 4); tid.copy(head, 8);
  if (integrity) {
    head.writeUInt16BE(body.length + 24, 2);
    const mac = crypto.createHmac('sha1', KEY).update(Buffer.concat([head, body])).digest();
    const h = Buffer.alloc(4); h.writeUInt16BE(A.MI, 0); h.writeUInt16BE(20, 2);
    body = Buffer.concat([body, h, mac]);
  }
  head.writeUInt16BE(body.length, 2);
  return Buffer.concat([head, body]);
}
function errorCode(code, reason) {
  const r = Buffer.from(reason); const b = Buffer.alloc(4 + r.length); b[2] = Math.floor(code / 100); b[3] = code % 100; r.copy(b, 4); return b;
}
function checkIntegrity(m) {
  const mi = m.attrs.find((x) => x.t === A.MI);
  if (!mi) return false;
  const head = Buffer.from(m.raw.subarray(0, mi.off));
  head.writeUInt16BE(mi.off - 20 + 24, 2);
  const mac = crypto.createHmac('sha1', KEY).update(head).digest();
  return mac.equals(mi.v) && String(get(m, A.USERNAME)) === USER;
}

const server = dgram.createSocket('udp4');
const allocs = new Map(); // client "ip:port" -> { relay socket, perms Set(ip), channels Map(num->peer), peerToChan Map }
const nonce = Buffer.from(crypto.randomBytes(8).toString('hex'));
const send = (buf, rinfo) => server.send(buf, rinfo.port, rinfo.address);

server.on('message', (buf, rinfo) => {
  const key = `${rinfo.address}:${rinfo.port}`;
  // ChannelData from client
  if ((buf[0] & 0xC0) === 0x40) {
    const a = allocs.get(key); if (!a) return;
    const ch = buf.readUInt16BE(0), len = buf.readUInt16BE(2), peer = a.channels.get(ch);
    if (peer) { a.sock.send(buf.subarray(4, 4 + len), peer.port, peer.ip); stats.relayedPackets++; }
    return;
  }
  const m = parse(buf); if (!m) return;
  if (m.method === 0x001 && m.cls === 0) { // Binding
    send(build(0x001, 0x100, m.tid, [[A.MAPPED, encXorAddr(rinfo.address, rinfo.port)]], false), rinfo); return;
  }
  if (m.method === 0x006 && m.cls === 0x010) { // Send indication
    const a = allocs.get(key); const pv = get(m, A.PEER), d = get(m, A.DATA);
    if (a && pv && d) { const peer = xorAddr(pv); if (a.perms.has(peer.ip)) { a.sock.send(d, peer.port, peer.ip); stats.relayedPackets++; } }
    return;
  }
  if (m.cls !== 0) return;
  if (!get(m, A.MI)) { send(build(m.method, 0x110, m.tid, [[A.ERROR, errorCode(401, 'Unauthorized')], [A.REALM, Buffer.from(REALM)], [A.NONCE, nonce]], false), rinfo); return; }
  if (!checkIntegrity(m)) { stats.authFailures++; send(build(m.method, 0x110, m.tid, [[A.ERROR, errorCode(401, 'Unauthorized')], [A.REALM, Buffer.from(REALM)], [A.NONCE, nonce]], false), rinfo); return; }
  const ok = (attrs) => send(build(m.method, 0x100, m.tid, attrs, true), rinfo);
  if (m.method === 0x003) { // Allocate
    let a = allocs.get(key);
    const reply = () => ok([[A.RELAYED, encXorAddr('127.0.0.1', a.sock.address().port)], [A.MAPPED, encXorAddr(rinfo.address, rinfo.port)], [A.LIFETIME, Buffer.from([0, 0, 2, 0x58])]]);
    if (a) { reply(); return; }
    const sock = dgram.createSocket('udp4');
    a = { sock, perms: new Set(), channels: new Map(), peerToChan: new Map() };
    allocs.set(key, a); stats.allocations++;
    sock.on('message', (data, from) => {
      if (!a.perms.has(from.address)) return;
      const ch = a.peerToChan.get(`${from.address}:${from.port}`);
      if (ch) { const h = Buffer.alloc(4); h.writeUInt16BE(ch, 0); h.writeUInt16BE(data.length, 2); send(Buffer.concat([h, data]), rinfo); }
      else send(build(0x007, 0x010, crypto.randomBytes(12), [[A.PEER, encXorAddr(from.address, from.port)], [A.DATA, data]], false), rinfo);
      stats.relayedPackets++;
    });
    sock.bind(0, '127.0.0.1', reply);
    return;
  }
  const a = allocs.get(key);
  if (!a) { send(build(m.method, 0x110, m.tid, [[A.ERROR, errorCode(437, 'Allocation Mismatch')]], false), rinfo); return; }
  if (m.method === 0x004) { // Refresh
    const lt = get(m, A.LIFETIME);
    if (lt && lt.readUInt32BE(0) === 0) { a.sock.close(); allocs.delete(key); }
    ok([[A.LIFETIME, lt || Buffer.from([0, 0, 2, 0x58])]]); return;
  }
  if (m.method === 0x008) { // CreatePermission
    for (const at of m.attrs) if (at.t === A.PEER) a.perms.add(xorAddr(at.v).ip);
    ok([]); return;
  }
  if (m.method === 0x009) { // ChannelBind
    const ch = get(m, A.CHANNEL).readUInt16BE(0), peer = xorAddr(get(m, A.PEER));
    a.channels.set(ch, peer); a.peerToChan.set(`${peer.ip}:${peer.port}`, ch); a.perms.add(peer.ip);
    ok([]); return;
  }
});
server.bind(PORT, '127.0.0.1', () => { if (process.send) process.send('ready'); else console.log(`TURN test server on 127.0.0.1:${PORT} user=${USER}`); });
process.on('message', (m) => { if (m === 'stats') process.send({ stats }); });
