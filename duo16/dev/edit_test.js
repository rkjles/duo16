// Editing a cheat in "Your cheats"
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
const MOCK = fs.readFileSync(path.join(__dirname, 'ff_test.js'), 'utf8').match(/const MOCK = `([\s\S]*?)`;/)[1];
(async () => {
  const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1180, height: 760 } });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript(MOCK);
  await page.goto('file://' + path.join(__dirname, '..', 'app', 'renderer', 'index.html'));
  await page.waitForTimeout(800); await page.click('#w-demo'); await page.click('.tab[data-tab=cheats]');
  for (const [code, desc] of [['7E000805', 'P1 score 5'], ['7E000903', 'P2 score 3']]) { await page.fill('#cheat-code', code); await page.fill('#cheat-desc', desc); await page.click('#cheat-form button[type=submit]'); await page.waitForTimeout(150); }
  await page.waitForTimeout(300);
  const state = () => page.evaluate(() => ({ list: machine.cheatList.map((c) => `${c.code} "${c.desc}" ${c.enabled ? 'on' : 'off'}`), p2score: machine.snes.wram[9] }));
  console.log('before      :', JSON.stringify(await state()));
  const row = page.locator('#cheat-list li', { hasText: 'P2 score 3' });
  await row.locator('.c-edit').click();
  console.log('editor open :', await page.isVisible('#edit-code'), '| prefilled:', await page.inputValue('#edit-code'), '/', await page.inputValue('#edit-desc'));
  await page.fill('#edit-code', 'ZZZZ'); await page.waitForTimeout(50);
  console.log('bad code    :', await page.textContent('#edit-decode'));
  await page.click('.cheat-edit button[type=submit]'); await page.waitForTimeout(200);
  console.log('not saved   :', JSON.stringify((await state()).list), '| editor still open:', await page.isVisible('#edit-code'));
  await page.fill('#edit-code', '7e0009 09'); await page.fill('#edit-desc', 'P2 score 9');
  await page.screenshot({ path: path.join(__dirname, 'out', 'ui-edit.png'), clip: { x: 840, y: 380, width: 340, height: 380 } });
  await page.press('#edit-desc', 'Enter'); await page.waitForTimeout(400);
  console.log('after save  :', JSON.stringify(await state()), '| editor closed:', !(await page.isVisible('#edit-code')));
  await page.locator('#cheat-list li', { hasText: 'P1 score 5' }).locator('.c-edit').click();
  await page.fill('#edit-desc', 'should not save'); await page.press('#edit-desc', 'Escape'); await page.waitForTimeout(200);
  console.log('escape      :', JSON.stringify((await state()).list));
  console.log(errs.length ? 'ERRORS ' + errs.join('; ') : 'no page errors');
  await browser.close();
})();
