// Controller fast-forward: trigger on a standard pad, Select+R / Select+L on a SNES-style USB pad
const { chromium } = require('playwright'); const path = require('path');
const MOCK = (mapping) => `
window.duo = { openRomDialog: async () => null, openRomPath: async () => { throw new Error('no'); }, recentRoms: async () => [],
  loadSram: async () => null, saveSram: async () => true, saveState: async () => true, loadState: async () => null, listStates: async () => ({}),
  loadCheats: async () => [], saveCheats: async () => true, loadSettings: async () => null, saveSettings: async () => true,
  copy: async () => true, paste: async () => '', info: async () => ({}), setTitle: () => {},
  direct: { host: async () => ({}), connect: async () => ({}), send: () => {}, close: async () => true }, on: () => () => {},
  cheatLibrary: { lookup: async () => ({ exact: null, suggestions: [] }), search: async () => [], get: async () => ({ found: false, cheats: [] }) } };
const pad = { id: '${mapping ? 'Xbox Wireless Controller' : 'USB Gamepad (Vendor: 0079 Product: 0011)'}', index: 0, connected: true, mapping: '${mapping}', timestamp: 0,
  buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1.2857] };
window.__pad = pad; navigator.getGamepads = () => [pad];`;
const press = (page, i, on) => page.evaluate(([i, on]) => { window.__pad.buttons[i] = { pressed: on, value: on ? 1 : 0 }; }, [i, on]);
async function open(browser, mapping) {
  const page = await browser.newPage({ viewport: { width: 1180, height: 1000 } }); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript(MOCK(mapping));
  await page.goto('file://' + path.join(__dirname, '..', 'app', 'renderer', 'index.html'));
  await page.waitForTimeout(800); await page.click('#w-demo'); await page.waitForTimeout(200);
  page.__errs = errs; return page;
}
const st = (page) => page.evaluate(() => ({ speed: machine.speed, rewinding: machine.rewinding, gameSees: input.readPad(input.p1Pad()).toString(16) }));
(async () => {
  const browser = await chromium.launch();
  const a = await open(browser, 'standard');
  await press(a, 7, true); await a.waitForTimeout(200); console.log('Xbox, right trigger held :', JSON.stringify(await st(a)));
  await press(a, 7, false); await a.waitForTimeout(200); console.log('Xbox, released           :', JSON.stringify(await st(a)));
  const b = await open(browser, '');
  await press(b, 8, true); await b.waitForTimeout(150); console.log('USB pad, Select alone     :', JSON.stringify(await st(b)), '(2000 = game sees Select)');
  await press(b, 5, true); await b.waitForTimeout(200); console.log('USB pad, Select + R       :', JSON.stringify(await st(b)));
  await press(b, 5, false); await b.waitForTimeout(200); console.log('USB pad, let go of R      :', JSON.stringify(await st(b)));
  await b.waitForTimeout(1500);
  await press(b, 4, true); await b.waitForTimeout(300); console.log('USB pad, Select + L       :', JSON.stringify(await st(b)));
  await press(b, 4, false); await press(b, 8, false); await b.waitForTimeout(200); console.log('USB pad, released         :', JSON.stringify(await st(b)));
  // shortcuts can be switched off
  await b.click('.tab[data-tab=controls]'); await b.uncheck('#pad-combos');
  await press(b, 8, true); await press(b, 5, true); await b.waitForTimeout(200); console.log('shortcuts off, Select + R :', JSON.stringify(await st(b)), '(2010 = game sees Select+R)');
  await press(b, 8, false); await press(b, 5, false);
  // bind fast-forward to a spare button
  await b.locator('#bind-pad .bind', { hasText: 'Fast-fwd' }).locator('button').click();
  await press(b, 10, true); await b.waitForTimeout(150); await press(b, 10, false); await b.waitForTimeout(150);
  await press(b, 10, true); await b.waitForTimeout(200); console.log('bound to button 11, held  :', JSON.stringify(await st(b)));
  await press(b, 10, false);
  await b.screenshot({ path: path.join(__dirname, 'out', 'ui-padff.png'), fullPage: false });
  console.log([...a.__errs, ...b.__errs].length ? 'ERRORS ' + [...a.__errs, ...b.__errs].join('; ') : 'no page errors');
  await browser.close();
})();
