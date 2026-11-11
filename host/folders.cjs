'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

function selectFolder(currentDir, { spawnProcess = spawn, onStart = () => {}, onEnd = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess('powershell.exe', ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'select-folder.ps1')], {
      windowsHide: false, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, VIDRUSH_CURRENT_FOLDER: currentDir },
    });
    onStart(child);
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-32768); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-3000); });
    child.on('error', error => { onEnd(child); reject(error); });
    child.on('close', code => {
      onEnd(child);
      if (code !== 0) { reject(new Error(stderr.trim() || 'The Windows folder picker could not open.')); return; }
      try {
        const result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
        if (result.cancelled === true) resolve(null);
        else if (typeof result.path === 'string' && result.path) resolve(result.path);
        else throw new Error('Invalid folder selection.');
      } catch { reject(new Error('The Windows folder picker returned an invalid result.')); }
    });
  });
}

function writableDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new Error('Choose an absolute folder path.');
  const directory = path.resolve(value);
  if (!fs.statSync(directory).isDirectory()) throw new Error('Choose a folder, rather than a file.');
  const probe = path.join(directory, `.vidrush-write-test-${randomUUID()}`);
  const descriptor = fs.openSync(probe, 'wx');
  try { fs.closeSync(descriptor); } finally { fs.unlinkSync(probe); }
  return directory;
}

function saveDownloadDirectory(configPath, config, directory) {
  if (!configPath) throw new Error('Update the companion by running Install.cmd before choosing a folder.');
  const next = { ...config, downloadDir: writableDirectory(directory) };
  const temporary = `${configPath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, configPath);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return next;
}

module.exports = { selectFolder, writableDirectory, saveDownloadDirectory };
