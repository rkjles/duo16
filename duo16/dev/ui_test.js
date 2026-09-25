// UI + netplay test: two app windows in Chromium, connected peer-to-peer with the real WebRTC code
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const OUT = path.join(__dirname, 'out');

const MOCK = `
(() => {
  const store = {};
  let clip = '';
  const listeners = {};
  window.duo = {
    openRomDialog: async () => null, openRomPath: async () => { throw new Error('no'); }, recentRoms: async () => [],
    loadSram: async () => null, saveSram: async () => true, saveState: async (k, s, b) => { store['st' + s] = b; return true; },
    loadState: async (k, s) => store['st' + s] || null, listStates: async () => ({}),
    loadCheats: async () => [], saveCheats: async () => true, loadSettings: async () => null, saveSettings: async () => true,
    copy: async (t) => { clip = t; window.__clip = t; return true; }, paste: async () => clip, info: async () => ({ version: 'test', addresses: [] }),
    setTitle: () => {}, direct: { host: async () => ({ ok: false, error: 'n/a' }), connect: async () => ({ ok: false }), send: () => {}, close: async () => true },
    on: (ch, fn) => { (listeners[ch] = listeners[ch] || []).push(fn); return () => {}; },
  };
})();`;

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 760 } });
  await ctx.addInitScript(MOCK);
  const url = 'file://' + path.join(__dirname, '..', 'app', 'renderer', 'index.html');
  const A = await ctx.newPage(), B = await ctx.newPage();
  const errs = [];
  for (const [n, p] of [['A', A], ['B', B]]) { p.on('pageerror', (e) => errs.push(n + ': ' + e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push(n + ' console: ' + m.text()); }); }
  await A.goto(url); await B.goto(url);
  await A.waitForTimeout(800);
  await A.screenshot({ path: path.join(OUT, 'ui-welcome.png') });

  // host flow
  await A.click('#w-demo');
  await A.click('#o-host');
  await A.waitForFunction(() => document.getElementById('host-invite').value.startsWith('DUO16-'), null, { timeout: 15000 });
  const invite = await A.inputValue('#host-invite');
  console.log('invite code length', invite.length);
  await A.screenshot({ path: path.join(OUT, 'ui-host-code.png') });
  // guest flow
  await B.click('#o-join');
  await B.fill('#join-invite', invite);
  await B.click('#join-make');
  await B.waitForFunction(() => document.getElementById('join-reply').value.startsWith('DUO16-'), null, { timeout: 15000 });
  const reply = await B.inputValue('#join-reply');
  console.log('reply code length', reply.length);
  await A.fill('#host-reply', reply);
  await A.click('#host-connect');
  // wait for the guest's session to be running and synced
  await B.waitForFunction(() => session && session.role === 'guest' && session.running && !net.syncing, null, { timeout: 20000 });
  await A.waitForFunction(() => session && session.role === 'host' && session.running, null, { timeout: 20000 });
  console.log('connected + synced');
  // play: hold keys on both sides
  await A.bringToFront();
  await A.keyboard.down('ArrowDown');
  await B.keyboard.down('ArrowUp');
  await A.waitForTimeout(1500);
  await A.keyboard.up('ArrowDown'); await B.keyboard.up('ArrowUp');
  // guest adds a cheat: PAR code sets P1's score to 5
  await B.click('.tab[data-tab=cheats]');
  await B.fill('#cheat-code', '7E000805');
  await B.fill('#cheat-desc', 'P1 score 5');
  await B.click('#cheat-form button[type=submit]');
  await A.waitForTimeout(800);
  // host rewinds for a bit
  await A.keyboard.down('Backspace'); await A.waitForTimeout(700); await A.keyboard.up('Backspace');
  await A.waitForTimeout(1500);
  const sa = await A.evaluate(() => ({ tick: session.tick, emu: machine.emuFrame, p1y: machine.snes.wram[2], p2y: machine.snes.wram[3], s1: machine.snes.wram[8], desync: session.stats.desyncs, cheats: machine.cheatList.length, rtt: session.stats.rtt, delay: session.delay }));
  const sb = await B.evaluate(() => ({ tick: session.tick, emu: machine.emuFrame, p1y: machine.snes.wram[2], p2y: machine.snes.wram[3], s1: machine.snes.wram[8], desync: session.stats.desyncs, cheats: machine.cheatList.length, rtt: session.stats.rtt, delay: session.delay }));
  console.log('host ', JSON.stringify(sa));
  console.log('guest', JSON.stringify(sb));
  // compare checksums at an identical tick: pause both by stopping the loop is hard, so compare recorded sums
  await A.click('.tab[data-tab=online]');
  await A.screenshot({ path: path.join(OUT, 'ui-host-connected.png') });
  await B.screenshot({ path: path.join(OUT, 'ui-guest-cheats.png') });
  console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : 'no page errors');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
