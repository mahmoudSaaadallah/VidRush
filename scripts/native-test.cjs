'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { encode, createDecoder } = require('../host/protocol.cjs');
const assert = require('node:assert/strict');
const { Companion } = require('../host/companion.cjs');
const root = path.resolve(__dirname, '..');

async function main() {
  if (process.platform !== 'win32') throw new Error('The native integration test currently requires Windows.');
  const installedRoot = path.join(process.env.LOCALAPPDATA, 'VidRush');
  const configPath = path.join(installedRoot, 'config.json');
  if (!fs.existsSync(configPath)) throw new Error('Run Install.cmd before this test.');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'vidrush-native-'));
  let server, child;
  const pending = new Map(), events = [];
  try {
    fs.cpSync(path.join(root, 'host'), path.join(fixture, 'host'), { recursive: true, filter: () => true });
    config.downloadDir = path.join(fixture, 'downloads');
    const testConfig = path.join(fixture, 'config.json');
    fs.writeFileSync(testConfig, JSON.stringify(config));
    const selectedDirectory = path.join(fixture, 'chosen مجلد with spaces');
    fs.mkdirSync(selectedDirectory);
    let selection;
    const chooser = new Companion(config, result => { selection = result; }, undefined, {
      configPath: testConfig, selectFolder: async () => selectedDirectory,
    });
    await chooser.handle({ id: 'selection', action: 'chooseFolder' });
    assert.equal(selection.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(testConfig, 'utf8')).downloadDir, selectedDirectory);
    config.downloadDir = selectedDirectory;
    const video = path.join(fixture, 'sample.mp4');
    execFileSync(path.join(config.ffmpegPath, 'ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', video], { windowsHide: true });
    execFileSync(path.join(config.ffmpegPath, 'ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-i', video,
      '-map', '0:v', '-map', '0:v', '-map', '0:a', '-c:v', 'libx264', '-filter:v:0', 'scale=640:360', '-filter:v:1', 'scale=320:180',
      '-b:v:0', '300k', '-b:v:1', '150k', '-c:a', 'aac', '-f', 'dash', path.join(fixture, 'manifest.mpd')], { windowsHide: true, cwd: fixture });
    const payload = fs.readFileSync(video);
    server = http.createServer((req, res) => {
      const name = req.url.slice(1);
      if (!/^(sample\.mp4|manifest\.mpd|(?:init|chunk)-stream[\w.-]+\.m4s)$/.test(name)) { res.writeHead(404); res.end(); return; }
      if (name !== 'sample.mp4' && (req.headers.referer !== `http://127.0.0.1:${server.address().port}/lesson` || req.headers['user-agent'] !== 'VidRush test browser' || req.headers.origin !== 'https://player.test')) { res.writeHead(403); res.end('Video request context required'); return; }
      const file = path.join(fixture, name);
      if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      const body = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': name.endsWith('.mpd') ? 'application/dash+xml' : 'video/mp4', 'Content-Length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/sample.mp4`;
    const origin = `chrome-extension://${config.extensionId}/`;
    child = spawn(config.nodePath, [path.join(fixture, 'host', 'index.cjs'), origin], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data.toString(); });
    child.stdout.on('data', createDecoder(message => {
      if (message.event) events.push(message);
      else {
        const request = pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer); pending.delete(message.id);
        message.ok ? request.resolve(message.data) : request.reject(new Error(message.error));
      }
    }));
    child.on('exit', code => {
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(`Host exited ${code}: ${stderr}`)); }
      pending.clear();
    });
    let id = 0;
    const request = (action, data = {}) => new Promise((resolve, reject) => {
      const key = String(++id);
      const timer = setTimeout(() => { pending.delete(key); reject(new Error(`Timed out: ${action}`)); }, 100000);
      pending.set(key, { resolve, reject, timer });
      child.stdin.write(encode({ id: key, action, ...data }));
    });
    const ping = await request('ping');
    assert.ok(ping.version);
    assert.equal(ping.downloadDir, selectedDirectory);
    const media = await request('inspect', { url });
    assert.ok(media.options.length);
    const job = await request('download', { token: media.token, choice: media.options[0].id });
    const deadline = Date.now() + 90000;
    let complete;
    while (Date.now() < deadline) {
      complete = events.find(event => event.job?.id === job.id && ['completed', 'failed'].includes(event.job.status));
      if (complete) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(complete?.job.status, 'completed', JSON.stringify(complete || events));
    const files = fs.readdirSync(config.downloadDir).filter(file => file.endsWith('.mp4'));
    assert.equal(files.length, 1);
    assert.deepEqual(fs.readFileSync(path.join(config.downloadDir, files[0])), payload);
    assert.ok(events.some(event => event.job?.percent > 0));
    assert.equal(ping.capabilities.pageSources, true);
    const dash = await request('inspect', { url: `http://127.0.0.1:${server.address().port}/manifest.mpd`, referer: `http://127.0.0.1:${server.address().port}/lesson`, userAgent: 'VidRush test browser', origin: 'https://player.test', title: 'Authorized embedded lesson' });
    assert.equal(dash.title, 'Authorized embedded lesson');
    assert.ok(dash.options.some(option => option.height === 360));
    const lowQuality = dash.options.find(option => option.height === 180);
    assert.ok(lowQuality, 'The lower resolution must be selectable.');
    const mergedJob = await request('download', { token: dash.token, choice: lowQuality.id });
    const mergeDeadline = Date.now() + 90000;
    let merged;
    while (Date.now() < mergeDeadline) {
      merged = events.find(event => event.job?.id === mergedJob.id && ['completed', 'failed'].includes(event.job.status));
      if (merged) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(merged?.job.status, 'completed', JSON.stringify(merged || events));
    const mergedFile = path.join(config.downloadDir, merged.job.filename);
    const probe = JSON.parse(execFileSync(path.join(config.ffmpegPath, 'ffprobe.exe'), ['-v', 'quiet', '-show_streams', '-of', 'json', mergedFile], { encoding: 'utf8', windowsHide: true }));
    assert.equal(probe.streams.find(stream => stream.codec_type === 'video').height, 180);
    assert.ok(probe.streams.some(stream => stream.codec_type === 'audio'));
    assert.equal(ping.capabilities.browserTransfer, true);
    assert.equal(ping.capabilities.browserQualities, true);
    const browser = await request('prepareBrowser', { metadata: { title: 'Browser-streamed original test video', variants: [
      { ext: 'webm', bytes: 16, height: 180, label: '180p' },
      { ext: 'mp4', bytes: payload.length, height: 360, label: '360p' },
    ] } });
    assert.equal(browser.options.length, 2);
    const browserJob = await request('download', { token: browser.token, choice: browser.options[1].id });
    assert.match(browserJob.quality, /^360p/);
    for (let offset = 0; offset < payload.length; offset += 65536) {
      const chunk = payload.subarray(offset, offset + 65536);
      const ack = await request('browserChunk', { jobId: browserJob.id, offset, data: chunk.toString('base64') });
      assert.equal(ack.received, offset + chunk.length);
    }
    await request('browserFinish', { jobId: browserJob.id });
    const completedBrowser = events.find(event => event.job?.id === browserJob.id && event.job.status === 'completed');
    assert.ok(completedBrowser);
    assert.deepEqual(fs.readFileSync(path.join(config.downloadDir, completedBrowser.job.filename)), payload);
    console.log('Framed browser transport saved the second quality with its own size and container, byte-for-byte through the native companion.');
    console.log('Real DASH download required the saved referrer for manifest and segments, selected 180p, and merged separate audio successfully.');
    await assert.rejects(request('inspect', { url: 'file:///C:/private' }), /HTTP|URL/);
    console.log(`Real yt-dlp ${ping.version}: native ping, analysis, quality selection, progress, downloaded bytes, and invalid URL handling passed.`);
    // Ensure a direct invocation from a different extension origin is rejected too.
    const denied = spawn(config.nodePath, [path.join(fixture, 'host', 'index.cjs'), 'chrome-extension://untrusted/'], { windowsHide: true, stdio: 'pipe' });
    let deniedError = '';
    denied.stderr.on('data', data => { deniedError += data.toString(); });
    const deniedExit = await new Promise(resolve => denied.on('exit', resolve));
    assert.equal(deniedExit, 1);
    assert.match(deniedError, /Unauthorized/);
    console.log('Untrusted native caller was rejected.');
    console.log('A selected Unicode folder persisted across companion restart and received the actual downloads.');
  } finally {
    for (const request of pending.values()) clearTimeout(request.timer);
    if (child && child.exitCode === null) {
      child.stdin.end();
      await new Promise(resolve => { child.once('exit', resolve); setTimeout(() => { child.kill(); resolve(); }, 3000).unref(); });
    }
    if (server) await new Promise(resolve => server.close(resolve));
    const relative = path.relative(os.tmpdir(), fixture);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) fs.rmSync(fixture, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
