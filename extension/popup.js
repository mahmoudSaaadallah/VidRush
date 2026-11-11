'use strict';

const $ = id => document.getElementById(id);
let activeTab;
let media;
let analyzing = false;
let connected = false;

async function call(action, data = {}) {
  const response = await chrome.runtime.sendMessage({ action, ...data });
  if (!response?.ok) throw new Error(response?.error || 'تعذّر إكمال الطلب. أعد المحاولة.');
  return response.data;
}

function notice(text, type = '') {
  $('notice').textContent = text;
  $('notice').className = `notice ${type}`;
  $('notice').hidden = !text;
}

function bytes(value) {
  if (!value) return '';
  const unit = value >= 1024 ** 3 ? 'GB' : 'MB';
  return `${(value / (unit === 'GB' ? 1024 ** 3 : 1024 ** 2)).toFixed(1)} ${unit}`;
}

function renderJobs(jobs) {
  $('empty').hidden = jobs.length > 0;
  $('jobs').replaceChildren();
  for (const job of [...jobs].reverse()) {
    const item = $('job-template').content.cloneNode(true);
    item.querySelector('.job-title').textContent = job.title;
    item.querySelector('.job-title').title = job.title;
    item.querySelector('.job-quality').textContent = job.quality;
    const labels = { downloading: `جارٍ التحميل · ${job.percent || 0}%`, processing: 'دمج الصوت والفيديو…', completed: 'اكتمل التحميل', cancelled: 'تم الإلغاء', failed: 'تعذّر التحميل' };
    let detail = labels[job.status] || job.status;
    if (job.status === 'downloading' && job.speed) detail += ` · ${bytes(job.speed)}/s`;
    item.querySelector('.job-status').textContent = detail;
    item.querySelector('progress').value = job.percent || 0;
    const cancel = item.querySelector('.cancel');
    cancel.hidden = !['downloading', 'processing'].includes(job.status);
    cancel.addEventListener('click', async () => {
      cancel.disabled = true;
      try { await call('cancel', { jobId: job.id }); }
      catch (error) { notice(error.message, 'error'); cancel.disabled = false; }
    });
    if (job.error) {
      item.querySelector('.job-error').hidden = false;
      item.querySelector('.job-error').textContent = job.error;
    }
    $('jobs').append(item);
  }
}

async function analyze(refresh = false) {
  if (analyzing) return;
  if (!activeTab?.url || !/^https?:\/\//i.test(activeTab.url)) {
    notice('افتح صفحة فيديو على موقع ويب، ثم افتح الإضافة.', 'error');
    return;
  }
  analyzing = true;
  media = null;
  $('video').hidden = true;
  $('refresh').disabled = true;
  notice('جارٍ فحص الفيديو والجودات المتاحة…');
  try {
    media = await call('analyze', { tabId: activeTab.id, url: activeTab.url, refresh });
    $('title').textContent = media.title;
    $('extractor').textContent = media.site;
    $('duration').textContent = media.duration ? `${Math.floor(media.duration / 60)}:${String(Math.floor(media.duration % 60)).padStart(2, '0')}` : '';
    $('quality').replaceChildren();
    for (const choice of media.options) {
      const option = document.createElement('option');
      option.value = choice.id;
      option.textContent = `${choice.label}${choice.bytes ? ` · ≈ ${bytes(choice.bytes)}` : ''}`;
      $('quality').append(option);
    }
    $('video').hidden = false;
    notice('');
  } catch (error) { notice(error.message, 'error'); }
  finally { analyzing = false; $('refresh').disabled = !connected; }
}

async function initialize() {
  $('reconnect').disabled = true;
  notice('جارٍ الاتصال بالبرنامج المساعد…');
  try {
    const { companion, jobs } = await call('bootstrap');
    connected = true;
    $('connection').textContent = 'متصل محليًا';
    $('connection').classList.add('connected');
    $('folder').disabled = false;
    $('refresh').disabled = false;
    $('setup').hidden = true;
    $('version').textContent = `yt-dlp ${companion.version}`;
    $('folder').title = companion.downloadDir;
    renderJobs(jobs);
    await analyze();
  } catch (error) {
    connected = false;
    $('connection').textContent = 'غير متصل';
    $('connection').classList.remove('connected');
    $('folder').disabled = true;
    $('refresh').disabled = true;
    $('setup').hidden = false;
    notice(error.message, 'error');
  } finally { $('reconnect').disabled = false; }
}

$('extension-id').value = chrome.runtime.id;
$('brand').addEventListener('click', event => event.preventDefault());
$('reconnect').addEventListener('click', () => void initialize());
$('refresh').addEventListener('click', () => void analyze(true));
$('folder').addEventListener('click', async () => {
  try { await call('openFolder'); } catch (error) { notice(error.message, 'error'); }
});
$('download').addEventListener('click', async () => {
  if (!media) return;
  $('download').disabled = true;
  try {
    await call('download', { token: media.token, choice: $('quality').value });
    notice('بدأ التحميل. تقدر تقفل النافذة، وسيكمل طالما Chrome مفتوح.', 'success');
  } catch (error) { notice(error.message, 'error'); }
  finally { $('download').disabled = false; }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.jobs) renderJobs(changes.jobs.newValue || []);
});
(async () => {
  const stored = await chrome.storage.session.get('jobs');
  renderJobs(stored.jobs || []);
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { $('site').textContent = new URL(activeTab.url).hostname; }
  catch { $('site').textContent = 'افتح صفحة الفيديو'; }
  await initialize();
})().catch(error => notice(error.message, 'error'));
