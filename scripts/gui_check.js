const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const path = require('path');

(async () => {
  const root = path.join(__dirname, '..');
  const portable = path.join(root, 'Release', 'Portable', 'Novela-Portable', 'Novela.exe');
  const fs = require('fs');
  const exe = fs.existsSync(portable) && process.env.NOVELA_CHECK_PORTABLE === '1'
    ? portable
    : path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  const args = exe === portable ? ['--no-sandbox', '--disable-gpu', '--remote-debugging-port=9333']
    : ['.', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9333'];
  const child = spawn(exe, args, {
    cwd: exe === portable ? path.dirname(exe) : root,
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  const errors = [];
  let browser = null;
  for (let i = 0; i < 40 && !browser; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
    } catch { /* retry */ }
  }
  if (!browser) { console.error('HARNESS FAIL: no CDP'); try { child.kill(); } catch {} process.exit(1); }
  const contexts = browser.contexts();
  const page = contexts.length && contexts[0].pages().length ? contexts[0].pages()[0] : await browser.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push('[console.error] ' + msg.text());
  });
  page.on('pageerror', (err) => errors.push('[pageerror] ' + String(err && err.message || err)));
  await page.waitForTimeout(9000);

  const state = await page.evaluate(() => ({
    backend: document.getElementById('backendState').textContent,
    editors: !!(document.querySelector('#inputEditor .monaco-editor') && document.querySelector('#outputEditor .monaco-editor')),
    navCount: document.querySelectorAll('.rail-item').length,
    sliders: document.querySelectorAll('input[type=range]').length,
    langOptions: document.getElementById('langSelect').options.length,
    profSwitches: document.querySelectorAll('#view-settings .switch-row').length,
    profSelects: document.querySelectorAll('#view-settings select').length,
    themes: document.querySelectorAll('.theme-opt').length,
  }));
  console.log('STATE ' + JSON.stringify(state));

  await page.click('[data-view=settings]');
  await page.waitForTimeout(500);
  await page.selectOption('#langSelect', 'ru');
  await page.waitForTimeout(800);
  console.log('RU nav: ' + await page.evaluate(() => document.querySelector('[data-view=obfuscator] span').textContent));
  await page.selectOption('#langSelect', 'ar');
  await page.waitForTimeout(800);
  console.log('AR dir: ' + await page.evaluate(() => document.documentElement.dir));
  await page.selectOption('#langSelect', 'en');
  await page.waitForTimeout(500);
  await page.click('[data-view=obfuscator]');
  await page.waitForTimeout(500);

  await page.click('#btnSampleInput');
  await page.waitForTimeout(500);
  // ensure embedded backend mode (a previous run may have persisted API mode)
  await page.click('[data-view=settings]');
  await page.waitForTimeout(400);
  const useApiOn = await page.evaluate(() => document.getElementById('swUseApi').getAttribute('aria-checked') === 'true');
  if (useApiOn) {
    await page.click('#swUseApi');
    await page.waitForTimeout(300);
  }
  await page.click('[data-view=obfuscator]');
  await page.waitForTimeout(400);
  await page.click('#btnObfuscate');
  try {
    await page.waitForFunction(() => !document.getElementById('statsRow').classList.contains('hidden'), null, { timeout: 120000 });
  } catch (e) {
    console.log('DIAG ' + JSON.stringify(await page.evaluate(() => ({
      out: document.getElementById('outputMeta').textContent,
      btnDis: document.getElementById('btnObfuscate').disabled,
      lastLog: (document.querySelector('#logList .log-entry:last-child .log-msg') || {}).textContent || null,
    }))));
    throw e;
  }
  console.log('RESULT ' + JSON.stringify(await page.evaluate(() => ({
    outMeta: document.getElementById('outputMeta').textContent,
    mode: document.getElementById('statMode').textContent,
    logs: document.getElementById('logCount').textContent,
  }))));

  // themes
  await page.click('[data-view=settings]');
  await page.click('.theme-opt[data-theme="midnight"]');
  const themeOk = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  console.log('THEME ' + themeOk);
  await page.click('.theme-opt[data-theme="forest"]');
  await page.waitForTimeout(400);
  console.log('THEME2 ' + await page.evaluate(() => document.documentElement.getAttribute('data-theme')));
  await page.click('.theme-opt[data-theme="novela"]');

  // no duplicated dropdown options anywhere
  const dd = await page.evaluate(() => {
    const out = {};
    Array.from(document.querySelectorAll('select')).forEach((el) => {
      const vals = Array.from(el.options).map((o) => o.value);
      out[el.id] = { count: vals.length, dupes: vals.length - new Set(vals).size };
    });
    return out;
  });
  console.log('DROPDOWNS ' + JSON.stringify(dd));

  // Prof: closure dispatcher + hex numbers, then fullscreen editors
  await page.selectOption('#selDispatch', '1');
  await page.selectOption('#selNumMask', '1');
  await page.click('[data-view=obfuscator]');
  await page.click('#btnFullInput');
  const fsOn = await page.evaluate(() => document.querySelectorAll('#view-obfuscator .pane')[0].classList.contains('fullscreen'));
  await page.keyboard.press('Escape');
  const fsOff = await page.evaluate(() => document.querySelectorAll('#view-obfuscator .pane')[0].classList.contains('fullscreen'));
  console.log('FULLSCREEN on=' + fsOn + ' off=' + fsOff);

  // local server lifecycle through the UI
  await page.click('[data-view=settings]');
  await page.waitForTimeout(400);
  await page.click('#btnSrvToggle');
  await page.waitForFunction(() => document.getElementById('srvStatus').textContent.includes('4477'), null, { timeout: 30000 });
  console.log('SERVER ' + await page.evaluate(() => document.getElementById('srvStatus').textContent));
  await page.click('#btnApiTest');
  await page.waitForFunction(() => !document.getElementById('apiTestResult').textContent.includes('…'), null, { timeout: 30000 });
  console.log('APITEST ' + await page.evaluate(() => document.getElementById('apiTestResult').textContent));
  // obfuscate through the HTTP API (same input => same size, so check completion via stats)
  await page.click('#swUseApi');
  await page.click('[data-view=obfuscator]');
  await page.click('#btnObfuscate');
  await page.waitForFunction(() => !document.getElementById('statsRow').classList.contains('hidden'), null, { timeout: 120000 });
  const apiOut = await page.evaluate(() => ({
    meta: document.getElementById('outputMeta').textContent,
    mode: document.getElementById('statMode').textContent,
  }));
  console.log('APIOBF ' + JSON.stringify(apiOut));
  await page.click('[data-view=settings]');
  await page.click('#btnSrvToggle');
  await page.waitForTimeout(1000);
  console.log('SERVERSTOP ' + await page.evaluate(() => document.getElementById('srvStatus').textContent));
  await page.screenshot({ path: 'gui-check.png' });
  console.log('ERRORS ' + JSON.stringify(errors));
  await browser.close();
  try { child.kill(); } catch {}
  await new Promise((r) => setTimeout(r, 1500));
  process.exit(errors.length ? 2 : 0);
})().catch((e) => { console.error('HARNESS FAIL', e && e.message); process.exit(1); });
