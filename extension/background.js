'use strict';

importScripts('discovery.js');
importScripts('capture.js');
importScripts('browser-transfer.js');
importScripts('player-identity.js');

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
let capturePaused = false;
const pending = new Map();
const analyses = new Map();
const sourceChoices = new Map();
const browserSources = new Map();
const browserJobs = new Map();
const capture = new CaptureSession({
  save: value => { void chrome.storage.session.set({ captureSession: value }).catch(() => {}); },
  // Capture traffic is not player identity: advertisements and later byte ranges
  // must not discard successful results (or detach an in-flight inspection).
  changed: (tabId, reset) => { if (reset && !analyses.has(tabId)) sourceChoices.delete(tabId); },
});
let jobs = [];
let destination = { downloadDir: '', choosingFolder: false };
let destinationEpoch = 0;
const ready = chrome.storage.session.get(['jobs', 'destination', 'captureSession', 'capturePaused']).then(async result => {
  destination = { ...destination, ...result.destination, choosingFolder: false };
  jobs = (result.jobs || []).map(job => ['downloading', 'processing'].includes(job.status)
    ? { ...job, status: 'failed', error: 'The browser or companion restarted. Analyze the video and retry.' } : job);
  capturePaused = result.capturePaused === true;
  if (await chrome.permissions.contains({ origins: SCAN_ORIGINS }) && result.captureSession) {
    try { const tab = await chrome.tabs.get(result.captureSession.tabId); capture.restore({ ...result.captureSession, url: tab.url, epoch: 0 }); } catch { capture.stop(); }
  }
});

// Register synchronously so network events can wake a suspended MV3 worker.
const observedUrls = { urls: SCAN_ORIGINS };
chrome.webRequest.onBeforeRequest.addListener(details => { void ready.then(() => capture.before(details)); }, observedUrls);
chrome.webRequest.onBeforeSendHeaders.addListener(details => { void ready.then(() => capture.headers(details)); }, observedUrls, ['requestHeaders', 'extraHeaders']);
chrome.webRequest.onResponseStarted.addListener(details => { void ready.then(() => capture.response(details)); }, observedUrls, ['responseHeaders']);
for (const event of [chrome.webRequest.onCompleted, chrome.webRequest.onErrorOccurred]) event.addListener(details => { void ready.then(() => capture.done(details)); }, observedUrls);
chrome.permissions.onRemoved.addListener(() => { void chrome.permissions.contains({ origins: SCAN_ORIGINS }).then(granted => { if (!granted) capture.stop(); }); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url) return;
  if (analyses.get(tabId)?.url !== change.url) { analyses.delete(tabId); sourceChoices.delete(tabId); }
  if (capture.session?.url !== change.url) capture.navigate(tabId, change.url);
});

async function scanStatus(tabId) {
  const enabled = await chrome.permissions.contains({ origins: SCAN_ORIGINS });
  if (!enabled && capture.session) capture.stop();
  return { enabled, active: enabled && capture.active(tabId), count: capture.active(tabId) ? capture.sources.size : 0 };
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

function startAnalysis(tabId, url, inspect) {
  const entry = { url, scope: { target: { tabId, frameIds: [0] } } };
  entry.promise = (async () => {
    entry.identity = await readIdentity(entry.scope);
    const media = await inspect(entry);
    if (entry.identity && entry.identity !== await readIdentity(entry.scope)) throw new Error('تغيّر الفيديو أثناء الفحص. اضغط تحديث للفيديو الحالي.');
    entry.media = media;
    if (Number.isInteger(media.sourceIndex)) entry.sources = sourceChoices.get(tabId);
    return media;
  })();
  analyses.set(tabId, entry);
  entry.promise.catch(() => { if (analyses.get(tabId) === entry) analyses.delete(tabId); });
  if (analyses.size > 8) analyses.delete(analyses.keys().next().value);
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
    media = await request('inspect', payload);
  }
  catch (error) {
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
    if (browserSources.size > 8) browserSources.delete(browserSources.keys().next().value);
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
    if (message.event === 'job') {
      const index = jobs.findIndex(job => job.id === message.job.id);
      if (index >= 0) jobs[index] = message.job;
      else jobs.push(message.job);
      void saveJobs();
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.ok) request.resolve(message.data);
    else {
      const detail = message.code === 'DRM_PROTECTED' ? protectedVideoMessage : message.code === 'MISSING_MEDIA_TRACKS' ? missingTracksMessage : message.error;
      request.reject(Object.assign(new Error(detail || 'The companion could not complete this request.'), { code: message.code, hasVideo: message.hasVideo, hasAudio: message.hasAudio }));
    }
  });
  port.onDisconnect.addListener(() => {
    const detail = chrome.runtime.lastError?.message;
    nativePort = null;
    for (const task of browserJobs.values()) {
      task.stopped = true;
      void chrome.scripting.executeScript({ target: task.target, world: 'MAIN', func: browserFrameFile, args: ['cancel', { key: task.key, url: task.url }] }).catch(() => {});
    }
    analyses.clear();
    sourceChoices.clear(); browserSources.clear();
    const error = new Error(`تعذّر الاتصال بالبرنامج المساعد. شغّل Install.cmd ثم أعد المحاولة.${detail ? ` (${detail})` : ''}`);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
    destinationEpoch++;
    void saveDestination({ choosingFolder: false });
    jobs = jobs.map(job => ['downloading', 'processing'].includes(job.status)
      ? { ...job, status: 'failed', error: 'The companion disconnected. Analyze the video and retry.' } : job);
    void saveJobs();
  });
  return port;
}

function request(action, data = {}, timeout = 100000) {
  return new Promise((resolve, reject) => {
    const id = String(++nextId);
    const port = connect();
    const timer = timeout ? setTimeout(() => { pending.delete(id); reject(new Error('انتهت مهلة الطلب. أعد المحاولة.')); }, timeout) : null;
    pending.set(id, { resolve, reject, timer });
    try { port.postMessage({ ...data, id, action }); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
}

async function inspectTab(tabId, url, scanOnly = false, entry) {
  let originalError;
  if (!scanOnly) {
    const [main] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: discoverPageMedia, args: [true] }).catch(() => []);
    if (main?.result?.hasDrm) throw new Error(protectedVideoMessage);
    let media;
    try { media = await request('inspect', { url }); }
    catch (error) {
      if (error.code === 'DRM_PROTECTED') throw error;
      originalError = error;
    }
    if (media) {
      if ((await chrome.tabs.get(tabId)).url !== url) throw new Error('تغيّرت الصفحة أثناء الفحص. اضغط تحديث على الفيديو الجديد.');
      return media;
    }
  }
  // Inspect only frames Chrome permits (activeTab and optional player grants).
  let frames;
  try { frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: discoverPageMedia }); }
  catch {
    throw new Error('تعذّر فحص الصفحة المفتوحة. افتح الإضافة من أيقونتها على صفحة الفيديو وأعد المحاولة.\n' + (originalError?.message || ''));
  }
  const current = await chrome.tabs.get(tabId);
  const main = frames.find(frame => frame.frameId === 0)?.result;
  if (current.url !== url || main?.pageUrl !== url) throw new Error('تغيّرت الصفحة أثناء الفحص. اضغط تحديث على الفيديو الجديد.');
  if (main.hasDrm) throw new Error(protectedVideoMessage);
  const origins = [...new Set(frames.flatMap(frame => frame.result?.playerOrigins || []))];
  if (!pageSources) throw new Error('البرنامج المساعد المثبّت لا يدعم فحص المشغّل. شغّل Update.cmd من نسخة المشروع الجديدة، ثم أعد تحميل الإضافة بعد انتهاء التحميلات.');
  const seen = new Set([url]);
  const protectedFrames = new Set(frames.filter(frame => frame.result?.hasDrm).map(frame => frame.frameId));
  const captured = capture.read(tabId, url).filter(source => !protectedFrames.has(source.frameId));
  if (captured.length && !sourceContext) throw new Error('الفحص الشامل يحتاج البرنامج المساعد الجديد. شغّل Update.cmd ثم أعد تحميل الإضافة بعد انتهاء التحميلات.');
  const snapshots = frames.flatMap(frame => frame.result?.hasDrm ? [] : (frame.result?.sources || []).map(source => ({ ...source, frameId: frame.frameId, documentId: frame.documentId, title: frame.result?.title || main.title })));
  const snapshotByUrl = new Map(snapshots.map(source => [source.url, source]));
  const embeds = frames.flatMap(frame => frame.result?.hasDrm ? [] : (frame.result?.embeds || []).map(source => ({ ...source, title: main.title, kind: 'embed' })));
  const rank = source => /(?:brightcove\.net|wistia\.net)/i.test(source.url) ? 1 : source.kind === 'embed' ? 5 : (source.kind || mediaKind(source.url)) === 'hls' ? (/(?:master|playlist|manifest|main|index)/i.test(new URL(source.url).pathname) ? 0 : 2) : (source.kind || mediaKind(source.url)) === 'dash' ? 3 : 4;
  const sources = [...captured.map(source => ({ ...snapshotByUrl.get(source.url), ...source, documentId: source.documentId || frames.find(frame => frame.frameId === source.frameId)?.documentId, title: frames.find(frame => frame.frameId === source.frameId)?.result?.title || main.title })), ...snapshots, ...embeds]
    .filter(source => !seen.has(source.url) && seen.add(source.url)).sort((a, b) => rank(a) - rank(b)).slice(0, 20);
  const set = { url, sources };
  sourceChoices.set(tabId, set);
  if (sourceChoices.size > 8) sourceChoices.delete(sourceChoices.keys().next().value);
  let sourceError;
  const inspectedTracks = [];
  for (let index = 0; index < Math.min(sources.length, 6); index++) {
    const latest = await chrome.tabs.get(tabId);
    if (latest.url !== url) throw new Error('تغيّرت الصفحة أثناء الفحص. اضغط تحديث على الفيديو الجديد.');
    let media;
    try { media = await inspectSource(tabId, url, set, index, entry); }
    catch (error) {
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
  const full = await scanStatus(tabId);
  const grants = await Promise.all(origins.map(origin => chrome.permissions.contains({ origins: [origin] })));
  const missingOrigins = origins.filter((_, index) => !grants[index]);
  if (!missingOrigins.length && (sourceError?.code === 'MISSING_MEDIA_TRACKS' || originalError?.code === 'MISSING_MEDIA_TRACKS')) throw new Error(missingTracksMessage);
  const message = full.active ? 'الفحص الشامل شغال. أعد تشغيل الفيديو أو غيّر الجودة، ثم اضغط تحديث. لم يظهر بث MP4 أو HLS أو DASH قابل للتحميل حتى الآن؛ بعض المشغّلات تستخدم نقلًا خاصًا غير مدعوم.' : missingOrigins.length ? 'شغّل الفيديو داخل الموقع، وفعّل الفحص التلقائي مرة واحدة للسماح بالوصول للمشغّلات المضمّنة.' : 'لم يظهر رابط فيديو قابل للتحميل. شغّل الفيديو ثم اضغط تحديث، أو فعّل الفحص الشامل من أعلى النافذة. بعض المشغّلات والمحتوى المحمي غير مدعومين.';
  const error = new Error(message + '\n' + (sourceError?.message || originalError?.message || ''));
  error.playerOrigins = missingOrigins;
  throw error;
}

async function handle(message) {
  await ready;
  if (['captureStatus', 'startCapture', 'stopCapture'].includes(message.action)) {
    if (message.action === 'stopCapture') { capturePaused = true; await chrome.storage.session.set({ capturePaused }); capture.stop(); return scanStatus(message.tabId); }
    if (message.action === 'startCapture') {
      if (!Number.isInteger(message.tabId) || !(await scanStatus(message.tabId)).enabled) throw new Error('فعّل الفحص الشامل واسمح بالصلاحية أولًا.');
      const tab = await chrome.tabs.get(message.tabId);
      if (tab.url !== message.url || !/^https?:\/\//i.test(tab.url)) throw new Error('افتح صفحة الفيديو وأعد المحاولة.');
      capture.select(message.tabId, tab.url);
      capturePaused = false; await chrome.storage.session.set({ capturePaused });
    }
    return scanStatus(message.tabId);
  }
  if (message.action === 'bootstrap') {
    const epoch = destinationEpoch;
    const companion = await request('ping', {}, 20000);
    pageSources = companion.capabilities?.pageSources === true;
    sourceContext = companion.capabilities?.sourceContext === true;
    browserTransfer = companion.capabilities?.browserTransfer === true;
    browserQualities = companion.capabilities?.browserQualities === true;
    analysisCache = companion.capabilities?.analysisCache === true;
    pairedStreams = companion.capabilities?.pairedStreams === true;
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
      const set = sourceChoices.get(message.tabId);
      if (!set || set.url !== tab.url || !Number.isInteger(message.sourceIndex)) throw new Error('انتهت نتائج الفحص. اضغط تحديث.');
      return startAnalysis(message.tabId, tab.url, entry => inspectSource(message.tabId, tab.url, set, message.sourceIndex, entry)).promise;
    }
    if (!capturePaused && (await scanStatus(message.tabId)).enabled) capture.select(message.tabId, tab.url);
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
          if (sourceChoices.size > 8) sourceChoices.delete(sourceChoices.keys().next().value);
        }
        return entry.media;
      } else entry = null;
    }
    if (!entry) {
      entry = startAnalysis(message.tabId, message.url, current => inspectTab(message.tabId, message.url, message.scanPlayer === true, current));
    }
    return entry.promise;
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
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  handle(message).then(data => respond({ ok: true, data })).catch(error => respond({ ok: false, error: error.message, playerOrigins: error.playerOrigins || [] }));
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => { analyses.delete(tabId); sourceChoices.delete(tabId); if (capture.active(tabId)) capture.stop(); });
