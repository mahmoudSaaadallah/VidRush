'use strict';

const MAX_MESSAGE = 1024 * 1024;

function encode(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > MAX_MESSAGE) throw new Error('Native message exceeds 1 MiB.');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

function createDecoder(onMessage) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (!length || length > MAX_MESSAGE) throw new Error('Invalid native message length.');
      if (buffer.length < 4 + length) return;
      const value = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
      buffer = buffer.subarray(4 + length);
      onMessage(value);
    }
  };
}

module.exports = { encode, createDecoder };
