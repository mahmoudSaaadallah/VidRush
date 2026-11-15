'use strict';

importScripts('discovery.js');
importScripts('capture.js');
importScripts('browser-transfer.js');
importScripts('player-identity.js');
importScripts('preparation.js');

const HOST = 'com.vidrush.companion';
const protectedVideoMessage = 'المشغّل يستخدم حماية DRM. تحميل الفيديو المحمي غير مدعوم في VidRush.';
const missingTracksMessage = 'المصدر المتاح ناقص مسار الصوت أو الصورة. VidRush يحتاج مصدرًا يوفّر المسارين.';
let nativePort;
let nextId = 0;
let pageSources = false;
let sourceContext = false;
let browserTransfer = false;
let browserQualities = false;
let analysisCache = false;
let pairedStreams = false;
let companionReady;
let companionRetryAt = 0;
let companionConnectionError;
let cancelInspection = false;
const inspectionSlots = new InspectionSlots();
let capturePaused = false;
const pending = new Map();
const analyses = new Map();
const sourceChoices = new Map();
const browserSources = new Map();
const browserJobs = new Map();
function updateBadge(tabId, count = 0, status = '') {
  if (!Number.isInteger(tabId) || tabId <= 0 || !chrome.action?.setBadgeText) return;
  try {
    if (count > 0) {
      const text = count > 9 ? '9+' : String(count);
      chrome.action.setBadgeText({ tabId, text });
      chrome.action.setBadgeBackgroundColor?.({ tabId, color: '#15803d' });
      chrome.action.setBadgeTextColor?.({ tabId, color: '#ffffff' });
    } else {
      chrome.action.setBadgeText({ tabId, text: ['queued', 'analyzing'].includes(status) ? '…' : status === 'error' ? '!' : '' });
      chrome.action.setBadgeBackgroundColor?.({ tabId, color: status === 'error' ? '#b45309' : '#2563eb' });
    }
  } catch {}
}

const capture = new CaptureSession({
  save: value => { void chrome.storage.session.set({ captureSession: value }).catch(() => {}); },
  // Capture traffic is not player identity: advertisements and later byte ranges
  // must not discard successful results (or detach an in-flight inspection).
  changed: (tabId, reset) => {
    if (reset && !analyses.has(tabId)) sourceChoices.delete(tabId);
  },
  discovered: tabId => hintPreparation(tabId),
  autoSniff: true,
});
let jobs = [];
let destination = { downloadDir: '', choosingFolder: false };
let destinationEpoch = 0;
const ready = chrome.storage.session.get(['jobs', 'destination', 'captureSession', 'capturePaused']).then(async result => {
  destination = { ...destination, ...result.destination, choosingFolder: false };
  jobs = (result.jobs || []).map(job => ['downloading', 'processing'].includes(job.status)
    ? { ...job, status: 'failed', error: 'The browser or companion restarted. Analyze the video and retry.' } : job);
  const preference = await chrome.storage.local.get('capturePaused');
  capturePaused = preference.capturePaused ?? result.capturePaused === true;
  capture.paused = capturePaused;
  if (await chrome.permissions.contains({ origins: SCAN_ORIGINS }) && result.captureSession) {
    try { const tab = await chrome.tabs.get(result.captureSession.tabId); capture.restore({ ...result.captureSession, url: tab.url, epoch: 0 }); } catch { capture.stop(); }
  }
});
importScripts('automatic.js');

// Register synchronously so network events can wake a suspended MV3 worker.
const observedUrls = { urls: SCAN_ORIGINS };
chrome.webRequest.onBeforeRequest.addListener(details => { void ready.then(() => capture.before(details)); }, observedUrls);
chrome.webRequest.onBeforeSendHeaders.addListener(details => { void ready.then(() => capture.headers(details)); }, observedUrls, ['requestHeaders', 'extraHeaders']);
chrome.webRequest.onResponseStarted.addListener(details => { void ready.then(() => capture.response(details)); }, observedUrls, ['responseHeaders']);
for (const event of [chrome.webRequest.onCompleted, chrome.webRequest.onErrorOccurred]) event.addListener(details => { void ready.then(() => capture.done(details)); }, observedUrls);
chrome.permissions.onRemoved.addListener(() => { void chrome.permissions.contains({ origins: SCAN_ORIGINS }).then(granted => { if (!granted) { capture.stop(); pausePreparation(); } }); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url && navigationUrls.get(tabId) !== change.url) {
    navigationUrls.set(tabId, change.url);
    resetPreparation(tabId);
    capture.navigate(tabId, change.url); capture.clearTab(tabId);
  }
  if (change.url || change.status === 'complete') hintPreparation(tabId);
});

async function scanStatus(tabId) {
  const enabled = await chrome.permissions.contains({ origins: SCAN_ORIGINS });
  if (!enabled && capture.session) capture.stop();
  return { enabled, active: enabled && !capturePaused, count: preparedSnapshot(tabId).count };
}

function withSourceChoices(media, set, selected) {
  return { ...media, sourceIndex: selected, detectedSources: set.sources.map((source, index) => ({ index,
    label: (source.kind === 'paired' ? 'بث مدمج' : source.kind === 'hls' ? 'HLS' : source.kind === 'dash' ? 'DASH' : source.kind === 'file' ? 'فيديو' : 'مشغّل') + ' · ' + new URL(source.url).hostname + ' · ' + (index + 1) })) };
}

async function readIdentity(scope) {
  try {
    const [frame] = await chrome.scripting.executeScript({ target: scope.target, world: 'MAIN', func: snapshotPlayerIdentity, args: [scope.videoIndex ?? null] });
    return typeof frame?.result === 'string' ? JSON.stringify([frame.documentId, frame.frameId, frame.result]) : null;
  } catch { return null; }
}

function startAnalysis(tabId, url, inspect, { automatic = false, select = true, signal } = {}) {
  const controller = new AbortController();
  const entry = { tabId, url, automatic, controller, generation: preparationGeneration(tabId), scope: { target: { tabId, frameIds: [0] } } };
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  activeInspections.add(entry);
  const deadline = setTimeout(() => controller.abort(new Error('انتهت مهلة تجهيز الفيديو. اضغط تحديث للمحاولة مجددًا.')), automatic ? 35000 : 100000);
  setPreparationStatus(tabId, 'analyzing');
  entry.promise = (async () => {
    controller.signal.throwIfAborted();
    entry.identity = await readIdentity(entry.scope);
    const media = await inspect(entry);
    controller.signal.throwIfAborted();
    if (entry.generation !== preparationGeneration(tabId) || (await chrome.tabs.get(tabId)).url !== url) throw new Error('تغيّرت الصفحة أثناء الفحص.');
    if (entry.identity && entry.identity !== await readIdentity(entry.scope)) throw new Error('تغيّر الفيديو أثناء الفحص. اضغط تحديث للفيديو الحالي.');
    if (automatic && !media.options?.length) throw new Error('لم تظهر جودات قابلة للتحميل بعد.');
    entry.media = media;
    if (Number.isInteger(media.sourceIndex)) entry.sources = sourceChoices.get(tabId);
    rememberPrepared(entry);
    return media;
  })().finally(() => { clearTimeout(deadline); activeInspections.delete(entry); signal?.removeEventListener('abort', abort); });
  if (select) analyses.set(tabId, entry);
  entry.promise.catch(error => {
    if (analyses.get(tabId) === entry) analyses.delete(tabId);
    if ((!controller.signal.aborted || controller.signal.reason?.name !== 'AbortError') && entry.generation === preparationGeneration(tabId)) setPreparationStatus(tabId, 'error', error.message);
  });
  if (analyses.size > 32) resetPreparation(analyses.keys().next().value);
  return entry;
}

async function reuseAnalysis(entry) {
  if (!analysisCache || !entry.identity || entry.identity !== await readIdentity(entry.scope)) return false;
  if (!(await request('cachedMedia', { token: entry.media.token })).available) return false;
  const source = browserSources.get(entry.media.token);
  if (entry.media.browser && !source) return false;
  if (source) {
    const [frame] = await chrome.scripting.executeScript({ target: source.target, world: 'MAIN', func: browserFrameFile, args: ['available', { url: source.url, videoIndex: source.videoIndex, catalogId: source.catalogId }] });
    if (!frame?.result?.available) return false;
  }
  return entry.identity === await readIdentity(entry.scope);
}

async function inspectSource(tabId, url, set, index, entry) {
  const source = set.sources[index];
  if (!source || (await chrome.tabs.get(tabId)).url !== url) throw new Error('تغيّرت الصفحة أو انتهت نتائج الفحص. اضغط تحديث.');
  if (entry) {
    entry.scope = { target: { tabId, ...(source.documentId ? { documentIds: [source.documentId] } : { frameIds: [source.frameId || 0] }) }, videoIndex: source.videoIndex };
    entry.frameId = source.frameId || 0;
    entry.group = source.group;
    entry.identity = await readIdentity(entry.scope);
  }
  const context = sourceContext ? { userAgent: source.userAgent, origin: source.origin } : {};
  let media;
  try {
    const payload = { url: source.url, referer: source.referer, title: source.title, ...context };
    if (source.audioUrl) {
      payload.audioUrl = source.audioUrl;
      if (source.audioReferer) payload.audioReferer = source.audioReferer;
    }
    media = await request('inspect', payload, 90000, entry?.controller.signal);
  }
  catch (error) {
    entry?.controller.signal.throwIfAborted();
    if (['DRM_PROTECTED', 'MISSING_MEDIA_TRACKS'].includes(error.code)) throw error;
    if (source.kind === 'embed' || source.kind !== 'file' && mediaKind(source.url) !== 'file') throw error;
    if (!browserTransfer) throw new Error('هذا الفيديو يحتاج النقل عبر المتصفح. شغّل Update.cmd ثم أعد تحميل الإضافة.');
    const target = { tabId, ...(source.documentId ? { documentIds: [source.documentId] } : { frameIds: [source.frameId || 0] }) };
    const [probe] = await chrome.scripting.executeScript({ target, world: 'MAIN', func: browserFrameFile, args: ['probe', { key: crypto.randomUUID(), url: source.url, videoIndex: source.videoIndex }] });
    if (!probe?.result) throw new Error('The video frame stopped responding. Start playback again and refresh.');
    if (probe.result.error) throw new Error(probe.result.error);
    if (!browserQualities) throw new Error('عرض جودات المشغّل يحتاج البرنامج المساعد الجديد. شغّل Update.cmd ثم أعد تحميل الإضافة بعد انتهاء التحميلات.');
    media = await request('prepareBrowser', { metadata: probe.result });
    if (media.options.length !== probe.result.variants.length) throw new Error('The companion returned mismatched browser qualities. Update the companion and retry.');
    browserSources.set(media.token, { target: { tabId, ...(probe.documentId ? { documentIds: [probe.documentId] } : { frameIds: [source.frameId || 0] }) }, url: source.url, videoIndex: source.videoIndex, pageUrl: url, catalogId: probe.result.catalogId,
      choices: media.options.map((choice, variantIndex) => ({ id: choice.id, variantIndex, total: probe.result.variants[variantIndex].bytes })) });
    if (browserSources.size > 32) expirePrepared(browserSources.keys().next().value);
  }
  if ((await chrome.tabs.get(tabId)).url !== url || sourceChoices.get(tabId) !== set) throw new Error('تغيّرت الصفحة أثناء الفحص. اضغط تحديث على الفيديو الجديد.');
  return withSourceChoices(media, set, index);
}

async function feedBrowserJob(job, source) {
  const task = { ...source, key: crypto.randomUUID(), stopped: false };
  browserJobs.set(job.id, task);
  let offset = 0;
  try {
    while (!task.stopped) {
      if ((await chrome.tabs.get(task.target.tabId)).url !== task.pageUrl) throw new Error('The video page changed during the browser download.');
      const [response] = await chrome.scripting.executeScript({ target: task.target, world: 'MAIN', func: browserFrameFile, args: ['read', { key: task.key, url: task.url, total: task.total, videoIndex: task.videoIndex, catalogId: task.catalogId, variantIndex: task.variantIndex }] });
      if (!response?.result) throw new Error('The video frame closed.');
      if (response.result.error) throw new Error(response.result.error);
      for (const data of response.result.chunks) {
        if (task.stopped) break;
        const acknowledgement = await request('browserChunk', { jobId: job.id, offset, data });
        offset = acknowledgement.received;
      }
      if (!task.stopped && response.result.done) { await request('browserFinish', { jobId: job.id }); return; }
    }
  } catch (error) { if (!task.stopped) await request('browserAbort', { jobId: job.id, error: error.message }).catch(() => {}); }
  finally {
    browserJobs.delete(job.id);
    await chrome.scripting.executeScript({ target: task.target, world: 'MAIN', func: browserFrameFile, args: ['cancel', { key: task.key, url: task.url }] }).catch(() => {});
  }
}

function saveJobs() { return chrome.storage.session.set({ jobs: jobs.slice(-30) }); }
function saveDestination(value) {
  destination = { ...destination, ...value };
  return chrome.storage.session.set({ destination });
}

function connect() {
  if (nativePort) return nativePort;
  const port = chrome.runtime.connectNative(HOST);
  nativePort = port;
  port.onMessage.addListener(message => {
    if (message.event === 'mediaExpired') { expirePrepared(message.token); return; }
    if (message.event === 'job') {
      const index = jobs.findIndex(job => job.id === message.job.id);
      if (index >= 0) jobs[index] = message.job;
      else jobs.push(message.job);
      void saveJobs();
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer); request.cleanup?.();
    pending.delete(message.id);
    if (request.cancelled) request.reject(request.cancelled);
    else if (message.ok) request.resolve(message.data);
    else {
      const detail = message.code === 'DRM_PROTECTED' ? protectedVideoMessage : message.code === 'MISSING_MEDIA_TRACKS' ? missingTracksMessage : message.error;
      request.reject(Object.assign(new Error(detail || 'The companion could not complete this request.'), { code: message.code, hasVideo: message.hasVideo, hasAudio: message.hasAudio }));
    }
  });
  port.onDisconnect.addListener(() => {
    const detail = chrome.runtime.lastError?.message;
    nativePort = null;
    companionReady = null;
    cancelInspection = false;
    pausePreparation('تعذّر الاتصال بالبرنامج المساعد. أعد الاتصال أو شغّل Update.cmd.');
    for (const task of browserJobs.values()) {
      task.stopped = true;
      void chrome.scripting.executeScript({ target: task.target, world: 'MAIN', func: browserFrameFile, args: ['cancel', { key: task.key, url: task.url }] }).catch(() => {});
    }
    analyses.clear();
    sourceChoices.clear(); browserSources.clear();
    const error = new Error(`تعذّر الاتصال بالبرنامج المساعد. شغّل Install.cmd ثم أعد المحاولة.${detail ? ` (${detail})` : ''}`);
    for (const request of pending.values()) { clearTimeout(request.timer); request.cleanup?.(); request.reject(error); }
    pending.clear();
    destinationEpoch++;
    void saveDestination({ choosingFolder: false });
    jobs = jobs.map(job => ['downloading', 'processing'].includes(job.status)
      ? { ...job, status: 'failed', error: 'The companion disconnected. Analyze the video and retry.' } : job);
    void saveJobs();
  });
  return port;
}

function request(action, data = {}, timeout = 100000, signal) {
  const run = () => new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const id = String(++nextId);
    const port = connect();
    const cancel = () => {
      if (action === 'inspect' && cancelInspection) {
        try { port.postMessage({ id: String(++nextId), action: 'cancelInspection', requestId: id }); } catch {}
      }
    };
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const abort = () => {
      cancel(); cleanup();
      if (action === 'inspect' && pending.has(id)) {
        // Keep the inspection slot until the native process acknowledges its
        // cancellation; otherwise a replacement can hit the host's two-job cap.
        pending.get(id).cancelled = signal.reason;
      } else { clearTimeout(timer); pending.delete(id); reject(signal.reason); }
    };
    const timer = timeout ? setTimeout(() => { cancel(); cleanup(); pending.delete(id); reject(new Error('انتهت مهلة الطلب. أعد المحاولة.')); }, timeout) : null;
    signal?.addEventListener('abort', abort, { once: true });
    pending.set(id, { resolve, reject, timer, cleanup });
    try { port.postMessage({ ...data, id, action }); }
    catch (error) { clearTimeout(timer); cleanup(); pending.delete(id); reject(error); }
  });
  return action === 'inspect' ? inspectionSlots.use(run, signal) : run();
}

function ensureCompanion(automatic = false) {
  if (automatic && Date.now() < companionRetryAt) return Promise.reject(companionConnectionError);
  return companionReady ||= request('ping', {}, 20000).then(companion => {
    companionRetryAt = 0;
    pageSources = companion.capabilities?.pageSources === true;
    sourceContext = companion.capabilities?.sourceContext === true;
    browserTransfer = companion.capabilities?.browserTransfer === true;
    browserQualities = companion.capabilities?.browserQualities === true;
    analysisCache = companion.capabilities?.analysisCache === true;
    pairedStreams = companion.capabilities?.pairedStreams === true;
    cancelInspection = companion.capabilities?.cancelInspection === true;
    return companion;
  }).catch(error => { companionReady = null; companionConnectionError = error; companionRetryAt = Date.now() + 15000; throw error; });
}

async function collectSources(tabId, url) {
  // Inspect only frames Chrome permits (activeTab and optional player grants).
  let frames;
  try { frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: discoverPageMedia }); }
  catch {
    throw new Error('تعذّر فحص الصفحة المفتوحة. افتح الإضافة من أيقونتها على صفحة الفيديو وأعد المحاولة.\n');
  }
  const current = await chrome.tabs.get(tabId);
  const main = frames.find(frame => frame.frameId === 0)?.result;
  if (current.url !== url || main?.pageUrl !== url) throw new Error('تغيّرت الصفحة أثناء الفحص. اضغط تحديث على الفيديو الجديد.');
  if (main.hasDrm) throw new Error(protectedVideoMessage);
  const origins = [...new Set(frames.flatMap(frame => frame.result?.playerOrigins || []))];
  const seen = new Set([url]);
  const protectedFrames = new Set(frames.filter(frame => frame.result?.hasDrm).map(frame => frame.frameId));
  const captured = capture.read(tabId, url).filter(source => !protectedFrames.has(source.frameId));
  const snapshots = frames.flatMap(frame => frame.result?.hasDrm ? [] : (frame.result?.sources || []).map(source => ({ ...source, frameId: frame.frameId, documentId: frame.documentId, title: frame.result?.title || main.title })));
  const snapshotByUrl = new Map(snapshots.map(source => [source.url, source]));
  const embeds = frames.flatMap(frame => frame.result?.hasDrm ? [] : (frame.result?.embeds || []).map(source => {
    // An iframe URL and the stream found inside it describe the same player.
    // Bind both to the child's document instead of counting the wrapper again.
    const child = frames.find(candidate => candidate.result?.pageUrl === source.url);
    return { ...source, frameId: child?.frameId ?? frame.frameId, documentId: child?.documentId ?? frame.documentId,
      videoIndex: child?.result?.videoCount ? child.result.primaryVideoIndex : undefined, title: main.title, kind: 'embed' };
  }));
  const rank = source => Number.isInteger(source.videoIndex) ? -1 : /(?:brightcove\.net|wistia\.net)/i.test(source.url) ? 1 : source.kind === 'embed' ? 5 : (source.kind || mediaKind(source.url)) === 'hls' ? (/(?:master|playlist|manifest|main|index)/i.test(new URL(source.url).pathname) ? 0 : 2) : (source.kind || mediaKind(source.url)) === 'dash' ? 3 : 4;
  const sources = [...captured.map(source => ({ ...snapshotByUrl.get(source.url), ...source, documentId: source.documentId || frames.find(frame => frame.frameId === source.frameId)?.documentId, title: frames.find(frame => frame.frameId === source.frameId)?.result?.title || main.title })), ...snapshots, ...embeds]
    .filter(source => !seen.has(source.url) && seen.add(source.url)).sort((a, b) => rank(a) - rank(b)).slice(0, 20);
  for (const source of sources) {
    const frame = frames.find(frame => frame.frameId === (source.frameId || 0));
    source.frameId ||= 0;
    source.videoIndex ??= frame?.result?.videoCount ? frame.result.primaryVideoIndex : undefined;
    source.group = JSON.stringify([source.documentId || frame?.documentId || source.frameId, source.videoIndex ?? 'frame']);
  }
  const set = { url, sources };
  return { set, frames, main, origins, protectedFrames, captured: captured.length > 0 };
}

async function inspectTab(tabId, url, scanOnly = false, entry) {
  let originalError;
  if (!scanOnly) {
    const [main] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: discoverPageMedia, args: [true] }).catch(() => []);
    if (main?.result?.hasDrm) throw new Error(protectedVideoMessage);
    let media;
    try { media = await request('inspect', { url }, 90000, entry?.controller.signal); }
    catch (error) {
      entry?.controller.signal.throwIfAborted();
      if (error.code === 'DRM_PROTECTED') throw error;
      originalError = error;
    }
    if (media) {
      if ((await chrome.tabs.get(tabId)).url !== url) throw new Error('تغيّرت الصفحة أثناء الفحص. اضغط تحديث على الفيديو الجديد.');
      return media;
    }
  }
  const { set, frames, main, origins, protectedFrames, captured } = entry?.discovery || await collectSources(tabId, url);
  const sources = set.sources;
  sourceChoices.set(tabId, set);
  if (!pageSources) throw new Error('شغّل Update.cmd لتحديث البرنامج المساعد.');
  if (captured && !sourceContext) throw new Error('الفحص الشامل يحتاج البرنامج المساعد الجديد. شغّل Update.cmd.');
  let sourceError;
  const inspectedTracks = [];
  for (let index = 0; index < Math.min(sources.length, 6); index++) {
    entry?.controller.signal.throwIfAborted();
    const latest = await chrome.tabs.get(tabId);
    if (latest.url !== url) throw new Error('تغيّرت الصفحة أثناء الفحص. اضغط تحديث على الفيديو الجديد.');
    let media;
    try { media = await inspectSource(tabId, url, set, index, entry); }
    catch (error) {
      entry?.controller.signal.throwIfAborted();
      if (error.code === 'MISSING_MEDIA_TRACKS') {
        inspectedTracks.push({ index, source: sources[index], hasVideo: Boolean(error.hasVideo), hasAudio: Boolean(error.hasAudio) });
      }
      if (!sourceError || error.code === 'DRM_PROTECTED' || error.code === 'MISSING_MEDIA_TRACKS' && !sourceError.code) sourceError = error;
      continue;
    }
    if ((await chrome.tabs.get(tabId)).url !== url) throw new Error('تغيّرت الصفحة أثناء الفحص. اضغط تحديث على الفيديو الجديد.');
    return media;
  }
  if (pairedStreams) {
    const videoCandidates = inspectedTracks.filter(item => item.hasVideo && !item.hasAudio);
    const audioCandidate = inspectedTracks.find(item => item.hasAudio && !item.hasVideo);
    if (videoCandidates.length && audioCandidate) {
      const pairedSources = videoCandidates.map(v => ({
        ...v.source,
        audioUrl: audioCandidate.source.url,
        audioReferer: audioCandidate.source.referer || v.source.referer,
        kind: 'paired'
      }));
      set.sources.unshift(...pairedSources);
      try {
        const media = await inspectSource(tabId, url, set, 0, entry);
        if ((await chrome.tabs.get(tabId)).url !== url) throw new Error('تغيّرت الصفحة أثناء الفحص. اضغط تحديث على الفيديو الجديد.');
        return media;
      } catch (error) {
        if (error.code === 'DRM_PROTECTED') throw error;
        if (!sourceError || error.code === 'MISSING_MEDIA_TRACKS' && !sourceError.code) sourceError = error;
      }
    }
  }
  if (protectedFrames.size || sourceError?.code === 'DRM_PROTECTED') throw new Error(protectedVideoMessage);
  const hasBlob = main?.hasBlob || frames.some(frame => frame.result?.hasBlob);
  if (browserTransfer && hasBlob && !entry?.automatic) {
    try {
      const target = { tabId, frameIds: [0] };
      const [probe] = await chrome.scripting.executeScript({
        target,
        world: 'MAIN',
        func: browserFrameFile,
        args: ['probe', { key: crypto.randomUUID(), allowMSE: true }]
      });
      if (probe?.result && !probe.result.error && probe.result.variants?.length) {
        if (browserQualities) {
          const media = await request('prepareBrowser', { metadata: probe.result });
          if (media.options.length === probe.result.variants.length) {
            browserSources.set(media.token, {
              target: { tabId, ...(probe.documentId ? { documentIds: [probe.documentId] } : { frameIds: [0] }) },
              url: 'mse://stream',
              videoIndex: 0,
              pageUrl: url,
              catalogId: probe.result.catalogId,
              choices: media.options.map((choice, variantIndex) => ({
                id: choice.id,
                variantIndex,
                total: probe.result.variants[variantIndex].bytes
              }))
            });
            if (browserSources.size > 32) expirePrepared(browserSources.keys().next().value);
            if ((await chrome.tabs.get(tabId)).url !== url) throw new Error('تغيّرت الصفحة أثناء الفحص. اضغط تحديث على الفيديو الجديد.');
            return media;
          }
        }
      } else {
        await chrome.scripting.executeScript({
          target,
          world: 'MAIN',
          func: browserFrameFile,
          args: ['enableMSE', {}]
        }).catch(() => {});
      }
    } catch {
      // Graceful fallback
    }
  }
  const full = await scanStatus(tabId);
  const grants = await Promise.all(origins.map(origin => chrome.permissions.contains({ origins: [origin] })));
  const missingOrigins = origins.filter((_, index) => !grants[index]);
  if (!missingOrigins.length && (sourceError?.code === 'MISSING_MEDIA_TRACKS' || originalError?.code === 'MISSING_MEDIA_TRACKS')) throw new Error(missingTracksMessage);
  const message = full.active
    ? 'الفحص الشامل شغال. أعد تشغيل الفيديو أو غيّر الجودة، ثم اضغط تحديث. لم يظهر بث MP4 أو HLS أو DASH قابل للتحميل حتى الآن؛ بعض المشغّلات تستخدم نقلًا خاصًا غير مدعوم.'
    : hasBlob && browserTransfer
      ? 'لم يظهر رابط بث مباشر قابل للتحميل. تم تفعيل الالتقاط الاحتياطي من الذاكرة (MSE Fallback)؛ شغّل الفيديو لبضع ثوانٍ داخل الصفحة ثم اضغط تحديث.'
      : missingOrigins.length
        ? 'شغّل الفيديو داخل الموقع، وفعّل الفحص التلقائي مرة واحدة للسماح بالوصول للمشغّلات المضمّنة.'
        : 'لم يظهر رابط فيديو قابل للتحميل. شغّل الفيديو ثم اضغط تحديث، أو فعّل الفحص الشامل من أعلى النافذة. بعض المشغّلات والمحتوى المحمي غير مدعومين.';
  const error = new Error(message + '\n' + (sourceError?.message || originalError?.message || ''));
  error.playerOrigins = missingOrigins;
  throw error;
}

async function handle(message) {
  await ready;
  if (message.action === 'preparation') {
    for (const entry of [...(preparedTabs.get(message.tabId)?.records.values() || [])]) {
      entry.validation ||= reuseAnalysis(entry).catch(() => false).finally(() => { delete entry.validation; });
      if (!await entry.validation || message.url && message.url !== entry.url) expirePrepared(entry.media.token);
    }
    return preparedSnapshot(message.tabId);
  }
  if (['captureStatus', 'startCapture', 'stopCapture'].includes(message.action)) {
    if (message.action === 'stopCapture') { capturePaused = true; capture.paused = true; pausePreparation(); capture.tabSources.clear(); await chrome.storage.local.set({ capturePaused }); capture.stop(); return scanStatus(message.tabId); }
    if (message.action === 'startCapture') {
      if (!Number.isInteger(message.tabId) || !(await scanStatus(message.tabId)).enabled) throw new Error('فعّل الفحص الشامل واسمح بالصلاحية أولًا.');
      const tab = await chrome.tabs.get(message.tabId);
      if (tab.url !== message.url || !/^https?:\/\//i.test(tab.url)) throw new Error('افتح صفحة الفيديو وأعد المحاولة.');
      capturePaused = false; capture.paused = false; await chrome.storage.local.set({ capturePaused });
      hintPreparation(message.tabId, true);
    }
    return scanStatus(message.tabId);
  }
  if (message.action === 'bootstrap') {
    const epoch = destinationEpoch;
    const companion = await ensureCompanion();
    if (epoch === destinationEpoch) await saveDestination({ downloadDir: companion.downloadDir, choosingFolder: !!companion.choosingFolder });
    const current = await request('status');
    for (const job of current) {
      const index = jobs.findIndex(item => item.id === job.id);
      if (index >= 0) jobs[index] = job;
      else jobs.push(job);
    }
    await saveJobs();
    return { companion: { ...companion, ...destination }, jobs };
  }
  if (message.action === 'analyze' || message.action === 'selectSource') {
    if (!Number.isInteger(message.tabId)) throw new Error('افتح صفحة الفيديو أولًا.');
    const tab = await chrome.tabs.get(message.tabId);
    if (tab.url !== message.url) throw new Error('تغيّرت الصفحة. أعد فتح الإضافة.');
    if (message.action === 'selectSource') {
      if (typeof message.sourceIndex === 'string' && message.sourceIndex.startsWith('ready:')) {
        const entry = [...(preparedTabs.get(message.tabId)?.records.values() || [])].find(entry => 'ready:' + entry.media.token === message.sourceIndex);
        if (!entry || !await reuseAnalysis(entry)) {
          if (entry) expirePrepared(entry.media.token);
          hintPreparation(message.tabId, true);
          throw new Error('انتهت صلاحية الاختيار. يجري تجهيز الفيديو مجددًا.');
        }
        analyses.set(message.tabId, entry); publishPreparation(message.tabId);
        return presentedMedia(message.tabId, entry.media);
      }
      const set = sourceChoices.get(message.tabId);
      if (!set || set.url !== tab.url || !Number.isInteger(message.sourceIndex)) throw new Error('انتهت نتائج الفحص. اضغط تحديث.');
      return startAnalysis(message.tabId, tab.url, entry => inspectSource(message.tabId, tab.url, set, message.sourceIndex, entry)).promise;
    }
    if (message.refresh) resetPreparation(message.tabId);
    const preparation = preparationQueue.jobs.get(message.tabId);
    if (!message.refresh && !analyses.has(message.tabId) && preparation) {
      preparationQueue.schedule(message.tabId, { immediate: true, priority: 2 });
      await preparation.promise;
    }
    if (!analyses.has(message.tabId)) {
      const retained = preparedTabs.get(message.tabId)?.records.values().next().value;
      if (retained) analyses.set(message.tabId, retained);
    }
    let entry = analyses.get(message.tabId);
    if (message.refresh || entry?.url !== message.url) entry = null;
    if (entry?.media) {
      // Concurrent popup openings share this validation and any required rescan.
      entry.validation ||= reuseAnalysis(entry).catch(() => false).finally(() => { delete entry.validation; });
      const reusable = await entry.validation;
      if ((await chrome.tabs.get(message.tabId)).url !== message.url) throw new Error('تغيّرت الصفحة. أعد فتح الإضافة.');
      if (analyses.get(message.tabId) !== entry) entry = analyses.get(message.tabId);
      else if (reusable) {
        analyses.delete(message.tabId); analyses.set(message.tabId, entry);
        if (entry.sources) {
          sourceChoices.delete(message.tabId); sourceChoices.set(message.tabId, entry.sources);
          if (sourceChoices.size > 32) sourceChoices.delete(sourceChoices.keys().next().value);
        }
        return presentedMedia(message.tabId, entry.media);
      } else { expirePrepared(entry.media.token); entry = null; }
    }
    if (!entry) {
      entry = startAnalysis(message.tabId, message.url, current => inspectTab(message.tabId, message.url, message.scanPlayer === true, current));
    }
    return presentedMedia(message.tabId, await entry.promise);
  }
  if (message.action === 'download') {
    const browserSource = browserSources.get(message.token);
    if (browserSource && (await chrome.tabs.get(browserSource.target.tabId)).url !== browserSource.pageUrl) throw new Error('تغيّرت الصفحة. أعد فحص الفيديو قبل التحميل.');
    const browserChoice = browserSource?.choices.find(choice => choice.id === message.choice);
    if (browserSource && !browserChoice) throw new Error('انتهى اختيار الجودة. أعد فحص الفيديو واختر الجودة مرة أخرى.');
    const job = await request('download', { token: message.token, choice: message.choice });
    const index = jobs.findIndex(item => item.id === job.id);
    if (index < 0) jobs.push(job);
    await saveJobs();
    if (browserSource) void feedBrowserJob(job, { ...browserSource, ...browserChoice });
    return job;
  }
  if (message.action === 'cancel') {
    const task = browserJobs.get(message.jobId);
    if (task) {
      task.stopped = true;
      void chrome.scripting.executeScript({ target: task.target, world: 'MAIN', func: browserFrameFile, args: ['cancel', { key: task.key, url: task.url }] }).catch(() => {});
    }
    return request('cancel', { jobId: message.jobId });
  }
  if (message.action === 'chooseFolder') {
    if (destination.choosingFolder) throw new Error('اختيار المجلد مفتوح بالفعل. أكمل الاختيار أو ألغِه.');
    destinationEpoch++;
    await saveDestination({ choosingFolder: true });
    try {
      const result = await request('chooseFolder', {}, 0);
      destinationEpoch++;
      await saveDestination({ downloadDir: result.downloadDir, choosingFolder: false });
      return result;
    } finally { await saveDestination({ choosingFolder: false }); }
  }
  if (message.action === 'openFolder') {
    const job = message.jobId ? jobs.find(item => item.id === message.jobId) : null;
    if (message.jobId && !job) throw new Error('التحميل غير موجود في سجل الجلسة.');
    return request('openFolder', { jobId: message.jobId, knownDownloadDir: job?.downloadDir });
  }
  throw new Error('Unknown extension action.');
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.action === 'playerChanged' && sender.id === chrome.runtime.id && Number.isInteger(sender.tab?.id)) {
    void invalidateChangedPlayers(sender.tab.id, sender.frameId).then(() => hintPreparation(sender.tab.id));
    respond({ ok: true }); return false;
  }
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  handle(message).then(data => respond({ ok: true, data })).catch(error => respond({ ok: false, error: error.message, playerOrigins: error.playerOrigins || [] }));
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => { resetPreparation(tabId); generations.delete(tabId); navigationUrls.delete(tabId); capture.clearTab(tabId); if (capture.active(tabId)) capture.stop(); });
