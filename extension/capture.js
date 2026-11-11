'use strict';

const SCAN_ORIGINS = ['http://*/*', 'https://*/*'];

function mediaKind(value, contentType = '') {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.length > 8192) return null;
  const name = url.pathname;
  if (/\.(?:ts|m4s|aac|vtt|srt|jpg|png)$/i.test(name)) return null;
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (/\.m3u8$/i.test(name) || ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl'].includes(type)) return 'hls';
  if (/\.mpd$/i.test(name) || type === 'application/dash+xml') return 'dash';
  if (/\.(?:mp4|webm|mov|m4v)$/i.test(name) || ['video/mp4', 'video/webm', 'video/quicktime'].includes(type)) return 'file';
  return null;
}

class CaptureSession {
  constructor({ now = Date.now, save = () => {}, changed = () => {} } = {}) {
    this.now = now; this.save = save; this.changed = changed;
    this.session = null; this.pending = new Map(); this.sources = new Map(); this.frames = new Map();
  }
  restore(value) {
    if (Number.isInteger(value?.tabId) && value.expiresAt > this.now()) this.session = value;
  }
  persist() { this.save(this.session ? { tabId: this.session.tabId, expiresAt: this.session.expiresAt } : null); }
  active(tabId) {
    if (this.session && this.session.expiresAt <= this.now()) this.stop();
    return this.session?.tabId === tabId;
  }
  select(tabId, url) {
    if (this.active(tabId) && this.session.url === url) return;
    this.stop();
    this.session = { tabId, url, epoch: 0, expiresAt: this.now() + 10 * 60 * 1000 };
    this.persist();
  }
  stop() {
    const tabId = this.session?.tabId;
    this.session = null; this.pending.clear(); this.sources.clear(); this.frames.clear();
    this.save(null);
    if (tabId !== undefined) this.changed(tabId, true);
  }
  navigate(tabId, url) {
    if (!this.active(tabId)) return;
    this.session.url = url; this.session.epoch++;
    this.pending.clear(); this.sources.clear(); this.frames.clear();
    this.persist(); this.changed(tabId, true);
  }
  before(details) {
    if (!this.active(details.tabId)) return;
    if (details.type === 'main_frame') { this.navigate(details.tabId, details.url); return; }
    if (details.type === 'sub_frame') {
      this.frames.set(details.frameId, (this.frames.get(details.frameId) || 0) + 1);
      for (const [key, source] of this.sources) if (source.frameId === details.frameId) this.sources.delete(key);
      this.changed(details.tabId, true);
      return;
    }
    if (details.method !== 'GET') return;
    let source;
    try { source = new URL(details.url); } catch { return; }
    if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password || details.url.length > 8192) return;
    this.pending.set(details.requestId, { url: details.url, frameId: details.frameId, documentId: details.documentId,
      epoch: this.session.epoch, frameEpoch: this.frames.get(details.frameId) || 0, initiator: details.initiator });
    if (this.pending.size > 128) this.pending.delete(this.pending.keys().next().value);
  }
  headers(details) {
    if (!this.active(details.tabId)) return;
    const entry = this.pending.get(details.requestId);
    if (!entry) return;
    entry.headersObserved = true;
    // Never retain cookies, authorization, request bodies, or arbitrary headers.
    for (const header of details.requestHeaders || []) {
      if (typeof header.value !== 'string' || /[\r\n]/.test(header.value)) continue;
      if (header.name.toLowerCase() === 'referer' && /^https?:\/\//i.test(header.value)) entry.referer = header.value.slice(0, 8192);
      if (header.name.toLowerCase() === 'origin' && /^https?:\/\//i.test(header.value)) entry.origin = header.value.slice(0, 512);
      if (header.name.toLowerCase() === 'user-agent') entry.userAgent = header.value.slice(0, 512);
    }
  }
  response(details) {
    if (!this.active(details.tabId) || ![200, 206].includes(details.statusCode)) return;
    const entry = this.pending.get(details.requestId);
    if (!entry || entry.epoch !== this.session.epoch || entry.frameEpoch !== (this.frames.get(entry.frameId) || 0)) return;
    const type = (details.responseHeaders || []).find(header => header.name.toLowerCase() === 'content-type')?.value || '';
    const kind = mediaKind(details.url, type);
    if (!kind) return;
    const { epoch, frameEpoch, initiator, headersObserved, ...source } = entry;
    if (!headersObserved && !source.referer && /^https?:\/\//i.test(initiator || '')) {
      try { source.referer = new URL(initiator).origin + '/'; } catch { /* No trustworthy referrer. */ }
    }
    const key = details.url;
    this.sources.set(key, { ...source, url: key, kind });
    if (this.sources.size > 40) this.sources.delete(this.sources.keys().next().value);
    this.changed(details.tabId, false);
  }
  done(details) { this.pending.delete(details.requestId); }
  read(tabId, url) {
    if (!this.active(tabId) || this.session.url !== url) return [];
    return [...this.sources.values()];
  }
}

if (typeof module !== 'undefined') module.exports = { CaptureSession, mediaKind };
