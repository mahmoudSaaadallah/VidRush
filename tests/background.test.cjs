'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function harness(initialJobs = [], options = {}) {
  const sent = [], stored = {}, callbacks = {};
  const port = {
    onMessage: { addListener(fn) { callbacks.message = fn; } },
    onDisconnect: { addListener(fn) { callbacks.disconnect = fn; } },
    postMessage(message) { sent.push(message); },
  };
  const chrome = {
    runtime: {
      id: 'test-extension', getURL: suffix => `chrome-extension://test-extension/${suffix}`,
      connectNative: () => port, onMessage: { addListener(fn) { callbacks.external = fn; } },
    },
    storage: { session: { get: async () => ({ jobs: initialJobs }), set: async data => Object.assign(stored, JSON.parse(JSON.stringify(data))) } },
    tabs: { get: async id => ({ id, url: 'https://example.com/video' }), onRemoved: { addListener() {} } },
    scripting: { executeScript: async () => [{ frameId: 0, result: { pageUrl: 'https://example.com/video', sources: [], playerOrigins: [], ...options.page } }, ...(options.frames || [])] },
  };
  const context = vm.createContext({ chrome, setTimeout, clearTimeout, console,
    importScripts: filename => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'extension', filename), 'utf8'), context) });
  vm.runInContext(`${fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8')}\nglobalThis.api = { handle };`, context);
  const respond = (message, data) => callbacks.message({ id: message.id, ok: true, data });
  return { api: context.api, sent, stored, callbacks, respond, chrome };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

async function bootstrap(h, pageSources = true) {
  const operation = h.api.handle({ action: 'bootstrap' });
  await tick(); h.respond(h.sent.at(-1), { capabilities: { pageSources } });
  await tick(); h.respond(h.sent.at(-1), []);
  await operation;
}

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
