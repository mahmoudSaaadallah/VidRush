'use strict';
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { extensionId } = require('./install.cjs');
const root = path.resolve(__dirname, '..');

async function main() {
  const artifacts = path.join(root, 'artifacts'); fs.mkdirSync(artifacts, { recursive: true });
  const extensionPath = path.join(root, 'extension');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vidrush-browser-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    viewport: { width: 440, height: 1000 },
  });
  let server;
  try {
    const errors = [];
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker');
    const id = extensionId(require('../extension/manifest.json').key);
    assert.equal(new URL(worker.url()).host, id);
    assert.deepEqual(await worker.evaluate(() => chrome.runtime.getManifest().permissions), ['activeTab', 'nativeMessaging', 'storage']);
    console.log(`Real extension loaded: ${id}`);
    if (process.argv.includes('--native')) {
      const ping = await worker.evaluate(async () => request('ping', {}, 20000));
      assert.ok(ping.version);
      console.log(`Chrome launched the registered companion successfully: yt-dlp ${ping.version}`);
    }

    // Exercise the actual DOM/CSS and popup handlers with predictable Chrome/companion responses.
    // No real site is contacted, and these mocks are not part of the shipped extension.
    server = http.createServer((req, res) => {
      const allowed = new Set(['/popup.html', '/popup.css', '/popup.js', '/icons/48.png']);
      if (!allowed.has(req.url)) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', req.url.endsWith('.html') ? 'text/html; charset=utf-8' : req.url.endsWith('.css') ? 'text/css' : req.url.endsWith('.js') ? 'text/javascript' : 'image/png');
      res.end(fs.readFileSync(path.join(extensionPath, req.url.slice(1))));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const listeners = [];
      window.testMode = 'ready';
      window.actions = [];
      window.chrome = {
        runtime: {
          id: 'abcdefghijklmnopabcdefghijklmnop',
          async sendMessage(message) {
            window.actions.push(message);
            if (window.testMode === 'missing') return { ok: false, error: 'تعذّر الاتصال بالبرنامج المساعد. شغّل Install.cmd ثم أعد المحاولة.' };
            if (message.action === 'bootstrap') return { ok: true, data: { companion: { version: 'test', downloadDir: 'C:\\Videos' }, jobs: [] } };
            if (message.action === 'analyze') {
              if (window.testMode === 'unsupported') return { ok: false, error: 'No downloadable video with audio was found.' };
              return { ok: true, data: { token: 'video', title: '<script>alert(1)</script> — فيديو تجريبي', duration: 83, site: 'Test site', options: [
                { id: '1080', label: '1080p · 60 fps · MP4', bytes: 1024 ** 2 * 85 },
                { id: '720', label: '720p · MP4', bytes: 1024 ** 2 * 40 },
              ] } };
            }
            if (message.action === 'download') {
              const job = { id: 'job1', title: 'فيديو تجريبي', quality: '720p · MP4', status: 'downloading', percent: 45, speed: 2 * 1024 ** 2 };
              listeners.forEach(listener => listener({ jobs: { newValue: [job] } }, 'session'));
              return { ok: true, data: job };
            }
            if (message.action === 'cancel') {
              listeners.forEach(listener => listener({ jobs: { newValue: [{ id: 'job1', title: 'فيديو تجريبي', quality: '720p · MP4', status: 'cancelled', percent: 45 }] } }, 'session'));
            }
            return { ok: true, data: {} };
          },
        },
        tabs: { query: async () => [{ id: 1, url: 'https://example.com/watch?v=test' }] },
        storage: { session: { get: async () => ({ jobs: [] }) }, onChanged: { addListener: callback => listeners.push(callback) } },
      };
    });
    await page.goto(`${base}/popup.html`);
    await page.locator('#video').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#quality option').count(), 2);
    assert.match(await page.locator('#title').innerText(), /<script>/);
    assert.equal(await page.locator('#title script').count(), 0);
    await page.setViewportSize({ width: 400, height: 600 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
    await page.locator('#title').evaluate(element => { element.textContent = 'رحلة قصيرة إلى البحر — فيديو تجريبي'; });
    await page.locator('body').screenshot({ path: path.join(artifacts, 'popup-ready.png') });
    await page.locator('#quality').selectOption('720');
    await page.locator('#download').click();
    await page.locator('.job').waitFor();
    assert.equal(await page.evaluate(() => window.actions.find(action => action.action === 'download').choice), '720');
    assert.match(await page.locator('.job-status').innerText(), /45%/);
    await page.screenshot({ path: path.join(artifacts, 'popup-downloading.png'), fullPage: true });
    await page.locator('.cancel').click();
    assert.match(await page.locator('.job-status').innerText(), /تم الإلغاء/);
    await page.evaluate(() => { window.testMode = 'unsupported'; });
    await page.locator('#refresh').click();
    await page.waitForFunction(() => document.getElementById('notice').textContent.includes('No downloadable'));
    assert.equal(await page.locator('#video').isVisible(), false);
    await page.screenshot({ path: path.join(artifacts, 'popup-error.png'), fullPage: true });
    await page.evaluate(() => { window.testMode = 'missing'; });
    // Reconnect through the same initialization path used by the real popup.
    await page.locator('#reconnect').evaluate(element => { element.closest('#setup').hidden = false; });
    await page.locator('#reconnect').click();
    await page.locator('#setup').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.getElementById('connection').textContent === 'غير متصل');
    assert.equal(await page.locator('#extension-id').inputValue(), 'abcdefghijklmnopabcdefghijklmnop');
    await page.screenshot({ path: path.join(artifacts, 'popup-setup.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log('Popup quality selection, download, progress, cancellation, setup, error handling, RTL layout and text safety passed.');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await context.close();
    const relative = path.relative(os.tmpdir(), profile);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) fs.rmSync(profile, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
