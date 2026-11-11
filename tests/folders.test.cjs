'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { execFileSync } = require('node:child_process');
const { writableDirectory, saveDownloadDirectory, selectFolder } = require('../host/folders.cjs');
const { openFolder } = require('../host/open-folder.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vidrush-folder-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('folder selection validates writable Unicode directories and leaves no probe files', t => {
  const directory = path.join(fixture(t), 'مقاطع الفيديو with spaces');
  fs.mkdirSync(directory);
  assert.equal(writableDirectory(directory), directory);
  assert.deepEqual(fs.readdirSync(directory), []);
  assert.throws(() => writableDirectory('relative/folder'), /absolute/);
  assert.throws(() => writableDirectory(path.join(directory, 'missing')));
  const file = path.join(directory, 'file.txt'); fs.writeFileSync(file, 'keep');
  assert.throws(() => writableDirectory(file), /folder/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
});

test('folder setting persists atomically and retains other configuration', t => {
  const root = fixture(t), file = path.join(root, 'config.json');
  const config = { extensionId: 'test', ytdlpPath: 'yt-dlp.exe', downloadDir: 'old' };
  fs.writeFileSync(file, JSON.stringify(config));
  const selected = saveDownloadDirectory(file, config, root);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ...config, downloadDir: root });
  assert.equal(selected.extensionId, 'test');
  assert.equal(config.downloadDir, 'old');
});

test('a failed configuration replacement keeps the original setting and cleans the temporary file', t => {
  const root = fixture(t), file = path.join(root, 'config.json');
  const config = { downloadDir: root, extensionId: 'test' };
  const original = JSON.stringify(config); fs.writeFileSync(file, original);
  t.mock.method(fs, 'renameSync', () => { throw new Error('Permission denied'); });
  assert.throws(() => saveDownloadDirectory(file, config, root), /Permission/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(root), ['config.json']);
});

test('Windows picker receives paths through the environment and decodes UTF-8 output', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let call;
  const selected = 'D:\\فيديوهاتي & clips';
  const operation = selectFolder(selected, { spawnProcess: (...args) => { call = args; return child; } });
  assert.equal(call[2].shell, false);
  assert.equal(call[2].windowsHide, false);
  assert.ok(call[1].includes('-WindowStyle'));
  assert.equal(call[2].env.VIDRUSH_CURRENT_FOLDER, selected);
  assert.ok(!call[1].includes(selected));
  assert.ok(call[1].includes('-STA'));
  const output = Buffer.from(JSON.stringify({ cancelled: false, path: selected }));
  for (const value of output) child.stdout.write(Buffer.from([value]));
  child.emit('close', 0);
  assert.equal(await operation, selected);
});

test('cancelling the native picker returns no folder', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const operation = selectFolder('C:\\Videos', { spawnProcess: () => child });
  child.stdout.write('{"cancelled":true}'); child.emit('close', 0);
  assert.equal(await operation, null);
});

test('Windows picker script loads its native dialog type without opening a window', { skip: process.platform !== 'win32' }, () => {
  execFileSync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', 'host', 'select-folder.ps1'), '-Check'], { windowsHide: true, stdio: 'pipe' });
});

test('Explorer requests a visible window and reports successful process launch', async t => {
  const directory = fixture(t);
  const child = new EventEmitter(); child.unref = () => {};
  let call;
  const operation = openFolder(directory, (...args) => { call = args; return child; });
  assert.equal(call[2].windowsHide, false);
  assert.equal(call[2].shell, false);
  assert.deepEqual(call[1], [directory]);
  child.emit('spawn');
  assert.equal((await operation).opened, true);
});

test('Explorer launch errors reach the caller rather than falsely reporting success', async t => {
  const child = new EventEmitter(); child.unref = () => {};
  const operation = openFolder(fixture(t), () => child);
  child.emit('error', new Error('ENOENT'));
  await assert.rejects(operation, /Could not open Windows Explorer/);
});
