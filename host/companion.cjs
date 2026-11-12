'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { createInterface } = require('node:readline');
const { validateUrl, buildMedia, publicMedia, baseArgs, downloadArgs, sourceArgs, safeError } = require('./media.cjs');
const { selectFolder, saveDownloadDirectory } = require('./folders.cjs');
const { openFolder } = require('./open-folder.cjs');
const { browserMedia, BrowserDownload } = require('./browser-download.cjs');

class Companion {
  constructor(config, emit, spawnProcess = spawn, options = {}) {
    this.config = config;
    this.emit = emit;
    this.spawn = spawnProcess;
    this.media = new Map();
    this.jobs = new Map();
    this.browserJobs = new Map();
    this.children = new Set();
    this.inspections = 0;
    this.choosingFolder = false;
    this.configPath = options.configPath;
    this.pickFolder = options.selectFolder || selectFolder;
  }

  run(args, { timeout = 90000, onLine } = {}) {
    return new Promise((resolve, reject) => {
      const child = this.spawn(this.config.ytdlpPath, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      this.children.add(child);
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      const timer = timeout ? setTimeout(() => { timedOut = true; this.stop(child); }, timeout) : null;
      child.stdout.on('data', data => {
        if (!onLine) {
          stdout += data.toString('utf8');
          if (stdout.length > 32 * 1024 * 1024) this.stop(child);
        }
      });
      if (onLine) createInterface({ input: child.stdout }).on('line', onLine);
      child.stderr.on('data', data => { stderr = (stderr + data.toString('utf8')).slice(-6000); });
      child.on('error', error => { clearTimeout(timer); this.children.delete(child); reject(error); });
      child.on('close', code => {
        clearTimeout(timer);
        this.children.delete(child);
        if (timedOut) reject(new Error('Video analysis timed out. Try again or open the individual video page.'));
        else if (code !== 0) reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}.`));
        else resolve(stdout);
      });
      if (onLine) onLine.child = child;
    });
  }

  stop(child) {
    if (!child || child.exitCode !== null) return;
    if (process.platform === 'win32') {
      const killer = this.spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => child.kill());
    } else child.kill('SIGTERM');
  }

  async handle(message) {
    const { id, action } = message || {};
    if (typeof id !== 'string' || id.length > 100) return;
    try {
      let data;
      if (action === 'ping') {
        const version = (await this.run(['--version'], { timeout: 15000 })).trim();
        data = { version, ffmpeg: !!this.config.ffmpegPath, downloadDir: this.config.downloadDir, choosingFolder: this.choosingFolder,
          protocolVersion: 5, capabilities: { folderPicker: true, openFolder: true, pageSources: true, sourceContext: true, browserTransfer: true } };
      } else if (action === 'chooseFolder') {
        if (this.choosingFolder) throw new Error('A folder picker is already open. Finish or cancel it first.');
        this.choosingFolder = true;
        try {
          const selected = await this.pickFolder(this.config.downloadDir, {
            spawnProcess: this.spawn,
            onStart: child => this.children.add(child), onEnd: child => this.children.delete(child),
          });
          if (selected !== null) this.config = saveDownloadDirectory(this.configPath, this.config, selected);
          data = { downloadDir: this.config.downloadDir, cancelled: selected === null, choosingFolder: false };
        } finally { this.choosingFolder = false; }
      } else if (action === 'inspect') {
        if (this.inspections >= 2) throw new Error('Video analysis is already running. Wait a moment and retry.');
        const url = validateUrl(message.url);
        const context = { userAgent: message.userAgent, origin: message.origin };
        const headers = sourceArgs(message.referer, context);
        this.inspections++;
        try {
          const raw = await this.run([...baseArgs(this.config), ...headers, '--skip-download', '--dump-single-json', '--', url]);
          let info = JSON.parse(raw);
          // Generic extractors wrap a single embedded video in a playlist result.
          // Do not expand real playlists, unresolved entries, or multiple videos.
          if (info.entries?.length === 1 && info.entries[0]?.formats) info = info.entries[0];
          const media = buildMedia(info, !!this.config.ffmpegPath);
          if (message.referer && typeof message.title === 'string' && message.title.trim()) media.title = message.title.trim().slice(0, 300);
          this.media.set(media.token, { ...media, url, referer: message.referer, context });
          if (this.media.size > 8) this.media.delete(this.media.keys().next().value);
          data = publicMedia(media);
        } finally { this.inspections--; }
      } else if (action === 'prepareBrowser') {
        const media = browserMedia(message.metadata);
        this.media.set(media.token, media);
        if (this.media.size > 8) this.media.delete(this.media.keys().next().value);
        data = publicMedia(media);
      } else if (['browserChunk', 'browserFinish', 'browserAbort'].includes(action)) {
        const transfer = this.browserJobs.get(message.jobId);
        if (!transfer) throw new Error('Browser download is no longer active.');
        try {
          if (action === 'browserChunk') data = await transfer.chunk(message.offset, message.data);
          else if (action === 'browserFinish') { data = await transfer.finish(); this.browserJobs.delete(message.jobId); }
          else { transfer.fail(String(message.error || 'The video page closed or the browser transfer stopped.')); this.browserJobs.delete(message.jobId); data = { stopped: true }; }
        } catch (error) { transfer.fail(error.message); this.browserJobs.delete(message.jobId); throw error; }
      } else if (action === 'download') {
        const media = this.media.get(message.token);
        const choice = media?.options.find(option => option.id === message.choice);
        if (!choice) throw new Error('This quality selection has expired. Analyze the video again.');
        if ([...this.jobs.values()].filter(job => ['downloading', 'processing'].includes(job.status)).length >= 2) {
          throw new Error('Two downloads are already running. Wait for one to finish.');
        }
        fs.mkdirSync(this.config.downloadDir, { recursive: true });
        const job = { id: randomUUID(), title: media.title, quality: choice.label, downloadDir: this.config.downloadDir, status: 'downloading', percent: 0, createdAt: Date.now() };
        this.jobs.set(job.id, job);
        while (this.jobs.size > 30) {
          const old = [...this.jobs.values()].find(item => !['downloading', 'processing'].includes(item.status));
          if (!old) break;
          this.jobs.delete(old.id);
        }
        if (media.browser) this.browserJobs.set(job.id, new BrowserDownload(job, media, value => this.update(value)));
        else this.startJob(job, media.url, choice, media.referer, media.context);
        data = this.publicJob(job);
      } else if (action === 'cancel') {
        const job = this.jobs.get(message.jobId);
        if (!job) throw new Error('Download not found.');
        if (['downloading', 'processing'].includes(job.status)) {
          job.status = 'cancelled';
          this.browserJobs.get(job.id)?.cancel(); this.browserJobs.delete(job.id);
          this.stop(job.child);
          this.update(job);
        }
        data = this.publicJob(job);
      } else if (action === 'status') {
        data = [...this.jobs.values()].map(job => this.publicJob(job));
      } else if (action === 'openFolder') {
        const job = message.jobId ? this.jobs.get(message.jobId) : null;
        if (message.jobId && !job && !message.knownDownloadDir) throw new Error('Download not found.');
        const directory = job?.downloadDir || (message.jobId ? message.knownDownloadDir : this.config.downloadDir);
        if (!message.jobId) fs.mkdirSync(directory, { recursive: true });
        data = await openFolder(directory, this.spawn);
      } else throw new Error('Unknown companion action.');
      this.emit({ id, ok: true, data });
    } catch (error) {
      this.emit({ id, ok: false, error: safeError(error.message || error).slice(-3000) });
    }
  }

  publicJob(job) {
    const { child, ...result } = job;
    return result;
  }

  update(job) { this.emit({ event: 'job', job: this.publicJob(job) }); }

  startJob(job, url, choice, referer, context) {
    job.downloadDir ||= this.config.downloadDir;
    const onLine = line => {
      if (!['downloading', 'processing'].includes(job.status)) return;
      if (line.startsWith('VIDRUSH_PROGRESS:')) {
        try {
          const progress = JSON.parse(line.slice('VIDRUSH_PROGRESS:'.length));
          const total = progress.total_bytes || progress.total_bytes_estimate;
          job.percent = total ? Math.min(99, Math.round(progress.downloaded_bytes / total * 100)) : 0;
          job.speed = typeof progress.speed === 'number' ? progress.speed : null;
          job.eta = typeof progress.eta === 'number' ? progress.eta : null;
          job.status = progress.status === 'finished' ? 'processing' : 'downloading';
          this.update(job);
        } catch { /* Ignore a malformed progress line from an extractor. */ }
      } else if (line.startsWith('VIDRUSH_FILE:')) {
        try {
          const outputPath = path.resolve(JSON.parse(line.slice('VIDRUSH_FILE:'.length)));
          const relative = path.relative(path.resolve(job.downloadDir), outputPath);
          if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) job.filename = path.basename(outputPath);
        } catch { /* Completion still works if the extractor omits the filename. */ }
      }
    };
    const task = this.run(downloadArgs({ ...this.config, downloadDir: job.downloadDir }, url, choice, referer, context), { timeout: 0, onLine });
    job.child = onLine.child;
    task.then(() => {
      if (job.status === 'cancelled') return;
      job.status = 'completed'; job.percent = 100;
      delete job.speed; delete job.eta;
      this.update(job);
    }).catch(error => {
      if (job.status === 'cancelled') return;
      job.status = 'failed'; job.error = safeError(error.message).slice(-2000);
      this.update(job);
    });
  }

  close() { for (const child of this.children) this.stop(child); for (const transfer of this.browserJobs.values()) transfer.cancel(); this.browserJobs.clear(); }
}

module.exports = { Companion };
