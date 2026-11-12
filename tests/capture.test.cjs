'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CaptureSession, mediaKind } = require('../extension/capture.js');

function harness() {
  let time = 1000;
  const saved = [], changed = [];
  const capture = new CaptureSession({ now: () => time, save: value => saved.push(value), changed: (...args) => changed.push(args) });
  capture.select(1, 'https://lesson.test/video?session=private');
  const request = (overrides = {}) => ({ requestId: 'request', tabId: 1, frameId: 4, documentId: 'frame-document', method: 'GET', type: 'xmlhttprequest', url: 'https://new-cdn.test/play?signature=private', initiator: 'https://new-player.test', ...overrides });
  const respond = (overrides = {}) => capture.response({ ...request(), statusCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/vnd.apple.mpegurl; charset=utf-8' }], ...overrides });
  return { capture, request, respond, saved, changed, advance: amount => { time += amount; } };
}

test('media detection uses response MIME for arbitrary domains and extensionless paths, excluding segments and non-web URLs', () => {
  assert.equal(mediaKind('https://unknown.test/play?id=1', 'application/vnd.apple.mpegurl'), 'hls');
  assert.equal(mediaKind('https://unknown.test/data', 'application/dash+xml'), 'dash');
  assert.equal(mediaKind('https://unknown.test/stream', 'video/mp4'), 'file');
  assert.equal(mediaKind('https://unknown.test/rendition.mp4', 'audio/mp4'), null);
  assert.equal(mediaKind('https://unknown.test/master.m3u8?sig=x'), 'hls');
  for (const url of ['blob:https://a.test/id', 'file:///private', 'https://user:pass@a.test/a.mp4', 'https://a.test/segment.m4s', 'https://a.test/segment.ts']) assert.equal(mediaKind(url, 'video/mp4'), null);
});

test('capture retains only the selected tab and GET media requests with minimal context', () => {
  const h = harness();
  h.capture.before(h.request({ tabId: 2 })); h.respond({ tabId: 2 });
  h.capture.before(h.request({ method: 'POST' })); h.respond();
  assert.equal(h.capture.sources.size, 0);
  h.capture.before(h.request());
  h.capture.headers({ ...h.request(), requestHeaders: [
    { name: 'Referer', value: 'https://new-player.test/' }, { name: 'Origin', value: 'https://new-player.test' }, { name: 'User-Agent', value: 'Browser UA' },
    { name: 'Cookie', value: 'account=secret' }, { name: 'Authorization', value: 'Bearer secret' },
  ] });
  h.respond();
  const [source] = h.capture.read(1, 'https://lesson.test/video?session=private');
  assert.equal(source.kind, 'hls'); assert.equal(source.referer, 'https://new-player.test/'); assert.equal(source.userAgent, 'Browser UA'); assert.equal(source.origin, 'https://new-player.test');
  assert.equal(JSON.stringify(source).includes('secret'), false);
  assert.equal(JSON.stringify(h.saved).includes('private'), false, 'No page/source URL is persisted.');
  assert.equal(h.capture.read(2, 'https://lesson.test/video?session=private').length, 0);
});

test('navigation, frame replacement and switching tabs clear old sources and reject late responses', () => {
  const h = harness(); h.capture.before(h.request());
  h.capture.before(h.request({ requestId: 'navigation', type: 'sub_frame' })); h.respond();
  assert.equal(h.capture.sources.size, 0);
  h.capture.before(h.request({ requestId: 'new' })); h.respond({ requestId: 'new' });
  assert.equal(h.capture.sources.size, 1);
  h.capture.navigate(1, 'https://lesson.test/new'); h.respond({ requestId: 'new' });
  assert.equal(h.capture.sources.size, 0);
  h.capture.before(h.request()); h.respond();
  h.capture.select(2, 'https://other.test/');
  assert.equal(h.capture.sources.size, 0); assert.equal(h.capture.pending.size, 0);
});

test('expiration and stop purge pending context and signed media, and captures are bounded', () => {
  const h = harness();
  for (let i = 0; i < 60; i++) { h.capture.before(h.request({ requestId: String(i), url: 'https://cdn.test/' + i + '.mp4' })); h.respond({ requestId: String(i), url: 'https://cdn.test/' + i + '.mp4' }); }
  assert.equal(h.capture.sources.size, 40);
  for (let i = 0; i < 200; i++) h.capture.before(h.request({ requestId: 'pending' + i }));
  assert.equal(h.capture.pending.size, 128);
  h.advance(10 * 60 * 1000 + 1); assert.equal(h.capture.active(1), false);
  assert.equal(h.capture.sources.size, 0); assert.equal(h.capture.pending.size, 0);
  assert.equal(h.saved.at(-1), null);
});
