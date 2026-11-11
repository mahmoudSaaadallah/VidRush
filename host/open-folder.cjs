'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function openFolder(directory, spawnProcess = spawn) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || !fs.statSync(directory).isDirectory()) {
    return Promise.reject(new Error('The saved folder is unavailable. Check that the drive or folder still exists.'));
  }
  return new Promise((resolve, reject) => {
    const explorer = spawnProcess('explorer.exe', [path.resolve(directory)], {
      detached: true, windowsHide: false, shell: false, stdio: 'ignore',
    });
    const timer = setTimeout(() => reject(new Error('Windows Explorer did not start. Please try again.')), 10000);
    explorer.once('error', error => { clearTimeout(timer); reject(new Error(`Could not open Windows Explorer: ${error.message}`)); });
    explorer.once('spawn', () => { clearTimeout(timer); explorer.unref(); resolve({ opened: true }); });
  });
}

module.exports = { openFolder };
