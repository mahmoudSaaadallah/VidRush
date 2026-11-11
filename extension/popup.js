'use strict';

const $ = id => document.getElementById(id);
let activeTab;
let media;
let analyzing = false;
let connected = false;
let destination = { downloadDir: '', choosingFolder: false };
let folderFeatures = false;
let analysisSequence = 0;
let themeRevision = 0;
let playerOrigins = [];
const jobElements = new Map();
const cancelling = new Set();

function text(node, value) {
  const next = String(value ?? '');
  if (node.textContent !== next) node.textContent = next;
}

function applyTheme(theme) {
  const value = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = value;
  $('theme-toggle').setAttribute('aria-checked', String(value === 'dark'));
  $('theme-icon').setAttribute('href', value === 'dark' ? '#i-moon' : '#i-sun');
  try { localStorage.setItem('vidrush-theme', value); } catch { /* Optional first-paint cache. */ }
}

async function loadTheme() {
  applyTheme(document.documentElement.dataset.theme);
  const revision = themeRevision;
  try {
    const stored = await chrome.storage.local.get('theme');
    if (revision === themeRevision && ['light', 'dark'].includes(stored.theme)) applyTheme(stored.theme);
  } catch { /* A missing setting never blocks the downloader. */ }
}

function setTab(name, focus = false) {
  for (const key of ['video', 'downloads']) {
    const selected = key === name;
    $('tab-' + key).setAttribute('aria-selected', String(selected));
    $('tab-' + key).tabIndex = selected ? 0 : -1;
    $('panel-' + key).hidden = !selected;
  }
  $('main-content').scrollTop = 0;
  if (focus) $('tab-' + name).focus();
}

function renderDestination(value) {
  destination = { ...destination, ...value };
  $('destination-path').value = destination.downloadDir || '';
  $('destination-path').title = destination.downloadDir || '';
  $('folder').title = destination.downloadDir || '';
  $('choose-folder').disabled = !connected || !folderFeatures || destination.choosingFolder;
  $('choose-folder').textContent = destination.choosingFolder ? 'مفتوح…' : 'تغيير';
  $('destination').setAttribute('aria-busy', String(destination.choosingFolder));
  $('download').disabled = !connected || !media || destination.choosingFolder;
}

async function call(action, data = {}) {
  const response = await chrome.runtime.sendMessage({ action, ...data });
  if (!response?.ok) {
    const error = new Error(response?.error || 'تعذّر إكمال الطلب. أعد المحاولة.');
    error.playerOrigins = response?.playerOrigins || [];
    throw error;
  }
  return response.data;
}

function notice(value, type = '') {
  text($('notice'), value);
  $('notice').className = 'notice ' + type;
  $('notice').hidden = !value;
}

function bytes(value) {
  if (!value) return '';
  const unit = value >= 1024 ** 3 ? 'GB' : 'MB';
  return (value / (unit === 'GB' ? 1024 ** 3 : 1024 ** 2)).toFixed(1) + ' ' + unit;
}

function qualityTitle(choice) {
  return choice.height ? choice.height + 'p' : choice.label.match(/\d+p/)?.[0] || 'الأصلية';
}

function updateQuality() {
  const selected = media?.options.find(option => option.id === $('quality').value);
  if (!selected) return;
  for (const input of $('quality-presets').querySelectorAll('input')) input.checked = input.value === selected.id;
  const container = selected.container?.toUpperCase() || selected.label.match(/\b(MP4|MKV|WEBM)\b/i)?.[0] || '';
  const fps = selected.fps || Number(selected.label.match(/(\d+) fps/)?.[1]);
  const details = [container, fps ? fps + ' fps' : '', selected.bytes ? '≈ ' + bytes(selected.bytes) : ''].filter(Boolean);
  text($('quality-details'), details.join(' · ') || selected.label);
}

function renderQualities() {
  $('quality').replaceChildren();
  $('quality-presets').replaceChildren();
  const presets = [];
  const resolutions = new Set();
  for (const choice of media.options) {
    const option = document.createElement('option');
    option.value = choice.id;
    option.textContent = choice.label + (choice.bytes ? ' · ≈ ' + bytes(choice.bytes) : '');
    $('quality').append(option);
    const title = qualityTitle(choice);
    if (presets.length < 3 && !resolutions.has(title)) {
      resolutions.add(title);
      presets.push(choice);
    }
  }
  for (const choice of presets) {
    const label = document.createElement('label');
    label.className = 'quality-option';
    label.title = choice.label;
    const input = document.createElement('input');
    input.type = 'radio'; input.name = 'quality-preset'; input.value = choice.id;
    input.setAttribute('aria-label', choice.label);
    const caption = document.createElement('span');
    caption.textContent = qualityTitle(choice);
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'icon'); icon.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-check'); icon.append(use);
    label.append(input, caption, icon);
    input.addEventListener('change', () => { $('quality').value = choice.id; updateQuality(); });
    $('quality-presets').append(label);
  }
  $('quality-presets').style.setProperty('--quality-count', Math.max(1, presets.length));
  $('quality-more').hidden = media.options.length === presets.length;
  $('quality-more').open = false;
  $('quality').value = media.options[0].id;
  updateQuality();
}

function createJob(job) {
  const article = $('job-template').content.firstElementChild.cloneNode(true);
  article.dataset.jobId = job.id;
  const cancel = article.querySelector('.cancel');
  cancel.addEventListener('click', async () => {
    cancelling.add(job.id); cancel.disabled = true;
    try { await call('cancel', { jobId: job.id }); }
    catch (error) { notice(error.message, 'error'); }
    finally { cancelling.delete(job.id); cancel.disabled = false; }
  });
  const open = article.querySelector('.open-job');
  open.addEventListener('click', async () => {
    open.disabled = true;
    try { await call('openFolder', { jobId: job.id }); }
    catch (error) { notice(error.message, 'error'); }
    finally { open.disabled = !folderFeatures; }
  });
  return article;
}

function renderJobs(values) {
  const jobs = Array.isArray(values) ? values : [];
  $('empty').hidden = jobs.length > 0;
  text($('downloads-count'), jobs.length);
  $('downloads-count').hidden = jobs.length === 0;
  $('tab-downloads').setAttribute('aria-label', jobs.length ? 'التحميلات، ' + jobs.length : 'التحميلات');
  const retained = new Set(jobs.map(job => job.id));
  for (const [id, node] of jobElements) {
    if (!retained.has(id)) { node.remove(); jobElements.delete(id); }
  }
  for (const [index, job] of [...jobs].reverse().entries()) {
    let article = jobElements.get(job.id);
    if (!article) { article = createJob(job); jobElements.set(job.id, article); }
    if ($('jobs').children[index] !== article) $('jobs').insertBefore(article, $('jobs').children[index] || null);
    article.dataset.status = job.status;
    const active = ['downloading', 'processing'].includes(job.status);
    const labels = { downloading: 'جارٍ التحميل', processing: 'دمج الصوت والفيديو…', completed: 'اكتمل التحميل', cancelled: 'تم الإلغاء', failed: 'تعذّر التحميل' };
    text(article.querySelector('.job-title'), job.title);
    article.querySelector('.job-title').title = job.title;
    text(article.querySelector('.job-quality'), job.quality);
    text(article.querySelector('.job-status'), labels[job.status] || job.status);
    text(article.querySelector('.job-percent'), job.status === 'downloading' ? (job.percent || 0) + '%' : '');
    const progress = article.querySelector('progress');
    progress.hidden = !active;
    progress.value = job.percent || 0;
    article.querySelector('.job-icon use').setAttribute('href', job.status === 'completed' ? '#i-check' : '#i-film');
    article.querySelector('.job-transfer').hidden = !active;
    text(article.querySelector('.job-speed'), job.status === 'downloading' && job.speed ? bytes(job.speed) + '/s' : '');
    text(article.querySelector('.job-eta'), job.status === 'downloading' && Number.isFinite(job.eta)
      ? job.eta >= 60 ? 'باقي ' + Math.ceil(job.eta / 60) + ' دقيقة' : 'باقي ' + Math.max(0, Math.ceil(job.eta)) + ' ثانية' : '');
    const cancel = article.querySelector('.cancel');
    cancel.hidden = !active;
    cancel.disabled = cancelling.has(job.id);
    const location = article.querySelector('.job-destination');
    text(location, job.downloadDir || '');
    location.title = job.downloadDir || '';
    const open = article.querySelector('.open-job');
    open.hidden = job.status !== 'completed';
    open.disabled = !folderFeatures;
    const error = article.querySelector('.job-error');
    error.hidden = !job.error;
    text(error, job.error || '');
  }
}

function showPlaceholder(show) {
  $('video-placeholder').hidden = !show;
}

async function analyze(refresh = false, scanPlayer = false) {
  let tab;
  try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); }
  catch (error) { notice(error.message, 'error'); return; }
  if (analyzing && tab?.id === activeTab?.id && tab?.url === activeTab?.url) return;
  const sequence = ++analysisSequence;
  activeTab = tab;
  try { $('site').textContent = new URL(activeTab.url).hostname; }
  catch { $('site').textContent = 'افتح صفحة الفيديو'; }
  media = null;
  playerOrigins = [];
  text($('placeholder-message'), 'افتح صفحة فيديو لعرض الجودات المتاحة.');
  $('scan-player').hidden = true;
  $('scan-hint').hidden = true;
  $('video').hidden = true;
  showPlaceholder(false);
  renderDestination(destination);
  if (!activeTab?.url || !/^https?:\/\//i.test(activeTab.url)) {
    analyzing = false;
    $('refresh').setAttribute('aria-busy', 'false');
    showPlaceholder(true);
    notice('افتح صفحة فيديو على موقع ويب، ثم اضغط تحديث.', 'error');
    return;
  }
  analyzing = true;
  $('refresh').disabled = !connected;
  $('refresh').setAttribute('aria-busy', 'true');
  notice('جارٍ فحص الفيديو والجودات المتاحة…');
  try {
    const result = await call('analyze', { tabId: activeTab.id, url: activeTab.url, refresh, scanPlayer });
    if (sequence !== analysisSequence) return;
    media = result;
    text($('title'), media.title);
    $('title').title = media.title;
    text($('extractor'), media.site);
    text($('duration'), media.duration ? Math.floor(media.duration / 60) + ':' + String(Math.floor(media.duration % 60)).padStart(2, '0') : '');
    renderQualities();
    $('video').hidden = false;
    notice('');
  } catch (error) {
    if (sequence === analysisSequence) {
      playerOrigins = error.playerOrigins || [];
      if (playerOrigins.length) text($('placeholder-message'), 'الفيديو موجود داخل مشغّل مضمّن في الصفحة.');
      $('scan-player').hidden = !playerOrigins.length;
      $('scan-hint').hidden = !playerOrigins.length;
      notice(error.message, 'error'); showPlaceholder(true);
    }
  } finally {
    if (sequence === analysisSequence) {
      analyzing = false;
      $('refresh').disabled = !connected;
      $('refresh').setAttribute('aria-busy', 'false');
      renderDestination(destination);
    }
  }
}

async function initialize() {
  $('reconnect').disabled = true;
  notice('جارٍ الاتصال بالبرنامج المساعد…');
  try {
    const { companion, jobs } = await call('bootstrap');
    connected = true;
    folderFeatures = companion.capabilities?.folderPicker === true && companion.capabilities?.openFolder === true;
    $('helper-update').hidden = folderFeatures;
    text($('connection-label'), folderFeatures ? 'متصل' : 'يحتاج تحديث');
    $('connection').className = folderFeatures ? 'badge connected' : 'badge needs-update';
    $('folder').disabled = !folderFeatures;
    $('refresh').disabled = false;
    $('setup').hidden = true;
    text($('version'), 'yt-dlp ' + companion.version);
    renderDestination({ downloadDir: companion.downloadDir, choosingFolder: !!companion.choosingFolder });
    renderJobs(jobs);
    await analyze();
  } catch (error) {
    connected = false;
    folderFeatures = false;
    analysisSequence++;
    analyzing = false;
    media = null;
    $('video').hidden = true;
    $('helper-update').hidden = true;
    showPlaceholder(false);
    text($('connection-label'), 'غير متصل');
    $('connection').className = 'badge';
    $('folder').disabled = true;
    $('refresh').disabled = true;
    $('refresh').setAttribute('aria-busy', 'false');
    $('setup').hidden = false;
    renderDestination({ choosingFolder: false });
    notice(error.message, 'error');
  } finally { $('reconnect').disabled = false; }
}

$('extension-id').value = chrome.runtime.id;
$('theme-toggle').addEventListener('click', () => {
  themeRevision++;
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(theme);
  chrome.storage.local.set({ theme }).catch(() => notice('تعذّر حفظ اختيار المظهر. جرّب مرة أخرى.', 'error'));
});
for (const name of ['video', 'downloads']) {
  $('tab-' + name).addEventListener('click', () => setTab(name));
  $('tab-' + name).addEventListener('keydown', event => {
    const names = ['video', 'downloads'];
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : (names.indexOf(name) + 1) % 2;
    setTab(names[index], true);
  });
}
$('back-to-video').addEventListener('click', () => setTab('video', true));
$('quality').addEventListener('change', updateQuality);
$('activate-update').addEventListener('click', async () => {
  $('activate-update').disabled = true;
  try {
    const { jobs } = await call('bootstrap');
    if (jobs.some(job => ['downloading', 'processing'].includes(job.status))) throw new Error('انتظر انتهاء التحميلات الحالية قبل تفعيل التحديث.');
    chrome.runtime.reload();
  } catch (error) { notice(error.message, 'error'); $('activate-update').disabled = false; }
});
$('reconnect').addEventListener('click', () => void initialize());
$('refresh').addEventListener('click', () => void analyze(true));
$('scan-player').addEventListener('click', async () => {
  if (!playerOrigins.length) return;
  $('scan-player').disabled = true;
  try {
    // Keep request() in this click handler so Chrome sees the user gesture.
    const granted = await chrome.permissions.request({ origins: playerOrigins });
    if (!granted) { notice('لم يتم السماح بفحص المشغّل. تقدر تسمح له من نفس الزر وقت ما تحب.'); return; }
    await analyze(true, true);
  } catch (error) { notice(error.message, 'error'); }
  finally { $('scan-player').disabled = false; }
});
$('folder').addEventListener('click', async () => {
  $('folder').disabled = true;
  try { await call('openFolder'); } catch (error) { notice(error.message, 'error'); }
  finally { $('folder').disabled = !folderFeatures; }
});
$('choose-folder').addEventListener('click', async () => {
  renderDestination({ choosingFolder: true });
  notice('اختار المجلد من نافذة Windows، ثم افتح الإضافة مجددًا.');
  try {
    const result = await call('chooseFolder');
    renderDestination(result);
    notice('');
    text($('action-status'), result.cancelled ? 'لم يتغيّر مجلد الحفظ.' : 'تم حفظ مكان التحميل.');
  } catch (error) { renderDestination({ choosingFolder: false }); notice(error.message, 'error'); }
});
$('download').addEventListener('click', async () => {
  if (!media) return;
  $('download').disabled = true;
  try {
    await call('download', { token: media.token, choice: $('quality').value });
    setTab('downloads', true);
    notice('بدأ التحميل. تقدر تقفل النافذة وتسيب Chrome مفتوح.', 'success');
  } catch (error) { notice(error.message, 'error'); }
  finally { renderDestination(destination); }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.jobs) renderJobs(changes.jobs.newValue || []);
  if (area === 'session' && changes.destination) renderDestination(changes.destination.newValue || {});
});
(async () => {
  await loadTheme();
  const stored = await chrome.storage.session.get('jobs');
  renderJobs(stored.jobs || []);
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { $('site').textContent = new URL(activeTab.url).hostname; }
  catch { $('site').textContent = 'افتح صفحة الفيديو'; }
  await initialize();
})().catch(error => notice(error.message, 'error'));
