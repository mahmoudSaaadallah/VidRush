'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

function main() {
  if (process.platform !== 'win32') throw new Error('The bootstrap smoke test requires Windows.');
  const root = path.resolve(__dirname, '..');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'vidrush-bootstrap-test-'));
  try {
    // GitHub's Windows image exposes both system curl and Git's curl on PATH.
    // Reproduce that environment locally as well; setup must pick one executable.
    const additionalTools = path.join(fixture, 'additional-tools');
    fs.mkdirSync(additionalTools);
    fs.copyFileSync(path.join(process.env.SystemRoot, 'System32', 'curl.exe'), path.join(additionalTools, 'curl.exe'));
    const environment = { ...process.env, LOCALAPPDATA: path.join(fixture, 'AppData اسم with spaces'), PATH: `${process.env.PATH};${additionalTools}` };
    const command = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'bootstrap.ps1'), '-PrepareOnly', '-ForcePortableRuntime', '-NoOpen'];
    const options = { env: environment, encoding: 'utf8', windowsHide: true, timeout: 900000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
    const output = execFileSync('powershell.exe', command, options);
    const executable = path.join(environment.LOCALAPPDATA, 'VidRush', 'setup-runtime', 'node.exe');
    assert.ok(fs.existsSync(executable), output);
    assert.match(output, /SHA-256 verified/);
    const version = execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
    assert.ok(Number(version.slice(1).split('.')[0]) >= 22);
    const second = execFileSync('powershell.exe', command, { ...options, timeout: 120000 });
    assert.match(second, /verified cached Node.js/);
    const cache = path.join(environment.LOCALAPPDATA, 'VidRush', 'cache');
    fs.writeFileSync(path.join(cache, fs.readdirSync(cache)[0]), 'corrupted download');
    const repaired = execFileSync('powershell.exe', command, options);
    assert.match(repaired, /SHA-256 verified/);
    assert.ok(!repaired.includes('verified cached Node.js'));
    console.log(`Without using system Node.js: downloaded ${version}, verified SHA-256, reused a verified cache, and recovered from a corrupt cache in a Unicode path.`);
  } finally {
    const relative = path.relative(os.tmpdir(), fixture);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) fs.rmSync(fixture, { recursive: true, force: true });
  }
}
try { main(); } catch (error) { console.error(error.stdout?.toString() || error.message); process.exitCode = 1; }
