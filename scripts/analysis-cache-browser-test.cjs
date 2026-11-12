'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');

async function run(chromium, extensionPath) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vidrush-analysis-cache-'));
  const extension = path.join(root, 'extension');
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('.mp4')) {
      res.setHeader('Content-Type', 'video/mp4'); res.end(Buffer.alloc(32)); return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(req.url.startsWith('/ad') ? '<title>Unrelated ad frame</title>' : '<title>Video lesson</title><video controls src="/first.mp4" style="width:640px;height:360px"></video><iframe id="ad" src="/ad" width="120" height="90"></iframe>');
  });
  let context;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    fs.cpSync(extensionPath, extension, { recursive: true, filter: () => true });
    const manifestPath = path.join(extension, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath)); manifest.host_permissions = ['http://*/*', 'https://*/*'];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    context = await chromium.launchPersistentContext(path.join(root, 'profile'), {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    // Only the native companion is mocked. The popup, worker, DOM identity checks,
    // capture invalidation and Chrome document IDs all use the shipped code.
    await worker.evaluate(() => {
      globalThis.cacheTest = { inspections: 0, checks: 0, tokens: new Set() };
      request = async (action, data = {}) => {
        if (action === 'ping') return { version: 'cache-test', downloadDir: 'test', capabilities: { analysisCache: true, pageSources: true, sourceContext: true, folderPicker: true, openFolder: true } };
        if (action === 'status') return [];
        if (action === 'inspect') {
          const token = 'media-' + ++cacheTest.inspections; cacheTest.tokens.add(token);
          return { token, title: 'Analyzed video ' + cacheTest.inspections, site: 'Local fixture', options: [{ id: '720', height: 720, label: '720p · MP4', container: 'mp4' }] };
        }
        if (action === 'cachedMedia') { cacheTest.checks++; return { available: cacheTest.tokens.has(data.token) }; }
        throw new Error('Unexpected native action: ' + action);
      };
    });
    const page = await context.newPage();
    const url = `http://127.0.0.1:${server.address().port}/lesson`;
    await page.goto(url);
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
    const errors = [];
    const open = async expected => {
      const popup = await context.newPage(); popup.on('pageerror', error => errors.push(error.message));
      // A real action popup is not a tab. Pin its active-tab query to the fixture
      // when displaying the same popup document in a test tab.
      await popup.addInitScript(tab => { chrome.tabs.query = async () => [tab]; }, { id: tabId, url });
      await popup.goto('chrome-extension://' + id + '/popup.html');
      await popup.locator('#video').waitFor({ state: 'visible' });
      assert.equal(await worker.evaluate(() => cacheTest.inspections), expected);
      assert.equal(await popup.locator('#quality option').count(), 1);
      return popup;
    };
    let popup = await open(1); await popup.close();
    await page.evaluate(async () => {
      document.querySelector('#ad').src = '/ad-changed';
      await (await fetch('/ad-video.mp4')).arrayBuffer();
      document.querySelector('video').playbackRate = 1.25;
    });
    await page.waitForTimeout(150);
    popup = await open(1); await popup.close();
    assert.ok(await worker.evaluate(() => cacheTest.checks > 0));
    assert.equal(await worker.evaluate(async () => JSON.stringify(await chrome.storage.session.get(null)).includes('first.mp4')), false, 'Signed/media source identities must not enter session storage.');
    await page.evaluate(() => { document.querySelector('video').src = '/second.mp4'; });
    popup = await open(2); await popup.close();
    await page.evaluate(() => { const video = document.querySelector('video'); video.replaceWith(video.cloneNode(true)); });
    popup = await open(3);
    await popup.locator('#refresh').click();
    await popup.waitForFunction(() => document.querySelector('#title').textContent === 'Analyzed video 4');
    assert.equal(await worker.evaluate(() => cacheTest.inspections), 4); await popup.close();
    await worker.evaluate(() => cacheTest.tokens.clear());
    popup = await open(5); await popup.close();
    await page.reload(); popup = await open(6); await popup.close();
    // A declared quality switch stays the same video; a changed playlist is new.
    await page.evaluate(() => {
      window.playlist = [{ file: '/first.mp4', label: '360p' }, { file: '/second.mp4', label: '720p' }];
      window.jwplayer = () => ({ getPlaylistItem: () => ({ sources: window.playlist }) });
    });
    popup = await open(7); await popup.close();
    await page.evaluate(() => { document.querySelector('video').src = '/second.mp4'; });
    popup = await open(7); await popup.close();
    await page.evaluate(() => { window.playlist = [{ file: '/another-video.mp4', label: '720p' }]; });
    popup = await open(8); await popup.close();
    assert.deepEqual(errors, []);
    console.log('Real popup reopen reused analysis through ad traffic and playback/quality changes; source, node, document, playlist, token expiry and Refresh triggered fresh scans.');
  } finally {
    if (context) await context.close(); await new Promise(resolve => server.close(resolve));
    const relative = path.relative(os.tmpdir(), root);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) fs.rmSync(root, { recursive: true, force: true });
  }
}
module.exports = { run };
