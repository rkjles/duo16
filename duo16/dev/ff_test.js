// Fast-forward button, hold key, speed badge and 3-minute rewind readout in the real app UI
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
const OUT = path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
const MOCK = `window.duo = { openRomDialog: async () => null, openRomPath: async () => { throw new Error('no'); }, recentRoms: async () => [],
  loadSram: async () => null, saveSram: async () => true, saveState: async () => true, loadState: async () => null, listStates: async () => ({}),
  loadCheats: async () => [], saveCheats: async () => true, loadSettings: async () => null, saveSettings: async () => true,
  copy: async () => true, paste: async () => '', info: async () => ({}), setTitle: () => {},
  direct: { host: async () => ({}), connect: async () => ({}), send: () => {}, close: async () => true }, on: () => () => {},
  cheatLibrary: { lookup: async () => ({ exact: null, suggestions: [] }), search: async () => [], get: async () => ({ found: false, cheats: [] }) } };`;
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1180, height: 760 } });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript(MOCK);
  await page.goto('file://' + path.join(__dirname, '..', 'app', 'renderer', 'index.html'));
  await page.waitForTimeout(800);
  await page.click('#w-demo');
  const rate = async (ms) => { const a = await page.evaluate(() => machine.emuFrame); await page.waitForTimeout(ms); const b = await page.evaluate(() => machine.emuFrame); return Math.round((b - a) / (ms / 1000)); };
  console.log('normal fps     :', await rate(1000));
  await page.click('#btn-fast');
  await page.waitForTimeout(100);
  console.log('button 3x fps  :', await rate(1000), '| badge:', await page.textContent('#speed-badge'), '| visible:', await page.isVisible('#speed-badge'));
  await page.screenshot({ path: path.join(OUT, 'ui-fast.png') });
  await page.click('#btn-fast'); await page.waitForTimeout(100);
  console.log('button off fps :', await rate(700));
  await page.click('.tab[data-tab=controls]'); await page.selectOption('#ff-speed', '4');
  await page.click('#screen');
  await page.keyboard.down('Tab'); await page.waitForTimeout(100);
  console.log('hold Tab 4x fps:', await rate(1000));
  await page.keyboard.up('Tab'); await page.waitForTimeout(100);
  console.log('released fps   :', await rate(700));
  // build up history and rewind
  await page.click('#btn-fast'); await page.waitForTimeout(6000); await page.click('#btn-fast');
  console.log('rewind available:', (await page.evaluate(() => machine.rewindSecondsAvailable())).toFixed(0), 's');
  await page.keyboard.down('Backspace'); await page.waitForTimeout(2500);
  console.log('overlay        :', await page.textContent('#overlay-text'));
  await page.screenshot({ path: path.join(OUT, 'ui-rewind.png') });
  await page.keyboard.up('Backspace'); await page.waitForTimeout(200);
  console.log('after release  : rewinding =', await page.evaluate(() => machine.rewinding), '| fps', await rate(700));
  console.log(errs.length ? 'ERRORS ' + errs.join('; ') : 'no page errors');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
