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
const { clearHlsSamples, isAmbiguousDirectFile, isAmbiguousHlsPlaylist, missingTracks, readTracks, trackProbeArgs } = require('./tracks.cjs');

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

  run(args, { timeout = 90000, onLine, executable = this.config.ytdlpPath } = {}) {
    return new Promise((resolve, reject) => {
      const child = this.spawn(executable, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
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
        else if (code !== 0) reject(new Error(stderr.trim() || `${path.basename(executable)} exited with code ${code}.`));
        else resolve(stdout);
      });
      if (onLine) onLine.child = child;
    });
  }

  async probeTracks(input, network) {
    const executable = path.join(this.config.ffmpegPath, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    const timeout = network?.ext === 'ts' ? 5000 : 8000;
    return readTracks(await this.run(trackProbeArgs(input, network), { executable, timeout }));
  }

  async resolveAmbiguousTracks(info, context) {
    if (!this.config.ffmpegPath || info.has_drm || !Array.isArray(info.formats)) return;
    const candidates = info.formats.filter(format => isAmbiguousDirectFile(format) || isAmbiguousHlsPlaylist(format)).slice(0, 2);
    await Promise.all(candidates.map(async format => {
      let tracks;
      try {
        const url = validateUrl(format.url);
        if (isAmbiguousHlsPlaylist(format)) {
          const samples = await clearHlsSamples(url, context);
          if (!samples.length) return;
          const results = await Promise.all(samples.map(segment => this.probeTracks(validateUrl(segment), { ...context, ext: 'ts' })));
          tracks = { video: results.find(result => result.video)?.video, audio: results.find(result => result.audio)?.audio };
        } else {
          tracks = await this.probeTracks(url, { ...context, ext: format.ext });
        }
      }
      catch (error) {
        if (error.code === 'DRM_PROTECTED') format.has_drm = true;
        // Some servers reject a separate metadata request. Validate the saved file instead.
        return;
      }
      format.vcodec = tracks.video ? tracks.video.codec_name || 'unknown' : 'none';
      format.acodec = tracks.audio ? tracks.audio.codec_name || 'unknown' : 'none';
      if (tracks.video) format.height ||= tracks.video.height;
    }));
  }

  async verifySavedVideo(file) {
    if (!this.config.ffmpegPath) return;
    const { video, audio } = await this.probeTracks(file);
    if (!video || !audio) throw missingTracks();
  }

  async describeDownloadError(error, input) {
    if (!/\bPostprocessing:/i.test(error.message)) return error.message;
    if (this.config.ffmpegPath && input) {
      try {
        if (fs.lstatSync(input).isFile()) {
          const { video, audio } = await this.probeTracks(input);
          if (video && !audio) return 'The downloaded source has no readable audio track. Refresh VidRush and choose another detected source if available.';
          if (audio && !video) return 'The downloaded source has no readable video track. Refresh VidRush and choose another detected source if available.';
        }
      } catch { /* Preserve the postprocessing error if the input cannot be verified. */ }
    }
    return 'FFmpeg could not finish the downloaded file.\n' + error.message;
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
        this.versionPromise ||= this.run(['--version'], { timeout: 15000 }).then(version => version.trim()).catch(error => { this.versionPromise = null; throw error; });
        const version = await this.versionPromise;
        data = { version, ffmpeg: !!this.config.ffmpegPath, downloadDir: this.config.downloadDir, choosingFolder: this.choosingFolder,
          protocolVersion: 7, capabilities: { folderPicker: true, openFolder: true, pageSources: true, sourceContext: true, browserTransfer: true, browserQualities: true, analysisCache: true } };
      } else if (action === 'cachedMedia') {
        const media = this.media.get(message.token);
        if (media) { this.media.delete(message.token); this.media.set(message.token, media); }
        // Confirm the token still belongs to this companion without running yt-dlp
        // or returning its signed URL, referrer, or request headers.
        data = { available: !!media };
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
          await this.resolveAmbiguousTracks(info, { ...context, referer: message.referer });
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
          else if (action === 'browserFinish') {
            data = await transfer.finish(file => this.verifySavedVideo(file));
            this.browserJobs.delete(message.jobId);
          }
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
        if (media.browser) this.browserJobs.set(job.id, new BrowserDownload(job, choice, value => this.update(value)));
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
      const code = ['DRM_PROTECTED', 'MISSING_MEDIA_TRACKS'].includes(error.code) ? error.code : undefined;
      this.emit({ id, ok: false, error: safeError(error.message || error).slice(-3000), code });
    }
  }

  publicJob(job) {
    const { child, ...result } = job;
    return result;
  }

  update(job) { this.emit({ event: 'job', job: this.publicJob(job) }); }

  startJob(job, url, choice, referer, context) {
    job.downloadDir ||= this.config.downloadDir;
    let input;
    const outputDirectory = path.resolve(job.downloadDir);
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
      } else if (line.startsWith('VIDRUSH_INPUT:') || line.startsWith('VIDRUSH_FILE:')) {
        try {
          const outputPath = path.resolve(JSON.parse(line.slice(line.indexOf(':') + 1)));
          const relative = path.relative(outputDirectory, outputPath);
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative !== path.basename(relative)) return;
          if (line.startsWith('VIDRUSH_INPUT:')) input = outputPath;
          else job.filename = relative;
        } catch { /* Completion still works if the extractor omits the filename. */ }
      }
    };
    const task = this.run(downloadArgs({ ...this.config, downloadDir: job.downloadDir }, url, choice, referer, context), { timeout: 0, onLine });
    job.child = onLine.child;
    task.then(async () => {
      if (job.status === 'cancelled') return;
      if (this.config.ffmpegPath) {
        if (!job.filename) throw new Error('VidRush could not verify the saved video file.');
        job.status = 'processing';
        this.update(job);
        await this.verifySavedVideo(path.join(job.downloadDir, job.filename));
      }
      if (job.status === 'cancelled') return;
      job.status = 'completed'; job.percent = 100;
      delete job.speed; delete job.eta;
      this.update(job);
    }).catch(async error => {
      if (job.status === 'cancelled') return;
      const detail = await this.describeDownloadError(error, input);
      if (job.status === 'cancelled') return;
      job.status = 'failed'; job.error = safeError(detail).slice(-2000);
      this.update(job);
    });
  }

  close() { for (const child of this.children) this.stop(child); for (const transfer of this.browserJobs.values()) transfer.cancel(); this.browserJobs.clear(); }
}

module.exports = { Companion };
