'use strict';

const HOST = 'com.vidrush.companion';
let nativePort;
let nextId = 0;
const pending = new Map();
const analyses = new Map();
let jobs = [];
let destination = { downloadDir: '', choosingFolder: false };
let destinationEpoch = 0;
const ready = chrome.storage.session.get(['jobs', 'destination']).then(result => {
  destination = { ...destination, ...result.destination, choosingFolder: false };
  jobs = (result.jobs || []).map(job => ['downloading', 'processing'].includes(job.status)
    ? { ...job, status: 'failed', error: 'The browser or companion restarted. Analyze the video and retry.' } : job);
});

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
    else request.reject(new Error(message.error || 'The companion could not complete this request.'));
  });
  port.onDisconnect.addListener(() => {
    const detail = chrome.runtime.lastError?.message;
    nativePort = null;
    analyses.clear();
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

async function handle(message) {
  await ready;
  if (message.action === 'bootstrap') {
    const epoch = destinationEpoch;
    const companion = await request('ping', {}, 20000);
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
  if (message.action === 'analyze') {
    if (!Number.isInteger(message.tabId)) throw new Error('افتح صفحة الفيديو أولًا.');
    const tab = await chrome.tabs.get(message.tabId);
    if (tab.url !== message.url) throw new Error('تغيّرت الصفحة. أعد فتح الإضافة.');
    let entry = analyses.get(message.tabId);
    if (message.refresh || entry?.url !== message.url) entry = null;
    if (!entry) {
      entry = { url: message.url, promise: request('inspect', { url: message.url }) };
      analyses.set(message.tabId, entry);
      entry.promise.catch(() => { if (analyses.get(message.tabId) === entry) analyses.delete(message.tabId); });
      if (analyses.size > 8) analyses.delete(analyses.keys().next().value);
    }
    return entry.promise;
  }
  if (message.action === 'download') {
    const job = await request('download', { token: message.token, choice: message.choice });
    const index = jobs.findIndex(item => item.id === job.id);
    if (index < 0) jobs.push(job);
    await saveJobs();
    return job;
  }
  if (message.action === 'cancel') return request('cancel', { jobId: message.jobId });
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
  if (message.action === 'openFolder') return request('openFolder', { jobId: message.jobId });
  throw new Error('Unknown extension action.');
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  handle(message).then(data => respond({ ok: true, data })).catch(error => respond({ ok: false, error: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => { analyses.delete(tabId); });
