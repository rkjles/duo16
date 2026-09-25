// Cheat library + controller diagram in the real app UI (network stubbed)
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
const OUT = path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
const MOCK = `
(() => {
  window.duo = {
    openRomDialog: async () => null, openRomPath: async () => { throw new Error('no'); }, recentRoms: async () => [],
    loadSram: async () => null, saveSram: async () => true, saveState: async () => true, loadState: async () => null, listStates: async () => ({}),
    loadCheats: async () => [], saveCheats: async () => true, loadSettings: async () => null, saveSettings: async () => true,
    copy: async () => true, paste: async () => '', info: async () => ({}), setTitle: () => {},
    direct: { host: async () => ({}), connect: async () => ({}), send: () => {}, close: async () => true },
    on: () => () => {},
    cheatLibrary: {
      lookup: async (crc, hints) => { window.__lookup = { crc, hints }; await new Promise((r) => setTimeout(r, 150)); return { exact: 'Super Mario World (USA)', suggestions: ['Super Mario World (Europe) (Rev 1)', 'Super Mario World (USA) (Beta)'] }; },
      search: async (q) => ['Super Mario World 2 - Yoshi\\'s Island (USA, Asia) (Rev 1)'],
      get: async (name) => name === 'Super Mario World (USA)' ? { found: true, cheats: [
        { desc: 'Infinite 99 Lives', code: '7E0DBE63' }, { desc: 'Always 999 Time', code: '7E0F3109+7E0F3209+7E0F3309' },
        { desc: 'Start on Star World', code: 'EDA5-0F6F+61A5-040F+61A6-0D6F' }, { desc: 'Broken entry', code: 'ZZZZ' },
        ...Array.from({ length: 12 }, (_, i) => ({ desc: 'Mario color ' + i, code: '7E0DB' + (i % 10) + '0' + (i % 10) })) ] } : { found: false, cheats: [] },
    },
  };
})();`;
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript(MOCK);
  await page.goto('file://' + path.join(__dirname, '..', 'app', 'renderer', 'index.html'));
  await page.waitForTimeout(1200);
  // load the demo bytes as if it were a normal ROM file
  await page.evaluate(async () => { const bin = atob(DEMO_ROM_B64); const d = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) d[i] = bin.charCodeAt(i); await loadRom({ name: 'Super Mario World (U) [!].smc', data: d }); });
  await page.click('.tab[data-tab=cheats]');
  await page.waitForSelector('#lib-list li button', { timeout: 5000 });
  console.log('lookup sent   :', JSON.stringify(await page.evaluate(() => window.__lookup)));
  console.log('status        :', await page.textContent('#lib-status'));
  console.log('rows          :', await page.locator('#lib-list li').count(), '| filter shown:', await page.isVisible('#lib-filter'));
  await page.locator('#lib-list li', { hasText: 'Always 999 Time' }).locator('button').click();
  await page.waitForTimeout(400);
  console.log('after add     :', await page.locator('#lib-list li', { hasText: 'Always 999 Time' }).locator('.added').textContent(),
    '| your cheats:', JSON.stringify(await page.evaluate(() => machine.cheatList.map((c) => c.code + ' ' + c.enabled))),
    '| RAM writes active:', await page.evaluate(() => machine.cheats.ramWrites.length));
  await page.fill('#lib-filter', 'lives');
  console.log('filter lives  :', await page.locator('#lib-list li').count(), 'row');
  await page.fill('#lib-filter', '');
  await page.screenshot({ path: path.join(OUT, 'ui-cheat-library.png') });
  await page.selectOption('#lib-game', 'Super Mario World (Europe) (Rev 1)');
  await page.waitForTimeout(200);
  console.log('other version :', await page.textContent('#lib-status'));
  await page.fill('#lib-search', 'yoshi'); await page.click('#lib-search-form button');
  await page.waitForTimeout(200);
  console.log('search        :', await page.inputValue('#lib-game'));
  // controller diagram lights up from the keyboard (X key = SNES A)
  await page.click('.tab[data-tab=controls]');
  await page.keyboard.down('KeyX'); await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(150);
  console.log('diagram lit   :', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.pad-diagram [data-btn].on')].map((e) => e.dataset.btn))));
  await page.screenshot({ path: path.join(OUT, 'ui-controls-diagram.png') });
  await page.keyboard.up('KeyX'); await page.keyboard.up('ArrowLeft');
  console.log(errs.length ? 'ERRORS ' + errs.join('; ') : 'no page errors');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
