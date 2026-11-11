'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { escapeHtml, installExtension, findChrome, openGuide } = require('../scripts/setup.cjs');

test('setup installs a complete extension and a guide with escaped, permanent paths', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'vidrush-setup-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const destination = path.join(fixture, 'User & Arabic اسم');
  const paths = installExtension(path.resolve(__dirname, '..'), destination, 'D:\\Videos & clips');
  const manifest = JSON.parse(fs.readFileSync(path.join(paths.extensionPath, 'manifest.json'), 'utf8'));
  assert.equal(manifest.key, require('../extension/manifest.json').key);
  for (const file of ['popup.html', 'background.js', 'popup.css', 'popup.js', 'icons/128.png']) {
    assert.ok(fs.existsSync(path.join(paths.extensionPath, file)), file);
  }
  const guide = fs.readFileSync(paths.guidePath, 'utf8');
  assert.ok(guide.includes(escapeHtml(paths.extensionPath)));
  assert.ok(guide.includes('D:\\Videos &amp; clips'));
  assert.ok(!guide.includes('{{EXTENSION_PATH}}'));
  assert.equal(escapeHtml('<script>"&\''), '&lt;script&gt;&quot;&amp;&#39;');
});

test('setup finds standard system and per-user Chrome installations', () => {
  const env = { PROGRAMFILES: 'C:\\Programs', LOCALAPPDATA: 'C:\\User data' };
  const perUser = path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe');
  assert.equal(findChrome(env, file => file === perUser), perUser);
  assert.equal(findChrome(env, () => false), undefined);
});

test('setup opens the extensions page and local guide without shell interpolation', () => {
  const calls = [];
  const launch = (...args) => { calls.push(args); const child = new EventEmitter(); child.unref = () => {}; return child; };
  const guide = path.resolve('User & اسم', 'setup-guide.html');
  openGuide(guide, 'chrome.exe', launch);
  assert.deepEqual(calls[0][1], ['chrome://extensions/', pathToFileURL(guide).href]);
  assert.equal(calls[0][2].shell, false);
  openGuide(guide, null, launch);
  assert.deepEqual(calls[1].slice(0, 2), ['explorer.exe', [guide]]);
});
