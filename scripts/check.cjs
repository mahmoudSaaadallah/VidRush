'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
for (const directory of ['extension', 'host', 'scripts', 'tests']) {
  for (const filename of fs.readdirSync(path.join(root, directory))) {
    if (/\.(cjs|js)$/.test(filename)) execFileSync(process.execPath, ['--check', path.join(root, directory, filename)], { stdio: 'inherit' });
  }
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
if (!manifest.key || manifest.manifest_version !== 3) throw new Error('Missing stable extension key or Manifest V3.');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const validVersion = value => typeof value === 'string' && versionPattern.test(value) && value.split('.').every(part => Number(part) <= 65535) && value !== '0.0.0';
if (!validVersion(manifest.version)) throw new Error('Use a numeric major.minor.patch extension version compatible with Chrome.');
if ([packageJson.version, lock.version, lock.packages?.['']?.version].some(version => version !== manifest.version)) throw new Error('Keep the extension, package.json and package-lock.json versions in sync.');
if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const baseSha = event.pull_request?.base?.sha;
  if (!/^[a-f\d]{40}$/i.test(baseSha || '')) throw new Error('Missing pull request base SHA for the version check.');
  const previous = JSON.parse(execFileSync('git', ['show', baseSha + ':extension/manifest.json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).version;
  if (!validVersion(previous)) throw new Error('The base extension version is invalid.');
  const currentParts = manifest.version.split('.').map(Number), previousParts = previous.split('.').map(Number);
  const firstDifference = currentParts.findIndex((part, index) => part !== previousParts[index]);
  if (firstDifference < 0 || currentParts[firstDifference] < previousParts[firstDifference]) throw new Error('Increment the extension version before delivering this pull request.');
}
for (const icon of Object.values(manifest.icons)) {
  if (!fs.existsSync(path.join(root, 'extension', icon))) throw new Error(`Missing icon: ${icon}`);
}
console.log('JavaScript syntax, extension manifest, version consistency, and icons checked.');
