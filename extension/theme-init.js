'use strict';
// A synchronous paint hint only; chrome.storage.local remains authoritative.
try {
  const theme = localStorage.getItem('vidrush-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch { /* The durable setting is read by popup.js even if the cache is blocked. */ }
