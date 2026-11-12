'use strict';
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { extensionId } = require('./install.cjs');
const { installExtension } = require('./setup.cjs');
const root = path.resolve(__dirname, '..');

async function main() {
  const artifacts = path.join(root, 'artifacts'); fs.mkdirSync(artifacts, { recursive: true });
  const extensionPath = process.argv.includes('--installed')
    ? path.join(process.env.LOCALAPPDATA, 'VidRush', 'extension') : path.join(root, 'extension');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vidrush-browser-'));
  const launchOptions = {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    viewport: { width: 440, height: 1000 },
  };
  let context = await chromium.launchPersistentContext(profile, launchOptions);
  let server;
  try {
    const errors = [];
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker');
    const manifest = JSON.parse(fs.readFileSync(path.join(extensionPath, 'manifest.json'), 'utf8'));
    const id = extensionId(manifest.key);
    assert.equal(new URL(worker.url()).host, id);
    assert.deepEqual(await worker.evaluate(() => chrome.runtime.getManifest().permissions), ['activeTab', 'scripting', 'webRequest', 'nativeMessaging', 'storage']);
    assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().host_permissions), undefined);
    console.log(`Real extension loaded: ${id}`);
    if (process.argv.includes('--native')) {
      const ping = await worker.evaluate(async () => request('ping', {}, 20000));
      assert.ok(ping.version);
      assert.equal(ping.capabilities?.folderPicker, true);
      assert.equal(ping.capabilities?.openFolder, true);
      console.log(`Chrome launched the registered companion successfully: yt-dlp ${ping.version}`);
    }

    // Exercise the actual DOM/CSS and popup handlers with predictable Chrome/companion responses.
    // No real site is contacted, and these mocks are not part of the shipped extension.
    server = http.createServer((req, res) => {
      const allowed = new Set(['/popup.html', '/popup.css', '/popup.js', '/theme-init.js', '/icons/logo.svg', '/icons/48.png']);
      if (!allowed.has(req.url)) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', req.url.endsWith('.html') ? 'text/html; charset=utf-8' : req.url.endsWith('.css') ? 'text/css' : req.url.endsWith('.js') ? 'text/javascript' : req.url.endsWith('.svg') ? 'image/svg+xml' : 'image/png');
      res.end(fs.readFileSync(path.join(extensionPath, req.url.slice(1))));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(extensionVersion => {
      const listeners = [];
      window.testMode = 'ready';
      window.actions = [];
      window.destination = { downloadDir: 'C:\\Videos', choosingFolder: false };
      window.folderOutcome = 'selected';
      window.currentTab = { id: 1, url: 'https://example.com/watch?v=test' };
      window.bootstrapJobs = [];
      window.captureState = { enabled: false, active: false, count: 0 };
      let selections = 0, jobNumber = 0, currentJob;
      const updateJobs = () => listeners.forEach(listener => listener({ jobs: { newValue: [currentJob] } }, 'session'));
      window.completeJob = () => { currentJob = { ...currentJob, status: 'completed', percent: 100 }; updateJobs(); };
      window.progressJob = percent => { currentJob = { ...currentJob, percent }; updateJobs(); };
      window.chrome = {
        runtime: {
          getManifest: () => ({ version: extensionVersion }),
          id: 'abcdefghijklmnopabcdefghijklmnop',
          reload() { window.updateActivated = true; },
          async sendMessage(message) {
            window.actions.push(message);
            if (message.action === 'captureStatus') return { ok: true, data: window.captureState };
            if (message.action === 'startCapture') { window.captureState.active = true; return { ok: true, data: window.captureState }; }
            if (message.action === 'stopCapture') { window.captureState.active = false; return { ok: true, data: window.captureState }; }
            if (window.testMode === 'missing') return { ok: false, error: 'تعذّر الاتصال بالبرنامج المساعد. شغّل Install.cmd ثم أعد المحاولة.' };
            if (message.action === 'bootstrap') return { ok: true, data: { companion: { version: 'test', ...window.destination,
              capabilities: window.testMode === 'legacy' ? undefined : { folderPicker: true, openFolder: true } }, jobs: window.bootstrapJobs } };
            if (message.action === 'chooseFolder') {
              if (window.folderOutcome === 'error') return { ok: false, error: 'Folder is not writable.' };
              if (window.folderOutcome === 'cancel') return { ok: true, data: { ...window.destination, cancelled: true } };
              window.destination.choosingFolder = true;
              listeners.forEach(listener => listener({ destination: { newValue: { ...window.destination } } }, 'session'));
              await new Promise(resolve => setTimeout(resolve, 80));
              window.destination = { downloadDir: ++selections === 1 ? 'D:\\الفيديوهات المختارة' : 'E:\\Other videos', choosingFolder: false };
              listeners.forEach(listener => listener({ destination: { newValue: { ...window.destination } } }, 'session'));
              return { ok: true, data: { ...window.destination, cancelled: false } };
            }
            if (message.action === 'analyze' || message.action === 'selectSource') {
              if (window.testMode === 'player' && !message.scanPlayer) return { ok: false, error: 'شغّل الفيديو ثم افحص المشغّل.', playerOrigins: ['https://player.hotmart.com/*'] };
              if (window.testMode === 'unsupported') return { ok: false, error: 'No downloadable video with audio was found.' };
              const slow = message.url.endsWith('/slow-video');
              if (slow) await new Promise(resolve => { window.releaseSlowAnalysis = resolve; });
              const title = slow ? 'Old delayed video' : message.url.endsWith('/latest-video') ? 'Latest video' : '<script>alert(1)</script> — فيديو تجريبي';
              return { ok: true, data: { token: 'video', title, duration: 83, site: 'Test site',
                browser: window.testMode === 'multiple' && message.sourceIndex === 1,
                sourceIndex: message.sourceIndex || 0,
                detectedSources: window.testMode === 'multiple' ? [{ index: 0, label: 'HLS · first.test' }, { index: 1, label: 'فيديو · second.test' }] : undefined,
                options: [
                { id: '1080', height: 1080, fps: 60, container: 'mp4', label: '1080p · 60 fps · MP4', bytes: 1024 ** 2 * 85 },
                { id: '720', height: 720, fps: 30, container: 'mp4', label: '720p · MP4', bytes: 1024 ** 2 * 40 },
                { id: '480', height: 480, fps: 30, container: 'mp4', label: '480p · MP4' },
                { id: '360', height: 360, fps: 30, container: 'mp4', label: '360p · MP4' },
              ] } };
            }
            if (message.action === 'download') {
              currentJob = { id: `job${++jobNumber}`, title: 'فيديو تجريبي', quality: '720p · MP4', downloadDir: window.destination.downloadDir, status: 'downloading', percent: 45, speed: 2 * 1024 ** 2 };
              updateJobs();
              return { ok: true, data: currentJob };
            }
            if (message.action === 'cancel') {
              currentJob = { ...currentJob, status: 'cancelled' }; updateJobs();
            }
            return { ok: true, data: {} };
          },
        },
        tabs: { query: async () => [{ ...window.currentTab }] },
        permissions: { contains: async value => window.captureState.enabled || !value.origins.includes('https://*/*') && window.allowPlayer === true, request: async value => {
          window.permissionRequests = (window.permissionRequests || 0) + 1;
          window.requestedOrigins = value.origins;
          if (value.origins.includes('https://*/*')) {
            if (window.allowFull === true) window.captureState.enabled = true;
            return window.allowFull === true;
          }
          return window.allowPlayer === true;
        }, remove: async () => { window.captureState.enabled = false; return true; } },
        storage: {
          session: { get: async () => ({ jobs: [] }) },
          local: {
            get: async () => {
              const theme = localStorage.getItem('mock-theme');
              if (localStorage.getItem('delay-theme')) await new Promise(resolve => { window.releaseThemeRead = resolve; });
              return { theme };
            },
            set: async ({ theme }) => { localStorage.setItem('mock-theme', theme); },
          },
          onChanged: { addListener: callback => listeners.push(callback) },
        },
      };
    }, manifest.version);
    await page.goto(`${base}/popup.html`);
    await page.locator('#video').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#extension-version').innerText(), 'v' + manifest.version);
    await page.setViewportSize({ width: 400, height: 600 });
    await page.locator('#discovery-settings').click();
    await page.locator('#enable-discovery').click();
    await page.waitForFunction(() => document.getElementById('capture-status').textContent.includes('لم يتم منح'));
    await page.evaluate(() => { window.allowFull = true; });
    await page.locator('#enable-discovery').click();
    await page.locator('#stop-discovery').waitFor({ state: 'visible' });
    assert.deepEqual(await page.evaluate(() => window.requestedOrigins), ['http://*/*', 'https://*/*']);
    const dialogBounds = await page.locator('#discovery-dialog').boundingBox();
    assert.ok(dialogBounds.y >= 0 && dialogBounds.y + dialogBounds.height <= 600, 'The permissions dialog must fit the real popup viewport.');
    await page.locator('body').screenshot({ path: path.join(artifacts, 'popup-comprehensive.png'), animations: 'disabled' });
    await page.locator('#stop-discovery').click();
    await page.locator('#start-discovery').waitFor({ state: 'visible' });
    await page.locator('#start-discovery').click();
    await page.locator('#disable-discovery').click();
    await page.locator('#enable-discovery').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#discovery-settings').evaluate(element => element === document.activeElement), true);
    assert.equal(await page.locator('#quality option').count(), 4);
    assert.equal(await page.locator('.quality-option').count(), 3);
    assert.equal(await page.locator('#brand img').evaluate(element => element.complete && element.naturalWidth > 0), true);
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.getByRole('switch', { name: 'الوضع الداكن' }).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    assert.equal(await page.evaluate(() => localStorage.getItem('mock-theme')), 'light');
    await page.reload();
    await page.locator('#video').waitFor({ state: 'visible' });
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    assert.equal(await page.getByRole('switch').getAttribute('aria-checked'), 'false');
    await page.getByRole('switch').focus();
    await page.keyboard.press('Space');
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.locator('#tab-video').focus();
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.locator('#tab-downloads').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#empty').isVisible(), true);
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#tab-video').getAttribute('aria-selected'), 'true');
    assert.match(await page.locator('#title').innerText(), /<script>/);
    assert.equal(await page.locator('#title script').count(), 0);
    await page.setViewportSize({ width: 400, height: 600 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
    await page.locator('#title').evaluate(element => { element.textContent = 'رحلة قصيرة إلى البحر — فيديو تجريبي'; });
    assert.equal(await page.locator('#destination-path').inputValue(), 'C:\\Videos');
    await page.evaluate(() => { window.folderOutcome = 'cancel'; });
    await page.locator('#choose-folder').click();
    await page.waitForFunction(() => !document.getElementById('choose-folder').disabled);
    assert.equal(await page.locator('#destination-path').inputValue(), 'C:\\Videos');
    await page.evaluate(() => { window.folderOutcome = 'error'; });
    await page.locator('#choose-folder').click();
    await page.waitForFunction(() => document.getElementById('notice').textContent.includes('not writable'));
    assert.equal(await page.locator('#download').isEnabled(), true);
    await page.evaluate(() => { window.folderOutcome = 'selected'; });
    await page.locator('#choose-folder').click();
    await page.waitForFunction(() => document.getElementById('destination-path').value.startsWith('D:'));
    const downloadBounds = await page.locator('#download').boundingBox();
    const mainBounds = await page.locator('#main-content').boundingBox();
    assert.ok(downloadBounds.y + downloadBounds.height <= mainBounds.y + mainBounds.height, 'The primary action must fit without scrolling.');
    const title = await page.locator('#title').innerText();
    await page.locator('#title').evaluate(element => { element.textContent = 'فيديو طويل العنوان لاختبار عرض سطرين داخل نافذة الإضافة مع بقاء زر التحميل ظاهرًا وسهل الاستخدام'; });
    const longTitleAction = await page.locator('#download').boundingBox();
    assert.ok(longTitleAction.y + longTitleAction.height <= mainBounds.y + mainBounds.height, 'A two-line title must not push the download button out of view.');
    await page.locator('#title').evaluate((element, value) => { element.textContent = value; }, title);
    await page.locator('body').screenshot({ path: path.join(artifacts, 'popup-ready.png'), animations: 'disabled' });
    await page.locator('body').screenshot({ path: path.join(artifacts, 'popup-ready-dark.png'), animations: 'disabled' });
    async function checkContrast() {
      const values = await page.evaluate(() => {
        function luminance(value) {
          const rgb = value.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255);
          return rgb.map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((total, v, i) => total + v * [.2126, .7152, .0722][i], 0);
        }
        function contrast(foreground, background) {
          const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
          return (values[0] + .05) / (values[1] + .05);
        }
        const body = getComputedStyle(document.body);
        const action = getComputedStyle(document.getElementById('download'));
        const label = getComputedStyle(document.querySelector('.field-label'));
        const source = getComputedStyle(document.querySelector('.source'));
        return { body: contrast(body.color, body.backgroundColor), action: contrast(action.color, action.backgroundColor), secondary: contrast(label.color, source.backgroundColor) };
      });
      for (const [name, ratio] of Object.entries(values)) assert.ok(ratio >= 4.5, name + ' contrast must be at least 4.5:1, got ' + ratio);
    }
    await checkContrast();
    await page.getByRole('switch').click();
    await page.locator('body').screenshot({ path: path.join(artifacts, 'popup-ready-light.png'), animations: 'disabled' });
    await checkContrast();
    await page.locator('#quality-more summary').click();
    await page.locator('#quality').selectOption('360');
    assert.equal(await page.locator('.quality-option input:checked').count(), 0);
    await page.locator('#quality-more summary').click();
    await page.locator('.quality-option').filter({ has: page.locator('input[value="480"]') }).click();
    assert.equal(await page.locator('#quality').inputValue(), '480');
    await page.locator('input[value="720"]').focus();
    await page.keyboard.press('Space');
    assert.equal(await page.locator('#quality').inputValue(), '720');
    await page.locator('#download').click();
    await page.locator('.job').waitFor();
    assert.equal(await page.evaluate(() => window.actions.find(action => action.action === 'download').choice), '720');
    assert.equal(await page.locator('#tab-downloads').getAttribute('aria-selected'), 'true');
    assert.match(await page.locator('.job-percent').innerText(), /45%/);
    assert.equal(await page.locator('.job-destination').innerText(), 'D:\\الفيديوهات المختارة');
    await page.locator('.cancel').focus();
    await page.evaluate(() => window.progressJob(55));
    assert.equal(await page.locator('.cancel').evaluate(element => element === document.activeElement), true, 'Progress updates must preserve the focused action.');
    assert.equal(await page.locator('.job-percent').innerText(), '55%');
    await page.screenshot({ path: path.join(artifacts, 'popup-downloading.png'), fullPage: true, animations: 'disabled' });
    await page.getByRole('switch').click();
    await page.screenshot({ path: path.join(artifacts, 'popup-downloads-dark.png'), animations: 'disabled' });
    await page.locator('#tab-video').click();
    await page.locator('#choose-folder').click();
    await page.waitForFunction(() => document.getElementById('destination-path').value.startsWith('E:'));
    await page.evaluate(() => window.completeJob());
    await page.locator('#tab-downloads').click();
    await page.locator('.open-job').click();
    assert.equal(await page.evaluate(() => window.actions.filter(action => action.action === 'openFolder').at(-1).jobId), 'job1');
    assert.equal(await page.locator('.job-destination').innerText(), 'D:\\الفيديوهات المختارة');
    await page.locator('#tab-video').click();
    await page.locator('#download').click();
    await page.locator('.cancel').click();
    assert.match(await page.locator('.job-status').innerText(), /تم الإلغاء/);
    await page.locator('#tab-video').click();
    await page.evaluate(() => { window.currentTab = { id: 1, url: 'https://www.facebook.com/reel/new-video' }; });
    await page.locator('#refresh').click();
    await page.waitForFunction(() => document.getElementById('site').textContent === 'www.facebook.com' && !document.getElementById('video').hidden);
    assert.equal(await page.evaluate(() => window.actions.filter(action => action.action === 'analyze').at(-1).url), 'https://www.facebook.com/reel/new-video');
    await page.evaluate(() => { window.currentTab.url = 'https://www.facebook.com/reel/another-video'; });
    await page.locator('#refresh').click();
    await page.waitForFunction(() => !document.getElementById('video').hidden);
    assert.equal(await page.evaluate(() => window.actions.filter(action => action.action === 'analyze').at(-1).url), 'https://www.facebook.com/reel/another-video');
    await page.evaluate(() => { window.currentTab.url = 'https://www.facebook.com/slow-video'; });
    await page.locator('#refresh').click();
    await page.waitForFunction(() => typeof window.releaseSlowAnalysis === 'function');
    await page.evaluate(() => { window.currentTab.url = 'https://www.facebook.com/latest-video'; });
    await page.locator('#refresh').click();
    await page.waitForFunction(() => document.getElementById('title').textContent === 'Latest video');
    await page.evaluate(async () => { window.releaseSlowAnalysis(); await new Promise(resolve => setTimeout(resolve, 20)); });
    assert.equal(await page.locator('#title').innerText(), 'Latest video');
    await page.evaluate(() => { window.testMode = 'legacy'; document.getElementById('setup').hidden = false; });
    await page.locator('#reconnect').click();
    await page.locator('#helper-update').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#choose-folder').isDisabled(), true);
    assert.equal(await page.locator('#folder').isDisabled(), true);
    assert.match(await page.locator('#helper-update').innerText(), /Update.cmd/);
    await page.screenshot({ path: path.join(artifacts, 'popup-update-dark.png'), animations: 'disabled' });
    await page.evaluate(() => { window.bootstrapJobs = [{ id: 'active', status: 'downloading' }]; });
    await page.locator('#activate-update').click();
    await page.waitForFunction(() => document.getElementById('notice').textContent.includes('انتظر انتهاء'));
    assert.equal(await page.evaluate(() => !!window.updateActivated), false);
    await page.evaluate(() => { window.bootstrapJobs = []; });
    await page.locator('#activate-update').click();
    await page.waitForFunction(() => window.updateActivated === true);
    await page.evaluate(() => { window.testMode = 'ready'; document.getElementById('setup').hidden = false; });
    await page.locator('#reconnect').click();
    await page.locator('#helper-update').waitFor({ state: 'hidden' });
    await page.locator('#video').waitFor({ state: 'visible' });
    await page.evaluate(() => { window.testMode = 'unsupported'; });
    await page.locator('#refresh').click();
    await page.waitForFunction(() => document.getElementById('notice').textContent.includes('No downloadable'));
    assert.equal(await page.locator('#video').isVisible(), false);
    await page.screenshot({ path: path.join(artifacts, 'popup-error.png'), fullPage: true });
    await page.evaluate(() => { window.testMode = 'player'; window.currentTab.url = 'https://courses.example.com/lesson'; });
    await page.locator('#refresh').click();
    await page.locator('#scan-player').waitFor({ state: 'visible' });
    await page.screenshot({ path: path.join(artifacts, 'popup-player.png'), animations: 'disabled' });
    await page.locator('#scan-player').click();
    await page.waitForFunction(() => document.getElementById('notice').textContent.includes('لم يتم السماح'));
    assert.deepEqual(await page.evaluate(() => window.requestedOrigins), ['http://*/*', 'https://*/*']);
    await page.evaluate(() => { window.allowFull = true; });
    await page.locator('#scan-player').click();
    await page.locator('#video').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#scan-player').isVisible(), false);
    assert.equal(await page.evaluate(() => window.actions.filter(action => action.action === 'analyze').at(-1).scanPlayer), true);
    const permissionRequests = await page.evaluate(() => window.permissionRequests);
    await page.evaluate(() => { window.currentTab.url = 'https://another.example/video'; });
    await page.locator('#refresh').click();
    await page.locator('#video').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => window.permissionRequests), permissionRequests, 'Saved access must scan a different website automatically without request().');
    assert.equal(await page.evaluate(() => window.actions.filter(action => action.action === 'analyze').at(-1).scanPlayer), true);
    assert.equal(await page.locator('#scan-player').isVisible(), false);
    // Previously saved per-player access is also reused without broadening it.
    await page.evaluate(() => { window.captureState.enabled = false; window.allowPlayer = true; window.currentTab.url = 'https://courses.example.com/second'; });
    await page.locator('#refresh').click();
    await page.locator('#video').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => window.permissionRequests), permissionRequests);
    await page.evaluate(() => { window.testMode = 'multiple'; });
    await page.locator('#refresh').click();
    await page.locator('#source-picker').waitFor({ state: 'visible' });
    await page.locator('#video-source').selectOption('1');
    await page.locator('#browser-note').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => window.actions.at(-1).action), 'selectSource');
    assert.equal(await page.locator('#video-source').inputValue(), '1');
    assert.match(await page.locator('#audio-note').innerText(), /حسب المصدر/);
    await page.evaluate(() => { window.testMode = 'missing'; });
    // Reconnect through the same initialization path used by the real popup.
    await page.locator('#reconnect').evaluate(element => { element.closest('#setup').hidden = false; });
    await page.locator('#reconnect').click();
    await page.locator('#setup').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.getElementById('connection-label').textContent === 'غير متصل');
    assert.equal(await page.locator('#extension-id').inputValue(), 'abcdefghijklmnopabcdefghijklmnop');
    await page.screenshot({ path: path.join(artifacts, 'popup-setup.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log('Popup current-page refresh, legacy-helper detection, folder actions, quality selection, progress, setup and layout passed.');
    const guide = installExtension(root, path.join(profile, 'VidRush & اسم'), 'D:\\My Videos');
    await page.goto(pathToFileURL(guide.guidePath).href);
    assert.equal(await page.locator('#extension-path').inputValue(), guide.extensionPath);
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => { window.copiedPath = value; } }, configurable: true }); });
    await page.locator('#copy-path').click();
    assert.equal(await page.evaluate(() => window.copiedPath), guide.extensionPath);
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('Clipboard unavailable'); } }, configurable: true }); });
    await page.locator('#copy-path').click();
    assert.match(await page.locator('#copy-status').innerText(), /Ctrl\+C/);
    await page.setViewportSize({ width: 375, height: 850 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
    await page.screenshot({ path: path.join(artifacts, 'setup-guide.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log('Installed setup guide, escaped Unicode paths, copy/fallback actions and narrow layout passed.');

    await page.goto(base + '/popup.html');
    await page.locator('#video').waitFor({ state: 'visible' });
    if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.getByRole('switch').click();
    await page.evaluate(() => localStorage.setItem('delay-theme', '1'));
    await page.reload();
    await page.waitForFunction(() => typeof window.releaseThemeRead === 'function');
    await page.getByRole('switch').click();
    await page.evaluate(() => { window.releaseThemeRead(); localStorage.removeItem('delay-theme'); });
    await page.locator('#video').waitFor({ state: 'visible' });
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light', 'A late theme read must not overwrite a newer user choice.');

    // Use the real extension storage, independent of the deterministic helper mock.
    async function openThemePopup(browserContext) {
      const popup = await browserContext.newPage();
      await popup.addInitScript(() => { chrome.runtime.sendMessage = async () => ({ ok: false, error: 'Theme test without a native companion.' }); });
      await popup.goto('chrome-extension://' + id + '/popup.html');
      await popup.locator('#setup').waitFor({ state: 'visible' });
      assert.equal(await popup.locator('#extension-version').innerText(), 'v' + manifest.version);
      return popup;
    }
    let themePopup = await openThemePopup(context);
    await themePopup.getByRole('switch').click();
    assert.equal(await themePopup.locator('html').getAttribute('data-theme'), 'light');
    await themePopup.waitForFunction(async () => (await chrome.storage.local.get('theme')).theme === 'light');
    await themePopup.evaluate(() => localStorage.setItem('vidrush-theme', 'dark'));
    await context.close();
    context = await chromium.launchPersistentContext(profile, launchOptions);
    themePopup = await openThemePopup(context);
    assert.equal(await themePopup.locator('html').getAttribute('data-theme'), 'light');
    await themePopup.getByRole('switch').click();
    await themePopup.waitForFunction(async () => (await chrome.storage.local.get('theme')).theme === 'dark');
    await themePopup.close();
    themePopup = await openThemePopup(context);
    assert.equal(await themePopup.locator('html').getAttribute('data-theme'), 'dark');
    console.log('Theme choice persisted in real chrome.storage.local across popup reopening and browser restart.');
    await context.close();
    await require('./discovery-browser-test.cjs').run(chromium, extensionPath);
    await require('./browser-transfer-browser-test.cjs').run(chromium, extensionPath);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await context.close();
    const relative = path.relative(os.tmpdir(), profile);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) fs.rmSync(profile, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
