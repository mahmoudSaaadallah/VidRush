'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function installExtension(sourceRoot, destination, downloadDir) {
  const source = path.join(sourceRoot, 'extension');
  const extensionPath = path.join(destination, 'extension');
  if (path.resolve(source).toLowerCase() !== path.resolve(extensionPath).toLowerCase()) {
    fs.cpSync(source, extensionPath, { recursive: true });
  }
  const template = fs.readFileSync(path.join(sourceRoot, 'scripts', 'setup-guide.html'), 'utf8');
  const html = template.replaceAll('{{EXTENSION_PATH}}', escapeHtml(extensionPath))
    .replaceAll('{{DOWNLOAD_PATH}}', escapeHtml(downloadDir));
  const guidePath = path.join(destination, 'setup-guide.html');
  fs.writeFileSync(guidePath, html);
  return { extensionPath, guidePath };
}

function findChrome(env = process.env, exists = fs.existsSync) {
  return [env.PROGRAMFILES, env['ProgramFiles(x86)'], env.LOCALAPPDATA]
    .filter(Boolean).map(base => path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    .find(exists);
}

function openGuide(guidePath, chromePath = findChrome(), launch = spawn) {
  const url = pathToFileURL(guidePath).href;
  const options = { detached: true, windowsHide: true, stdio: 'ignore', shell: false };
  let child;
  if (chromePath) child = launch(chromePath, ['chrome://extensions/', url], options);
  else child = launch('explorer.exe', [guidePath], options);
  child.on('error', error => console.error(`Could not open the setup guide automatically: ${error.message}\nOpen it manually: ${guidePath}`));
  child.unref();
}

function assertCompanionStopped(destination) {
  // Do not overwrite executables or extension files while a native host is using them.
  // Merely opening Chrome does not block first-time setup.
  const { execFileSync } = require('node:child_process');
  const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$found = $false; foreach ($p in [Diagnostics.Process]::GetProcessesByName('node')) { try { if ($p.MainModule.FileName -eq $env:VIDRUSH_RUNTIME) { $found = $true } } catch {} }; [Console]::Write($found)"],
  { encoding: 'utf8', windowsHide: true, env: { ...process.env, VIDRUSH_RUNTIME: path.join(destination, 'runtime', 'node.exe') } }).trim();
  if (result === 'True') throw new Error('Close Chrome to stop the existing VidRush companion, then run Install.cmd again. Your browser will not be closed automatically.');
}

module.exports = { escapeHtml, installExtension, findChrome, openGuide, assertCompanionStopped };
