'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { browserMedia, BrowserDownload } = require('../host/browser-download.cjs');

function fixture(t, bytes = Buffer.concat([Buffer.from('000000206674797069736f6d', 'hex'), Buffer.alloc(100)])) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vidrush-bytes-'));
  const media = browserMedia({ ext: 'mp4', bytes: bytes.length, height: 720, title: '../CON:video', duration: 2 });
  const job = { id: 'unique-id', title: media.title, status: 'downloading', downloadDir: root };
  const transfer = new BrowserDownload(job, media, () => {});
  t.after(async () => {
    transfer.cancel();
    if (!transfer.stream.closed) await new Promise(resolve => transfer.stream.once('close', resolve));
    const relative = path.relative(os.tmpdir(), root);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, media, job, transfer, bytes };
}

test('browser transport writes exact bytes with offset acknowledgements into a safe, unique destination', async t => {
  const h = fixture(t);
  assert.equal((await h.transfer.chunk(0, h.bytes.toString('base64'))).received, h.bytes.length);
  await h.transfer.finish();
  assert.equal(h.job.status, 'completed'); assert.equal(h.job.percent, 100);
  assert.deepEqual(fs.readFileSync(path.join(h.root, h.job.filename)), h.bytes);
  assert.equal(path.dirname(h.transfer.file), h.root); assert.equal(fs.existsSync(h.transfer.partial), false);
});

test('browser transport rejects bad metadata, file signatures, offsets, truncation and oversized chunks', async t => {
  assert.throws(() => browserMedia({ ext: 'exe', bytes: 3 }), /Invalid/);
  assert.throws(() => browserMedia({ ext: 'mp4', bytes: -1 }), /Invalid/);
  const h = fixture(t);
  await assert.rejects(h.transfer.chunk(10, h.bytes.toString('base64')), /Invalid/);
  await assert.rejects(h.transfer.chunk(0, Buffer.alloc(20).toString('base64')), /not a supported video/);
  await assert.rejects(h.transfer.chunk(0, 'a'.repeat(90000)), /Invalid/);
  await h.transfer.chunk(0, h.bytes.subarray(0, 16).toString('base64'));
  await assert.rejects(h.transfer.finish(), /before all/);
  assert.equal(fs.existsSync(h.transfer.file), false);
  h.job.status = 'cancelled'; h.transfer.cancel();
  await assert.rejects(h.transfer.chunk(16, h.bytes.subarray(16).toString('base64')), /no longer active/);
  assert.equal(h.job.status, 'cancelled');
});
