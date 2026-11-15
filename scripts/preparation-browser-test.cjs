'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { Companion } = require('../host/companion.cjs');

async function run(chromium, extensionPath, realNative = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vidrush-preparation-'));
  let context, companion, server, releaseSlow, heldSlow = false;
  const replies = new Map(), calls = [], errors = [], tokens = new Set();
  const mediaFile = path.join(root, 'sample.mp4');
  if (realNative) {
    const config = JSON.parse(fs.readFileSync(path.join(process.env.LOCALAPPDATA, 'VidRush', 'config.json')));
    config.downloadDir = path.join(root, 'downloads');
    execFileSync(path.join(config.ffmpegPath, 'ffmpeg.exe'), ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', mediaFile], { windowsHide: true });
    companion = new Companion(config, message => {
      const respond = replies.get(message.id);
      if (respond) { replies.delete(message.id); respond(message); }
    });
  }
  const payload = realNative ? fs.readFileSync(mediaFile) : Buffer.alloc(64);
  const inspectCount = () => calls.filter(call => call.action === 'inspect').length;
  server = http.createServer(async (req, res) => {
    if (req.url === '/native' && req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const message = JSON.parse(body); calls.push(message);
      const respond = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
      if (companion) { replies.set(message.id, respond); void companion.handle(message); return; }
      let data;
      if (message.action === 'ping') data = { version: 'browser-fixture', downloadDir: 'test', capabilities: { pageSources: true, sourceContext: true, analysisCache: true, cancelInspection: true, mediaExpiryEvents: true, folderPicker: true, openFolder: true } };
      else if (message.action === 'inspect') {
        if (message.url.endsWith('/slow.mp4') && !heldSlow) {
          heldSlow = true;
          await new Promise(resolve => { releaseSlow = resolve; });
        }
        const token = 'prepared-' + inspectCount(); tokens.add(token);
        data = { token, title: new URL(message.url).pathname, site: 'Local fixture', options: [360, 720].map(height => ({ id: String(height), height, label: height + 'p · MP4', container: 'mp4' })) };
      } else if (message.action === 'cachedMedia') data = { available: tokens.has(message.token) };
      else data = [];
      respond({ id: message.id, ok: true, data }); return;
    }
    if (req.url.endsWith('.mp4')) { res.setHeader('Content-Type', 'video/mp4'); res.setHeader('Content-Length', payload.length); res.end(payload); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(req.url.startsWith('/ad') ? '<title>Unrelated frame</title>' : '<title>Autonomous preparation</title><video controls preload="metadata" src="/first.mp4" style="width:640px;height:360px"></video><iframe id="ad" src="/ad" width="120" height="90"></iframe>');
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    context = await chromium.launchPersistentContext(path.join(root, 'profile'), { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    // The shipped worker, content observers, navigation/capture APIs and popup
    // run unchanged. Only native transport uses this isolated loopback fixture.
    // --native runs the real Companion + installed yt-dlp/FFprobe behind it.
    await worker.evaluate(base => {
      let next = 0;
      request = async (action, data = {}, timeout, signal) => {
        const id = String(++next);
        const abort = () => { void fetch(base + '/native', { method: 'POST', body: JSON.stringify({ id: String(++next), action: 'cancelInspection', requestId: id }) }).catch(() => {}); };
        signal?.addEventListener('abort', abort, { once: true });
        try {
          const response = await fetch(base + '/native', { method: 'POST', body: JSON.stringify({ id, action, ...data }), signal });
          const value = await response.json();
          if (!value.ok) throw Object.assign(new Error(value.error), { code: value.code });
          return value.data;
        } finally { signal?.removeEventListener('abort', abort); }
      };
    }, base);
    const page = await context.newPage();
    await page.goto(base + '/lesson');
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
    const waitFor = async (condition, label) => {
      const end = Date.now() + (realNative ? 60000 : 10000);
      while (!await condition()) {
        if (Date.now() > end) throw new Error('Timed out: ' + label + ' ' + JSON.stringify(await worker.evaluate(id => preparedSnapshot(id), tabId)));
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };
    const badge = () => worker.evaluate(id => chrome.action.getBadgeText({ tabId: id }), tabId);
    await waitFor(async () => await badge() === '1', 'quality preparation with popup closed');
    assert.equal(context.pages().some(page => page.url().endsWith('/popup.html')), false);
    assert.equal(inspectCount(), 1);
    const initial = await worker.evaluate(id => preparedSnapshot(id), tabId);
    assert.ok(initial.media.options.length > 0);
    assert.equal(calls.some(call => call.action === 'download'), false);
    const open = async () => {
      const popup = await context.newPage(); popup.on('pageerror', error => errors.push(error.message));
      await popup.addInitScript(tab => { chrome.tabs.query = async () => [tab]; }, { id: tabId, url: page.url() });
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await popup.locator('#video').waitFor({ state: 'visible' });
      await popup.waitForFunction(() => document.querySelector('#download').disabled === false);
      return popup;
    };
    let popup = await open();
    assert.equal(await popup.locator('#quality option').count(), initial.media.options.length);
    await popup.close(); popup = await open(); await popup.close();
    assert.equal(inspectCount(), 1, 'Opening/reopening must not issue inspect.');
    await page.evaluate(async () => { document.querySelector('#ad').src = '/ad-changed'; await fetch('/variant.mp4'); });
    await page.waitForTimeout(1100);
    assert.equal(await badge(), '1'); assert.equal(inspectCount(), 1);
    await page.evaluate(() => { document.querySelector('video').src = '/second.mp4'; });
    await waitFor(async () => inspectCount() === 2 && await badge() === '1', 'same-URL player change');
    popup = await open(); await popup.close(); assert.equal(inspectCount(), 2);
    await page.evaluate(() => { const video = document.createElement('video'); video.src = '/third.mp4'; video.controls = true; document.body.append(video); });
    await waitFor(async () => await badge() === '2', 'two independent ready players');
    assert.equal(inspectCount(), 3);
    popup = await open(); assert.equal(await popup.locator('#video-source option').count(), 2);
    await popup.selectOption('#video-source', { index: 1 });
    await popup.waitForFunction(() => document.querySelector('#video-source').disabled === false);
    assert.equal(inspectCount(), 3); await popup.close();
    await page.evaluate(() => { document.querySelectorAll('video')[1].remove(); });
    await waitFor(async () => await badge() === '1', 'removed player invalidation');
    await page.evaluate(() => { history.pushState({}, '', '/new-video'); document.querySelector('video').src = '/new.mp4'; });
    await waitFor(async () => inspectCount() === 4 && await badge() === '1', 'SPA navigation');
    await page.reload();
    await waitFor(async () => inspectCount() === 5 && await badge() === '1', 'same-URL reload');
    if (!realNative) {
      await page.evaluate(() => { document.querySelector('video').src = '/slow.mp4'; });
      await waitFor(() => !!releaseSlow, 'pending inspection');
      assert.equal(await badge(), '…');
      const opening = open();
      await page.waitForTimeout(150);
      assert.equal(inspectCount(), 6, 'Popup joins the pending native inspection.');
      releaseSlow(); popup = await opening; await popup.close(); assert.equal(inspectCount(), 6);
      tokens.clear();
      popup = await open(); await popup.close(); assert.equal(inspectCount(), 7, 'Expired tokens must be renewed.');
    }
    const stored = await worker.evaluate(() => chrome.storage.session.get('preparations'));
    assert.equal(JSON.stringify(stored).includes(base), false, 'Source URLs must not be persisted in preparation metadata.');
    assert.deepEqual(errors, []);
    console.log(`${realNative ? 'Real yt-dlp + FFprobe' : 'Deterministic native fixture'}: closed-popup preparation, ready-only badges, cached reopening, two players, removal, SPA and same-URL reload passed.`);
  } finally {
    releaseSlow?.();
    if (context) await context.close();
    if (companion) for (const child of companion.children) companion.stop(child);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    const relative = path.relative(os.tmpdir(), root);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) fs.rmSync(root, { recursive: true, force: true });
  }
}
module.exports = { run };
if (require.main === module) run(require('playwright').chromium, path.resolve(__dirname, '../extension'), process.argv.includes('--native')).catch(error => { console.error(error); process.exitCode = 1; });
