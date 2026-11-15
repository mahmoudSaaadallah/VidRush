'use strict';

// An isolated-world hint, not a source of trusted URLs. The worker reads the
// actual player and Chrome document identity before inspecting anything.
(() => {
  if (globalThis.__vidrushObserver) return;
  globalThis.__vidrushObserver = true;
  let timer;
  const notify = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      chrome.runtime.sendMessage({ action: 'playerChanged' }).catch(() => {});
    }, 250);
  };
  const watched = new WeakSet();
  const observe = root => {
    if (watched.has(root)) return;
    watched.add(root);
    const media = root.querySelectorAll('video, audio');
    for (const video of media) {
      if (watched.has(video)) continue;
      watched.add(video);
      for (const name of ['loadstart', 'loadedmetadata', 'emptied', 'play', 'encrypted']) video.addEventListener(name, notify);
      notify();
    }
    // Observe open shadow trees as well as ordinary and embedded documents.
    for (const node of root.querySelectorAll('*')) if (node.shadowRoot) observe(node.shadowRoot);
    new MutationObserver(records => {
      let relevant = false;
      for (const record of records) {
        if (record.type === 'attributes') {
          if (record.target.matches('video, audio, source, iframe')) relevant = true;
        } else for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches('video, audio, source, iframe') || node.querySelector('video, audio, iframe')) relevant = true;
          if (node.shadowRoot) observe(node.shadowRoot);
        }
        for (const node of record.removedNodes || []) if (node.nodeType === 1 && (node.matches('video, audio, source, iframe') || node.querySelector('video, audio, iframe'))) relevant = true;
      }
      if (relevant) { attachMedia(root); notify(); }
    }).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'data-src'] });
  };
  const attachMedia = root => {
    for (const video of root.querySelectorAll('video, audio')) {
      if (watched.has(video)) continue;
      watched.add(video);
      for (const name of ['loadstart', 'loadedmetadata', 'emptied', 'play', 'encrypted']) video.addEventListener(name, notify);
    }
  };
  observe(document);
  addEventListener('pageshow', notify);
})();
