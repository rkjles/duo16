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
let settings = { keys: {}, padMaps: {}, padChoice: '', volume: 0.8, smooth: false, delayPref: 'auto', perms: { guestCheats: true, guestRewind: true, guestPause: true, guestReset: false } };
let currentSlot = 1;
let fastForward = false;
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
    guestPause: $('perm-pause').checked, guestReset: $('perm-reset').checked,
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
    if (s.guestCheats) can.push('cheats'); if (s.guestRewind) can.push('rewind'); if (s.guestPause) can.push('pause'); if (s.guestReset) can.push('reset');
    gp.textContent = can.length ? `The host lets you use: ${can.join(', ')}.` : 'The host has turned off cheats, rewind and pause for guests.';
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
function renderCheats() {
  const ul = $('cheat-list'); ul.innerHTML = '';
  const list = machine.cheatList;
  $('cheat-lock').hidden = canCheat();
  if (!list.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'No cheats yet'; ul.appendChild(li); return; }
  list.forEach((c, i) => {
    const li = document.createElement('li');
    const kind = (() => { try { return parseCheat(c.code, c.kind).type === 'gg' ? 'GG' : 'PAR'; } catch (_) { return '?'; } })();
    li.innerHTML = `<input type="checkbox" ${c.enabled ? 'checked' : ''} aria-label="Enabled"><div style="min-width:0"><div><span class="c-code"></span><span class="c-kind">${kind}</span></div><div class="c-desc"></div></div><button class="x" title="Remove" aria-label="Remove">×</button>`;
    li.querySelector('.c-code').textContent = c.code;
    li.querySelector('.c-desc').textContent = c.desc || 'No description';
    li.querySelector('input').onchange = (e) => {
      const nl = machine.cheatList.map((x, j) => j === i ? { ...x, enabled: e.target.checked } : x);
      commitCheats(nl, `${e.target.checked ? 'turned on' : 'turned off'} ${c.desc || c.code}`);
      e.target.checked = c.enabled; // UI updates when the change takes effect
    };
    li.querySelector('.x').onclick = () => commitCheats(machine.cheatList.filter((_, j) => j !== i), `removed ${c.desc || c.code}`);
    ul.appendChild(li);
  });
}
function describeCode() {
  const el = $('cheat-decode'); const v = $('cheat-code').value.trim();
  if (!v) { el.textContent = ''; el.className = 'decode'; return; }
  try {
    const p = parseCheat(v, $('cheat-kind').value);
    const addr = `$${hex(p.addr >> 16, 2)}:${hex(p.addr & 0xFFFF, 4)}`;
    el.textContent = `${p.type === 'gg' ? 'Game Genie' : 'Action Replay'} → ${p.type === 'gg' ? 'replaces the byte at' : 'holds'} ${addr} ${p.type === 'gg' ? 'with' : 'at'} $${hex(p.value, 2)}`;
    el.className = 'decode';
  } catch (e) { el.textContent = e.message; el.className = 'decode bad'; }
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
  $('hints').innerHTML = `<span>${k('rewind')} hold to rewind</span><span>${k('pause')} pause</span><span>${k('save')} / ${k('load')} save / load state (slot <b id="hint-slot">${currentSlot}</b>)</span><span>${k('fast')} fast-forward</span><span>Controller: arrows, ${k('b')} B, ${k('a')} A, ${k('y')} Y, ${k('x')} X</span>`;
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
      session.command({ k: 'rewind', on: pressed });
      if (pressed) audio.flush();
      break;
    case 'pause': if (pressed) togglePause(); break;
    case 'fast':
      if (pressed && session.role !== 'solo') { toast('Fast-forward is off during online play.'); return; }
      fastForward = pressed; break;
    case 'save': if (pressed) saveState(currentSlot); break;
    case 'load': if (pressed) loadState(currentSlot); break;
  }
};
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
  while (acc >= period && ran < 3) {
    if (!session.step()) { acc = Math.min(acc, period); if (!waitingSince) waitingSince = t; break; }
    waitingSince = 0;
    acc -= period; ran++;
    afterFrame(true);
    if (fastForward && session.role === 'solo') for (let i = 0; i < 3; i++) if (session.step()) afterFrame(false);
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
    if (rom && !rom.demo && !isGuest()) window.duo.saveCheats(rom.key, machine.cheatList);
  }
  $('btn-pause').classList.toggle('on', !!machine.paused);
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
  else if (machine.rewinding) { kind = 'rewind'; text = `Rewinding${machine.rewindHeldBy >= 0 && session.role !== 'solo' ? ` · Player ${machine.rewindHeldBy + 1}` : ''}`; }
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
  $('btn-pause').onclick = togglePause; $('btn-reset').onclick = resetGame;
  for (const t of document.querySelectorAll('.tab')) t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    for (const p of document.querySelectorAll('.panel')) p.hidden = p.id !== 'panel-' + t.dataset.tab;
  };
  $('o-host').onclick = hostStart; $('o-join').onclick = joinStart;
  $('o-direct').onclick = () => showView('direct');
  $('host-copy').onclick = async () => { await window.duo.copy($('host-invite').value); toast('Invite code copied'); };
  $('join-copy').onclick = async () => { await window.duo.copy($('join-reply').value); toast('Reply code copied'); };
  $('host-connect').onclick = hostConnect; $('join-make').onclick = joinMake;
  $('host-cancel').onclick = () => { closeLink(); showView('idle'); };
  $('join-cancel').onclick = () => { closeLink(); showView('idle'); };
  $('d-host').onclick = directHost; $('d-join').onclick = directJoin;
  $('d-cancel').onclick = () => { closeLink(); showView('idle'); $('d-host-info').textContent = ''; };
  $('o-leave').onclick = leaveSession;
  $('rom-mismatch-open').onclick = openRomDialog;
  for (const id of ['perm-cheats', 'perm-rewind', 'perm-pause', 'perm-reset']) $(id).onchange = applyHostSettings;
  $('delay-select').onchange = (e) => {
    settings.delayPref = e.target.value; saveSettings();
    if (myRole() === 'host') { session.delay = chosenDelay(); session.sendSync(`Input delay set to ${session.delay} frames`); }
  };
  $('cheat-code').oninput = describeCode; $('cheat-kind').onchange = describeCode;
  $('cheat-form').onsubmit = (e) => {
    e.preventDefault();
    if (!rom) { toast('Load a game first.'); return; }
    try {
      const p = parseCheat($('cheat-code').value, $('cheat-kind').value);
      const desc = $('cheat-desc').value.trim();
      commitCheats([...machine.cheatList, { code: p.text, desc, enabled: true, kind: $('cheat-kind').value }], `added ${desc || p.text}`);
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
  for (const b of [...BUTTONS, { id: 'rewind', label: 'Rewind (hold)' }]) {
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
  if (!live.childElementCount) for (const b of BUTTONS) { const s = document.createElement('span'); s.textContent = b.label.toUpperCase(); s.dataset.bit = b.bit; live.appendChild(s); }
  const bits = input.padCapture ? 0 : input.readPad(input.p1Pad());
  for (const s of live.children) s.classList.toggle('on', !!(bits & +s.dataset.bit));
}

async function init() {
  drawLogo();
  const saved = await window.duo.loadSettings();
  if (saved) settings = { ...settings, ...saved, perms: { ...settings.perms, ...(saved.perms || {}) } };
  input.setKeys(settings.keys);
  input.setPadMaps(settings.padMaps); input.setPadChoice(settings.padChoice);
  audio.setVolume(settings.volume);
  $('volume').value = settings.volume;
  $('opt-smooth').checked = !!settings.smooth; screen.classList.toggle('smooth', !!settings.smooth);
  $('delay-select').value = settings.delayPref;
  $('perm-cheats').checked = settings.perms.guestCheats; $('perm-rewind').checked = settings.perms.guestRewind;
  $('perm-pause').checked = settings.perms.guestPause; $('perm-reset').checked = settings.perms.guestReset;
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
