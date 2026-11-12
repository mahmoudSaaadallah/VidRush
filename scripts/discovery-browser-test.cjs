'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');

async function run(chromium, extensionPath) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'vidrush-discovery-'));
  const copiedExtension = path.join(fixture, 'extension');
  let context;
  // Local fixtures model a signed, cross-origin player. No third-party video or
  // logged-in profile is used. Extra localhost host grants exist only in this copy.
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', req.url.includes('.m3u8') ? 'application/vnd.apple.mpegurl' : 'text/html; charset=utf-8');
    const port = server.address().port;
    if (req.url.startsWith('/master.m3u8')) { res.end('#EXTM3U\n#EXT-X-ENDLIST'); return; }
    if (req.url.startsWith('/opaque')) { res.setHeader('Content-Type', 'application/vnd.apple.mpegurl'); res.end('#EXTM3U\n#EXT-X-ENDLIST'); return; }
    if (req.url === '/player') {
      res.end('<video></video><script>fetch("/master.m3u8?token=ephemeral").then(response=>response.text()).then(()=>window.loaded=true)</script>'); return;
    }
    res.end(`<title>Signed-in lesson fixture</title><video src="/video.mp4"></video><iframe src="http://localhost:${port}/player"></iframe>`);
  });
  try {
    await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
    fs.cpSync(extensionPath, copiedExtension, { recursive: true, filter: () => true });
    const manifestPath = path.join(copiedExtension, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    manifest.host_permissions = ['http://127.0.0.1/*'];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const launch = () => chromium.launchPersistentContext(path.join(fixture, 'profile'), {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${copiedExtension}`, `--load-extension=${copiedExtension}`],
    });
    context = await launch();
    let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    let page = await context.newPage();
    const url = `http://127.0.0.1:${server.address().port}/lesson`;
    await page.goto(url);
    const scan = activeWorker => activeWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: discoverPageMedia });
    });
    let frames = await scan(worker);
    assert.equal(frames.length, 1, 'A cross-origin player cannot be scanned before its host grant.');
    assert.ok(frames[0].result.sources.some(source => source.url.endsWith('/video.mp4')));
    // Model the additional host grant, then run the same shipped discovery code.
    await context.close();
    manifest.host_permissions = ['http://*/*', 'https://*/*'];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    context = await launch();
    worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    page = await context.newPage();
    await page.goto(url);
    const player = page.frame({ url: /\/player$/ });
    await player.waitForFunction(() => window.loaded === true);
    frames = await scan(worker);
    const detected = frames.find(frame => frame.result.pageUrl.includes('localhost'));
    assert.ok(detected, 'The granted player frame must be included.');
    const stream = detected.result.sources.find(source => source.url.includes('master.m3u8'));
    assert.ok(stream);
    assert.match(stream.url, /token=ephemeral/);
    assert.equal(stream.referer, `http://localhost:${server.address().port}/player`);
    assert.equal(frames[0].result.sources.some(source => source.url.includes('master.m3u8')), false, 'The parent cannot read the cross-origin performance buffer.');
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
    await worker.evaluate(({ tabId, url }) => handle({ action: 'startCapture', tabId, url }), { tabId, url });
    await player.evaluate(async () => { await (await fetch('/opaque?signature=private')).text(); });
    await page.waitForTimeout(100);
    const network = await worker.evaluate(({ tabId, url }) => capture.read(tabId, url), { tabId, url });
    assert.ok(network.some(source => source.kind === 'hls' && source.url.includes('/opaque?signature=private') && source.userAgent));
    const other = await context.newPage(); await other.goto(url);
    await other.evaluate(async () => { await (await fetch('/opaque?other-tab=1')).text(); });
    assert.equal(await worker.evaluate(({ tabId, url }) => capture.read(tabId, url).some(source => source.url.includes('other-tab')), { tabId, url }), false);
    await other.close();
    const metadata = await worker.evaluate(() => chrome.storage.session.get('captureSession'));
    assert.equal(JSON.stringify(metadata).includes('signature'), false);
    assert.equal(metadata.captureSession.url, undefined);
    await page.route('https://**/*', route => route.abort());
    await page.evaluate(() => {
      document.querySelector('video').src = URL.createObjectURL(new Blob(['fixture'], { type: 'video/mp4' }));
      document.body.insertAdjacentHTML('beforeend', '<iframe src="https://player.hotmart.com/embed/example?signature=private"></iframe><iframe src="https://unrelated.test/ad"></iframe><div class="wistia_embed wistia_async_abcdefghij"></div><div class="video-js bc-player-q7xJcHDcKT_default" data-account="6057955906001" data-video-id="1847146344589202484"></div><script src="https://players.brightcove.net/6415782337001/jZNdE49vY_default/index.min.js"></script><video-js class="video-js bc-player-jZNdE49vY_default bc-player-jZNdE49vY_default-index-0" data-video-id="6366111081112"></video-js>');
    });
    frames = await scan(worker);
    const main = frames[0].result;
    assert.ok(main.playerOrigins.includes('https://player.hotmart.com/*'));
    assert.ok(main.playerOrigins.includes('https://unrelated.test/*'), 'Frame discovery must not rely on player names.');
    assert.ok(main.sources.some(source => source.url === 'https://fast.wistia.net/embed/iframe/abcdefghij'));
    assert.ok(main.sources.some(source => source.url === 'https://players.brightcove.net/6057955906001/q7xJcHDcKT_default/index.html?videoId=1847146344589202484'));
    assert.ok(main.sources.some(source => source.url === 'https://players.brightcove.net/6415782337001/jZNdE49vY_default/index.html?videoId=6366111081112'));
    assert.ok(main.sources.every(source => /^https?:/.test(source.url) && !source.url.includes('signature=private')));
    await page.locator('video').evaluate(async video => {
      const access = await navigator.requestMediaKeySystemAccess('org.w3.clearkey', [{
        initDataTypes: ['cenc'], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }],
      }]);
      await video.setMediaKeys(await access.createMediaKeys());
    });
    frames = await scan(worker);
    assert.equal(frames[0].result.hasDrm, true);
    assert.deepEqual(frames[0].result.sources, []);
    console.log('Real scripting discovery passed: cross-origin isolation/grants, signed HLS timing, video sources, Wistia, and protected/blob handling.');
  } finally {
    if (context) await context.close();
    await new Promise(resolve => server.close(resolve));
    const relative = path.relative(os.tmpdir(), fixture);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) fs.rmSync(fixture, { recursive: true, force: true });
  }
}

module.exports = { run };
