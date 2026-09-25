// Simulates a generic USB controller (non-standard layout, D-pad on a hat switch) in the real app UI
const { chromium } = require('playwright'); const path = require('path');
const OUT = path.join(__dirname, 'out');
const MOCK = `
(() => {
  const store = {}; let settings = null;
  window.duo = {
    openRomDialog: async () => null, openRomPath: async () => { throw new Error('no'); }, recentRoms: async () => [],
    loadSram: async () => null, saveSram: async () => true, saveState: async () => true, loadState: async () => null, listStates: async () => ({}),
    loadCheats: async () => [], saveCheats: async () => true, loadSettings: async () => settings, saveSettings: async (s) => { settings = JSON.parse(JSON.stringify(s)); window.__saved = settings; return true; },
    copy: async () => true, paste: async () => '', info: async () => ({}), setTitle: () => {},
    direct: { host: async () => ({}), connect: async () => ({}), send: () => {}, close: async () => true },
    on: () => () => {},
  };
  const pad = { id: 'USB Gamepad (Vendor: 0079 Product: 0011)', index: 0, connected: true, mapping: '', timestamp: 0,
    buttons: Array.from({ length: 12 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1.2857] };
  window.__pad = pad;
  navigator.getGamepads = () => [pad];
})();`;
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1180, height: 760 } });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript(MOCK);
  await page.goto('file://' + path.join(__dirname, '..', 'app', 'renderer', 'index.html'));
  await page.waitForTimeout(1500);
  await page.click('#w-demo');
  await page.click('.tab[data-tab=controls]');
  await page.waitForTimeout(300);
  console.log('status:', await page.textContent('#pad-status'));
  // hat up -> P1 paddle moves up; also the live tester lights "UP"
  const y0 = await page.evaluate(() => machine.snes.wram[2]);
  await page.evaluate(() => { window.__pad.axes[9] = -1; });
  await page.waitForTimeout(400);
  const liveUp = await page.evaluate(() => [...document.querySelectorAll('#pad-live span.on')].map((s) => s.textContent));
  const y1 = await page.evaluate(() => machine.snes.wram[2]);
  await page.evaluate(() => { window.__pad.axes[9] = 1.2857; });
  console.log('hat up: lit', liveUp, 'paddle y', y0, '->', y1);
  // diagonal up-left still counts as up
  await page.evaluate(() => { window.__pad.axes[9] = 1.0; });
  await page.waitForTimeout(50);
  console.log('up-left reads as:', await page.evaluate(() => [...document.querySelectorAll('#pad-live span.on')].map((s) => s.textContent)));
  await page.evaluate(() => { window.__pad.axes[9] = 1.2857; });
  // remap A to physical button 7
  const aBtn = page.locator('#bind-pad .bind', { hasText: /^A/ }).locator('button');
  await aBtn.click();
  await page.evaluate(() => { window.__pad.buttons[6] = { pressed: true, value: 1 }; });
  await page.waitForTimeout(150);
  await page.evaluate(() => { window.__pad.buttons[6] = { pressed: false, value: 0 }; });
  console.log('A now bound to:', await aBtn.textContent(), '| saved:', JSON.stringify(await page.evaluate(() => window.__saved.padMaps['USB Gamepad (Vendor: 0079 Product: 0011)'].a)));
  await page.evaluate(() => { window.__pad.buttons[6] = { pressed: true, value: 1 }; });
  await page.waitForTimeout(100);
  console.log('pressing button 7 lights:', await page.evaluate(() => [...document.querySelectorAll('#pad-live span.on')].map((s) => s.textContent)), '| pad bits:', await page.evaluate(() => input.readP1().toString(16)));
  await page.screenshot({ path: path.join(OUT, 'ui-controller.png') });
  console.log(errs.length ? 'ERRORS ' + errs.join('; ') : 'no page errors');
  await browser.close();
})();
