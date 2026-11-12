'use strict';

// Serialized into the player's MAIN world. Read metadata only: no fetch, seeks,
// quality changes, playback timestamps, or Resource Timing history.
function snapshotPlayerIdentity(videoIndex) {
  try {
    const state = window.__vidrush_player_identity || (window.__vidrush_player_identity = { nodes: new WeakMap(), next: 0 });
    const id = node => {
      if (!state.nodes.has(node)) state.nodes.set(node, ++state.next);
      return state.nodes.get(node);
    };
    const value = source => {
      const text = typeof source === 'string' ? source : source ? JSON.stringify(source) : '';
      if (typeof text !== 'string' || text.length > 8192) throw new Error('Unverifiable video source.');
      return text;
    };
    const largest = nodes => nodes.sort((a, b) => {
      const area = node => { const box = node.getBoundingClientRect(); return box.width * box.height; };
      return area(b) - area(a);
    })[0];
    const videos = [...document.querySelectorAll('video')].slice(0, 30);
    const video = Number.isInteger(videoIndex) ? videos[videoIndex] : largest(videos);
    let player;
    if (video) {
      if (video.mediaKeys) return null;
      const container = video.closest('.jwplayer');
      let sources;
      try {
        const api = typeof window.jwplayer === 'function' && (container?.id || videos.length === 1) ? window.jwplayer(container?.id) : null;
        const declared = api?.getPlaylistItem?.()?.sources;
        if (Array.isArray(declared) && declared.length) sources = declared.slice(0, 16).map(source => [value(source.file || source.src), value(source.label || '')]);
      } catch { /* Ordinary HTML sources do not need a player API. */ }
      if (!sources) {
        const declared = [...video.querySelectorAll('source[src]')].slice(0, 16);
        sources = declared.length ? declared.map(source => [value(source.src), source.getAttribute('label')])
          : [[value(video.currentSrc || video.src || video.getAttribute('src'))]];
      }
      player = ['video', id(video), sources];
    } else {
      const frame = largest([...document.querySelectorAll('iframe[src]')].slice(0, 100).filter(node => {
        const box = node.getBoundingClientRect(); return box.width >= 100 && box.height >= 80;
      }));
      player = frame ? ['frame', id(frame), value(frame.src)] : ['page'];
    }
    return JSON.stringify([location.href, player]);
  } catch { return null; }
}
