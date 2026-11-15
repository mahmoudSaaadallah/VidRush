'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { Companion } = require('../host/companion.cjs');

// CI uses a deterministic feed with recycled players and prefetched fragments.
// --live URL optionally checks a public Reel with real yt-dlp/FFmpeg on Windows,
// in an isolated browser profile. It never reads the user's Chrome cookies.
async function run(chromium, extensionPath, liveUrl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vidrush-reels-'));
  const calls = [], replies = new Map(), tokens = new Set();
  let context, companion, config, releaseSlow;
  const inspections = () => calls.filter(call => call.action === 'inspect');
  if (liveUrl) {
    if (process.platform !== 'win32' || !/^https:\/\/www\.facebook\.com\/reel\/\d+\/?$/.test(liveUrl)) throw new Error('Use --live with a public Facebook Reel permalink on Windows.');
    config = JSON.parse(fs.readFileSync(path.join(process.env.LOCALAPPDATA, 'VidRush/config.json')));
    config.downloadDir = path.join(root, 'downloads');
    companion = new Companion(config, message => {
      const respond = replies.get(message.id);
      if (respond) { replies.delete(message.id); respond(message); }
    });
  }
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const message = JSON.parse(body); calls.push(message);
    const respond = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (companion) { replies.set(message.id, respond); void companion.handle(message); return; }
    let data;
    if (message.action === 'ping') data = { version: 'fixture', capabilities: { pageSources: true, sourceContext: true, analysisCache: true, cancelInspection: true, mediaExpiryEvents: true } };
    else if (message.action === 'inspect') {
      if (message.url.endsWith('/333')) await new Promise(resolve => { releaseSlow = resolve; });
      const token = 'reel-' + new URL(message.url).pathname.split('/').at(-1); tokens.add(token);
      data = { token, title: token, options: [{ id: '1080', height: 1080, label: '1080p · MP4', container: 'mp4' }] };
    } else if (message.action === 'cachedMedia') data = { available: tokens.has(message.token) };
    else data = [];
    respond({ id: message.id, ok: true, data });
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const bridge = `http://127.0.0.1:${server.address().port}`;
    context = await chromium.launchPersistentContext(path.join(root, 'profile'), { channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    if (!liveUrl) {
      await context.route('https://www.facebook.com/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Reel fixture</title><video></video><video></video><video></video><script>for(const v of document.querySelectorAll("video"))v.src=URL.createObjectURL(new Blob(["fixture"]));fetch("https://media.test/neighbour.mp4?bytestart=0&byteend=1023").catch(()=>{});</script>' }));
      await context.route('https://media.test/**', route => route.fulfill({ status: 206, headers: { 'Content-Type': 'video/mp4', 'Access-Control-Allow-Origin': '*', 'Content-Range': 'bytes 0-31/700000' }, body: Buffer.alloc(32) }));
    }
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(bridge => {
      let id = 0;
      request = async (action, data = {}, timeout, signal) => {
        const key = String(++id);
        const abort = () => { void fetch(bridge, { method: 'POST', body: JSON.stringify({ id: String(++id), action: 'cancelInspection', requestId: key }) }); };
        signal?.addEventListener('abort', abort, { once: true });
        try {
          const response = await fetch(bridge, { method: 'POST', body: JSON.stringify({ id: key, action, ...data }), signal });
          const result = await response.json();
          if (!result.ok) throw Object.assign(new Error(result.error), { code: result.code });
          return result.data;
        } finally { signal?.removeEventListener('abort', abort); }
      };
    }, bridge);
    const page = await context.newPage();
    const first = liveUrl || 'https://www.facebook.com/reel/111';
    await page.goto(first, { waitUntil: 'domcontentloaded' });
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, first);
    const waitFor = async (predicate, label) => {
      const deadline = Date.now() + (liveUrl ? 120000 : 15000);
      while (!await predicate()) {
        if (Date.now() > deadline) throw new Error('Timed out: ' + label);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };
    const prepared = () => worker.evaluate(id => preparedSnapshot(id), tabId);
    const ready = async token => { const state = await prepared(); return state.count === 1 && (!token || state.media.token === token); };
    await waitFor(() => ready(), 'first Reel prepared with popup closed');
    assert.equal(context.pages().some(page => page.url().endsWith('/popup.html')), false);
    assert.equal(inspections().length, 1); assert.equal(inspections()[0].url, first);
    assert.equal(await worker.evaluate(id => chrome.action.getBadgeText({ tabId: id }), tabId), '1');
    const extensionId = new URL(worker.url()).host;
    const reopen = async () => {
      const popup = await context.newPage();
      await popup.addInitScript(tab => { chrome.tabs.query = async () => [tab]; }, { id: tabId, url: page.url() });
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await popup.waitForFunction(() => document.querySelector('#download').disabled === false);
      assert.ok(await popup.locator('#quality option').count()); await popup.close();
    };
    await reopen(); await reopen(); assert.equal(inspections().length, 1);
    if (liveUrl) {
      const media = (await prepared()).media;
      const job = await worker.evaluate(media => handle({ action: 'download', token: media.token, choice: media.options[0].id }), media);
      await waitFor(() => ['completed', 'failed'].includes(companion.jobs.get(job.id)?.status), 'real Reel download');
      const finished = companion.jobs.get(job.id);
      assert.equal(finished.status, 'completed', finished.error);
      const file = fs.readdirSync(config.downloadDir).find(name => /\.(mp4|mkv|webm)$/.test(name)); assert.ok(file);
      const tracks = JSON.parse(execFileSync(path.join(config.ffmpegPath, 'ffprobe.exe'), ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', path.join(config.downloadDir, file)], { encoding: 'utf8', windowsHide: true }));
      assert.ok(tracks.streams.some(stream => stream.codec_type === 'video'));
      assert.ok(tracks.streams.some(stream => stream.codec_type === 'audio'));
      console.log(JSON.stringify({ liveReel: true, choices: media.options.map(option => option.height), streams: tracks.streams, duration: tracks.format.duration, cachedPopup: true }));
    } else {
      await page.evaluate(() => { document.querySelectorAll('video')[1].src = URL.createObjectURL(new Blob(['recycled'])); });
      await page.waitForTimeout(1000); assert.equal(inspections().length, 1);
      await page.evaluate(() => history.pushState({}, '', '/reel/222'));
      await waitFor(() => ready('reel-222'), 'next Reel without opening popup');
      assert.equal(inspections().length, 2);
      await reopen(); assert.equal(inspections().length, 2);
      await page.evaluate(() => history.pushState({}, '', '/reel/333'));
      await waitFor(() => !!releaseSlow, 'slow Reel inspection');
      assert.equal((await prepared()).count, 0);
      await page.evaluate(() => history.replaceState({}, '', '/reel/444'));
      releaseSlow();
      await waitFor(() => ready('reel-444'), 'late old result discarded');
      assert.ok(inspections().every(call => /^https:\/\/www\.facebook\.com\/reel\/\d+$/.test(call.url)));
      assert.equal(calls.some(call => ['prepareBrowser', 'download'].includes(call.action)), false);
      console.log('Reel feed passed: closed-popup preparation, cached reopen, recycled blobs, SPA navigation, prefetched fragment isolation and stale-result cancellation.');
    }
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
if (require.main === module) run(require('playwright').chromium, path.resolve(__dirname, '../extension'), process.argv.includes('--live') ? process.argv[process.argv.indexOf('--live') + 1] : undefined).catch(error => { console.error(error); process.exitCode = 1; });
