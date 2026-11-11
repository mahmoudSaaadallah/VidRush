'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function harness(initialJobs = []) {
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
  };
  const context = vm.createContext({ chrome, setTimeout, clearTimeout, console });
  vm.runInContext(`${fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8')}\nglobalThis.api = { handle };`, context);
  const respond = (message, data) => callbacks.message({ id: message.id, ok: true, data });
  return { api: context.api, sent, stored, callbacks, respond };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

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
