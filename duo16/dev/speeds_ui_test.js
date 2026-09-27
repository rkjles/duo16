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
  console.log('options        :', await page.evaluate(() => [...document.querySelectorAll('#ff-speed option')].map((o) => o.textContent).join(' ')), '|', await page.evaluate(() => [...document.querySelectorAll('#rw-speed option')].map((o) => o.textContent.split(' ')[0]).join(' ')));
  await page.click('.tab[data-tab=controls]');
  for (const v of ['6', '10']) {
    await page.selectOption('#ff-speed', v);
    await page.click('#btn-fast'); await page.waitForTimeout(300);
    console.log(`button ${v}x      : ${await rate(1500)} fps (60 = normal) | badge ${await page.textContent('#speed-badge')}`);
    await page.click('#btn-fast'); await page.waitForTimeout(200);
  }
  await page.waitForTimeout(12000);
  await page.selectOption('#rw-speed', '4');
  await page.click('#screen');
  await page.keyboard.down('Backspace'); await page.waitForTimeout(2000);
  console.log('rewind 4x 2s   :', await page.textContent('#overlay-text'));
  await page.keyboard.up('Backspace'); await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, 'ui-speeds.png') });
  console.log(errs.length ? 'ERRORS ' + errs.join('; ') : 'no page errors');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
