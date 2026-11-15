'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function harness(initialJobs = [], options = {}) {
  const sent = [], stored = {}, callbacks = {};
  const identity = { value: 'unchanged-player', documentId: 'main-document' };
  const port = {
    onMessage: { addListener(fn) { callbacks.message = fn; } },
    onDisconnect: { addListener(fn) { callbacks.disconnect = fn; } },
    postMessage(message) { sent.push(message); },
  };
  const badges = {}, badgeColors = {};
  const chrome = {
    action: {
      setBadgeText: ({ tabId, text }) => { badges[tabId] = text; },
      setBadgeBackgroundColor: ({ tabId, color }) => { badgeColors[tabId] = color; },
      setBadgeTextColor: () => {},
    },
    runtime: {
      id: 'test-extension', getURL: suffix => `chrome-extension://test-extension/${suffix}`,
      connectNative: () => port, onMessage: { addListener(fn) { callbacks.external = fn; } },
    },
    storage: { session: { get: async () => ({ jobs: initialJobs }), set: async data => Object.assign(stored, JSON.parse(JSON.stringify(data))) } },
    tabs: { get: async id => ({ id, url: 'https://example.com/video' }), onRemoved: { addListener(fn) { callbacks.tabRemoved = fn; } }, onUpdated: { addListener(fn) { callbacks.tabUpdated = fn; } } },
    permissions: { contains: async () => options.full === true, onRemoved: { addListener(fn) { callbacks.revoked = fn; } } },
    webRequest: Object.fromEntries(['onBeforeRequest', 'onBeforeSendHeaders', 'onResponseStarted', 'onCompleted', 'onErrorOccurred'].map(name => [name, { addListener(fn) { callbacks[name] = fn; } }])),
    scripting: { executeScript: async script => {
      if (options.executeScript) {
        const res = await options.executeScript(script, identity);
        if (res !== undefined) return res;
      }
      return script.func.name === 'snapshotPlayerIdentity'
        ? [{ frameId: script.target.frameIds?.[0] || 0, documentId: identity.documentId, result: identity.value }]
        : [{ frameId: 0, result: { pageUrl: 'https://example.com/video', sources: [], playerOrigins: [], ...options.page } }, ...(options.frames || [])];
    } },
  };
  const context = vm.createContext({ chrome, setTimeout, clearTimeout, console, URL, crypto,
    importScripts: filename => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'extension', filename), 'utf8'), context) });
  vm.runInContext(`${fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8')}\nglobalThis.api = { handle };`, context);
  const respond = (message, data) => callbacks.message({ id: message.id, ok: true, data });
  return { api: context.api, sent, stored, callbacks, respond, chrome, identity, badges, badgeColors };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

async function bootstrap(h, pageSources = true, pairedStreams = true, browserTransfer = false, browserQualities = false) {
  const operation = h.api.handle({ action: 'bootstrap' });
  await tick(); h.respond(h.sent.at(-1), { capabilities: { pageSources, sourceContext: true, analysisCache: true, pairedStreams, browserTransfer, browserQualities } });
  await tick(); h.respond(h.sent.at(-1), []);
  await operation;
}

test('full scan detects extensionless media on any host, binds source context, and stops without rearming', async () => {
  const h = harness([], { full: true }); await bootstrap(h);
  await h.api.handle({ action: 'startCapture', tabId: 1, url: 'https://example.com/video' });
  const network = { requestId: 'network', tabId: 1, frameId: 7, method: 'GET', url: 'https://arbitrary-cdn.test/watch?token=private' };
  h.callbacks.onBeforeRequest(network);
  h.callbacks.onBeforeSendHeaders({ ...network, requestHeaders: [{ name: 'Referer', value: 'https://arbitrary-player.test/' }, { name: 'User-Agent', value: 'Browser UA' }] });
  h.callbacks.onResponseStarted({ ...network, statusCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/dash+xml' }] });
  await tick();
  const operation = h.api.handle({ action: 'analyze', tabId: 1, url: 'https://example.com/video', scanPlayer: true });
  await tick();
  assert.equal(h.sent.at(-1).url, network.url); assert.equal(h.sent.at(-1).userAgent, 'Browser UA');
  h.respond(h.sent.at(-1), { token: 'detected', options: [] });
  const media = await operation;
  assert.equal(media.detectedSources[0].label.includes('private'), false);
  assert.equal(media.sourceIndex, 0);
  await h.api.handle({ action: 'stopCapture', tabId: 1 });
  await assert.rejects(h.api.handle({ action: 'analyze', tabId: 1, url: 'https://example.com/video', refresh: true, scanPlayer: true }), /لم يظهر/);
  assert.equal((await h.api.handle({ action: 'captureStatus', tabId: 1 })).active, false);
  h.callbacks.onBeforeRequest(network); h.callbacks.onResponseStarted({ ...network, statusCode: 200 }); await tick();
  assert.equal((await h.api.handle({ action: 'captureStatus', tabId: 1 })).count, 0);
  assert.equal(JSON.stringify(h.stored).includes('private'), false);
  await assert.rejects(h.api.handle({ action: 'selectSource', tabId: 1, url: 'https://example.com/video', sourceIndex: 0 }), /انتهت/);
});

test('unsupported pages fall back to media discovered in an authorized player frame', async () => {
  const source = { url: 'https://cdn.example/master.m3u8?token=ephemeral', referer: 'https://player.hotmart.com/' };
  const h = harness([], { page: { title: 'Lesson title' }, frames: [{ frameId: 3, result: { sources: [source] } }] });
  await bootstrap(h);
  const operation = h.api.handle({ action: 'analyze', tabId: 1, url: 'https://example.com/video' });
  await tick(); h.callbacks.message({ id: h.sent.at(-1).id, ok: false, error: 'Unsupported URL' });
  await tick();
  assert.equal(h.sent.at(-1).url, source.url);
  assert.equal(h.sent.at(-1).referer, source.referer);
  assert.equal(h.sent.at(-1).title, 'Lesson title');
  h.respond(h.sent.at(-1), { token: 'detected-video' });
  assert.equal((await operation).token, 'detected-video');
});

test('fallback failures preserve the video stream error instead of an incidental iframe error', async () => {
  const h = harness([], { page: { sources: [{ url: 'https://cdn.test/master.m3u8' }], embeds: [{ url: 'https://frame.test/player' }] } });
  await bootstrap(h);
  const operation = h.api.handle({ action: 'analyze', tabId: 1, url: 'https://example.com/video', scanPlayer: true });
  const rejected = assert.rejects(operation, error => /HTTP 403: video stream/.test(error.message) && !/Unsupported iframe/.test(error.message));
  await tick(); h.callbacks.message({ id: h.sent.at(-1).id, ok: false, error: 'HTTP 403: video stream' });
  await tick(); h.callbacks.message({ id: h.sent.at(-1).id, ok: false, error: 'Unsupported iframe' });
  await rejected;
});

test('a verified single-track source is skipped in favor of another complete source', async () => {
  const h = harness([], { page: { sources: [{ url: 'https://cdn.test/track.mp4' }, { url: 'https://cdn.test/complete.mp4' }] } });
  await bootstrap(h);
  const operation = h.api.handle({ action: 'analyze', tabId: 1, url: 'https://example.com/video', scanPlayer: true });
  await tick();
  assert.equal(h.sent.at(-1).url, 'https://cdn.test/track.mp4');
  h.callbacks.message({ id: h.sent.at(-1).id, ok: false, code: 'MISSING_MEDIA_TRACKS', error: 'Missing audio' });
  await tick();
  assert.equal(h.sent.at(-1).url, 'https://cdn.test/complete.mp4');
  h.respond(h.sent.at(-1), { token: 'complete' });
  assert.equal((await operation).token, 'complete');
});

test('the extension reports protected playback without asking the companion to fetch the source', async () => {
  const h = harness([], { page: { hasDrm: true, sources: [{ url: 'https://cdn.test/protected.mpd' }] } });
  await bootstrap(h);
  const input = { action: 'analyze', tabId: 1, url: 'https://example.com/video' };
  await assert.rejects(h.api.handle(input), /DRM/);
  await assert.rejects(h.api.handle({ ...input, scanPlayer: true }), /DRM/);
  assert.equal(h.sent.filter(message => message.action === 'inspect').length, 0);
});

test('locked player offers only its optional origin and rescans after permission without repeating the failed page URL', async () => {
  const origin = 'https://player.hotmart.com/*';
  const h = harness([], { page: { playerOrigins: [origin] } });
  await bootstrap(h);
  const operation = h.api.handle({ action: 'analyze', tabId: 1, url: 'https://example.com/video' });
  const rejected = assert.rejects(operation, error => error.playerOrigins[0] === origin && /شغّل الفيديو/.test(error.message));
  await tick(); h.callbacks.message({ id: h.sent.at(-1).id, ok: false, error: 'Unsupported URL' });
  await rejected;
  h.chrome.scripting.executeScript = async () => [{ frameId: 0, result: { pageUrl: 'https://example.com/video', sources: [{ url: 'https://cdn.test/master.m3u8', referer: 'https://example.com/' }] } }];
  const before = h.sent.length;
  const retry = h.api.handle({ action: 'analyze', tabId: 1, url: 'https://example.com/video', refresh: true, scanPlayer: true });
  await tick();
  assert.equal(h.sent.length, before + 1);
  assert.equal(h.sent.at(-1).url, 'https://cdn.test/master.m3u8');
  h.respond(h.sent.at(-1), { token: 'ready' }); await retry;
});

test('a previously authorized player is scanned automatically and is not offered another permission prompt on failure', async () => {
  const origin = 'https://already-authorized.test/*';
  const h = harness([], { page: { playerOrigins: [origin] } });
  h.chrome.permissions.contains = async ({ origins }) => origins.length === 1 && origins[0] === origin;
  await bootstrap(h);
  const operation = h.api.handle({ action: 'analyze', tabId: 1, url: 'https://example.com/video' });
  const rejected = assert.rejects(operation, error => error.playerOrigins.length === 0);
  await tick(); h.callbacks.message({ id: h.sent.at(-1).id, ok: false, error: 'Unsupported page URL' });
  await rejected;
});

test('navigation during fallback and an outdated companion cannot produce a stale or unsupported selection', async () => {
  const h = harness(); await bootstrap(h);
  const operation = h.api.handle({ action: 'analyze', tabId: 1, url: 'https://example.com/video' });
  const rejected = assert.rejects(operation, /تغيّرت الصفحة/);
  await tick();
  h.chrome.tabs.get = async id => ({ id, url: 'https://example.com/next-video' });
  h.callbacks.message({ id: h.sent.at(-1).id, ok: false, error: 'Unsupported URL' });
  await rejected;
  const old = harness(); await bootstrap(old, false);
  const retry = old.api.handle({ action: 'analyze', tabId: 1, url: 'https://example.com/video', scanPlayer: true });
  await assert.rejects(retry, /Update.cmd/);
  assert.equal(old.sent.length, 2, 'No media requests may reach a helper without the new capability.');
});

test('worker reuses an in-flight analysis across popup openings and correlates replies', async () => {
  const h = harness();
  const first = h.api.handle({ action: 'analyze', tabId: 1, url: 'https://example.com/video' });
  const second = h.api.handle({ action: 'analyze', tabId: 1, url: 'https://example.com/video' });
  const another = h.api.handle({ action: 'analyze', tabId: 2, url: 'https://example.com/video' });
  await tick();
  assert.equal(h.sent.length, 2);
  h.respond(h.sent[1], { token: 'second-tab' });
  h.respond(h.sent[0], { token: 'first-tab' });
  assert.equal((await first).token, 'first-tab');
  assert.equal((await second).token, 'first-tab');
  assert.equal((await another).token, 'second-tab');
});

test('a completed analysis survives unrelated capture traffic and popup reopening without inspecting again', async () => {
  const h = harness([], { full: true }); await bootstrap(h);
  const analyze = () => h.api.handle({ action: 'analyze', tabId: 1, url: 'https://example.com/video' });
  const first = analyze(); await tick(); h.respond(h.sent.at(-1), { token: 'cached', options: [{ id: '720' }] }); await first;
  const request = { requestId: 'ad', tabId: 1, frameId: 44, type: 'media', method: 'GET', url: 'https://cdn.test/ad.mp4' };
  h.callbacks.onBeforeRequest(request);
  h.callbacks.onResponseStarted({ ...request, statusCode: 206 });
  h.callbacks.onBeforeRequest({ ...request, requestId: 'ad-frame', type: 'sub_frame', url: 'https://ads.test/new' });
  await tick();
  const reopened = analyze(); await tick();
  assert.equal(h.sent.at(-1).action, 'cachedMedia'); h.respond(h.sent.at(-1), { available: true });
  assert.equal((await reopened).token, 'cached');
  assert.equal(h.sent.filter(message => message.action === 'inspect').length, 1);
});

test('capture events during an in-flight scan do not detach it when the popup reopens', async () => {
  const h = harness([], { full: true }); await bootstrap(h);
  const analyze = () => h.api.handle({ action: 'analyze', tabId: 1, url: 'https://example.com/video' });
  const first = analyze(); await tick();
  h.callbacks.onBeforeRequest({ requestId: 'frame', type: 'sub_frame', tabId: 1, frameId: 17, url: 'https://ad.test/' });
  const reopened = analyze(); await tick();
  assert.equal(h.sent.filter(message => message.action === 'inspect').length, 1);
  h.respond(h.sent.at(-1), { token: 'shared-inspection' });
  assert.equal((await first).token, 'shared-inspection'); assert.equal((await reopened).token, 'shared-inspection');
});

test('a new video or document at the same URL, and explicit Refresh, require fresh analysis', async () => {
  const h = harness(); await bootstrap(h);
  const analyze = refresh => h.api.handle({ action: 'analyze', tabId: 1, url: 'https://example.com/video', refresh });
  const complete = async (operation, token) => { await tick(); assert.equal(h.sent.at(-1).action, 'inspect'); h.respond(h.sent.at(-1), { token }); return operation; };
  await complete(analyze(), 'first');
  h.identity.value = 'different-video'; await complete(analyze(), 'next-video');
  h.identity.documentId = 'reloaded-document'; await complete(analyze(), 'reloaded');
  await complete(analyze(true), 'refreshed');
  assert.equal(h.sent.filter(message => message.action === 'inspect').length, 4);
});

test('an evicted companion token produces one shared rescan for concurrent popup requests', async () => {
  const h = harness(); await bootstrap(h);
  const analyze = () => h.api.handle({ action: 'analyze', tabId: 1, url: 'https://example.com/video' });
  const first = analyze(); await tick(); h.respond(h.sent.at(-1), { token: 'expired' }); await first;
  const a = analyze(), b = analyze(); await tick();
  assert.equal(h.sent.filter(message => message.action === 'cachedMedia').length, 1);
  h.respond(h.sent.at(-1), { available: false }); await tick();
  assert.equal(h.sent.filter(message => message.action === 'inspect').length, 2);
  h.respond(h.sent.at(-1), { token: 'renewed' });
  assert.equal((await a).token, 'renewed'); assert.equal((await b).token, 'renewed');
});

test('a selected embedded source remains selected when reopening the popup', async () => {
  const h = harness([], { page: { sources: [{ url: 'https://cdn.test/first.mp4' }, { url: 'https://cdn.test/second.mp4' }] } }); await bootstrap(h);
  const first = h.api.handle({ action: 'analyze', tabId: 1, url: 'https://example.com/video', scanPlayer: true });
  await tick(); h.respond(h.sent.at(-1), { token: 'first' }); await first;
  const selection = h.api.handle({ action: 'selectSource', tabId: 1, url: 'https://example.com/video', sourceIndex: 1 });
  await tick(); h.respond(h.sent.at(-1), { token: 'selected' }); await selection;
  const reopened = h.api.handle({ action: 'analyze', tabId: 1, url: 'https://example.com/video' });
  await tick(); h.respond(h.sent.at(-1), { available: true });
  const media = await reopened;
  assert.equal(media.token, 'selected'); assert.equal(media.sourceIndex, 1);
});

test('a player changed during inspection cannot enter the result cache', async () => {
  const h = harness(); await bootstrap(h);
  const operation = h.api.handle({ action: 'analyze', tabId: 1, url: 'https://example.com/video' });
  const rejected = assert.rejects(operation, /تغيّر الفيديو أثناء الفحص/);
  await tick(); h.identity.value = 'another-player'; h.respond(h.sent.at(-1), { token: 'stale' });
  await rejected;
});

test('a video changed during cached-token validation is rescanned before showing any old result', async () => {
  const h = harness(); await bootstrap(h);
  const analyze = () => h.api.handle({ action: 'analyze', tabId: 1, url: 'https://example.com/video' });
  const first = analyze(); await tick(); h.respond(h.sent.at(-1), { token: 'old' }); await first;
  const reopened = analyze(); await tick(); assert.equal(h.sent.at(-1).action, 'cachedMedia');
  h.identity.value = 'new-video'; h.respond(h.sent.at(-1), { available: true }); await tick();
  assert.equal(h.sent.at(-1).action, 'inspect'); h.respond(h.sent.at(-1), { token: 'current' });
  assert.equal((await reopened).token, 'current');
});

test('worker checks the active tab URL before passing it to the native companion', async () => {
  const h = harness();
  await assert.rejects(h.api.handle({ action: 'analyze', tabId: 1, url: 'https://different.test' }), /تغيّرت الصفحة/);
  assert.equal(h.sent.length, 0);
  assert.equal(h.callbacks.external({ action: 'download' }, { id: 'other-extension', url: 'https://example.com' }, () => {}), false);
});

test('native disconnection marks active downloads failed and rejects pending requests', async () => {
  const h = harness();
  const operation = h.api.handle({ action: 'bootstrap' });
  await tick();
  h.respond(h.sent[0], { version: 'test' });
  await tick();
  h.respond(h.sent[1], [{ id: 'job1', status: 'downloading', title: 'Test' }]);
  await operation;
  const pending = h.api.handle({ action: 'openFolder' });
  await tick();
  const rejection = assert.rejects(pending, /Install.cmd/);
  h.callbacks.disconnect();
  await rejection;
  assert.equal(h.stored.jobs[0].status, 'failed');
});

test('browser restart preserves finished history and invalidates interrupted downloads', async () => {
  const h = harness([{ id: 'old', status: 'downloading' }, { id: 'done', status: 'completed' }]);
  const operation = h.api.handle({ action: 'bootstrap' });
  await tick();
  h.respond(h.sent[0], { version: 'test' });
  await tick();
  h.respond(h.sent[1], []);
  await operation;
  assert.equal(h.stored.jobs[0].status, 'failed');
  assert.equal(h.stored.jobs[1].status, 'completed');
});

test('folder selection survives popup lifetime and stale bootstrap replies cannot undo it', async () => {
  const h = harness();
  const bootstrap = h.api.handle({ action: 'bootstrap' });
  await tick();
  const selection = h.api.handle({ action: 'chooseFolder' });
  await tick();
  assert.equal(h.stored.destination.choosingFolder, true);
  h.respond(h.sent[1], { downloadDir: 'D:\\Chosen videos', cancelled: false });
  await selection;
  h.respond(h.sent[0], { version: 'test', downloadDir: 'C:\\Old videos' });
  await tick();
  h.respond(h.sent[2], []);
  const result = await bootstrap;
  assert.equal(h.stored.destination.downloadDir, 'D:\\Chosen videos');
  assert.equal(h.stored.destination.choosingFolder, false);
  assert.equal(result.companion.downloadDir, 'D:\\Chosen videos');
});

test('opening a historical folder uses session metadata, never a caller-supplied fallback path', async () => {
  const h = harness([{ id: 'saved', status: 'completed', downloadDir: 'D:\\Saved videos' }]);
  const opening = h.api.handle({ action: 'openFolder', jobId: 'saved', knownDownloadDir: 'C:\\Untrusted override' });
  await tick();
  assert.equal(h.sent[0].knownDownloadDir, 'D:\\Saved videos');
  h.respond(h.sent[0], { opened: true }); await opening;
  await assert.rejects(h.api.handle({ action: 'openFolder', jobId: 'missing' }), /غير موجود/);
});

test('a declared Brightcove player is prioritized over single-track rendition streams', async () => {
  const brightcove = 'https://players.brightcove.net/6057955906001/q7xJcHDcKT_default/index.html?videoId=1847146344589202484';
  const h = harness([], { page: { sources: [{ url: 'https://manifest.prod.boltdns.net/video/rendition.m3u8' }, { url: brightcove }] } });
  await bootstrap(h);
  const operation = h.api.handle({ action: 'analyze', tabId: 1, url: 'https://example.com/video', scanPlayer: true });
  await tick();
  assert.equal(h.sent.at(-1).url, brightcove);
  h.respond(h.sent.at(-1), { token: 'brightcove-complete' });
  assert.equal((await operation).token, 'brightcove-complete');
});

test('a declared playlist or master manifest is prioritized over single-track rendition streams', async () => {
  const playlist = 'https://stream.test/live/playlist.m3u8';
  const rendition = 'https://stream.test/live/rendition.m3u8';
  const h = harness([], { page: { sources: [{ url: rendition }, { url: playlist }] } });
  await bootstrap(h);
  const operation = h.api.handle({ action: 'analyze', tabId: 1, url: 'https://example.com/video', scanPlayer: true });
  await tick();
  assert.equal(h.sent.at(-1).url, playlist);
  h.respond(h.sent.at(-1), { token: 'playlist-complete' });
  assert.equal((await operation).token, 'playlist-complete');
});

test('demuxed video-only and audio-only streams are paired into a combined candidate', async () => {
  const videoStream = 'https://stream.test/video-rendition.m3u8';
  const audioStream = 'https://stream.test/audio-rendition.m3u8';
  const h = harness([], { page: { sources: [{ url: videoStream }, { url: audioStream }] } });
  await bootstrap(h);
  const operation = h.api.handle({ action: 'analyze', tabId: 1, url: 'https://example.com/video', scanPlayer: true });
  await tick();
  assert.equal(h.sent.at(-1).url, videoStream);
  h.callbacks.message({ id: h.sent.at(-1).id, ok: false, code: 'MISSING_MEDIA_TRACKS', hasVideo: true, hasAudio: false });
  await tick();
  assert.equal(h.sent.at(-1).url, audioStream);
  h.callbacks.message({ id: h.sent.at(-1).id, ok: false, code: 'MISSING_MEDIA_TRACKS', hasVideo: false, hasAudio: true });
  await tick();
  const pairedRequest = h.sent.at(-1);
  assert.equal(pairedRequest.url, videoStream);
  assert.equal(pairedRequest.audioUrl, audioStream);
  h.respond(pairedRequest, { token: 'paired-token', options: [{ id: 'opt-1' }] });
  const result = await operation;
  assert.equal(result.token, 'paired-token');
  assert.match(result.detectedSources[0].label, /^بث مدمج/);
});

test('discoverPageMedia reconstructs Brightcove embed player URLs from DOM elements', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'extension', 'discovery.js'), 'utf8');
  const dom = {
    location: { href: 'https://www.watchit.com/#/details/series/1183/play' },
    document: {
      title: 'WATCH IT',
      baseURI: 'https://www.watchit.com/#/details/series/1183/play',
      querySelectorAll(selector) {
        if (selector === 'video') return [];
        if (selector === 'iframe[src]') return [];
        if (selector.includes('data-account')) {
          return [{
            tagName: 'DIV',
            className: 'video-js bc-player-q7xJcHDcKT_default',
            getAttribute(name) {
              if (name === 'data-account') return '6057955906001';
              if (name === 'data-video-id') return '1847146344589202484';
              if (name === 'data-player') return 'q7xJcHDcKT';
              if (name === 'data-embed') return 'default';
              return null;
            },
            querySelector() { return null; },
            closest() { return null; },
          }];
        }
        return [];
      },
    },
    performance: { getEntriesByType() { return []; } },
    URL,
  };
  const context = vm.createContext(dom);
  vm.runInContext(code, context);
  const result = vm.runInContext('discoverPageMedia()', context);
  assert.equal(result.hasDrm, false);
  const expectedUrl = 'https://players.brightcove.net/6057955906001/q7xJcHDcKT_default/index.html?videoId=1847146344589202484';
  assert.ok(result.sources.some(s => s.url === expectedUrl));
  assert.equal(result.sources[0].referer, 'https://www.watchit.com/');
});

test('discoverPageMedia extracts Brightcove account and player from page scripts when data-account is omitted', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'extension', 'discovery.js'), 'utf8');
  const dom = {
    location: { href: 'https://www.almentor.net/en/courses/Waste-Your-Time' },
    document: {
      title: 'Waste Your Time - Almentor',
      baseURI: 'https://www.almentor.net/en/courses/Waste-Your-Time',
      querySelectorAll(selector) {
        if (selector === 'video') return [];
        if (selector === 'iframe[src]') return [];
        if (selector.includes('script[src]')) {
          return [{
            src: 'https://players.brightcove.net/6415782337001/jZNdE49vY_default/index.min.js',
            getAttribute() { return null; },
          }];
        }
        if (selector.includes('data-account') || selector.includes('data-video-id')) {
          return [{
            tagName: 'VIDEO-JS',
            className: 'video-js bc-player-jZNdE49vY_default bc-player-jZNdE49vY_default-index-0',
            getAttribute(name) {
              if (name === 'data-video-id') return '6366111081112';
              return null;
            },
            querySelector() { return null; },
            closest() { return null; },
          }];
        }
        return [];
      },
    },
    performance: { getEntriesByType() { return []; } },
    URL,
  };
  const context = vm.createContext(dom);
  vm.runInContext(code, context);
  const result = vm.runInContext('discoverPageMedia()', context);
  assert.equal(result.hasDrm, false);
  const expectedUrl = 'https://players.brightcove.net/6415782337001/jZNdE49vY_default/index.html?videoId=6366111081112';
  assert.ok(result.sources.some(s => s.url === expectedUrl));
  assert.equal(result.sources[0].referer, 'https://www.almentor.net/');
});

test('discoverPageMedia penetrates open Shadow DOM to find enclosed video elements', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'extension', 'discovery.js'), 'utf8');
  const videoInShadow = {
    tagName: 'VIDEO',
    currentSrc: 'https://cdn.test/shadow-video.mp4',
    getAttribute(name) { return name === 'src' ? 'https://cdn.test/shadow-video.mp4' : null; },
    querySelectorAll() { return []; },
  };
  const shadowRoot = {
    querySelectorAll(selector) {
      if (selector === 'video') return [videoInShadow];
      return [];
    },
    children: [],
  };
  const customElement = {
    tagName: 'MEDIA-PLAYER',
    shadowRoot,
    getAttribute() { return null; },
    querySelectorAll() { return []; },
  };
  const dom = {
    location: { href: 'https://example.com/watch' },
    document: {
      title: 'Shadow Player Test',
      baseURI: 'https://example.com/watch',
      querySelectorAll(selector) {
        if (selector === 'video') return [];
        if (selector === '*') return [customElement];
        return [];
      },
      children: [customElement],
    },
    performance: { getEntriesByType() { return []; } },
    URL,
  };
  const context = vm.createContext(dom);
  vm.runInContext(code, context);
  const result = vm.runInContext('discoverPageMedia()', context);
  assert.equal(result.sources.some(s => s.url === 'https://cdn.test/shadow-video.mp4'), true);
});

test('discoverPageMedia extracts media from universal data attributes and custom video containers', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'extension', 'discovery.js'), 'utf8');
  const videoWithDataAttrs = {
    tagName: 'VIDEO',
    currentSrc: '',
    getAttribute(name) {
      if (name === 'data-stream-url') return 'https://cdn.test/universal-stream.m3u8';
      return null;
    },
    querySelectorAll() { return []; },
  };
  const vimeoContainer = {
    tagName: 'DIV',
    getAttribute(name) {
      if (name === 'data-vimeo-id') return '76979871';
      return null;
    },
  };
  const dom = {
    location: { href: 'https://example.com/embedded' },
    document: {
      title: 'Universal Player Test',
      baseURI: 'https://example.com/embedded',
      querySelectorAll(selector) {
        if (selector === 'video') return [videoWithDataAttrs];
        if (selector.includes('data-vimeo-id')) return [vimeoContainer];
        return [];
      },
    },
    performance: {
      getEntriesByType() {
        return [
          { name: 'https://api.cdn.test/hls/master?token=xyz' },
          { name: 'https://api.cdn.test/stream?format=m3u8' },
        ];
      },
    },
    URL,
  };
  const context = vm.createContext(dom);
  vm.runInContext(code, context);
  const result = vm.runInContext('discoverPageMedia()', context);
  assert.equal(result.sources.some(s => s.url === 'https://cdn.test/universal-stream.m3u8'), true);
  assert.equal(result.sources.some(s => s.url === 'https://player.vimeo.com/video/76979871'), true);
  assert.equal(result.sources.some(s => s.url === 'https://api.cdn.test/hls/master?token=xyz'), true);
  assert.equal(result.sources.some(s => s.url === 'https://api.cdn.test/stream?format=m3u8'), true);
});

test('fast path dominance: when network stream is available, MSE fallback is not called', async () => {
  const streamUrl = 'https://cdn.example/hls/master.m3u8';
  let mseProbeCalled = false;
  const h = harness([], {
    page: { hasBlob: true, sources: [{ url: streamUrl }] },
    executeScript: async script => {
      if (script.func.name === 'browserFrameFile' && script.args?.[1]?.allowMSE) {
        mseProbeCalled = true;
      }
      return undefined;
    }
  });
  await bootstrap(h, true, true, true, true);
  const operation = h.api.handle({ action: 'analyze', tabId: 1, url: 'https://example.com/video' });
  await tick();
  // Direct inspect fails, then source inspect is attempted
  h.callbacks.message({ id: h.sent.at(-1).id, ok: false, error: 'Unsupported URL' });
  await tick();
  assert.equal(h.sent.at(-1).url, streamUrl);
  h.respond(h.sent.at(-1), { token: 'fast-path-success', options: [] });
  const media = await operation;
  assert.equal(media.token, 'fast-path-success');
  assert.equal(mseProbeCalled, false);
});

test('graceful MSE fallback: when standard network stream fails and page has blob player, MSE fallback captures stream', async () => {
  let mseProbeCalled = false;
  const h = harness([], {
    page: { hasBlob: true, sources: [] },
    executeScript: async script => {
      if (script.func.name === 'browserFrameFile' && script.args?.[0] === 'probe' && script.args?.[1]?.allowMSE) {
        mseProbeCalled = true;
        return [{
          frameId: 0,
          result: {
            catalogId: 'mse-cat-1',
            variants: [{ ext: 'mp4', bytes: 5000000, height: 1080, label: 'MSE Stream · Browser', isMSE: true }],
            title: 'Blob Streamed Course',
            duration: 300
          }
        }];
      }
      return undefined;
    }
  });
  await bootstrap(h, true, true, true, true);
  const operation = h.api.handle({ action: 'analyze', tabId: 1, url: 'https://example.com/video' });
  await tick();
  // Direct inspect fails
  h.callbacks.message({ id: h.sent.at(-1).id, ok: false, error: 'Unsupported URL' });
  await tick();
  assert.equal(mseProbeCalled, true);
  // Companion receives prepareBrowser
  assert.equal(h.sent.at(-1).action, 'prepareBrowser');
  assert.equal(h.sent.at(-1).metadata.catalogId, 'mse-cat-1');
  h.respond(h.sent.at(-1), {
    token: 'mse-token',
    browser: true,
    options: [{ id: 'opt-1', label: '1080p · MP4 · Browser' }]
  });
  const media = await operation;
  assert.equal(media.token, 'mse-token');
});

test('browserFrameFile hooks MSE SourceBuffer, probes recorded chunks, and streams them via read', async () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'extension', 'browser-transfer.js'), 'utf8');
  class MockSourceBuffer {
    appendBuffer(chunk) {
      this.lastChunk = chunk;
    }
  }
  class MockMediaSource {
    addSourceBuffer(type) {
      const sb = new MockSourceBuffer();
      sb.type = type;
      return sb;
    }
  }
  const dom = {
    document: {
      title: 'Protected MSE Course Lesson',
      querySelectorAll: sel => sel === 'video' ? [{
        currentSrc: 'blob:https://example.com/mse-blob-uuid',
        videoHeight: 1080,
        duration: 120,
        querySelectorAll: () => []
      }] : []
    },
    location: { href: 'https://example.com/watch' },
    URL,
    crypto,
    AbortController,
    btoa: str => Buffer.from(str, 'binary').toString('base64'),
    setTimeout,
    clearTimeout,
    MediaSource: MockMediaSource,
    SourceBuffer: MockSourceBuffer,
  };
  dom.window = dom;
  const context = vm.createContext(dom);
  vm.runInContext(code, context);

  // 1. Enable MSE capture
  const enableRes = await vm.runInContext('browserFrameFile("enableMSE", {})', context);
  assert.equal(enableRes.enabled, true);

  // 2. Simulate video player appending fMP4 chunks
  const ftypHeader = Buffer.from('000000206674797069736f6d', 'hex');
  const mediaChunk = Buffer.concat([ftypHeader, Buffer.alloc(100, 7)]);
  const appendCode = `
    const sb = new window.SourceBuffer();
    sb.appendBuffer(new Uint8Array(${JSON.stringify(Array.from(mediaChunk))}));
  `;
  vm.runInContext(appendCode, context);

  // 3. Probe with allowMSE: true
  const probeRes = await vm.runInContext('browserFrameFile("probe", { key: "test-probe-key", allowMSE: true })', context);
  assert.equal(probeRes.ext, 'mp4');
  assert.equal(probeRes.bytes, mediaChunk.length);
  assert.equal(probeRes.height, 1080);
  assert.equal(probeRes.variants[0].isMSE, true);
  assert.equal(probeRes.title, 'Protected MSE Course Lesson');

  // 4. Read the buffered chunks
  const readRes = await vm.runInContext(`
    browserFrameFile("read", {
      key: "test-probe-key",
      url: "blob:https://example.com/mse-blob-uuid",
      total: ${mediaChunk.length},
      catalogId: "${probeRes.catalogId}",
      variantIndex: 0
    })
  `, context);
  assert.equal(readRes.done, true);
  const reconstructed = Buffer.from(readRes.chunks[0], 'base64');
  assert.deepEqual(reconstructed, mediaChunk);
});

test('automatic background media sniffer updates badge and pre-arms analysis', async () => {
  const h = harness([], { full: true });
  await bootstrap(h);

  const network = { requestId: 'net-bg-1', tabId: 3, frameId: 0, method: 'GET', url: 'https://cdn.example.test/stream/master.m3u8' };
  h.callbacks.onBeforeRequest(network);
  h.callbacks.onBeforeSendHeaders({ ...network, requestHeaders: [{ name: 'Referer', value: 'https://example.com/video' }, { name: 'User-Agent', value: 'Test UA' }] });
  h.callbacks.onResponseStarted({ ...network, statusCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/vnd.apple.mpegurl' }] });
  await tick();

  assert.equal(h.badges[3], '1');
  assert.equal(h.badgeColors[3], '#2563eb');

  const operation = h.api.handle({ action: 'analyze', tabId: 3, url: 'https://example.com/video' });
  await tick();
  h.callbacks.message({ id: h.sent.at(-1).id, ok: false, error: 'Unsupported URL' });
  await tick();
  assert.equal(h.sent.at(-1).url, network.url);
  h.respond(h.sent.at(-1), { token: 'auto-sniffed-token', options: [] });
  const media = await operation;
  assert.equal(media.token, 'auto-sniffed-token');

  h.callbacks.tabUpdated(3, { url: 'https://other-site.test/' });
  assert.equal(h.badges[3], '');
});
