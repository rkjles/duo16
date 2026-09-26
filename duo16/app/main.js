// Duo16 — Electron main process
const electron = require('electron');
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, clipboard } = electron;
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const net = require('net');
const os = require('os');

let win = null;
let pendingOpenFile = null;

const dataDir = () => app.getPath('userData');
const ensureDir = (d) => { fs.mkdirSync(d, { recursive: true }); return d; };
const safeKey = (k) => String(k).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 800, minWidth: 820, minHeight: 600,
    backgroundColor: '#0d0f15',
    title: 'Duo16',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('context-menu', (_e, p) => {
    if (!p.isEditable && !p.selectionText) return;
    const items = p.isEditable
      ? [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' }]
      : [{ role: 'copy' }];
    Menu.buildFromTemplate(items).popup({ window: win });
  });
  win.on('closed', () => { win = null; closeDirect(); });
  win.webContents.once('did-finish-load', () => {
    if (pendingOpenFile) { openRomPath(pendingOpenFile); pendingOpenFile = null; }
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open ROM…', accelerator: 'CmdOrCtrl+O', click: () => win && win.webContents.send('menu', 'open-rom') },
        { label: 'Play Built-in Demo', click: () => win && win.webContents.send('menu', 'demo') },
        { type: 'separator' },
        { label: 'Open Saves Folder', click: () => shell.openPath(ensureDir(path.join(dataDir(), 'saves'))) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Game',
      submenu: [
        { label: 'Pause / Resume', accelerator: 'P', registerAccelerator: false, click: () => win && win.webContents.send('menu', 'pause') },
        { label: 'Fast-forward On / Off', click: () => win && win.webContents.send('menu', 'fast') },
        { label: 'Reset', click: () => win && win.webContents.send('menu', 'reset') },
        { type: 'separator' },
        { label: 'Save State', accelerator: 'F5', registerAccelerator: false, click: () => win && win.webContents.send('menu', 'save-state') },
        { label: 'Load State', accelerator: 'F7', registerAccelerator: false, click: () => win && win.webContents.send('menu', 'load-state') },
      ],
    },
    { label: 'View', submenu: [{ role: 'togglefullscreen' }, { role: 'resetZoom' }, { type: 'separator' }, { role: 'toggleDevTools' }] },
    { label: 'Help', submenu: [{ label: 'How to play online', click: () => win && win.webContents.send('menu', 'help') }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------- ROM loading (plain files and .zip) ----------------
function extractFromZip(buf) {
  // Walk local file headers; return the first .sfc/.smc/.bin/.fig/.swc entry
  let p = 0; const found = [];
  while (p + 30 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const flags = buf.readUInt16LE(p + 6), method = buf.readUInt16LE(p + 8);
    let csize = buf.readUInt32LE(p + 18); const nameLen = buf.readUInt16LE(p + 26), extraLen = buf.readUInt16LE(p + 28);
    const name = buf.slice(p + 30, p + 30 + nameLen).toString('utf8');
    const start = p + 30 + nameLen + extraLen;
    if (flags & 8) {
      // sizes are in the central directory; find it
      const cd = findCentral(buf, name); if (cd) csize = cd.csize; else break;
    }
    found.push({ name, method, data: buf.slice(start, start + csize) });
    p = start + csize + ((flags & 8) ? 16 : 0);
  }
  const rom = found.find((f) => /\.(sfc|smc|swc|fig|bin)$/i.test(f.name)) || found[0];
  if (!rom) throw new Error('No ROM file found inside the zip.');
  if (rom.method === 0) return { name: rom.name, data: rom.data };
  if (rom.method === 8) return { name: rom.name, data: zlib.inflateRawSync(rom.data) };
  throw new Error('This zip uses an unsupported compression method.');
}
function findCentral(buf, name) {
  for (let p = buf.length - 22; p >= 0; p--) {
    if (buf.readUInt32LE(p) !== 0x06054b50) continue;
    let cd = buf.readUInt32LE(p + 16); const n = buf.readUInt16LE(p + 10);
    for (let i = 0; i < n; i++) {
      const nl = buf.readUInt16LE(cd + 28), el = buf.readUInt16LE(cd + 30), cl = buf.readUInt16LE(cd + 32);
      const nm = buf.slice(cd + 46, cd + 46 + nl).toString('utf8');
      if (nm === name) return { csize: buf.readUInt32LE(cd + 20) };
      cd += 46 + nl + el + cl;
    }
  }
  return null;
}

function readRomFile(file) {
  const buf = fs.readFileSync(file);
  if (buf.length > 16 * 1024 * 1024) throw new Error('That file is too large to be a Super NES ROM.');
  let name = path.basename(file), data = buf;
  if (/\.zip$/i.test(file) || buf.readUInt32LE(0) === 0x04034b50) { const r = extractFromZip(buf); name = path.basename(r.name); data = r.data; }
  return { name, path: file, data: new Uint8Array(data) };
}

function openRomPath(file) {
  try { const r = readRomFile(file); win.webContents.send('rom-opened', r); rememberRecent(file); }
  catch (e) { win.webContents.send('toast', 'Could not open ROM: ' + e.message); }
}

function recentFile() { return path.join(dataDir(), 'recent.json'); }
function rememberRecent(file) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(recentFile(), 'utf8')); } catch (_) { }
  list = [file, ...list.filter((f) => f !== file)].slice(0, 10);
  try { fs.writeFileSync(recentFile(), JSON.stringify(list)); } catch (_) { }
}

ipcMain.handle('rom:open-dialog', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Open a Super NES ROM',
    filters: [{ name: 'Super NES ROMs', extensions: ['sfc', 'smc', 'swc', 'fig', 'zip', 'bin'] }, { name: 'All files', extensions: ['*'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const rom = readRomFile(r.filePaths[0]);
  rememberRecent(r.filePaths[0]);
  return rom;
});
ipcMain.handle('rom:recent', () => {
  try { return JSON.parse(fs.readFileSync(recentFile(), 'utf8')).filter((f) => fs.existsSync(f)).map((f) => ({ path: f, name: path.basename(f) })); }
  catch (_) { return []; }
});
ipcMain.handle('rom:open-path', (_e, file) => { const r = readRomFile(file); rememberRecent(file); return r; });

// ---------------- saves, states, cheats, settings ----------------
ipcMain.handle('sram:load', (_e, key) => {
  const f = path.join(ensureDir(path.join(dataDir(), 'saves')), safeKey(key) + '.srm');
  return fs.existsSync(f) ? new Uint8Array(fs.readFileSync(f)) : null;
});
ipcMain.handle('sram:save', (_e, key, bytes) => {
  const f = path.join(ensureDir(path.join(dataDir(), 'saves')), safeKey(key) + '.srm');
  fs.writeFileSync(f + '.tmp', Buffer.from(bytes)); fs.renameSync(f + '.tmp', f); return true;
});
ipcMain.handle('state:save', (_e, key, slot, bytes) => {
  const f = path.join(ensureDir(path.join(dataDir(), 'states')), `${safeKey(key)}.slot${slot | 0}.d16s`);
  fs.writeFileSync(f, Buffer.from(bytes)); return true;
});
ipcMain.handle('state:load', (_e, key, slot) => {
  const f = path.join(ensureDir(path.join(dataDir(), 'states')), `${safeKey(key)}.slot${slot | 0}.d16s`);
  return fs.existsSync(f) ? new Uint8Array(fs.readFileSync(f)) : null;
});
ipcMain.handle('state:list', (_e, key) => {
  const d = ensureDir(path.join(dataDir(), 'states'));
  const out = {};
  for (let s = 1; s <= 4; s++) { const f = path.join(d, `${safeKey(key)}.slot${s}.d16s`); if (fs.existsSync(f)) out[s] = fs.statSync(f).mtimeMs; }
  return out;
});
ipcMain.handle('cheats:load', (_e, key) => {
  const f = path.join(ensureDir(path.join(dataDir(), 'cheats')), safeKey(key) + '.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return []; }
});
ipcMain.handle('cheats:save', (_e, key, list) => {
  const f = path.join(ensureDir(path.join(dataDir(), 'cheats')), safeKey(key) + '.json');
  fs.writeFileSync(f, JSON.stringify(list, null, 2)); return true;
});
ipcMain.handle('settings:load', () => {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir(), 'settings.json'), 'utf8')); } catch (_) { return null; }
});
ipcMain.handle('settings:save', (_e, s) => { fs.writeFileSync(path.join(dataDir(), 'settings.json'), JSON.stringify(s, null, 2)); return true; });
ipcMain.handle('clipboard:write', (_e, text) => { clipboard.writeText(String(text)); return true; });
ipcMain.handle('clipboard:read', () => clipboard.readText());
// ---------------- Online cheat library (libretro-database on GitHub) ----------------
// The game list (No-Intro) identifies a ROM exactly by its CRC; each game's cheat file is named after the game.
const CHEAT_BASE = 'https://raw.githubusercontent.com/libretro/libretro-database/master';
const SNES_SET = 'Nintendo - Super Nintendo Entertainment System';
const INDEX_MAX_AGE = 30 * 24 * 3600 * 1000;
const cheatDir = () => ensureDir(path.join(dataDir(), 'cheat-library'));
let cheatIndex = null; // { at, games: [[name, crc]] }

async function httpGet(url) {
  const f = electron.net && electron.net.fetch ? electron.net.fetch.bind(electron.net) : fetch;
  let res;
  try { res = await f(url, { headers: { 'User-Agent': 'Duo16' } }); }
  catch (e) { const err = new Error('offline'); err.offline = true; throw err; }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`The cheat library answered with an error (${res.status}). Try again later.`);
  return await res.text();
}

function parseDat(text) {
  const games = []; let name = null;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('game (')) { name = null; continue; }
    let m = t.match(/^name "(.*)"$/);
    if (m && name === null) { name = m[1]; continue; }
    m = t.match(/^rom \(.*\bcrc ([0-9A-Fa-f]{8})\b/);
    if (m && name !== null) { games.push([name, parseInt(m[1], 16) >>> 0]); name = '\u0000'; }
  }
  return games.filter((g) => g[0] !== '\u0000');
}

async function loadCheatIndex() {
  if (cheatIndex && Date.now() - cheatIndex.at < INDEX_MAX_AGE) return cheatIndex;
  const file = path.join(cheatDir(), 'snes-games.json');
  let cached = null;
  try { cached = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { }
  if (cached && Date.now() - cached.at < INDEX_MAX_AGE) return (cheatIndex = cached);
  try {
    const text = await httpGet(`${CHEAT_BASE}/metadat/no-intro/${encodeURIComponent(SNES_SET)}.dat`);
    if (!text) throw new Error('The cheat library\'s game list has moved. Duo16 needs an update to use it.');
    const games = parseDat(text);
    if (games.length < 100) throw new Error('The cheat library\'s game list could not be read.');
    cheatIndex = { at: Date.now(), games };
    fs.writeFileSync(file, JSON.stringify(cheatIndex));
    return cheatIndex;
  } catch (e) {
    if (cached) return (cheatIndex = cached); // use the older copy when offline
    if (e.offline) throw new Error('Couldn\'t reach the cheat library. Check your internet connection and try again.');
    throw e;
  }
}

function normTitle(s) {
  return String(s).toLowerCase().replace(/\.(sfc|smc|swc|fig|zip|bin)$/i, '').replace(/[([][^)\]]*[)\]]/g, ' ')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}
function scoreTitle(query, name) {
  const q = normTitle(query), n = normTitle(name);
  if (!q || !n) return 0;
  const qc = q.replace(/ /g, ''), nc = n.replace(/ /g, '');
  let s = 0;
  if (qc === nc) s = 100;
  else if (nc.startsWith(qc) || qc.startsWith(nc)) s = 75;
  else if (nc.includes(qc)) s = 60;
  else {
    const qt = q.split(' '), nt = n.split(' ');
    const hit = qt.filter((w) => nt.some((x) => x === w || (w.length > 2 && x.startsWith(w)))).length;
    s = (hit / qt.length) * 55 - Math.max(0, nt.length - qt.length) * 2;
  }
  if (/\(USA/.test(name)) s += 4; else if (/\(World|\(Europe/.test(name)) s += 2;
  if (/\((Beta|Proto|Demo|Sample|Pirate|Hack|Unl|Aftermarket)/i.test(name)) s -= 15;
  if (/\(Rev /.test(name)) s -= 1;
  return s;
}
function bestMatches(queries, games, limit) {
  const scored = new Map();
  for (const [name] of games) {
    let best = 0;
    for (const q of queries) if (q) best = Math.max(best, scoreTitle(q, name));
    if (best >= 35) scored.set(name, Math.max(best, scored.get(name) || 0));
  }
  return [...scored.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map((e) => e[0]);
}

ipcMain.handle('cheatdb:lookup', async (_e, crc, hints) => {
  const idx = await loadCheatIndex();
  const exact = idx.games.find((g) => g[1] === (crc >>> 0));
  const queries = [exact && exact[0], ...(Array.isArray(hints) ? hints.map(String) : [])].filter(Boolean);
  const suggestions = bestMatches(queries, idx.games, 12).filter((n) => !exact || n !== exact[0]);
  return { exact: exact ? exact[0] : null, suggestions };
});
ipcMain.handle('cheatdb:search', async (_e, query) => {
  const idx = await loadCheatIndex();
  return bestMatches([String(query).slice(0, 100)], idx.games, 30);
});
ipcMain.handle('cheatdb:get', async (_e, name) => {
  name = String(name);
  const idx = await loadCheatIndex();
  if (!idx.games.some((g) => g[0] === name)) throw new Error('Unknown game.');
  const file = path.join(cheatDir(), safeKey(name) + '.cht');
  let text = null;
  try {
    text = await httpGet(`${CHEAT_BASE}/cht/${encodeURIComponent(SNES_SET)}/${encodeURIComponent(name)}.cht`);
    if (text !== null) fs.writeFileSync(file, text);
  } catch (e) {
    if (fs.existsSync(file)) text = fs.readFileSync(file, 'utf8');
    else if (e.offline) throw new Error('Couldn\'t reach the cheat library. Check your internet connection and try again.');
    else throw e;
  }
  if (text === null) return { found: false, cheats: [] };
  return { found: true, cheats: parseCht(text) };
});
function parseCht(text) {
  const byIdx = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*cheat(\d+)_(desc|code)\s*=\s*"(.*)"\s*$/);
    if (!m) continue;
    (byIdx[m[1]] = byIdx[m[1]] || {})[m[2]] = m[3].replace(/\\"/g, '"');
  }
  return Object.keys(byIdx).map(Number).sort((a, b) => a - b).map((i) => byIdx[i])
    .filter((c) => c.code && c.code.trim()).map((c) => ({ desc: (c.desc || '').trim().slice(0, 80), code: c.code.trim().slice(0, 400) }));
}

ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, addresses: localAddresses() }));
ipcMain.on('app:set-title', (_e, t) => { if (win) win.setTitle(t); });

function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out;
}

// ---------------- Direct connection (TCP) for LAN / VPN play ----------------
// Frames: u32 length | u8 kind (0 json, 1 binary) | payload
let server = null, sock = null, rxBuf = Buffer.alloc(0);
function closeDirect() {
  if (sock) { try { sock.destroy(); } catch (_) { } sock = null; }
  if (server) { try { server.close(); } catch (_) { } server = null; }
  rxBuf = Buffer.alloc(0);
}
function wireSocket(s) {
  sock = s; s.setNoDelay(true);
  s.on('data', (d) => {
    rxBuf = Buffer.concat([rxBuf, d]);
    while (rxBuf.length >= 5) {
      const len = rxBuf.readUInt32LE(0);
      if (len > 8 * 1024 * 1024) { closeDirect(); return; }
      if (rxBuf.length < 5 + len) break;
      const kind = rxBuf[4]; const payload = rxBuf.slice(5, 5 + len); rxBuf = rxBuf.slice(5 + len);
      if (win) win.webContents.send('direct:data', kind === 1 ? { bin: new Uint8Array(payload) } : { json: payload.toString('utf8') });
    }
  });
  s.on('close', () => { if (sock === s) { sock = null; if (win) win.webContents.send('direct:closed'); } });
  s.on('error', (e) => { if (win) win.webContents.send('direct:error', e.message); });
  if (win) win.webContents.send('direct:open');
}
ipcMain.handle('direct:host', (_e, port) => new Promise((resolve) => {
  closeDirect();
  server = net.createServer((s) => { if (sock) { s.destroy(); return; } wireSocket(s); });
  server.on('error', (e) => resolve({ ok: false, error: e.code === 'EADDRINUSE' ? `Port ${port} is already in use.` : e.message }));
  server.listen(port, '0.0.0.0', () => resolve({ ok: true, addresses: localAddresses() }));
}));
ipcMain.handle('direct:connect', (_e, host, port) => new Promise((resolve) => {
  closeDirect();
  const s = net.connect({ host, port }, () => { wireSocket(s); resolve({ ok: true }); });
  s.setTimeout(8000, () => { s.destroy(); resolve({ ok: false, error: 'Timed out. Check the address and that the host is waiting.' }); });
  s.on('connect', () => s.setTimeout(0));
  s.on('error', (e) => resolve({ ok: false, error: e.code === 'ECONNREFUSED' ? 'Connection refused. Is the host waiting on that port?' : e.message }));
}));
ipcMain.on('direct:send', (_e, msg) => {
  if (!sock) return;
  const payload = msg.bin ? Buffer.from(msg.bin) : Buffer.from(msg.json, 'utf8');
  const head = Buffer.alloc(5); head.writeUInt32LE(payload.length, 0); head[4] = msg.bin ? 1 : 0;
  sock.write(Buffer.concat([head, payload]));
});
ipcMain.handle('direct:close', () => { closeDirect(); return true; });

// ---------------- app lifecycle ----------------
app.on('open-file', (e, file) => { e.preventDefault(); if (win) openRomPath(file); else pendingOpenFile = file; });
const argFile = process.argv.slice(1).find((a) => /\.(sfc|smc|zip)$/i.test(a));
if (argFile) pendingOpenFile = argFile;

app.whenReady().then(() => { buildMenu(); createWindow(); });
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (!win) createWindow(); });
