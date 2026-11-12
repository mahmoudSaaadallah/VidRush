'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');

async function run(chromium, extensionPath) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vidrush-browser-stream-'));
  const ext = path.join(root, 'extension');
  const bytes = Buffer.alloc(300000, 7); Buffer.from('000000206674797069736f6d', 'hex').copy(bytes);
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/sw.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(`self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('fetch',e=>{if(new URL(e.request.url).hostname!=='browser-only.invalid')return;const bytes=new Uint8Array(300000).fill(7);bytes.set([0,0,0,32,102,116,121,112,105,115,111,109]);const match=e.request.headers.get('range')?.match(/bytes=(\\d+)-(\\d*)/);const start=Number(match?.[1]||0),end=match?.[2]?Number(match[2]):bytes.length-1;e.respondWith(new Response(bytes.slice(start,end+1),{status:match?206:200,headers:{'Content-Type':'video/mp4','Content-Length':String(end-start+1),...(match?{'Content-Range':'bytes '+start+'-'+end+'/'+bytes.length}:{})}}));});`);
      return;
    }
    res.end(`<title>Browser-only video fixture</title><video></video><script>(async()=>{await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}));const video=document.querySelector('video');video.setAttribute('src','https://display-only.invalid/video.mp4');const readable='https://browser-only.invalid/virtual.mp4',alias={toJSON:()=>readable,toString:()=>readable};Object.defineProperty(video,'currentSrc',{get:()=>alias});Object.defineProperty(video,'src',{get:()=>alias});const original=video.getAttribute.bind(video);video.getAttribute=name=>name==='src'?alias:original(name);window.ready=true;})();</script>`);
  });
  let context;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    fs.cpSync(extensionPath, ext, { recursive: true, filter: () => true });
    const manifestPath = path.join(ext, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath)); manifest.host_permissions = ['http://*/*', 'https://*/*'];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    context = await chromium.launchPersistentContext(path.join(root, 'profile'), { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage(); const url = `http://127.0.0.1:${server.address().port}/video`;
    await page.goto(url); await page.waitForFunction(() => window.ready === true);
    await worker.evaluate(() => {
      pageSources = sourceContext = browserTransfer = true;
      globalThis.testStream = { parts: [], bytes: 0, finished: false, cancelled: false, job: 0 };
      request = async (action, data) => {
        if (action === 'inspect') throw new Error('HTTP 403: browser-only Service Worker URL.');
        if (action === 'prepareBrowser') return { token: 'browser', browser: true, title: data.metadata.title, options: [{ id: 'format', label: 'Original · MP4', bytes: data.metadata.bytes, container: 'mp4' }] };
        if (action === 'download') return { id: 'browser-job-' + ++testStream.job, title: 'Browser fixture', status: 'downloading', downloadDir: 'test', percent: 0 };
        if (action === 'browserChunk') {
          if (data.offset !== testStream.bytes) throw new Error('Wrong offset');
          testStream.parts.push(data.data); testStream.bytes += atob(data.data).length;
          if (testStream.hold) await new Promise(resolve => { testStream.release = resolve; });
          await new Promise(resolve => setTimeout(resolve, 10));
          return { received: testStream.bytes };
        }
        if (action === 'browserFinish') { testStream.finished = true; return { completed: true }; }
        if (action === 'cancel') { testStream.cancelled = true; return {}; }
        if (action === 'browserAbort') { testStream.error = data.error; return {}; }
        return {};
      };
    });
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
    const media = await worker.evaluate(({ tabId, url }) => handle({ action: 'analyze', tabId, url, scanPlayer: true }), { tabId, url });
    assert.equal(media.browser, true); assert.equal(media.options[0].bytes, bytes.length);
    await worker.evaluate(() => handle({ action: 'download', token: 'browser', choice: 'format' }));
    for (let attempt = 0; attempt < 100 && !await worker.evaluate(() => testStream.finished || testStream.error); attempt++) await page.waitForTimeout(50);
    const result = await worker.evaluate(async () => {
      const all = new Uint8Array(testStream.bytes); let offset = 0;
      for (const part of testStream.parts) { const value = Uint8Array.from(atob(part), c => c.charCodeAt(0)); all.set(value, offset); offset += value.length; }
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', all))].map(v => v.toString(16).padStart(2, '0')).join('');
      return { finished: testStream.finished, error: testStream.error, digest, bytes: testStream.bytes };
    });
    assert.equal(result.error, undefined); assert.equal(result.finished, true); assert.equal(result.bytes, bytes.length);
    assert.equal(result.digest, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(await page.evaluate(() => Object.keys(window).filter(key => key.startsWith('__vidrush_')).length), 0);
    for (let attempt = 0; attempt < 30 && await worker.evaluate(() => browserJobs.size > 0); attempt++) await page.waitForTimeout(20);
    await worker.evaluate(() => { testStream.parts = []; testStream.bytes = 0; testStream.finished = false; testStream.hold = true; });
    const cancelling = await worker.evaluate(() => handle({ action: 'download', token: 'browser', choice: 'format' }));
    for (let attempt = 0; attempt < 100 && !await worker.evaluate(() => !!testStream.release); attempt++) await page.waitForTimeout(20);
    assert.equal(await worker.evaluate(() => !!testStream.release), true);
    await worker.evaluate(jobId => handle({ action: 'cancel', jobId }), cancelling.id);
    await worker.evaluate(() => { testStream.hold = false; testStream.release(); });
    for (let attempt = 0; attempt < 100 && await worker.evaluate(() => browserJobs.size > 0); attempt++) await page.waitForTimeout(20);
    assert.equal(await worker.evaluate(() => testStream.cancelled && !testStream.finished && browserJobs.size === 0), true);
    assert.equal(await page.evaluate(() => Object.keys(window).filter(key => key.startsWith('__vidrush_')).length), 0);
    console.log('Browser-only Service Worker fallback preserved file bytes through MAIN-world reads, bounded chunks and acknowledgements.');
  } finally {
    if (context) await context.close(); await new Promise(resolve => server.close(resolve));
    const relative = path.relative(os.tmpdir(), root);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) fs.rmSync(root, { recursive: true, force: true });
  }
}
module.exports = { run };
