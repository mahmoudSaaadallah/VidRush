'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { Companion } = require('../host/companion.cjs');
const { buildMedia } = require('../host/media.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  const events = [], calls = [];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vidrush-test-'));
  const companion = new Companion({ ytdlpPath: 'yt-dlp.exe', downloadDir: directory, ffmpegPath: directory }, message => {
    JSON.stringify(message); // Real protocol serialization must succeed even while a process is attached.
    events.push(message);
  }, (executable, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.pid = 123; child.exitCode = null;
    child.kill = () => { child.exitCode = 1; child.emit('close', 1); };
    child.unref = () => {};
    calls.push({ executable, args, options, child });
    return child;
  });
  return { companion, events, calls, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test('download responds with serializable job and emits progress and completion', async t => {
  const h = harness(); t.after(h.cleanup);
  const media = buildMedia({ title: 'Test', formats: [{ format_id: 'test', url: 'https://test.test/v', height: 720, ext: 'mp4', vcodec: 'avc1', acodec: 'aac' }] }, true);
  h.companion.media.set(media.token, { ...media, url: 'https://test.test/v' });
  await h.companion.handle({ id: '1', action: 'download', token: media.token, choice: media.options[0].id });
  const response = h.events.find(event => event.id === '1');
  assert.equal(response.ok, true);
  assert.equal(response.data.child, undefined);
  assert.equal(h.calls[0].options.shell, false);
  const { child } = h.calls[0];
  child.stdout.write('VIDRUSH_PROGRESS:{"status":"downloading","downloaded_bytes":50,"total_bytes":100,"speed":20}\n');
  await tick();
  assert.equal(h.events.at(-1).job.percent, 50);
  child.stdout.write('VIDRUSH_PROGRESS:{"status":"finished","downloaded_bytes":100,"total_bytes":100}\n');
  await tick();
  assert.equal(h.events.at(-1).job.status, 'processing');
  child.exitCode = 0; child.emit('close', 0);
  await tick();
  assert.equal(h.events.at(-1).job.status, 'completed');
  assert.equal(h.events.at(-1).job.percent, 100);
});

test('invalid requests and expired selections produce errors without starting processes', async t => {
  const h = harness(); t.after(h.cleanup);
  await h.companion.handle({ id: '1', action: 'download', token: 'expired', choice: 'injected' });
  await h.companion.handle({ id: '2', action: 'inspect', url: 'file:///secrets' });
  await h.companion.handle({ id: '3', action: 'exec', command: 'calc' });
  assert.equal(h.calls.length, 0);
  assert.ok(h.events.every(event => event.ok === false));
});

test('failed downloads retain useful yt-dlp error details', async t => {
  const h = harness(); t.after(h.cleanup);
  const job = { id: 'job', title: 'Test', status: 'downloading' };
  h.companion.jobs.set(job.id, job);
  h.companion.startJob(job, 'https://example.com', { selector: '18', needsMerge: false });
  h.calls[0].child.stderr.write('ERROR: Login required');
  h.calls[0].child.emit('close', 1);
  await tick();
  assert.equal(h.events.at(-1).job.status, 'failed');
  assert.match(h.events.at(-1).job.error, /Login required/);
});

test('cancellation cannot later become a completed download', async t => {
  const h = harness(); t.after(h.cleanup);
  const child = { pid: 123, exitCode: null, kill: () => {} };
  const job = { id: 'job', title: 'Test', status: 'downloading', child };
  h.companion.jobs.set(job.id, job);
  await h.companion.handle({ id: '1', action: 'cancel', jobId: 'job' });
  assert.equal(job.status, 'cancelled');
  assert.equal(h.events.at(-1).data.status, 'cancelled');
  assert.equal(h.events.at(-1).data.child, undefined);
});
