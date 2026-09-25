// Cheats main switch and per-cheat checkbox in the real app UI
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
const OUT = path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
const MOCK = `window.duo = { openRomDialog: async () => null, openRomPath: async () => { throw new Error('no'); }, recentRoms: async () => [],
  loadSram: async () => null, saveSram: async () => true, saveState: async () => true, loadState: async () => null, listStates: async () => ({}),
  loadCheats: async () => [], saveCheats: async () => true, loadSettings: async () => null, saveSettings: async () => true,
  copy: async () => true, paste: async () => '', info: async () => ({}), setTitle: () => {},
  direct: { host: async () => ({}), connect: async () => ({}), send: () => {}, close: async () => true }, on: () => () => {},
  cheatLibrary: { lookup: async () => ({ exact: null, suggestions: [] }), search: async () => [], get: async () => ({ found: false, cheats: [] }) } };`;
(async () => {
  const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1180, height: 760 } });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript(MOCK);
  await page.goto('file://' + path.join(__dirname, '..', 'app', 'renderer', 'index.html'));
  await page.waitForTimeout(800); await page.click('#w-demo');
  await page.click('.tab[data-tab=cheats]');
  for (const [code, desc] of [['7E000805', 'P1 score 5'], ['7E000903', 'P2 score 3']]) { await page.fill('#cheat-code', code); await page.fill('#cheat-desc', desc); await page.click('#cheat-form button[type=submit]'); await page.waitForTimeout(150); }
  await page.waitForTimeout(300);
  const score = () => page.evaluate(() => [machine.snes.wram[8], machine.snes.wram[9]]);
  console.log('both cheats on :', JSON.stringify(await score()), '| switch:', await page.textContent('#cheats-master-text'));
  await page.click('#cheats-master'); await page.waitForTimeout(300);
  console.log('switched off   : writes', await page.evaluate(() => machine.cheats.ramWrites.length), '| switch:', await page.textContent('#cheats-master-text'), '| note shown:', await page.isVisible('#cheats-off-note'), '| list kept:', await page.locator('#cheat-list li').count());
  await page.evaluate(() => { machine.snes.wram[8] = 0; machine.snes.wram[9] = 0; }); await page.waitForTimeout(200);
  console.log('scores free    :', JSON.stringify(await score()));
  await page.screenshot({ path: path.join(OUT, 'ui-cheats-off.png') });
  await page.click('#cheats-master'); await page.waitForTimeout(300);
  console.log('back on        :', JSON.stringify(await score()));
  await page.locator('#cheat-list li', { hasText: 'P2 score 3' }).locator('input').click(); await page.waitForTimeout(300);
  console.log('one unticked   : enabled', JSON.stringify(await page.evaluate(() => machine.cheatList.map((c) => c.enabled))), '| writes', await page.evaluate(() => machine.cheats.ramWrites.length));
  console.log(errs.length ? 'ERRORS ' + errs.join('; ') : 'no page errors');
  await browser.close();
})();
