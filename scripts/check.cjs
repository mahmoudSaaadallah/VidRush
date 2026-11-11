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
for (const icon of Object.values(manifest.icons)) {
  if (!fs.existsSync(path.join(root, 'extension', icon))) throw new Error(`Missing icon: ${icon}`);
}
console.log('JavaScript syntax, extension manifest, and icons checked.');
