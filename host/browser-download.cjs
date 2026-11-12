'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { safeError } = require('./media.cjs');

function browserMedia(value) {
  const variants = value?.variants || [value];
  if (!Array.isArray(variants) || !variants.length || variants.length > 16) throw new Error('Invalid browser video qualities.');
  const options = variants.map(variant => {
    if (!variant || !['mp4', 'webm'].includes(variant.ext) || !Number.isSafeInteger(variant.bytes) || variant.bytes <= 0 || variant.bytes > 2 ** 41) throw new Error('Invalid browser video metadata.');
    const height = Number.isInteger(variant.height) && variant.height > 0 && variant.height <= 16384 ? variant.height : 0;
    const label = typeof variant.label === 'string' ? variant.label.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 60) : '';
    return { id: randomUUID(), height, fps: 0, container: variant.ext, bytes: variant.bytes, label: `${label || (height ? height + 'p' : 'Original')} · ${variant.ext.toUpperCase()} · Browser`, selector: 'browser', needsMerge: false };
  });
  return { token: randomUUID(), browser: true, title: String(value.title || 'Video').slice(0, 300), duration: Number.isFinite(value.duration) && value.duration > 0 ? value.duration : null, site: 'Browser video',
    options };
}

class BrowserDownload {
  constructor(job, choice, update) {
    this.job = job; this.update = update; this.bytes = 0; this.total = choice.bytes; this.ext = choice.container; this.lastProgress = 0;
    const title = job.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[ .]+$/g, '').slice(0, 100) || 'Video';
    this.filename = `VidRush - ${title} [${job.id}].${this.ext}`;
    this.file = path.join(job.downloadDir, this.filename); this.partial = this.file + '.part';
    this.stream = fs.createWriteStream(this.partial, { flags: 'wx' });
    this.stream.on('error', error => this.fail(error.message));
  }
  async chunk(offset, encoded) {
    if (this.job.status !== 'downloading') throw new Error('Browser download is no longer active.');
    if (this.writing) throw new Error('A browser chunk is already being written.');
    if (offset !== this.bytes || typeof encoded !== 'string' || encoded.length > 87384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Invalid browser download chunk.');
    const data = Buffer.from(encoded, 'base64');
    if (!data.length || data.length > 65536 || data.toString('base64') !== encoded || this.bytes + data.length > this.total) throw new Error('Invalid browser download size.');
    if (this.bytes === 0 && (this.ext === 'mp4' ? data.subarray(4, 8).toString() !== 'ftyp' : data.subarray(0, 4).toString('hex') !== '1a45dfa3')) throw new Error('The browser response is not a supported video file.');
    this.writing = true;
    try { await new Promise((resolve, reject) => this.stream.write(data, error => error ? reject(error) : resolve())); }
    finally { this.writing = false; }
    if (this.job.status !== 'downloading') throw new Error('Browser download was cancelled.');
    this.bytes += data.length;
    this.job.percent = Math.min(99, Math.floor(this.bytes / this.total * 100));
    if (Date.now() - this.lastProgress > 250) { this.lastProgress = Date.now(); this.update(this.job); }
    return { received: this.bytes };
  }
  async finish() {
    if (this.job.status !== 'downloading' || this.bytes !== this.total) throw new Error('Browser download ended before all video bytes arrived.');
    await new Promise((resolve, reject) => this.stream.end(error => error ? reject(error) : resolve()));
    if (this.job.status !== 'downloading') throw new Error('Browser download was cancelled.');
    fs.renameSync(this.partial, this.file);
    Object.assign(this.job, { status: 'completed', percent: 100, filename: this.filename }); this.update(this.job);
    return { completed: true };
  }
  cancel() { this.stream.destroy(); }
  fail(message) {
    this.cancel();
    if (this.job.status !== 'downloading') return;
    Object.assign(this.job, { status: 'failed', error: safeError(message).slice(-2000) }); this.update(this.job);
  }
}

module.exports = { browserMedia, BrowserDownload };
