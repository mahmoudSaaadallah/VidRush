'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { extensionId } = require('../scripts/install.cjs');

test('offline code update preserves configuration and binaries and installs folder scripts', { skip: process.platform !== 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vidrush-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installRoot = path.join(root, 'VidRush'); fs.mkdirSync(installRoot);
  const config = JSON.stringify({ extensionId: extensionId(require('../extension/manifest.json').key), downloadDir: 'D:\\فيديوهاتي' });
  fs.writeFileSync(path.join(installRoot, 'config.json'), config);
  fs.mkdirSync(path.join(installRoot, 'bin')); fs.writeFileSync(path.join(installRoot, 'bin', 'keep.txt'), 'existing tools');
  fs.mkdirSync(path.join(installRoot, 'host')); fs.writeFileSync(path.join(installRoot, 'host', 'companion.cjs'), 'old code');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', 'scripts', 'update.ps1'), '-NoOpen'];
  const result = execFileSync('powershell.exe', args, { env: { ...process.env, LOCALAPPDATA: root }, encoding: 'utf8', windowsHide: true });
  assert.match(result, /successfully/);
  assert.equal(fs.readFileSync(path.join(installRoot, 'config.json'), 'utf8'), config);
  assert.equal(fs.readFileSync(path.join(installRoot, 'bin', 'keep.txt'), 'utf8'), 'existing tools');
  assert.ok(fs.existsSync(path.join(installRoot, 'host', 'select-folder.ps1')));
  assert.ok(fs.existsSync(path.join(installRoot, 'host', 'open-folder.cjs')));
  assert.ok(fs.existsSync(path.join(installRoot, 'extension', 'popup.js')));
  assert.ok(fs.existsSync(path.join(installRoot, 'extension', 'theme-init.js')));
  assert.ok(fs.existsSync(path.join(installRoot, 'extension', 'icons', 'logo.svg')));
});
