'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const code = fs.readFileSync(path.join(__dirname, '../extension/browser-transfer.js'), 'utf8');
const bytes = Buffer.alloc(700000, 37);
Buffer.from('000000206674797069736f6d', 'hex').copy(bytes);

function fixture(mode) {
  const calls = [];
  const url = 'https://media.test/video.mp4?signature=keep';
  const video = { currentSrc: url, getAttribute: () => url, querySelectorAll: () => [], closest: () => null, videoHeight: 720 };
  const context = vm.createContext({
    window: {}, document: { title: 'Range fixture', querySelectorAll: () => [video] }, location: { href: 'https://page.test/' },
    URL, crypto, AbortController, setTimeout, clearTimeout, btoa,
    fetch: async (handle, options) => {
      const range = options.headers?.Range; calls.push(range || 'full');
      let start = 0, end = bytes.length - 1, status = 200;
      if (mode === 'fixed') { end = 1023; status = 206; }
      else if (range) { const match = range.match(/bytes=(\d+)-(\d*)/); start = +match[1]; end = match[2] ? +match[2] : end; status = 206; }
      const body = bytes.subarray(start, end + 1);
      const headers = { 'Content-Length': String(body.length), 'Content-Type': 'video/mp4' };
      if (status === 206 && mode !== 'hidden') headers['Content-Range'] = `bytes ${start}-${end}/${bytes.length}`;
      return new Response(body, { status, headers });
    },
  });
  vm.runInContext(code, context);
  const call = (action, extra = {}) => context.browserFrameFile(action, { key: 'fixture', url, videoIndex: 0, ...extra });
  return { calls, call, context };
}

async function download(h, probe) {
  const chunks = [];
  for (let i = 0; i < 10; i++) {
    const part = await h.call('read', { total: probe.bytes, catalogId: probe.catalogId, variantIndex: 0 });
    assert.equal(part.error, undefined);
    chunks.push(...part.chunks.map(value => Buffer.from(value, 'base64')));
    if (part.done) return Buffer.concat(chunks);
  }
  assert.fail('Transfer did not finish');
}

test('browser ranges verify another offset and transfer the entire file byte-for-byte', async () => {
  const h = fixture('ranges');
  const probe = await h.call('probe');
  assert.equal(probe.error, undefined); assert.equal(probe.bytes, bytes.length);
  assert.deepEqual(h.calls, ['bytes=0-1023', 'bytes=699999-699999']);
  assert.deepEqual(await download(h, probe), bytes);
});

test('hidden Content-Range never makes slice Content-Length the file size; full fetch recovers', async () => {
  const h = fixture('hidden');
  const probe = await h.call('probe');
  assert.equal(probe.error, undefined); assert.equal(probe.bytes, bytes.length);
  assert.deepEqual(h.calls, ['bytes=0-1023', 'full']);
  assert.deepEqual(await download(h, probe), bytes);
  assert.equal(h.calls.at(-1), 'full');
});

test('a fixed video fragment is rejected during preparation, before it can become a ready quality', async () => {
  const h = fixture('fixed');
  const probe = await h.call('probe');
  assert.match(probe.error, /No readable MP4\/WebM/);
  assert.equal(probe.variants, undefined);
  assert.deepEqual(h.calls, ['bytes=0-1023', 'bytes=699999-699999', 'full']);
});

test('a blob player can probe the actual network file instead of fetching its blob URL', async () => {
  const h = fixture('ranges');
  h.context.document.querySelectorAll()[0].currentSrc = 'blob:https://page.test/id';
  const probe = await h.call('probe');
  assert.equal(probe.bytes, bytes.length);
  assert.deepEqual(await download(h, probe), bytes);
});
