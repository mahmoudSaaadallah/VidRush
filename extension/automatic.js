'use strict';

const preparedTabs = new Map();
const generations = new Map();
const navigationUrls = new Map();
const activeInspections = new Set();
let preparationWrite = Promise.resolve();
const preparationQueue = new PreparationQueue(prepareInBackground, { changed: setPreparationStatus });

function preparationGeneration(tabId) { return generations.get(tabId) || 0; }
function tabPreparation(tabId) {
  let state = preparedTabs.get(tabId);
  if (!state) {
    state = { phase: 'waiting', records: new Map(), failures: new Map() };
    preparedTabs.set(tabId, state);
    if (preparedTabs.size > 32) resetPreparation(preparedTabs.keys().next().value);
  }
  return state;
}
function presentedMedia(tabId, media) {
  const entries = [...(preparedTabs.get(tabId)?.records.values() || [])];
  if (!entries.some(entry => entry.media.token === media.token)) return media;
  return { ...media, sourceIndex: 'ready:' + media.token,
    detectedSources: entries.map(entry => ({ index: 'ready:' + entry.media.token, label: entry.media.title || 'فيديو جاهز' })) };
}
function preparedSnapshot(tabId) {
  const state = preparedTabs.get(tabId);
  const records = [...(state?.records.values() || [])];
  const selected = records.find(entry => entry === analyses.get(tabId)) || records[0];
  return { generation: preparationGeneration(tabId), status: records.length ? 'ready' : state?.phase || 'waiting',
    count: records.length, error: state?.error || '', media: selected ? presentedMedia(tabId, selected.media) : null };
}
function publishPreparation(tabId) {
  const current = preparedSnapshot(tabId);
  updateBadge(tabId, current.count, current.status);
  // Public metadata only. No URLs, request context, player fingerprints or video bytes.
  const preparations = Object.fromEntries([...preparedTabs.keys()].map(id => [id, preparedSnapshot(id)]));
  preparationWrite = preparationWrite.catch(() => {}).then(() => chrome.storage.session.set({ preparations }));
}
function setPreparationStatus(tabId, phase, error = '') {
  const state = tabPreparation(tabId);
  state.phase = phase; state.error = error;
  publishPreparation(tabId);
}
function rememberPrepared(entry) {
  if (!entry.identity || !entry.media?.options?.length || entry.media.browser && browserSources.get(entry.media.token)?.url === 'mse://stream') return;
  const state = tabPreparation(entry.tabId);
  // One player/playlist identity is one video, irrespective of variant URLs.
  for (const [key, previous] of state.records) if (previous.group && previous.group === entry.group && key !== entry.identity) state.records.delete(key);
  state.records.set(entry.identity, entry);
  state.phase = 'ready'; state.error = '';
  publishPreparation(entry.tabId);
}
function resetPreparation(tabId) {
  generations.set(tabId, preparationGeneration(tabId) + 1);
  preparationQueue.cancel(tabId);
  for (const entry of activeInspections) if (entry.tabId === tabId) entry.controller.abort();
  for (const entry of preparedTabs.get(tabId)?.records.values() || []) browserSources.delete(entry.media.token);
  clearTimeout(preparedTabs.get(tabId)?.retry);
  preparedTabs.delete(tabId); analyses.delete(tabId); sourceChoices.delete(tabId);
  publishPreparation(tabId);
}
function pausePreparation(error = '') {
  preparationQueue.clear();
  for (const id of [...preparedTabs.keys()]) {
    resetPreparation(id);
    if (error) setPreparationStatus(id, 'error', error);
  }
}
function expirePrepared(token) {
  browserSources.delete(token);
  for (const [id, state] of preparedTabs) {
    for (const [key, entry] of state.records) if (entry.media.token === token) {
      state.records.delete(key);
      if (analyses.get(id) === entry) analyses.delete(id);
      state.phase = 'waiting'; publishPreparation(id);
      // Avoid an eviction/reinspection loop across many background tabs.
      void chrome.tabs.get(id).then(tab => { if (tab.active) hintPreparation(id); }).catch(() => {});
    }
  }
}
function hintPreparation(tabId, immediate = false) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  void ready.then(async () => {
    if (capturePaused || !await chrome.permissions.contains({ origins: SCAN_ORIGINS })) return;
    const tab = await chrome.tabs.get(tabId);
    if (!/^https?:\/\//i.test(tab.url || '') || tab.discarded) return;
    preparationQueue.schedule(tabId, { immediate, priority: tab.active ? 1 : 0 });
  }).catch(() => {});
}

async function invalidateChangedPlayers(tabId, frameId) {
  try {
    const state = preparedTabs.get(tabId);
    const entries = new Set([...(state?.records.values() || []), ...[...activeInspections].filter(entry => entry.tabId === tabId)]);
    for (const entry of entries) {
      if (entry.frameId !== undefined && entry.frameId !== frameId || !entry.identity) continue;
      if (entry.identity !== await readIdentity(entry.scope)) {
        entry.controller.abort(); state?.records.delete(entry.identity);
        if (analyses.get(tabId) === entry) analyses.delete(tabId);
      }
    }
    if (state) { state.phase = 'waiting'; publishPreparation(tabId); }
  } catch { /* A closing tab needs no follow-up. */ }
}

async function prepareInBackground(tabId, signal) {
  await ready;
  if (capturePaused) return;
  const generation = preparationGeneration(tabId);
  const current = () => { signal.throwIfAborted(); if (generation !== preparationGeneration(tabId)) throw new Error('Page changed.'); };
  const state = tabPreparation(tabId);
  try {
    const tab = await chrome.tabs.get(tabId);
    const discovery = await collectSources(tabId, tab.url);
    current();
    discovery.set.sources = discovery.set.sources.filter(source => source.kind !== 'embed' || discovery.frames.some(frame => frame.result?.pageUrl === source.url && frame.result.videoCount));
    const hasPlayer = discovery.pageOnly || discovery.frames.some(frame => frame.result?.videoCount || frame.result?.hasBlob);
    if (!discovery.set.sources.length && !hasPlayer) { setPreparationStatus(tabId, 'waiting'); return; }
    const companion = await ensureCompanion(true);
    current();
    if (!companion.capabilities?.cancelInspection || !companion.capabilities?.mediaExpiryEvents) throw new Error('التجهيز في الخلفية يحتاج البرنامج المساعد الجديد. شغّل Update.cmd ثم أعد تحميل VidRush.');
    // Reuse both ready results and an inspection started by a popup. Never launch
    // a duplicate just because a content or network event arrived meanwhile.
    const running = analyses.get(tabId);
    if (running && !running.media) await running.promise.catch(() => {});
    for (const [key, entry] of state.records) {
      if (entry.url !== tab.url || !await reuseAnalysis(entry)) {
        state.records.delete(key);
        if (analyses.get(tabId) === entry) analyses.delete(tabId);
      }
      current();
    }
    if (!analyses.has(tabId) && state.records.size) analyses.set(tabId, state.records.values().next().value);
    publishPreparation(tabId);
    const groups = new Map();
    for (const source of discovery.set.sources) {
      if (!groups.has(source.group)) groups.set(source.group, []);
      groups.get(source.group).push(source);
    }
    if (hasPlayer) groups.set('page', []);
    for (const [group, sources] of [...groups].slice(0, 8)) {
      current();
      if (group === 'page' && state.records.size) continue;
      const source = sources[0];
      const scope = { target: { tabId, ...(source?.documentId ? { documentIds: [source.documentId] } : { frameIds: [source?.frameId || 0] }) }, videoIndex: source?.videoIndex, pageOnly: discovery.pageOnly };
      const identity = await readIdentity(scope);
      current();
      if (identity && state.records.has(identity)) continue;
      const fingerprint = JSON.stringify([identity, sources.map(source => source.url)]);
      const failures = state.failures.get(fingerprint) || 0;
      if (failures >= 2) continue;
      const entry = startAnalysis(tabId, tab.url, async entry => {
        entry.group = group;
        entry.discovery = { ...discovery, set: { url: tab.url, sources } };
        return inspectTab(tabId, tab.url, sources.length > 0, entry);
      }, { automatic: true, select: !analyses.has(tabId), signal });
      try { await entry.promise; state.failures.delete(fingerprint); }
      catch (error) {
        current();
        state.failures.set(fingerprint, failures + 1);
        if (state.failures.size > 20) state.failures.delete(state.failures.keys().next().value);
        state.error = error.message;
        if (!failures && !/DRM|Update\.cmd/.test(error.message)) {
          clearTimeout(state.retry);
          state.retry = setTimeout(() => hintPreparation(tabId), 2000);
        }
      }
    }
    current();
    setPreparationStatus(tabId, state.records.size ? 'ready' : state.error ? 'error' : 'waiting', state.error);
  } catch (error) {
    if (!signal.aborted && generation === preparationGeneration(tabId)) setPreparationStatus(tabId, 'error', error.message);
  }
}

// Navigation events are independent of webRequest ordering. Document IDs reject
// responses from old frames, including same-URL reloads and restored pages.
chrome.webNavigation.onCommitted.addListener(details => {
  if (details.frameId === 0) {
    navigationUrls.set(details.tabId, details.url);
    resetPreparation(details.tabId); capture.clearTab(details.tabId, details.documentId);
    capture.navigate(details.tabId, details.url);
  } else {
    const state = preparedTabs.get(details.tabId);
    for (const [key, entry] of state?.records || []) if (entry.scope.target.frameIds?.includes(details.frameId) || entry.frameId === details.frameId) {
      state.records.delete(key);
      if (analyses.get(details.tabId) === entry) analyses.delete(details.tabId);
    }
    for (const entry of activeInspections) if (entry.tabId === details.tabId && entry.frameId === details.frameId) entry.controller.abort();
    publishPreparation(details.tabId);
  }
  capture.clearFrame(details.tabId, details.frameId, details.documentId);
  hintPreparation(details.tabId);
});
for (const event of [chrome.webNavigation.onHistoryStateUpdated, chrome.webNavigation.onReferenceFragmentUpdated]) event.addListener(details => {
  if (details.frameId === 0 && navigationUrls.get(details.tabId) !== details.url) {
    navigationUrls.set(details.tabId, details.url);
    resetPreparation(details.tabId); capture.clearTab(details.tabId); capture.navigate(details.tabId, details.url);
  }
  hintPreparation(details.tabId);
});
chrome.tabs.onActivated.addListener(({ tabId }) => hintPreparation(tabId));

void ready.then(async () => {
  const saved = await chrome.storage.session.get('preparations');
  // Metadata survives suspension, but tokens in a restarted native host do not.
  // Clear old ready badges before rediscovering; never resurrect a stale token.
  for (const id of Object.keys(saved.preparations || {})) updateBadge(Number(id), 0);
  await chrome.storage.session.set({ preparations: {} });
  const tabs = await chrome.tabs.query({ url: SCAN_ORIGINS });
  for (const tab of tabs) {
    if (capturePaused) break;
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['player-observer.js'] }).catch(() => {});
    hintPreparation(tab.id);
  }
}).catch(() => {});
