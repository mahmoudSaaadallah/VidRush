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
const videoTrack = { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 };
const audioTrack = { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '44100' };
function probeResult(call, streams) {
  assert.match(call.executable, /ffprobe(?:\.exe)?$/);
  call.child.stdout.write(JSON.stringify({ streams }));
  call.child.exitCode = 0;
  call.child.emit('close', 0);
}

test('a single embedded video keeps its referrer for download without exposing private source URLs', async t => {
  const h = harness(); t.after(h.cleanup);
  const url = 'https://cdn.test/master.m3u8?token=secret';
  const referer = 'https://player.hotmart.com/';
  const inspect = h.companion.handle({ id: 'inspect', action: 'inspect', url, referer, userAgent: 'Browser UA', origin: 'https://player.hotmart.com', title: 'Lesson title' });
  assert.equal(h.calls[0].args[h.calls[0].args.indexOf('--referer') + 1], referer);
  h.calls[0].child.stdout.write(JSON.stringify({ _type: 'playlist', entries: [{ title: 'master', formats: [{ format_id: '1', url, ext: 'mp4', height: 720 }] }] }));
  h.calls[0].child.emit('close', 0); await inspect;
  const media = h.events.at(-1).data;
  assert.equal(media.title, 'Lesson title');
  assert.equal(media.url, undefined); assert.equal(media.referer, undefined);
  await h.companion.handle({ id: 'download', action: 'download', token: media.token, choice: media.options[0].id, referer: 'https://untrusted.test/' });
  const download = h.calls.at(-1);
  assert.equal(download.args[download.args.indexOf('--referer') + 1], referer);
  assert.equal(download.args[download.args.indexOf('--user-agent') + 1], 'Browser UA');
  assert.equal(download.args[download.args.indexOf('--add-header') + 1], 'Origin:https://player.hotmart.com');
  assert.equal(download.args.at(-1), url);
  assert.equal(JSON.stringify(h.events).includes('token=secret'), false);
  download.child.stderr.write('HTTP 403: ' + url); download.child.emit('close', 1); await tick();
  assert.match(h.events.at(-1).job.error, /redacted/);
  assert.equal(h.events.at(-1).job.error.includes('token=secret'), false);
});

test('invalid referrers are rejected and real multi-video playlists remain unsupported', async t => {
  const h = harness(); t.after(h.cleanup);
  await h.companion.handle({ id: 'bad', action: 'inspect', url: 'https://cdn.test/video.mp4', referer: 'https://example.test/\r\nCookie: injected' });
  assert.equal(h.calls.length, 0);
  const operation = h.companion.handle({ id: 'playlist', action: 'inspect', url: 'https://example.test/course' });
  h.calls[0].child.stdout.write(JSON.stringify({ _type: 'playlist', entries: [{ formats: [] }, { formats: [] }] }));
  h.calls[0].child.emit('close', 0); await operation;
  assert.equal(h.events.at(-1).ok, false);
  assert.match(h.events.at(-1).error, /individual video/);
});

function harness(options = {}) {
  const events = [], calls = [];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vidrush-test-'));
  const config = { ytdlpPath: 'yt-dlp.exe', downloadDir: directory, ffmpegPath: directory };
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  const companion = new Companion(config, message => {
    JSON.stringify(message); // Real protocol serialization must succeed even while a process is attached.
    events.push(message);
  }, (executable, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.pid = 123; child.exitCode = null;
    child.kill = () => { child.exitCode = 1; child.emit('close', 1); };
    child.unref = () => {};
    calls.push({ executable, args, options, child });
    if (executable === 'explorer.exe') setImmediate(() => child.emit('spawn'));
    return child;
  }, { configPath, ...options });
  return { companion, events, calls, directory, configPath, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
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
  child.stdout.write(`VIDRUSH_FILE:${JSON.stringify(path.join(h.directory, 'complete.mp4'))}\n`);
  child.exitCode = 0; child.emit('close', 0);
  await tick(); probeResult(h.calls[1], [videoTrack, audioTrack]);
  await tick();
  assert.equal(h.events.at(-1).job.status, 'completed');
  assert.equal(h.events.at(-1).job.percent, 100);
});

test('a successful yt-dlp exit with a silent video is not marked completed', async t => {
  const h = harness(); t.after(h.cleanup);
  const job = { id: 'job', title: 'Silent', status: 'downloading' };
  h.companion.startJob(job, 'https://test.test/video', { selector: 'mp4' });
  const { child } = h.calls[0];
  child.stdout.write(`VIDRUSH_FILE:${JSON.stringify(path.join(h.directory, 'silent.mp4'))}\n`);
  child.exitCode = 0; child.emit('close', 0);
  await tick(); probeResult(h.calls[1], [videoTrack]);
  await tick();
  assert.equal(h.events.at(-1).job.status, 'failed');
  assert.match(h.events.at(-1).job.error, /both a video track and an audio track/);
});

test('the companion rejects an audio-only MP4 even when yt-dlp does not know its codecs', async t => {
  const h = harness(); t.after(h.cleanup);
  const url = 'https://cdn.test/rendition?token=private';
  const inspect = h.companion.handle({ id: 'inspect', action: 'inspect', url, referer: 'https://player.test/' });
  h.calls[0].child.stdout.write(JSON.stringify({ formats: [{ format_id: '0', url, ext: 'mp4', protocol: 'https', vcodec: null }] }));
  h.calls[0].child.emit('close', 0);
  await tick();
  assert.equal(h.calls[1].args[h.calls[1].args.indexOf('-referer') + 1], 'https://player.test/');
  probeResult(h.calls[1], [audioTrack, { ...videoTrack, disposition: { attached_pic: 1 } }]);
  await inspect;
  assert.equal(h.events.at(-1).code, 'MISSING_MEDIA_TRACKS');
  assert.equal(h.companion.media.size, 0);
});

test('cached media availability never starts yt-dlp or discloses source details', async t => {
  const h = harness(); t.after(h.cleanup);
  h.companion.media.set('cached', { url: 'https://private.test/video?secret=token', referer: 'https://private.test/', context: { userAgent: 'Private UA' } });
  await h.companion.handle({ id: '1', action: 'cachedMedia', token: 'cached' });
  assert.deepEqual(h.events.at(-1).data, { available: true });
  h.companion.media.clear();
  await h.companion.handle({ id: '2', action: 'cachedMedia', token: 'cached' });
  assert.deepEqual(h.events.at(-1).data, { available: false });
  assert.equal(h.calls.length, 0); assert.equal(JSON.stringify(h.events).includes('secret'), false);
});

test('reopening popups reuses the yt-dlp version while ping still returns current settings', async t => {
  const h = harness(); t.after(h.cleanup);
  const first = h.companion.handle({ id: '1', action: 'ping' });
  const second = h.companion.handle({ id: '2', action: 'ping' });
  assert.equal(h.calls.length, 1);
  h.calls[0].child.stdout.write('test-version\n'); h.calls[0].child.emit('close', 0);
  await Promise.all([first, second]);
  h.companion.choosingFolder = true;
  await h.companion.handle({ id: '3', action: 'ping' });
  assert.equal(h.calls.length, 1);
  assert.equal(h.events.at(-1).data.version, 'test-version');
  assert.equal(h.events.at(-1).data.choosingFolder, true);
  assert.equal(h.events.at(-1).data.capabilities.analysisCache, true);
});

test('a failed version lookup is retried on the next connection attempt', async t => {
  const h = harness(); t.after(h.cleanup);
  const first = h.companion.handle({ id: '1', action: 'ping' });
  h.calls[0].child.emit('close', 1); await first;
  assert.equal(h.events.at(-1).ok, false);
  const second = h.companion.handle({ id: '2', action: 'ping' });
  assert.equal(h.calls.length, 2);
  h.calls[1].child.stdout.write('recovered\n'); h.calls[1].child.emit('close', 0); await second;
  assert.equal(h.events.at(-1).data.version, 'recovered');
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

test('changing the default folder persists it while active jobs keep their original destination', async t => {
  let selected;
  const h = harness({ selectFolder: async () => selected }); t.after(h.cleanup);
  const oldDirectory = h.directory;
  selected = path.join(h.directory, 'new مجلد'); fs.mkdirSync(selected);
  const media = buildMedia({ title: 'Test', formats: [{ format_id: 'test', url: 'https://test.test/v', height: 720, ext: 'mp4', vcodec: 'avc1', acodec: 'aac' }] }, true);
  h.companion.media.set(media.token, { ...media, url: 'https://test.test/v' });
  await h.companion.handle({ id: '1', action: 'download', token: media.token, choice: media.options[0].id, downloadDir: 'untrusted-override' });
  const first = h.events.find(event => event.id === '1').data;
  await h.companion.handle({ id: '2', action: 'chooseFolder', downloadDir: 'untrusted-override' });
  assert.equal(h.events.at(-1).data.downloadDir, selected);
  assert.equal(JSON.parse(fs.readFileSync(h.configPath, 'utf8')).downloadDir, selected);
  const process = h.calls[0].child;
  process.stdout.write(`VIDRUSH_FILE:${JSON.stringify(path.join(oldDirectory, 'video.mp4'))}\n`);
  process.emit('close', 0); await tick();
  probeResult(h.calls[1], [videoTrack, audioTrack]); await tick();
  assert.equal(h.events.at(-1).job.filename, 'video.mp4');
  assert.equal(h.events.at(-1).job.downloadDir, oldDirectory);
  await h.companion.handle({ id: '3', action: 'download', token: media.token, choice: media.options[0].id });
  assert.equal(h.calls[2].args[h.calls[2].args.indexOf('--paths') + 1], selected);
  await h.companion.handle({ id: '4', action: 'openFolder', jobId: first.id });
  assert.deepEqual(h.calls[3].args, [oldDirectory]);
});

test('folder cancellation and errors preserve the configured destination', async t => {
  let selected = null;
  const h = harness({ selectFolder: async () => selected }); t.after(h.cleanup);
  const before = fs.readFileSync(h.configPath, 'utf8');
  await h.companion.handle({ id: '1', action: 'chooseFolder' });
  assert.equal(h.events.at(-1).data.cancelled, true);
  selected = path.join(h.directory, 'missing');
  await h.companion.handle({ id: '2', action: 'chooseFolder' });
  assert.equal(h.events.at(-1).ok, false);
  assert.equal(h.companion.config.downloadDir, h.directory);
  assert.equal(fs.readFileSync(h.configPath, 'utf8'), before);
  assert.equal(h.companion.choosingFolder, false);
});

test('a second folder picker is rejected while the first remains open', async t => {
  let finish;
  const h = harness({ selectFolder: () => new Promise(resolve => { finish = resolve; }) }); t.after(h.cleanup);
  const first = h.companion.handle({ id: '1', action: 'chooseFolder' });
  await h.companion.handle({ id: '2', action: 'chooseFolder' });
  assert.equal(h.events.at(-1).ok, false);
  assert.match(h.events.at(-1).error, /already open/);
  finish(null); await first;
  assert.equal(h.events.at(-1).data.cancelled, true);
});

test('completed session folders still open after the companion loses its in-memory job map', async t => {
  const h = harness(); t.after(h.cleanup);
  await h.companion.handle({ id: 'old', action: 'openFolder', jobId: 'previous-session', knownDownloadDir: h.directory });
  assert.equal(h.events.at(-1).ok, true);
  assert.deepEqual(h.calls[0].args, [h.directory]);
  await h.companion.handle({ id: 'invalid', action: 'openFolder', jobId: 'previous-session', knownDownloadDir: 'relative/path' });
  assert.equal(h.events.at(-1).ok, false);
});

test('separate video and audio streams are paired, merged, and downloaded via info json', async t => {
  const h = harness(); t.after(h.cleanup);
  const videoUrl = 'https://cdn.test/video.m3u8';
  const audioUrl = 'https://cdn.test/audio.m3u8';
  const inspect = h.companion.handle({
    id: 'inspect-pair', action: 'inspect', url: videoUrl, audioUrl,
    referer: 'https://player.test/', audioReferer: 'https://player.test/audio',
    userAgent: 'Test UA', title: 'Paired Video Title'
  });
  await tick();
  assert.equal(h.calls[0].args.at(-1), videoUrl);
  h.calls[0].child.stdout.write(JSON.stringify({ formats: [{ format_id: '1080', url: videoUrl, ext: 'mp4', height: 1080, fps: 30, vcodec: 'avc1', acodec: 'none' }] }));
  h.calls[0].child.emit('close', 0);
  await tick();
  assert.equal(h.calls[1].args.at(-1), audioUrl);
  assert.equal(h.calls[1].args[h.calls[1].args.indexOf('--referer') + 1], 'https://player.test/audio');
  h.calls[1].child.stdout.write(JSON.stringify({ formats: [{ format_id: 'a1', url: audioUrl, ext: 'm4a', vcodec: 'none', acodec: 'aac', abr: 128 }] }));
  h.calls[1].child.emit('close', 0);
  await inspect;
  const result = h.events.at(-1);
  assert.equal(result.ok, true);
  assert.equal(result.data.title, 'Paired Video Title');
  assert.equal(result.data.options[0].height, 1080);
  assert.equal(result.data.options[0].label, '1080p · MP4');
  assert.equal(h.companion.media.get(result.data.token).options[0].needsMerge, true);

  const mediaToken = result.data.token;
  const choiceId = result.data.options[0].id;
  await h.companion.handle({ id: 'dl-pair', action: 'download', token: mediaToken, choice: choiceId });
  const dlCall = h.calls[2];
  assert.equal(dlCall.args.includes('--load-info-json'), true);
  const infoJsonPath = dlCall.args[dlCall.args.indexOf('--load-info-json') + 1];
  assert.equal(fs.existsSync(infoJsonPath), true);
  const storedJson = JSON.parse(fs.readFileSync(infoJsonPath, 'utf8'));
  assert.equal(storedJson.title, 'Paired Video Title');
  assert.equal(storedJson.formats.length, 2);
  assert.equal(storedJson.formats[0].format_id, 'v-1080');
  assert.equal(storedJson.formats[1].format_id, 'a-a1');

  dlCall.child.stdout.write(`VIDRUSH_FILE:${JSON.stringify(path.join(h.directory, 'paired.mp4'))}\n`);
  dlCall.child.exitCode = 0; dlCall.child.emit('close', 0);
  await tick(); probeResult(h.calls[3], [videoTrack, audioTrack]);
  await tick();
  assert.equal(h.events.at(-1).job.status, 'completed');
  assert.equal(fs.existsSync(infoJsonPath), false);
});
