'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'extension', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath));
if (!manifest.key) {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  manifest.key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}
manifest.icons['32'] = 'icons/32.png';
manifest.action.default_icon['32'] = 'icons/32.png';
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const value of buffer) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}
fs.mkdirSync(path.join(root, 'extension', 'icons'), { recursive: true });
// One geometry drives both the SVG and antialiased Chrome toolbar PNGs.
const mark = [[20,28],[44,28],[64,72],[84,28],[108,28],[77,100],[72,104],[56,104],[51,100]];
const arrow = [[58,48],[70,48],[70,71],[78,71],[64,87],[50,71],[58,71]];
const blue = [37,99,235];
const points = polygon => polygon.map(point => point.join(',')).join(' ');
fs.writeFileSync(path.join(root, 'extension', 'icons', 'logo.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="27" fill="#2563eb"/><polygon points="${points(mark)}" fill="#fff"/><polygon points="${points(arrow)}" fill="#2563eb"/></svg>\n`);
function inside(x, y, polygon) {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) result = !result;
  }
  return result;
}
for (const size of [16, 32, 48, 128]) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sums = [0,0,0];
      let hits = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const px = (x + (sx + .5) / 4) * 128 / size;
        const py = (y + (sy + .5) / 4) * 128 / size;
        const dx = Math.max(27 - px, 0, px - 101), dy = Math.max(27 - py, 0, py - 101);
        if (dx * dx + dy * dy > 27 * 27) continue;
        const color = inside(px, py, mark) && !inside(px, py, arrow) ? [255,255,255] : blue;
        color.forEach((value, i) => { sums[i] += value; }); hits++;
      }
      const color = hits ? [...sums.map(value => Math.round(value / hits)), Math.round(hits / 16 * 255)] : [0,0,0,0];
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      raw.set(color, offset);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  fs.writeFileSync(path.join(root, 'extension', 'icons', `${size}.png`), png);
}
console.log('Generated Rush V SVG and 16/32/48/128px PNGs; preserved the stable extension key.');
