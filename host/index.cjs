'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { encode, createDecoder } = require('./protocol.cjs');
const { Companion } = require('./companion.cjs');

try {
  const root = path.resolve(__dirname, '..');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  const origin = process.argv[2];
  if (origin !== `chrome-extension://${config.extensionId}/`) throw new Error('Unauthorized extension origin.');
  const companion = new Companion(config, message => process.stdout.write(encode(message)));
  const decode = createDecoder(message => { void companion.handle(message); });
  process.stdin.on('data', chunk => {
    try { decode(chunk); } catch (error) { process.stderr.write(`${error.message}\n`); companion.close(); process.exit(1); }
  });
  process.stdin.on('end', () => { companion.close(); process.exit(0); });
  process.on('SIGTERM', () => { companion.close(); process.exit(0); });
  process.stdout.on('error', () => { companion.close(); process.exit(1); });
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
