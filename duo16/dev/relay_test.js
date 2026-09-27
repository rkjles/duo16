// End-to-end: two app windows connect through a local TURN relay with "Always use the relay" on
const { chromium } = require('playwright'); const path = require('path'); const { fork } = require('child_process');
const src = require('fs').readFileSync(path.join(__dirname, 'ui_test.js'), 'utf8');
const MOCK = src.match(/const MOCK = `([\s\S]*?)`;/)[1];
(async () => {
  const turn = fork(path.join(__dirname, 'turn_server.js'), ['3478', 'duo', 'secret']);
  await new Promise((r) => turn.once('message', r));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 900 } });
  await ctx.addInitScript(MOCK);
  const url = 'file://' + path.join(__dirname, '..', 'app', 'renderer', 'index.html');
  const A = await ctx.newPage(), B = await ctx.newPage(); const errs = [];
  for (const p of [A, B]) p.on('pageerror', (e) => errs.push(e.message));
  await A.goto(url); await B.goto(url); await A.waitForTimeout(800);
  await A.click('#w-demo');
  // relay settings on the host only
  await A.click('#relay-box summary');
  await A.selectOption('#relay-mode', 'manual');
  await A.fill('#relay-url', '127.0.0.1:3478'); await A.fill('#relay-user', 'duo'); await A.fill('#relay-pass', 'wrong');
  await A.click('#relay-test'); await A.waitForFunction(() => !document.getElementById('relay-test').disabled, null, { timeout: 15000 });
  console.log('wrong password  :', await A.textContent('#relay-status'));
  await A.fill('#relay-pass', 'secret'); await A.check('#relay-force');
  await A.click('#relay-test'); await A.waitForFunction(() => !document.getElementById('relay-test').disabled, null, { timeout: 15000 });
  console.log('right password  :', await A.textContent('#relay-status'), '| label:', await A.textContent('#relay-state'));
  await A.screenshot({ path: path.join(__dirname, 'out', 'ui-relay.png'), clip: { x: 840, y: 60, width: 340, height: 840 } });
  // host -> guest via codes
  await A.click('#o-host');
  await A.waitForFunction(() => document.getElementById('host-invite').value.startsWith('DUO16-'), null, { timeout: 20000 });
  const invite = await A.inputValue('#host-invite');
  const decoded = await A.evaluate(async (c) => { const o = await unpackCode(c); return { hasRelay: !!o.ice, force: !!o.force, relayOnly: !/typ host|typ srflx/.test(o.sdp) }; }, invite);
  console.log('invite          :', invite.length, 'chars', JSON.stringify(decoded));
  await B.click('#o-join'); await B.fill('#join-invite', invite); await B.click('#join-make');
  await B.waitForFunction(() => document.getElementById('join-reply').value.startsWith('DUO16-'), null, { timeout: 20000 });
  const reply = await B.inputValue('#join-reply');
  await A.fill('#host-reply', reply); await A.click('#host-connect');
  await B.waitForFunction(() => session && session.role === 'guest' && session.running && !net.syncing, null, { timeout: 30000 });
  console.log('connected + synced through relay');
  await A.bringToFront(); await A.keyboard.down('ArrowDown'); await B.keyboard.down('ArrowUp');
  await A.waitForTimeout(2500); await A.keyboard.up('ArrowDown'); await B.keyboard.up('ArrowUp');
  await A.waitForTimeout(1200);
  const s = async (p) => p.evaluate(() => ({ tick: session.tick, p1y: machine.snes.wram[2], p2y: machine.snes.wram[3], desync: session.stats.desyncs, rtt: session.stats.rtt }));
  console.log('host            :', JSON.stringify(await s(A)), '| route:', await A.textContent('#st-route'));
  console.log('guest           :', JSON.stringify(await s(B)), '| route:', await B.textContent('#st-route'));
  turn.send('stats'); const st = await new Promise((r) => turn.once('message', r));
  console.log('relay server    :', JSON.stringify(st.stats));
  console.log(errs.length ? 'ERRORS ' + errs.join('; ') : 'no page errors');
  await browser.close(); turn.kill();
})().catch((e) => { console.error(e); process.exit(1); });
