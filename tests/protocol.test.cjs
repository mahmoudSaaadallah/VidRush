'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encode, createDecoder } = require('../host/protocol.cjs');

test('native protocol preserves Unicode across fragmented and multiple frames', () => {
  const messages = [{ title: 'فيديو عربي 🎬', id: '1' }, { ok: true }];
  const bytes = Buffer.concat(messages.map(encode));
  const decoded = [];
  const push = createDecoder(value => decoded.push(value));
  for (let i = 0; i < bytes.length; i += 3) push(bytes.subarray(i, i + 3));
  assert.deepEqual(decoded, messages);
});

test('native protocol rejects oversized and invalid messages', () => {
  assert.throws(() => encode({ value: 'x'.repeat(1024 * 1024) }), /exceeds/);
  const header = Buffer.alloc(4); header.writeUInt32LE(2 * 1024 * 1024);
  assert.throws(() => createDecoder(() => {})(header), /length/);
  assert.throws(() => createDecoder(() => {})(Buffer.from([1,0,0,0,123])), /JSON/);
});
