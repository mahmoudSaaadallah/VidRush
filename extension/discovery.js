'use strict';

// Serialized by chrome.scripting: keep this function independent of worker state.
function discoverPageMedia(protectionOnly = false) {
  const sources = new Map();
  const playerOrigins = new Set();
  const page = new URL(location.href);

  // Traverse document and open shadow roots to discover all video elements
  const videos = [];
  const visitedRoots = new Set();
  const queue = [document];
  while (queue.length && videos.length < 30) {
    const root = queue.shift();
    if (!root || visitedRoots.has(root)) continue;
    visitedRoots.add(root);
    try {
      const found = root.querySelectorAll ? root.querySelectorAll('video') : [];
      for (const v of found) {
        if (!videos.includes(v)) videos.push(v);
        if (videos.length >= 30) break;
      }
    } catch {}
    try {
      const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const el of all) {
        if (el?.shadowRoot && !visitedRoots.has(el.shadowRoot)) queue.push(el.shadowRoot);
      }
      for (const child of (root.children || [])) {
        if (child?.shadowRoot && !visitedRoots.has(child.shadowRoot)) queue.push(child.shadowRoot);
      }
    } catch {}
  }

  const hasDrm = videos.some(video => !!video.mediaKeys);
  if (protectionOnly) return { hasDrm };
  const hasBlob = videos.some(video => (video.currentSrc || video.src || '').startsWith('blob:'));
  const embeds = [];
  function add(value, mediaElement = false, videoIndex) {
    if (typeof value !== 'string' || !value || value.length > 8192 || sources.size >= 20) return;
    let url;
    try { url = new URL(value, document.baseURI); } catch { return; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    if (!mediaElement) {
      const isMedia = /\.(?:m3u8|mpd|mp4|webm|mov|m4v)(?:$|[?#])/i.test(url.href) ||
        /(?:\/manifest\/(?:v\d+\/)?(?:hls|dash)\/|\/(?:hls|dash)\/(?:master|playlist|index|manifest)\b)/i.test(url.pathname) ||
        /[?&](?:format|type|ext)=(?:m3u8|mpd|hls|dash)/i.test(url.search);
      if (!isMedia) return;
    }
    url.hash = '';
    const referer = url.origin === page.origin ? page.href.split('#')[0] : page.origin + '/';
    sources.set(url.href, { ...sources.get(url.href), url: url.href, referer, ...(Number.isInteger(videoIndex) ? { videoIndex } : {}) });
  }
  if (!hasDrm) {
    const mediaAttrs = ['src', 'data-src', 'data-url', 'data-stream-url', 'data-hls-url', 'data-hls', 'data-manifest', 'data-video-url', 'data-mpd'];
    for (const [index, video] of videos.entries()) {
      add(video.currentSrc, true, index);
      for (const attr of mediaAttrs) add(video.getAttribute?.(attr), true, index);
      for (const source of (video.querySelectorAll?.('source') || [])) {
        add(source.src, true, index);
        for (const attr of mediaAttrs) add(source.getAttribute?.(attr), true, index);
      }
    }
    // Check custom media players and universal embed containers
    try {
      for (const element of [...(document.querySelectorAll?.('video-js, media-player, mux-player, jw-player, [data-vimeo-id], [data-vimeo-url], [data-youtube-id]') || [])].slice(0, 30)) {
        for (const attr of mediaAttrs) add(element.getAttribute?.(attr), true);
        const vimeoId = element.getAttribute?.('data-vimeo-id');
        if (/^\d{6,12}$/.test(vimeoId || '')) add(`https://player.vimeo.com/video/${vimeoId}`, true);
        const vimeoUrl = element.getAttribute?.('data-vimeo-url');
        if (typeof vimeoUrl === 'string' && /vimeo\.com\/\d+/.test(vimeoUrl)) add(vimeoUrl, true);
        const ytId = element.getAttribute?.('data-youtube-id');
        if (/^[a-zA-Z0-9_-]{11}$/.test(ytId || '')) add(`https://www.youtube.com/watch?v=${ytId}`, true);
      }
    } catch {}

    // MSE players expose blob: in <video>; their fetched HLS/DASH manifests remain
    // in this frame's Resource Timing buffer. No request bodies or cookies are read.
    const resources = performance.getEntriesByType('resource').slice(-500);
    for (const resource of resources.reverse()) add(resource.name);
    try {
      for (const meta of (document.querySelectorAll?.('meta[property="og:video"],meta[property="og:video:url"],meta[property="og:video:secure_url"],meta[name="twitter:player:stream"],meta[property="twitter:player:stream"],meta[itemprop="contentUrl"],meta[itemprop="embedUrl"]') || [])) {
        add(meta.content);
      }
    } catch {}
  }
  for (const iframe of [...(document.querySelectorAll?.('iframe[src], iframe[data-src], iframe[data-url]') || [])].slice(0, 100)) {
    let url;
    const rawSrc = iframe.src || iframe.getAttribute?.('data-src') || iframe.getAttribute?.('data-url');
    try { url = new URL(rawSrc, document.baseURI); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
    const box = iframe.getBoundingClientRect ? iframe.getBoundingClientRect() : { width: 300, height: 200 };
    if (box.width < 100 || box.height < 80) continue;
    if (url.origin !== page.origin) playerOrigins.add(url.origin + '/*');
    embeds.push({ url: url.href, referer: url.origin === page.origin ? page.href.split('#')[0] : page.origin + '/', area: box.width * box.height });
  }
  if (!hasDrm) {
    let defaultBcAccount = '';
    let defaultBcPlayer = '';
    let defaultBcEmbed = 'default';
    for (const script of [...document.querySelectorAll('script[src],link[href]')].slice(0, 100)) {
      const src = script.src || script.getAttribute('href') || '';
      const match = src.match(/players\.brightcove\.net\/(\d+)\/([a-zA-Z0-9-]+)(?:_([a-zA-Z0-9-]+))?/);
      if (match) {
        defaultBcAccount = defaultBcAccount || match[1];
        defaultBcPlayer = defaultBcPlayer || match[2];
        if (match[3]) defaultBcEmbed = match[3].replace(/-index-\d+$/, '') || 'default';
        break;
      }
    }
    if (!defaultBcAccount) {
      const resources = performance.getEntriesByType?.('resource') || [];
      for (const resource of resources) {
        const match = (resource.name || '').match(/players\.brightcove\.net\/(\d+)\/([a-zA-Z0-9-]+)(?:_([a-zA-Z0-9-]+))?/);
        if (match) {
          defaultBcAccount = match[1];
          defaultBcPlayer = defaultBcPlayer || match[2];
          if (match[3]) defaultBcEmbed = match[3].replace(/-index-\d+$/, '') || 'default';
          break;
        }
        const boltMatch = (resource.name || '').match(/manifest\.prod\.boltdns\.net\/manifest\/v1\/(?:hls|dash)\/[^/]+\/(?:clear|protected)\/(\d+)\//);
        if (boltMatch && !defaultBcAccount) defaultBcAccount = boltMatch[1];
      }
    }
    if (!defaultBcAccount) {
      for (const el of document.querySelectorAll('[poster]')) {
        const poster = el.getAttribute('poster') || '';
        const match = poster.match(/brightcovecdn\.com\/(?:image|media)\/v1\/(?:jit|hls|dash)\/(?:clear\/)?(\d+)\//);
        if (match) { defaultBcAccount = match[1]; break; }
      }
    }
    for (const element of [...document.querySelectorAll('[data-account],video-js,.video-js,[data-video-id],[data-videoid]')].slice(0, 30)) {
      if (element.tagName === 'VIDEO' && element.closest?.('video-js, .video-js')) continue;
      const account = element.getAttribute('data-account') || element.querySelector('[data-account]')?.getAttribute('data-account') || element.closest?.('[data-account]')?.getAttribute('data-account') || defaultBcAccount;
      const videoId = element.getAttribute('data-video-id') || element.getAttribute('data-videoid') || element.querySelector('[data-video-id],[data-videoid]')?.getAttribute('data-video-id') || element.querySelector('[data-video-id],[data-videoid]')?.getAttribute('data-videoid') || element.closest?.('[data-video-id],[data-videoid]')?.getAttribute('data-video-id');
      let player = element.getAttribute('data-player');
      let embed = element.getAttribute('data-embed') || 'default';
      if (!player) {
        const classSource = [typeof element.className === 'string' ? element.className : '', typeof element.closest?.('[class*="bc-player-"]')?.className === 'string' ? element.closest('[class*="bc-player-"]').className : ''].filter(Boolean).join(' ');
        const match = classSource.match(/\bbc-player-([a-zA-Z0-9-]+)(?:_([a-zA-Z0-9-]+))?\b/);
        player = match?.[1] || defaultBcPlayer || 'default';
        if (match?.[2]) embed = match[2].replace(/-index-\d+$/, '') || 'default';
        else embed = defaultBcEmbed || 'default';
      }
      if (/^\d+$/.test(account || '') && /^[0-9a-zA-Z_:-]+$/.test(videoId || '')) {
        const v = element.tagName === 'VIDEO' ? element : element.querySelector('video');
        const videoIndex = v ? videos.indexOf(v) : undefined;
        add(`https://players.brightcove.net/${account}/${player}_${embed}/index.html?videoId=${videoId}`, true, videoIndex >= 0 ? videoIndex : undefined);
      }
    }
    for (const element of [...document.querySelectorAll('[class*="wistia_async_"],[data-wistia-id],[data-wistiaid],wistia-player[media-id]')].slice(0, 30)) {
      const id = element.getAttribute('media-id') || element.getAttribute('data-wistia-id') || element.getAttribute('data-wistiaid') || element.className?.match?.(/\bwistia_async_([a-z0-9]{10})\b/)?.[1];
      if (/^[a-z0-9]{10}$/.test(id || '')) add('https://fast.wistia.net/embed/iframe/' + id, true);
    }
  }
  const rank = value => /(?:master|playlist|manifest)/i.test(value) ? 0 : /(?:brightcove\.net|wistia\.net|vimeo\.com|youtube\.com|dailymotion\.com)/i.test(value) ? 1 : /\.m3u8(?:$|[?#])/i.test(value) ? 2 : /\.mpd(?:$|[?#])/i.test(value) ? 3 : /\.(mp4|webm|mov|m4v)(?:$|[?#])/i.test(value) ? 4 : 5;
  return { pageUrl: page.href, title: document.title.slice(0, 300), hasDrm, hasBlob,
    sources: [...sources.values()].sort((a, b) => rank(a.url) - rank(b.url)).slice(0, 8),
    embeds: embeds.sort((a, b) => b.area - a.area).slice(0, 4), playerOrigins: [...playerOrigins].slice(0, 12) };
}
