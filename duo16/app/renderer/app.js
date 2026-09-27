// ===== Duo16 app controller =====
'use strict';
const $ = (id) => document.getElementById(id);
const input = new Input();
const audio = new AudioOut();
const machine = new Machine();
let session = null;
let link = null;
const net = { mode: 'offline', role: null, remoteRom: null, autoDelayAt: 0, lastAutoDelay: 0, syncing: false };
let rom = null;                 // { name, crc, key, demo, data }
let settings = { keys: {}, padMaps: {}, padChoice: '', volume: 0.8, smooth: false, delayPref: 'auto', ffSpeed: 3, rwSpeed: 0, padCombos: true, perms: { guestCheats: true, guestRewind: true, guestPause: true, guestReset: false, guestFast: true } };
let currentSlot = 1;
let ffHeld = false;
let sramWritable = true, sramLastCrc = 0;
let frameDirty = false, waitingSince = 0;
let lastCheatVersion = -1;
let rewindSent = false;

// ---------------------------------------------------------------- helpers
function romCrc(data) {
  const d = (data.length & 0x3FF) === 0x200 ? data.subarray(0x200) : data;
  return crc32(d);
}
function hex(n, w) { return n.toString(16).toUpperCase().padStart(w, '0'); }
function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind; el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4200);
  while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
}
function playerKind(text) { return /player 2/i.test(text) ? 'p2' : /player 1/i.test(text) ? 'p1' : ''; }
machine.onEvent = (t) => toast(t, playerKind(t));
function saveSettings() { window.duo.saveSettings(settings); }
function myRole() { return session ? session.role : 'solo'; }
function isGuest() { return net.mode === 'connected' && net.role === 'guest'; }

// ---------------------------------------------------------------- sessions
function sessionOpts(role) {
  return {
    role,
    delay: role === 'solo' ? 0 : chosenDelay(),
    readInput: () => input.readP1(),
    readLocal2: () => input.readP2(),
    onToast: (t) => toast(t),
    onStatus: (s) => { net.syncing = !!s.syncing; if (s.synced) toast('Connected. You\'re player 2.', 'p2'); },
  };
}
function makeSolo() {
  session = new Session(machine, sessionOpts('solo'));
}
function chosenDelay() {
  if (settings.delayPref !== 'auto') return +settings.delayPref;
  const rtt = session && session.stats ? session.stats.rtt : 0;
  return autoDelay(rtt);
}
function autoDelay(rtt) {
  if (!rtt) return 4;
  return Math.max(2, Math.min(8, Math.ceil(rtt / 2 / 16.67) + 2));
}

// ---------------------------------------------------------------- ROM loading
async function loadRom(r, opts = {}) {
  const data = r.data instanceof Uint8Array ? r.data : new Uint8Array(r.data);
  const crc = romCrc(data);
  if (isGuest() && !opts.fromHost) {
    const want = net.remoteRom;
    if (want && !want.demo && want.crc !== crc) {
      toast(`That file doesn't match the host's game (${want.title}). Pick the same ROM file.`, 'bad');
      return false;
    }
  }
  await flushSram();
  try { machine.loadROM(data); }
  catch (e) { toast('Could not start that ROM: ' + e.message, 'bad'); return false; }
  const cart = machine.snes.cart;
  rom = { name: r.name, crc, demo: !!opts.demo, key: `${cart.title.replace(/\s+/g, '_')}_${hex(crc, 8)}`, title: opts.demo ? 'Paddle Duel (demo)' : cart.title };
  $('game-title').textContent = rom.title;
  window.duo.setTitle(`Duo16 — ${rom.title}`);
  $('welcome').hidden = true;
  if (cart.unsupportedChip) toast(`This game uses the ${cart.unsupportedChip} chip, which Duo16 doesn't emulate yet. It may not run correctly.`, 'bad');
  // battery save
  sramWritable = !isGuest() && !rom.demo;
  sramLastCrc = 0;
  if (!rom.demo && cart.sramSize) {
    const s = await window.duo.loadSram(rom.key);
    if (s && s.length === cart.sram.length) cart.sram.set(s);
    sramLastCrc = crc32(cart.sram);
  }
  machine.snes.softReset();
  makeSolo();
  if (!isGuest()) {
    machine.applyCommand({ k: 'settings', settings: settings.perms }, 0);
    const lib = rom.demo ? [] : await window.duo.loadCheats(rom.key);
    if (lib && lib.length) session.command({ k: 'cheats', list: lib });
  }
  audio.flush();
  refreshSlots();
  renderCheats();
  lib.forKey = null; lib.game = null; lib.cheats = []; $('lib-body').hidden = true; renderLibList();
  libStatus(rom.demo ? 'The demo game has no cheat library. Open a ROM to look up its cheats.' : 'Looks up Game Genie and Action Replay codes for the game you\'re playing.');
  if (!$('panel-cheats').hidden && !rom.demo) libFind();
  if (net.mode === 'connected' && net.role === 'host') announceRom();
  if (isGuest()) sendReady();
  return true;
}

async function openRomDialog() {
  try { const r = await window.duo.openRomDialog(); if (r) await loadRom(r); }
  catch (e) { toast('Could not open that file: ' + e.message, 'bad'); }
}
function loadDemo(opts = {}) {
  const bin = atob(DEMO_ROM_B64); const d = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) d[i] = bin.charCodeAt(i);
  return loadRom({ name: 'Paddle Duel', data: d }, { demo: true, ...opts });
}

async function flushSram() {
  if (!rom || !sramWritable || rom.demo) return;
  const cart = machine.snes.cart; if (!cart || !cart.sramSize) return;
  const c = crc32(cart.sram);
  if (c !== sramLastCrc) { sramLastCrc = c; await window.duo.saveSram(rom.key, cart.sram.slice()); }
}
setInterval(flushSram, 2000);
addEventListener('beforeunload', () => { flushSram(); });

// ---------------------------------------------------------------- save states
async function refreshSlots() {
  const list = $('slots'); list.innerHTML = '';
  const times = rom && !rom.demo ? await window.duo.listStates(rom.key) : {};
  for (let s = 1; s <= 4; s++) {
    const li = document.createElement('li'); if (s === currentSlot) li.className = 'current';
    const when = times[s] ? new Date(times[s]).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Empty';
    li.innerHTML = `<span class="s-num">SLOT ${s}</span><span class="s-when"></span><button class="btn small" data-a="save">Save</button><button class="btn small" data-a="load" ${times[s] ? '' : 'disabled'}>Load</button>`;
    li.querySelector('.s-when').textContent = when;
    li.querySelector('[data-a=save]').onclick = () => { currentSlot = s; saveState(s); };
    li.querySelector('[data-a=load]').onclick = () => { currentSlot = s; loadState(s); };
    list.appendChild(li);
  }
}
async function saveState(slot) {
  if (!rom) return;
  if (rom.demo) { toast('Save states are turned off for the demo.'); return; }
  const bytes = serializeState({ v: 1, emuFrame: machine.emuFrame, snes: snapshotSNES(machine.snes) });
  await window.duo.saveState(rom.key, slot, bytes);
  toast(`Saved to slot ${slot}`); refreshSlots();
}
async function loadState(slot) {
  if (!rom || rom.demo) return;
  if (isGuest()) { toast('During online play, only the host can load a save state. It loads for both of you.'); return; }
  const bytes = await window.duo.loadState(rom.key, slot);
  if (!bytes) { toast(`Slot ${slot} is empty.`); return; }
  try {
    const st = deserializeState(bytes);
    restoreSNES(machine.snes, st.snes);
    audio.flush();
    if (myRole() === 'host') session.sendSync('Loaded a save state for both players');
    else toast(`Loaded slot ${slot}`);
  } catch (e) { toast('That save state could not be loaded: ' + e.message, 'bad'); }
}

// ---------------------------------------------------------------- online: connection flow
function showView(name) {
  for (const v of document.querySelectorAll('#panel-online .view')) v.hidden = v.dataset.view !== name;
}
function newRtc() {
  closeLink();
  link = new RtcLink();
  wireLink(link);
  return link;
}
function wireLink(l) {
  l.handlers.fast = (o) => { if (session && session.role !== 'solo') session.onFast(o); };
  l.handlers.reliable = (o) => {
    if (o instanceof Uint8Array || ['ping', 'pong', 'sum', 'sync-begin', 'synced', 'desync', 'chat'].includes(o.t)) {
      if (session && session.role !== 'solo') session.onReliable(o);
      else if (o.t === 'ping') l.sendReliable({ t: 'pong', ts: o.ts });
      return;
    }
    onAppMessage(o);
  };
  l.handlers.open = () => onConnected();
  l.handlers.close = (reason) => onDisconnected(reason);
}
function closeLink() { if (link) { const l = link; link = null; l.handlers = {}; l.close(); } }

async function hostStart() {
  showView('host-code');
  net.role = 'host';
  $('host-invite').value = 'Creating code…'; $('host-reply').value = '';
  try { $('host-invite').value = await newRtc().createInvite(); }
  catch (e) { toast('Could not create an invite: ' + e.message, 'bad'); showView('idle'); }
}
async function hostConnect() {
  try { await link.acceptReply($('host-reply').value); $('host-connect').disabled = true; $('host-connect').textContent = 'Connecting…'; }
  catch (e) { toast(e.message, 'bad'); }
}
function joinStart() {
  showView('join-code'); net.role = 'guest';
  $('join-invite').value = ''; $('join-reply').value = ''; $('join-step2').classList.add('dim'); $('join-copy').disabled = true;
}
async function joinMake() {
  try {
    $('join-make').disabled = true; $('join-make').textContent = 'Creating…';
    const code = await newRtc().createReply($('join-invite').value);
    $('join-reply').value = code; $('join-step2').classList.remove('dim'); $('join-copy').disabled = false;
  } catch (e) { toast(e.message, 'bad'); }
  finally { $('join-make').disabled = false; $('join-make').textContent = 'Create reply code'; }
}
async function directHost() {
  closeLink(); net.role = 'host';
  const l = link = new DirectLink(); wireLink(l);
  const port = +$('d-port').value || 47016;
  const r = await l.host(port);
  if (!r.ok) { toast(r.error, 'bad'); return; }
  $('d-host-info').textContent = `Waiting on port ${port}. Your address${r.addresses.length > 1 ? 'es' : ''}: ${r.addresses.join(', ') || 'unknown'}`;
}
async function directJoin() {
  closeLink(); net.role = 'guest';
  const l = link = new DirectLink(); wireLink(l);
  const r = await l.connect($('d-addr').value.trim(), +$('d-port2').value || 47016);
  if (!r.ok) toast(r.error, 'bad');
}

function onConnected() {
  net.mode = 'connected';
  showView('connected');
  $('host-connect').disabled = false; $('host-connect').textContent = 'Connect';
  link.sendReliable({ t: 'hello', v: NET_VERSION, app: 'duo16' });
  updateOnlinePanel();
  if (net.role === 'host') {
    toast('Your friend connected. You\'re player 1.', 'p1');
    if (rom) announceRom(); else toast('Pick a game and it will start for both of you.');
  } else {
    toast('Connected to the host.', 'p2');
    $('welcome').hidden = true;
  }
}
function onDisconnected(reason) {
  const wasConnected = net.mode === 'connected';
  link = null;
  net.mode = 'offline'; net.remoteRom = null; net.syncing = false;
  if (session && session.role !== 'solo') makeSolo();
  if (net.role === 'guest' && wasConnected) sramWritable = false; // don't overwrite your own save with the host's game
  showView('idle');
  $('rom-mismatch').hidden = true;
  if (reason) toast(reason, 'bad');
  updateOnlinePanel();
}
function leaveSession() {
  if (link) { link.sendReliable({ t: 'bye' }); setTimeout(() => { closeLink(); onDisconnected('You left the session.'); }, 100); }
  else onDisconnected();
}

function announceRom() {
  if (!link || !rom) return;
  if (session.role !== 'solo') makeSolo();
  link.sendReliable({ t: 'rom', crc: rom.crc, title: rom.title, demo: rom.demo });
}
function sendReady() {
  if (!link || !rom) return;
  const want = net.remoteRom; if (!want) return;
  if (!want.demo && want.crc !== rom.crc) return;
  if (want.demo && !rom.demo) return;
  $('rom-mismatch').hidden = true;
  session = new Session(machine, sessionOpts('guest'));
  session.attach(link);
  link.sendReliable({ t: 'ready', crc: rom.crc });
}
function startHostSession(reason) {
  session = new Session(machine, sessionOpts('host'));
  session.attach(link);
  machine.applyCommand({ k: 'settings', settings: settings.perms }, 0);
  session.sendSync(reason);
  net.autoDelayAt = performance.now() + 3000;
}

async function onAppMessage(o) {
  switch (o.t) {
    case 'hello':
      if (o.v !== NET_VERSION) { toast(`Your friend has a different version of Duo16. Both players need the same version.`, 'bad'); leaveSession(); }
      break;
    case 'rom': // guest learns what the host is playing
      if (net.role !== 'guest') break;
      net.remoteRom = { crc: o.crc >>> 0, title: String(o.title).slice(0, 40), demo: !!o.demo };
      if (session.role !== 'solo') makeSolo();
      if (net.remoteRom.demo) { await loadDemo({ fromHost: true }); break; }
      if (rom && rom.crc === net.remoteRom.crc) { sendReady(); break; }
      if (await tryRecentFor(net.remoteRom.crc)) break;
      $('rom-mismatch-text').textContent = `The host is playing ${net.remoteRom.title}. Open your copy of the same ROM file to join in.`;
      $('rom-mismatch').hidden = false;
      break;
    case 'ready': // host: guest has the same game loaded
      if (net.role !== 'host' || !rom || o.crc >>> 0 !== rom.crc) break;
      startHostSession('Starting the game for both players');
      break;
    case 'bye':
      closeLink(); onDisconnected('Your friend left the session.');
      break;
  }
}
async function tryRecentFor(crc) {
  const recents = await window.duo.recentRoms();
  for (const r of recents) {
    try {
      const f = await window.duo.openRomPath(r.path);
      if (romCrc(f.data) === crc) { toast(`Found ${f.name} in your recent games.`); await loadRom(f); return true; }
    } catch (_) { }
  }
  return false;
}

function applyHostSettings() {
  settings.perms = {
    guestCheats: $('perm-cheats').checked, guestRewind: $('perm-rewind').checked,
    guestPause: $('perm-pause').checked, guestReset: $('perm-reset').checked, guestFast: $('perm-fast').checked,
  };
  saveSettings();
  if (!isGuest()) session.command({ k: 'settings', settings: settings.perms });
}

function updateOnlinePanel() {
  const connected = net.mode === 'connected';
  const pill = $('net-pill');
  pill.className = 'pill ' + (!connected ? 'offline' : (net.syncing ? 'wait' : 'live'));
  if (!connected) $('net-pill-text').textContent = 'Offline';
  if (!connected) return;
  const st = session.role !== 'solo' ? session.status() : null;
  const me = net.role === 'host' ? 1 : 2;
  $('p1-who').textContent = me === 1 ? 'You (host)' : 'Host';
  $('p2-who').textContent = me === 2 ? 'You' : 'Your friend';
  const ping = st && st.rtt ? `${st.rtt} ms` : '–';
  $('st-ping').textContent = ping;
  $('st-delay').textContent = st ? `${st.delay} fr` : '–';
  $('st-sync').textContent = net.syncing ? 'Syncing' : !st ? 'Waiting' : st.desyncs ? `Repaired ×${st.desyncs}` : 'In sync';
  $('p1-meta').textContent = me === 1 ? '' : ping;
  $('p2-meta').textContent = me === 2 ? '' : ping;
  $('net-pill-text').textContent = net.syncing ? 'Syncing…' : !st ? `Connected · waiting for game` : `P${me} · ${ping}`;
  $('host-settings').hidden = net.role !== 'host';
  const gp = $('guest-perms');
  gp.hidden = net.role !== 'guest';
  if (net.role === 'guest') {
    const s = machine.settings; const can = [];
    if (s.guestCheats) can.push('cheats'); if (s.guestRewind) can.push('rewind'); if (s.guestPause) can.push('pause'); if (s.guestFast !== false) can.push('fast-forward'); if (s.guestReset) can.push('reset');
    gp.textContent = can.length ? `The host lets you use: ${can.join(', ')}.` : 'The host has turned off cheats, rewind, pause and fast-forward for guests.';
  }
}
setInterval(() => {
  updateOnlinePanel();
  // automatic input delay from measured ping
  if (net.mode === 'connected' && net.role === 'host' && session.role === 'host' && settings.delayPref === 'auto' && !net.syncing) {
    const t = performance.now();
    if (net.autoDelayAt && t > net.autoDelayAt && session.stats.rtt) {
      const want = autoDelay(session.stats.rtt);
      if (Math.abs(want - session.delay) >= (net.lastAutoDelay ? 2 : 1)) {
        session.delay = want; net.lastAutoDelay = want;
        session.sendSync(`Input delay set to ${want} frames for your connection`);
      }
      net.autoDelayAt = t + 20000;
    }
  }
}, 500);

// ---------------------------------------------------------------- cheats UI
function canCheat() { return !isGuest() || machine.settings.guestCheats; }
function commitCheats(list, note) {
  if (!canCheat()) { toast('The host has turned off cheats for guests.'); return; }
  session.command({ k: 'cheats', list, note });
}
let cheatEdit = null; // { index, orig, code, desc, kind } while a cheat is being edited
function cheatKindLabel(code, kind) {
  try { const ps = parseCheatCodes(code, kind); const t = new Set(ps.map((p) => p.type)); return t.size > 1 ? 'MIX' : (ps[0].type === 'gg' ? 'GG' : 'PAR'); } catch (_) { return '?'; }
}
function startCheatEdit(i) {
  if (!canCheat()) { toast('The host has turned off cheats for guests.'); return; }
  const c = machine.cheatList[i];
  cheatEdit = { index: i, orig: c.code, code: c.code, desc: c.desc || '', kind: c.kind || 'auto' };
  renderCheats();
  const el = document.getElementById('edit-code'); if (el) { el.focus(); el.select(); }
}
function saveCheatEdit() {
  const e = cheatEdit; if (!e) return;
  const c = machine.cheatList[e.index];
  if (!c || c.code !== e.orig) { toast('That cheat was changed or removed by the other player.'); cheatEdit = null; renderCheats(); return; }
  let code;
  try { code = parseCheatCodes(e.code, e.kind).map((p) => p.text).join('+'); }
  catch (err) { toast(err.message, 'bad'); return; }
  const desc = e.desc.trim().slice(0, 80);
  cheatEdit = null;
  if (code === c.code && desc === (c.desc || '') && e.kind === (c.kind || 'auto')) { renderCheats(); return; }
  const nl = machine.cheatList.map((x, j) => j === e.index ? { ...x, code, desc, kind: e.kind } : x);
  commitCheats(nl, `edited ${desc || code}`);
  renderCheats();
}
function renderCheatEditor(li, c) {
  const e = cheatEdit;
  li.className = 'editing';
  li.innerHTML = `
    <form class="cheat-edit" autocomplete="off">
      <label class="field"><span>Code</span><input id="edit-code" class="mono" spellcheck="false"></label>
      <label class="field"><span>What it does</span><input id="edit-desc" spellcheck="false"></label>
      <div class="row">
        <select id="edit-kind" aria-label="Code type"><option value="auto">Detect type</option><option value="gg">Game Genie</option><option value="par">Pro Action Replay</option></select>
        <button class="btn primary small" type="submit">Save</button>
        <button class="btn ghost small" type="button" id="edit-cancel">Cancel</button>
      </div>
      <div class="decode" id="edit-decode"></div>
    </form>`;
  const code = li.querySelector('#edit-code'), desc = li.querySelector('#edit-desc'), kind = li.querySelector('#edit-kind'), dec = li.querySelector('#edit-decode');
  code.value = e.code; desc.value = e.desc; kind.value = e.kind;
  const check = () => {
    try { const n = parseCheatCodes(code.value, kind.value).length; dec.textContent = n > 1 ? `${n} codes` : 'Code looks good'; dec.className = 'decode'; }
    catch (err) { dec.textContent = err.message; dec.className = 'decode bad'; }
  };
  code.oninput = () => { e.code = code.value; check(); };
  desc.oninput = () => { e.desc = desc.value; };
  kind.onchange = () => { e.kind = kind.value; check(); };
  li.querySelector('form').onsubmit = (ev) => { ev.preventDefault(); saveCheatEdit(); };
  li.querySelector('#edit-cancel').onclick = () => { cheatEdit = null; renderCheats(); };
  li.onkeydown = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); cheatEdit = null; renderCheats(); } };
  check();
}
function renderCheats() {
  const ul = $('cheat-list');
  // keep typing focus if the list redraws while someone is editing
  const focusedId = document.activeElement && ul.contains(document.activeElement) ? document.activeElement.id : null;
  ul.innerHTML = '';
  const on = machine.cheatsOn !== false;
  $('cheats-master').setAttribute('aria-checked', String(on));
  $('cheats-master-text').textContent = on ? 'Cheats on' : 'Cheats off';
  $('cheats-off-note').hidden = on || !machine.cheatList.length;
  ul.classList.toggle('all-off', !on);
  const list = machine.cheatList;
  $('cheat-lock').hidden = canCheat();
  if (cheatEdit && (!list[cheatEdit.index] || list[cheatEdit.index].code !== cheatEdit.orig)) {
    cheatEdit = null; toast('The cheat you were editing was changed or removed by the other player.');
  }
  if (!list.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'No cheats yet'; ul.appendChild(li); return; }
  list.forEach((c, i) => {
    const li = document.createElement('li');
    if (cheatEdit && cheatEdit.index === i) { renderCheatEditor(li, c); ul.appendChild(li); return; }
    li.innerHTML = `<input type="checkbox" ${c.enabled ? 'checked' : ''} aria-label="Enabled"><div style="min-width:0"><div><span class="c-code"></span><span class="c-kind">${cheatKindLabel(c.code, c.kind)}</span></div><div class="c-desc"></div></div><div class="c-actions"><button class="c-edit" title="Edit" aria-label="Edit">Edit</button><button class="x" title="Remove" aria-label="Remove">×</button></div>`;
    li.querySelector('.c-code').textContent = c.code.replace(/\+/g, ' + ');
    li.querySelector('.c-desc').textContent = c.desc || 'No description';
    li.querySelector('input').onchange = (e) => {
      const nl = machine.cheatList.map((x, j) => j === i ? { ...x, enabled: e.target.checked } : x);
      commitCheats(nl, `${e.target.checked ? 'turned on' : 'turned off'} ${c.desc || c.code}`);
      e.target.checked = c.enabled; // UI updates when the change takes effect
    };
    li.querySelector('.c-edit').onclick = () => startCheatEdit(i);
    li.querySelector('.x').onclick = () => commitCheats(machine.cheatList.filter((_, j) => j !== i), `removed ${c.desc || c.code}`);
    ul.appendChild(li);
  });
  if (focusedId) { const el = document.getElementById(focusedId); if (el) el.focus(); }
}
function describeCode() {
  const el = $('cheat-decode'); const v = $('cheat-code').value.trim();
  if (!v) { el.textContent = ''; el.className = 'decode'; return; }
  try {
    const ps = parseCheatCodes(v, $('cheat-kind').value); const p = ps[0];
    const addr = `$${hex(p.addr >> 16, 2)}:${hex(p.addr & 0xFFFF, 4)}`;
    el.textContent = `${p.type === 'gg' ? 'Game Genie' : 'Action Replay'} → ${p.type === 'gg' ? 'replaces the byte at' : 'holds'} ${addr} ${p.type === 'gg' ? 'with' : 'at'} $${hex(p.value, 2)}` + (ps.length > 1 ? ` (+${ps.length - 1} more code${ps.length > 2 ? 's' : ''})` : '');
    el.className = 'decode';
  } catch (e) { el.textContent = e.message; el.className = 'decode bad'; }
}

// ---------------------------------------------------------------- online cheat library
const lib = { forKey: null, game: null, cheats: [], busy: false };
function libStatus(text, bad) { const el = $('lib-status'); el.textContent = text; el.style.color = bad ? 'var(--bad)' : ''; }
function normCode(c) { return String(c).toUpperCase().replace(/\s+/g, ''); }
function libOption(name, label) { const o = document.createElement('option'); o.value = name; o.textContent = label || name; return o; }
async function libFind() {
  if (!rom) { libStatus('Load a game first.'); return; }
  if (rom.demo) { libStatus('The demo game has no cheat library. Open a ROM to look up its cheats.'); $('lib-body').hidden = true; return; }
  if (lib.busy) return;
  lib.busy = true; $('lib-find').disabled = true;
  libStatus(`Looking up ${rom.title}…`);
  try {
    const hints = [rom.name, rom.title].filter(Boolean);
    const r = await window.duo.cheatLibrary.lookup(rom.crc, hints);
    lib.forKey = rom.key;
    const sel = $('lib-game'); sel.innerHTML = '';
    if (r.exact) sel.appendChild(libOption(r.exact, `${r.exact} (exact match)`));
    for (const n of r.suggestions) sel.appendChild(libOption(n));
    $('lib-body').hidden = false;
    if (!sel.options.length) {
      libStatus('This ROM isn\'t in the library\'s game list. Search for the game by name below.');
      renderLibList(); return;
    }
    await libLoad(sel.value, !r.exact);
  } catch (e) { libStatus(e.message, true); }
  finally { lib.busy = false; $('lib-find').disabled = false; }
}
async function libLoad(name, guessed) {
  lib.game = name; lib.cheats = [];
  $('lib-filter').value = ''; renderLibList();
  libStatus(`Getting cheats for ${name}…`);
  try {
    const r = await window.duo.cheatLibrary.get(name);
    if (lib.game !== name) return;
    if (!r.found || !r.cheats.length) {
      libStatus(`No cheats in the library for ${name}. Try another version in the list.`);
      renderLibList(); return;
    }
    lib.cheats = r.cheats.map((c) => { let ok = true; try { parseCheatCodes(c.code); } catch (_) { ok = false; } return { ...c, ok }; });
    const usable = lib.cheats.filter((c) => c.ok).length;
    libStatus(`${usable} cheat${usable === 1 ? '' : 's'} for ${name}.` + (guessed ? ' This is a best guess from the file name; check the version is right.' : '') + (usable < lib.cheats.length ? ` ${lib.cheats.length - usable} use a format Duo16 can't read and are hidden.` : ''));
    $('lib-filter').hidden = usable < 8;
    renderLibList();
  } catch (e) { libStatus(e.message, true); }
}
function renderLibList() {
  const ul = $('lib-list'); ul.innerHTML = '';
  const f = $('lib-filter').value.trim().toLowerCase();
  const have = new Set(machine.cheatList.map((c) => normCode(c.code)));
  const rows = lib.cheats.filter((c) => c.ok && (!f || c.desc.toLowerCase().includes(f) || c.code.toLowerCase().includes(f)));
  if (lib.cheats.length && !rows.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'No cheats match that filter.'; ul.appendChild(li); return; }
  for (const c of rows.slice(0, 400)) {
    const li = document.createElement('li');
    li.innerHTML = '<div style="min-width:0"><div class="l-desc"></div><div class="l-code"></div></div>';
    li.querySelector('.l-desc').textContent = c.desc || 'No description';
    li.querySelector('.l-code').textContent = c.code.replace(/\+/g, ' + ');
    li.querySelector('.l-code').title = c.code;
    if (have.has(normCode(c.code))) {
      const s = document.createElement('span'); s.className = 'added'; s.textContent = 'Added'; li.appendChild(s);
    } else {
      const b = document.createElement('button'); b.className = 'btn small'; b.textContent = 'Add';
      b.onclick = () => {
        if (!canCheat()) { toast('The host has turned off cheats for guests.'); return; }
        commitCheats([...machine.cheatList, { code: normCode(c.code), desc: c.desc, enabled: true, kind: 'auto' }], `added ${c.desc || c.code}`);
        b.disabled = true; b.textContent = 'Adding…';
      };
      li.appendChild(b);
    }
    ul.appendChild(li);
  }
}

// ---------------------------------------------------------------- controls UI
function renderBindings() {
  const mk = (host, items) => {
    host.innerHTML = '';
    for (const b of items) {
      const d = document.createElement('div'); d.className = 'bind';
      d.innerHTML = `<span></span><button></button>`;
      d.querySelector('span').textContent = b.label;
      const btn = d.querySelector('button'); btn.textContent = input.keyName(input.keys[b.id]);
      btn.onclick = () => {
        btn.textContent = 'Press a key'; btn.classList.add('listening');
        input.capture = (code) => {
          btn.classList.remove('listening');
          if (code) { input.keys[b.id] = code; settings.keys = { ...input.keys }; saveSettings(); }
          renderBindings(); renderHints();
        };
      };
      host.appendChild(d);
    }
  };
  mk($('bind-buttons'), BUTTONS);
  mk($('bind-hotkeys'), HOTKEYS);
}
function renderHints() {
  const k = (id) => `<b>${input.keyName(input.keys[id])}</b>`;
  $('hints').innerHTML = `<span>${k('rewind')} hold to rewind</span><span>${k('pause')} pause</span><span>${k('save')} / ${k('load')} save / load state (slot <b id="hint-slot">${currentSlot}</b>)</span><span>${k('fast')} hold to fast-forward</span><span>Controller: arrows, ${k('b')} B, ${k('a')} A, ${k('y')} Y, ${k('x')} X</span>`;
  $('rewind-key').textContent = input.keyName(input.keys.rewind);
}

// ---------------------------------------------------------------- hotkeys & buttons
input.onHotkey = (id, pressed) => {
  if (!rom) return;
  switch (id) {
    case 'rewind':
      if (pressed && isGuest() && !machine.settings.guestRewind) { toast('The host has turned off rewind for guests.'); return; }
      if (!pressed && !rewindSent) return;
      rewindSent = pressed;
      session.command({ k: 'rewind', on: pressed, v: settings.rwSpeed || 0 });
      if (pressed) audio.flush();
      break;
    case 'pause': if (pressed) togglePause(); break;
    case 'fast':
      if (pressed) {
        if (!canFast()) return;
        ffHeld = true; session.command({ k: 'speed', v: settings.ffSpeed });
      } else if (ffHeld) { ffHeld = false; session.command({ k: 'speed', v: 1 }); }
      break;
    case 'save': if (pressed) saveState(currentSlot); break;
    case 'load': if (pressed) loadState(currentSlot); break;
  }
};
function canFast() {
  if (isGuest() && machine.settings.guestFast === false) { toast('The host has turned off fast-forward for guests.'); return false; }
  return true;
}
function toggleFast() {
  if (!rom) return;
  if (machine.speed > 1) { session.command({ k: 'speed', v: 1 }); return; }
  if (!canFast()) return;
  session.command({ k: 'speed', v: settings.ffSpeed });
}
function togglePause() {
  if (!rom) return;
  if (isGuest() && !machine.settings.guestPause) { toast('The host has turned off pause for guests.'); return; }
  session.command({ k: 'pause', on: !machine.paused });
}
function resetGame() {
  if (!rom) return;
  if (isGuest() && !machine.settings.guestReset) { toast('The host has turned off reset for guests.'); return; }
  session.command({ k: 'reset' });
}

// ---------------------------------------------------------------- main loop
let lastT = performance.now(), acc = 0;
function afterFrame(withAudio) {
  const a = machine.snes.apu.takeAudio();
  if (withAudio) audio.push(a);
  frameDirty = true;
}
function tick() {
  const t = performance.now(); let dt = t - lastT; lastT = t;
  if (dt > 250) dt = 250;
  if (!rom || !session) return;
  acc += dt;
  const period = 1000 / (machine.snes.cart.pal ? 50.007 : 60.0988);
  session.maintain();
  let ran = 0;
  const maxCatchUp = machine.speed > 4 ? 1 : 3;
  while (acc >= period && ran < maxCatchUp) {
    if (!session.step()) { acc = Math.min(acc, period); if (!waitingSince) waitingSince = t; break; }
    waitingSince = 0;
    acc -= period; ran++;
    afterFrame(true);
  }
  if (session.role !== 'solo' && session.lead() > session.delay + 2 && session.step()) afterFrame(true);
}
setInterval(tick, 4);

const screen = $('screen'); const sctx = screen.getContext('2d');
let imageData = null;
function draw() {
  requestAnimationFrame(draw);
  input.pollPadCapture();
  if (!$('panel-controls').hidden) renderPadLive();
  fitScreen();
  updateOverlay();
  if (machine.cheatVersion !== lastCheatVersion) {
    lastCheatVersion = machine.cheatVersion;
    renderCheats();
    if (lib.cheats.length) renderLibList();
    if (rom && !rom.demo && !isGuest()) window.duo.saveCheats(rom.key, machine.cheatList);
  }
  $('btn-pause').classList.toggle('on', !!machine.paused);
  const fast = machine.speed > 1;
  $('btn-fast').classList.toggle('ff-on', fast); $('btn-fast').setAttribute('aria-pressed', String(fast));
  const badge = $('speed-badge'); const showBadge = fast && !machine.rewinding && !machine.paused && !!rom;
  if (badge.hidden === showBadge) badge.hidden = !showBadge;
  if (showBadge && badge.textContent !== machine.speed + '×') badge.textContent = machine.speed + '×';
  if (!frameDirty || !machine.snes.cart) return;
  frameDirty = false;
  const h = machine.snes.ppu.frameHeight;
  if (screen.height !== h) { screen.height = h; imageData = null; }
  if (!imageData) imageData = new ImageData(new Uint8ClampedArray(machine.snes.ppu.frame.buffer, 0, 256 * h * 4), 256, h);
  sctx.putImageData(imageData, 0, 0);
}
function fitScreen() {
  const st = $('stage').getBoundingClientRect();
  const h = screen.height;
  const aspectW = 256 * (8 / 7); // pixel aspect of a real TV
  let scale = Math.min((st.width - 32) / aspectW, (st.height - 32) / h);
  if (scale >= 2) scale = Math.floor(scale * 2) / 2;
  scale = Math.max(1, scale);
  const w = Math.round(aspectW * scale) + 'px', hh = Math.round(h * scale) + 'px';
  if (screen.style.width !== w) screen.style.width = w;
  if (screen.style.height !== hh) screen.style.height = hh;
}
const ICONS = {
  rewind: '<path d="M11 6 5 12l6 6M19 6l-6 6 6 6"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  wait: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  sync: '<path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3"/><path d="M18 3v4h-4M6 21v-4h4"/>',
};
function updateOverlay() {
  let kind = null, text = '';
  if (net.syncing) { kind = 'sync'; text = net.role === 'guest' ? 'Syncing with the host…' : 'Syncing with your friend…'; }
  else if (machine.rewinding) {
    const back = Math.round(machine.rewindSecondsBack());
    kind = 'rewind'; text = `Rewinding${machine.rewindSpeed > 0 ? ` ${machine.rewindSpeed}×` : ''}${machine.rewindHeldBy >= 0 && session.role !== 'solo' ? ` · Player ${machine.rewindHeldBy + 1}` : ''} · ${Math.floor(back / 60)}:${String(back % 60).padStart(2, '0')} back`;
  }
  else if (machine.paused && rom) { kind = 'pause'; text = 'Paused'; }
  else if (session && session.role !== 'solo' && waitingSince && performance.now() - waitingSince > 400) { kind = 'wait'; text = `Waiting for Player ${net.role === 'host' ? 2 : 1}…`; }
  const ov = $('overlay');
  if (!kind) { ov.hidden = true; return; }
  ov.hidden = false; ov.className = 'overlay ' + kind;
  $('overlay-text').textContent = text;
  if ($('overlay-icon').dataset.k !== kind) { $('overlay-icon').innerHTML = ICONS[kind]; $('overlay-icon').dataset.k = kind; }
}

// ---------------------------------------------------------------- logo (drawn in the demo's own pixel font)
function drawLogo() {
  const F = { D: ['110', '101', '101', '101', '110'], U: ['101', '101', '101', '101', '111'], O: ['111', '101', '101', '101', '111'], 1: ['010', '110', '010', '010', '111'], 6: ['111', '100', '111', '101', '111'] };
  const c = $('logo'); const g = c.getContext('2d'); const px = 4;
  c.width = 84; c.height = 20;
  let x = 0;
  for (const [ch, col] of [['D', '#4fd1ff'], ['U', '#4fd1ff'], ['O', '#4fd1ff'], ['1', '#ff6e96'], ['6', '#ff6e96']]) {
    g.fillStyle = col;
    F[ch].forEach((row, r) => [...row].forEach((b, k) => { if (b === '1') g.fillRect(x + k * px, r * px, px, px); }));
    x += 4 * px + (ch === 'O' ? px : 0);
  }
}

// ---------------------------------------------------------------- wiring
function bind() {
  $('btn-open').onclick = openRomDialog; $('w-open').onclick = openRomDialog;
  $('btn-demo').onclick = () => loadDemo(); $('w-demo').onclick = () => loadDemo();
  $('btn-pause').onclick = togglePause; $('btn-reset').onclick = resetGame; $('btn-fast').onclick = toggleFast;
  for (const t of document.querySelectorAll('.tab')) t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    for (const p of document.querySelectorAll('.panel')) p.hidden = p.id !== 'panel-' + t.dataset.tab;
    if (t.dataset.tab === 'cheats' && rom && !rom.demo && lib.forKey !== rom.key) libFind();
  };
  $('o-host').onclick = hostStart; $('o-join').onclick = joinStart;
  $('o-direct').onclick = () => showView('direct');
  $('host-copy').onclick = async () => { await window.duo.copy($('host-invite').value); toast('Invite code copied'); };
  $('join-copy').onclick = async () => { await window.duo.copy($('join-reply').value); toast('Reply code copied'); };
  const pasteInto = (id) => async () => {
    const t = String(await window.duo.paste() || '').trim();
    if (!t) { toast('Nothing to paste. Copy the code first.'); return; }
    $(id).value = t; $(id).focus();
  };
  $('host-paste').onclick = pasteInto('host-reply'); $('join-paste').onclick = pasteInto('join-invite');
  $('host-connect').onclick = hostConnect; $('join-make').onclick = joinMake;
  $('host-cancel').onclick = () => { closeLink(); showView('idle'); };
  $('join-cancel').onclick = () => { closeLink(); showView('idle'); };
  $('d-host').onclick = directHost; $('d-join').onclick = directJoin;
  $('d-cancel').onclick = () => { closeLink(); showView('idle'); $('d-host-info').textContent = ''; };
  $('o-leave').onclick = leaveSession;
  $('rom-mismatch-open').onclick = openRomDialog;
  for (const id of ['perm-cheats', 'perm-rewind', 'perm-pause', 'perm-reset', 'perm-fast']) $(id).onchange = applyHostSettings;
  $('rw-speed').onchange = (e) => { settings.rwSpeed = +e.target.value; saveSettings(); };
  $('ff-speed').onchange = (e) => { settings.ffSpeed = +e.target.value; saveSettings(); if (machine.speed > 1) session.command({ k: 'speed', v: settings.ffSpeed }); };
  $('delay-select').onchange = (e) => {
    settings.delayPref = e.target.value; saveSettings();
    if (myRole() === 'host') { session.delay = chosenDelay(); session.sendSync(`Input delay set to ${session.delay} frames`); }
  };
  $('cheats-master').onclick = () => {
    if (!rom) return;
    if (!canCheat()) { toast('The host has turned off cheats for guests.'); return; }
    session.command({ k: 'cheatsOn', on: machine.cheatsOn === false });
  };
  $('lib-find').onclick = libFind;
  $('lib-game').onchange = (e) => libLoad(e.target.value, false);
  $('lib-filter').oninput = renderLibList;
  $('lib-search-form').onsubmit = async (e) => {
    e.preventDefault();
    const q = $('lib-search').value.trim(); if (!q) return;
    libStatus(`Searching for "${q}"…`);
    try {
      const names = await window.duo.cheatLibrary.search(q);
      if (!names.length) { libStatus(`No games found for "${q}". Try fewer or different words.`); return; }
      const sel = $('lib-game'); sel.innerHTML = '';
      for (const n of names) sel.appendChild(libOption(n));
      await libLoad(names[0], false);
    } catch (err) { libStatus(err.message, true); }
  };
  $('cheat-code').oninput = describeCode; $('cheat-kind').onchange = describeCode;
  $('cheat-form').onsubmit = (e) => {
    e.preventDefault();
    if (!rom) { toast('Load a game first.'); return; }
    try {
      const text = parseCheatCodes($('cheat-code').value, $('cheat-kind').value).map((p) => p.text).join('+');
      const desc = $('cheat-desc').value.trim();
      commitCheats([...machine.cheatList, { code: text, desc, enabled: true, kind: $('cheat-kind').value }], `added ${desc || text}`);
      $('cheat-code').value = ''; $('cheat-desc').value = ''; describeCode();
    } catch (err) { toast(err.message, 'bad'); }
  };
  $('bind-reset').onclick = () => { input.setKeys({}); settings.keys = {}; saveSettings(); renderBindings(); renderHints(); };
  $('volume').oninput = (e) => { settings.volume = +e.target.value; audio.setVolume(settings.volume); saveSettings(); };
  $('opt-smooth').onchange = (e) => { settings.smooth = e.target.checked; screen.classList.toggle('smooth', settings.smooth); saveSettings(); };
  const wake = () => audio.start();
  addEventListener('pointerdown', wake); addEventListener('keydown', wake);
  window.duo.on('menu', (m) => {
    if (m === 'open-rom') openRomDialog();
    else if (m === 'demo') loadDemo();
    else if (m === 'pause') togglePause();
    else if (m === 'fast') toggleFast();
    else if (m === 'reset') resetGame();
    else if (m === 'save-state') saveState(currentSlot);
    else if (m === 'load-state') loadState(currentSlot);
    else if (m === 'help') { document.querySelector('.tab[data-tab=online]').click(); toast('Host: click "Host a game" and send the invite code. Guest: click "Join a friend", paste it, and send back your reply code.'); }
  });
  window.duo.on('rom-opened', (r) => loadRom(r));
  window.duo.on('toast', (t) => toast(t, 'bad'));
  addEventListener('gamepadconnected', (e) => { toast(`Controller connected: ${padName(e.gamepad)}`); updatePadStatus(); });
  addEventListener('gamepaddisconnected', (e) => { toast(`Controller unplugged: ${padName(e.gamepad)}`); updatePadStatus(); });
  setInterval(() => { const k = input.pads().map((p) => p.index + ':' + p.id).join('|'); if (k !== padListKey) updatePadStatus(); }, 1000);
  $('pad-select').onchange = (e) => { settings.padChoice = e.target.value; input.setPadChoice(settings.padChoice); saveSettings(); updatePadStatus(); };
  $('pad-combos').onchange = (e) => { settings.padCombos = e.target.checked; input.combos = e.target.checked; saveSettings(); };
  $('pad-reset').onclick = () => {
    const gp = input.p1Pad(); if (!gp) return;
    const m = { ...settings.padMaps }; delete m[gp.id]; settings.padMaps = m;
    input.setPadMaps(m); saveSettings(); renderPadBindings(); toast('Controller buttons reset');
  };
  // number keys choose the save slot
  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (/^Digit[1-4]$/.test(e.code) && !Object.values(input.keys).includes(e.code)) { currentSlot = +e.code.slice(5); refreshSlots(); renderHints(); toast(`Save slot ${currentSlot}`); }
  });
}
// ---------------------------------------------------------------- controller setup
let padListKey = '';
function updatePadStatus() {
  const pads = input.pads();
  padListKey = pads.map((p) => p.index + ':' + p.id).join('|');
  const sel = $('pad-select');
  sel.innerHTML = '';
  const auto = document.createElement('option'); auto.value = ''; auto.textContent = 'Automatic (first one plugged in)'; sel.appendChild(auto);
  for (const p of pads) { const o = document.createElement('option'); o.value = p.id; o.textContent = padName(p); sel.appendChild(o); }
  if (settings.padChoice && !pads.some((p) => p.id === settings.padChoice)) {
    const o = document.createElement('option'); o.value = settings.padChoice; o.textContent = 'Not plugged in: ' + settings.padChoice.replace(/\s*\(.*\)$/, ''); sel.appendChild(o);
  }
  sel.value = settings.padChoice || '';
  const p1 = input.p1Pad(), p2 = input.p2Pad();
  $('pad-setup').hidden = !p1;
  $('pad-status').textContent = !p1
    ? 'No controller detected. Plug it in and press any button on it. (Your computer only reports a controller after you press a button.)'
    : `Using ${padName(p1)}${p1.mapping === 'standard' ? '' : ' (custom layout; check the buttons below)'}.` + (p2 ? ` ${padName(p2)} is Player 2 in offline play.` : '');
  renderPadBindings();
}
function renderPadBindings() {
  const host = $('bind-pad'); host.innerHTML = '';
  const gp = input.p1Pad(); if (!gp) return;
  const map = input.mapFor(gp);
  for (const b of [...BUTTONS, { id: 'rewind', label: 'Rewind' }, { id: 'fast', label: 'Fast-fwd' }]) {
    const d = document.createElement('div'); d.className = 'bind';
    d.innerHTML = '<span></span><button></button>';
    d.querySelector('span').textContent = b.label;
    const btn = d.querySelector('button');
    btn.textContent = input.describeBinding((map[b.id] || [])[0]);
    if (input.hasCustomMap(gp)) btn.classList.add('custom');
    btn.onclick = () => {
      input.cancelPadCapture();
      btn.textContent = 'Press on pad…'; btn.classList.add('listening');
      input.startPadCapture((bnd, err, pad) => {
        btn.classList.remove('listening');
        if (err) toast(err);
        if (bnd && pad) {
          const base = input.mapFor(pad);
          const custom = JSON.parse(JSON.stringify(base));
          // a physical button can only do one thing: remove it from other SNES buttons
          const same = (x) => JSON.stringify(x) === JSON.stringify(bnd);
          for (const k of Object.keys(custom)) custom[k] = (custom[k] || []).filter((x) => !same(x));
          custom[b.id] = [bnd];
          settings.padMaps = { ...settings.padMaps, [pad.id]: custom };
          input.setPadMaps(settings.padMaps); saveSettings();
          toast(`${b.label} set to ${input.describeBinding(bnd)}`);
        }
        renderPadBindings();
      });
    };
    host.appendChild(d);
  }
}
function renderPadLive() {
  const live = $('pad-live');
  if (!live.childElementCount) for (const b of BUTTONS) { const el = document.createElement('span'); el.textContent = b.label.toUpperCase(); el.dataset.bit = b.bit; live.appendChild(el); }
  let bits = 0;
  if (!input.padCapture) {
    bits = input.readPad(input.p1Pad());
    for (const b of BUTTONS) if (input.down.has(input.keys[b.id])) bits |= b.bit;
  }
  for (const el of live.children) el.classList.toggle('on', !!(bits & +el.dataset.bit));
  for (const el of document.querySelectorAll('.pad-diagram [data-btn]')) {
    const b = BUTTONS.find((x) => x.id === el.dataset.btn);
    el.classList.toggle('on', !!(b && (bits & b.bit)));
  }
}

async function init() {
  drawLogo();
  const saved = await window.duo.loadSettings();
  if (saved) settings = { ...settings, ...saved, perms: { ...settings.perms, ...(saved.perms || {}) } };
  input.setKeys(settings.keys);
  input.setPadMaps(settings.padMaps); input.setPadChoice(settings.padChoice); input.combos = settings.padCombos !== false;
  $('pad-combos').checked = input.combos;
  audio.setVolume(settings.volume);
  $('volume').value = settings.volume;
  $('opt-smooth').checked = !!settings.smooth; screen.classList.toggle('smooth', !!settings.smooth);
  $('delay-select').value = settings.delayPref;
  $('perm-cheats').checked = settings.perms.guestCheats; $('perm-rewind').checked = settings.perms.guestRewind;
  $('perm-pause').checked = settings.perms.guestPause; $('perm-reset').checked = settings.perms.guestReset; $('perm-fast').checked = settings.perms.guestFast !== false;
  $('ff-speed').value = String(settings.ffSpeed || 3);
  $('rw-speed').value = String(settings.rwSpeed || 0);
  bind(); renderBindings(); renderHints(); refreshSlots(); updatePadStatus(); renderCheats();
  showView('idle');
  const recents = await window.duo.recentRoms();
  if (recents.length) {
    $('recent-wrap').hidden = false;
    for (const r of recents.slice(0, 5)) {
      const li = document.createElement('li'); const b = document.createElement('button');
      b.textContent = r.name; b.title = r.path;
      b.onclick = async () => { try { await loadRom(await window.duo.openRomPath(r.path)); } catch (e) { toast('Could not open that file: ' + e.message, 'bad'); } };
      li.appendChild(b); $('recent').appendChild(li);
    }
  }
  // the demo runs quietly behind the welcome card so the window is never a blank screen
  await loadDemo();
  $('welcome').hidden = false;
  $('game-title').textContent = 'Paddle Duel (demo)';
  requestAnimationFrame(draw);
}
init();
