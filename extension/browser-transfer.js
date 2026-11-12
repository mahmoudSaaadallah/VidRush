'use strict';

// Runs in the selected document's MAIN world: its own Service Worker and normal
// browser session must handle the request. No cookies or credentials leave Chrome.
async function browserFrameFile(action, options) {
  try {
  const { key, url, total, videoIndex, catalogId, variantIndex } = options;
  const slot = '__vidrush_' + key;
  const matches = value => value === url || value && typeof value === 'object' && JSON.stringify(value) === JSON.stringify(url);
  const getVideo = () => {
    const videos = [...document.querySelectorAll('video')];
    return Number.isInteger(videoIndex) && videoIndex >= 0 ? videos[videoIndex] : videos.find(video => matches(video.currentSrc) || matches(video.src) || matches(video.getAttribute('src')));
  };
  // A player can expose a URL-like currentSrc object whose string conversion is
  // meaningful only inside the page. Preserve it for fetch; never export it.
  const currentSource = () => getVideo()?.currentSrc || url;
  const rangeTotal = response => Number(response.headers.get('content-range')?.match(/\/(\d+)$/)?.[1] || response.headers.get('content-length'));
  if (action !== 'cancel' && getVideo()?.mediaKeys) throw new Error('DRM-protected videos are unsupported.');
  if (action === 'probe') {
    const video = getVideo();
    const candidates = [];
    const add = (handle, label = '', height = 0) => {
      if (!handle) return;
      if (typeof handle === 'string') {
        try { if (!['http:', 'https:'].includes(new URL(handle, location.href).protocol)) return; } catch { return; }
      }
      const existing = candidates.find(candidate => candidate.handle === handle);
      if (existing) { if (label) existing.label = label; if (height) existing.height = height; return; }
      if (candidates.length < 16) candidates.push({ handle, label, height });
    };
    add(currentSource());
    // Read public player metadata without changing playback or cycling qualities.
    // This works across sites using the API, rather than matching website domains.
    try {
      const container = video?.closest('.jwplayer');
      const player = typeof window.jwplayer === 'function' && (container?.id || document.querySelectorAll('video').length === 1)
        ? window.jwplayer(container?.id) : null;
      const levels = player?.getQualityLevels?.() || [];
      const current = levels[player?.getCurrentQuality?.()];
      const sources = player?.getPlaylistItem?.()?.sources || [];
      if (current) add(currentSource(), current.label, current.height);
      if (Array.isArray(sources)) for (const source of sources.slice(0, 16)) add(source.file || source.src, source.label, source.height);
    } catch { /* Players without this API still expose ordinary video sources. */ }
    for (const source of [...(video?.querySelectorAll('source') || [])].slice(0, 16)) {
      add(source.src, source.getAttribute('label') || source.getAttribute('data-quality') || '', Number(source.getAttribute('size') || source.getAttribute('res')) || 0);
    }
    const probe = async candidate => {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
      let reader;
      try {
      const response = await fetch(candidate.handle, { headers: { Range: 'bytes=0-1023' }, signal: controller.signal });
      if (![200, 206].includes(response.status) || !response.body) throw new Error('The browser could not read the video file.');
      reader = response.body.getReader();
      let head = new Uint8Array();
      while (head.length < 16) {
        const chunk = await reader.read(); if (chunk.done) break;
        const joined = new Uint8Array(Math.min(32, head.length + chunk.value.length)); joined.set(head); joined.set(chunk.value.subarray(0, joined.length - head.length), head.length); head = joined;
      }
      const ext = String.fromCharCode(...head.subarray(4, 8)) === 'ftyp' ? 'mp4' : head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3 ? 'webm' : null;
      const bytes = rangeTotal(response);
      if (!ext || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 2 ** 41) throw new Error('No readable MP4/WebM file with a known size was found.');
      const label = typeof candidate.label === 'string' ? candidate.label.trim().slice(0, 60) : '';
      const advertised = Number(label.match(/\b(\d{2,5})p\b/i)?.[1]) || candidate.height;
      const height = advertised || (candidate.handle === currentSource() ? video?.videoHeight || 0 : 0);
      return { handle: candidate.handle, metadata: { ext, bytes, label, height } };
      } finally { clearTimeout(timer); if (reader) void reader.cancel().catch(() => {}); controller.abort(); }
    };
    const entries = [];
    for (let start = 0; start < candidates.length; start += 4) {
      const batch = await Promise.allSettled(candidates.slice(start, start + 4).map(probe));
      entries.push(...batch.filter(result => result.status === 'fulfilled').map(result => result.value));
    }
    if (!entries.length) throw new Error('No readable MP4/WebM file with a known size was found.');
    // Raw page-owned handles never cross into the extension or native companion.
    // Retain a bounded catalogue; each transfer pins its own handle on first read.
    const catalogs = window.__vidrush_browser_sources || (window.__vidrush_browser_sources = new Map());
    const id = key || crypto.randomUUID();
    catalogs.set(id, entries);
    while (catalogs.size > 8) catalogs.delete(catalogs.keys().next().value);
    return { ...entries[0].metadata, catalogId: id, variants: entries.map(entry => entry.metadata), title: document.title.slice(0, 300), duration: Number.isFinite(video?.duration) ? video.duration : null };
  }
  if (action === 'cancel') {
    const state = window[slot]; delete window[slot];
    if (state) { state.controller.abort(); void state.reader?.cancel().catch(() => {}); }
    return { stopped: true };
  }
  let state = window[slot];
  if (!state) {
    const entry = window.__vidrush_browser_sources?.get(catalogId)?.[variantIndex];
    if (!entry || entry.metadata.bytes !== total) throw new Error('The browser quality selection expired. Refresh VidRush and choose the quality again.');
    state = { controller: new AbortController(), offset: 0, remainder: new Uint8Array(), url, total, catalogId, variantIndex, handle: entry.handle };
    window[slot] = state;
  }
  if (state.url !== url || state.total !== total || state.catalogId !== catalogId || state.variantIndex !== variantIndex) throw new Error('The browser video selection changed.');
  const timer = setTimeout(() => state.controller.abort(), 20000);
  try {
    const chunks = [];
    let produced = 0;
    while (produced < 262144 && state.offset < total) {
      if (!state.remainder.length) {
        if (!state.reader) {
          const response = await fetch(state.handle, { headers: { Range: 'bytes=' + state.offset + '-' }, signal: state.controller.signal });
          const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
          if (![200, 206].includes(response.status) || !response.body || response.status === 200 && state.offset !== 0 || response.status === 206 && (!range || Number(range[1]) !== state.offset || Number(range[3]) !== total)) throw new Error('The browser returned an invalid video byte range.');
          state.responseEnd = range ? Number(range[2]) + 1 : total;
          state.reader = response.body.getReader();
        }
        const next = await state.reader.read();
        if (next.done) {
          state.reader = null;
          if (state.offset !== state.responseEnd) throw new Error('The browser video response was truncated.');
          if (state.offset < total) continue;
          break;
        }
        state.remainder = next.value;
        while (state.offset === 0 && state.remainder.length < 16) {
          const more = await state.reader.read();
          if (more.done) throw new Error('The browser video header was truncated.');
          const joined = new Uint8Array(state.remainder.length + more.value.length);
          joined.set(state.remainder); joined.set(more.value, state.remainder.length); state.remainder = joined;
        }
      }
      const take = Math.min(65536, state.remainder.length, 262144 - produced);
      if (state.offset + take > total) throw new Error('The browser video exceeded its declared size.');
      const bytes = state.remainder.subarray(0, take);
      let binary = '';
      for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
      chunks.push(btoa(binary));
      state.remainder = state.remainder.subarray(take); state.offset += take; produced += take;
    }
    const done = state.offset === total;
    if (done) { delete window[slot]; state.controller.abort(); void state.reader?.cancel().catch(() => {}); }
    return { chunks, done };
  } catch (error) {
    delete window[slot]; state.controller.abort(); void state.reader?.cancel().catch(() => {}); throw error;
  } finally { clearTimeout(timer); }
  } catch (error) { return { error: String(error.message || error).slice(0, 1000) }; }
}
