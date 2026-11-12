'use strict';

// Serialized by chrome.scripting: keep this function independent of worker state.
function discoverPageMedia() {
  const sources = new Map();
  const playerOrigins = new Set();
  const page = new URL(location.href);
  const videos = [...document.querySelectorAll('video')].slice(0, 30);
  const hasDrm = videos.some(video => !!video.mediaKeys);
  const hasBlob = videos.some(video => (video.currentSrc || video.src || '').startsWith('blob:'));
  const embeds = [];
  function add(value, mediaElement = false, videoIndex) {
    if (typeof value !== 'string' || !value || value.length > 8192 || sources.size >= 20) return;
    let url;
    try { url = new URL(value, document.baseURI); } catch { return; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    if (!mediaElement && !/\.(?:m3u8|mpd|mp4|webm|mov|m4v)(?:$|[?#])/i.test(url.href)) return;
    url.hash = '';
    const referer = url.origin === page.origin ? page.href.split('#')[0] : page.origin + '/';
    sources.set(url.href, { ...sources.get(url.href), url: url.href, referer, ...(Number.isInteger(videoIndex) ? { videoIndex } : {}) });
  }
  if (!hasDrm) {
    for (const [index, video] of videos.entries()) {
      add(video.currentSrc, true, index); add(video.getAttribute('src'), true, index);
      for (const source of video.querySelectorAll('source[src]')) add(source.src, true, index);
    }
    // MSE players expose blob: in <video>; their fetched HLS/DASH manifests remain
    // in this frame's Resource Timing buffer. No request bodies or cookies are read.
    const resources = performance.getEntriesByType('resource').slice(-500);
    for (const resource of resources.reverse()) add(resource.name);
    for (const meta of document.querySelectorAll('meta[property="og:video"],meta[property="og:video:url"],meta[property="og:video:secure_url"]')) add(meta.content);
  }
  for (const iframe of [...document.querySelectorAll('iframe[src]')].slice(0, 100)) {
    let url;
    try { url = new URL(iframe.src); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
    const box = iframe.getBoundingClientRect();
    if (box.width < 100 || box.height < 80) continue;
    if (url.origin !== page.origin) playerOrigins.add(url.origin + '/*');
    embeds.push({ url: url.href, referer: url.origin === page.origin ? page.href.split('#')[0] : page.origin + '/', area: box.width * box.height });
  }
  if (!hasDrm) {
    for (const element of [...document.querySelectorAll('[class*="wistia_async_"],[data-wistia-id],[data-wistiaid],wistia-player[media-id]')].slice(0, 30)) {
      const id = element.getAttribute('media-id') || element.getAttribute('data-wistia-id') || element.getAttribute('data-wistiaid') || element.className?.match?.(/\bwistia_async_([a-z0-9]{10})\b/)?.[1];
      if (/^[a-z0-9]{10}$/.test(id || '')) add('https://fast.wistia.net/embed/iframe/' + id, true);
    }
  }
  const rank = value => /\.m3u8(?:$|[?#])/i.test(value) ? (/master/i.test(value) ? 0 : 1) : /\.mpd(?:$|[?#])/i.test(value) ? 2 : /\.(mp4|webm|mov|m4v)(?:$|[?#])/i.test(value) ? 3 : 4;
  return { pageUrl: page.href, title: document.title.slice(0, 300), hasDrm, hasBlob,
    sources: [...sources.values()].sort((a, b) => rank(a.url) - rank(b.url)).slice(0, 8),
    embeds: embeds.sort((a, b) => b.area - a.area).slice(0, 4), playerOrigins: [...playerOrigins].slice(0, 12) };
}
