const { chromium } = require('playwright'); const path = require('path');
const MOCK = require('fs').readFileSync(path.join(__dirname, 'ff_test.js'), 'utf8').match(/const MOCK = `([\s\S]*?)`;/)[1];
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1180, height: 760 } });
  await p.addInitScript(MOCK);
  await p.goto('file://' + path.join(__dirname, '..', 'app', 'renderer', 'index.html'));
  await p.waitForTimeout(800); await p.click('#w-demo'); await p.click('.tab[data-tab=controls]');
  await p.locator('#ff-speed').scrollIntoViewIfNeeded();
  await p.screenshot({ path: path.join(__dirname, 'out', 'controls-speeds.png'), clip: { x: 840, y: 100, width: 340, height: 660 } });
  await b.close();
})();
