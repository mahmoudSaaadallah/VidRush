'use strict';

const { randomUUID } = require('node:crypto');
const { missingTracks, protectedMedia } = require('./tracks.cjs');

function validateUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Invalid video URL.');
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter a valid video URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only HTTP and HTTPS video pages are supported.');
  }
  return url.href;
}

function buildMedia(info, hasFfmpeg) {
  if (info.has_drm === true) throw protectedMedia();
  if (info._type === 'playlist' || info.entries) throw new Error('Open an individual video page, rather than a playlist.');
  if (info.is_live || info.live_status === 'is_live' || info.live_status === 'is_upcoming') throw new Error('Live streams are not supported. Open a recorded video.');
  const formats = (info.formats || []).filter(f => f.format_id && !f.has_drm);
  // Generic/direct MP4 extractors can leave codec fields unknown. Only the explicit
  // sentinel "none" proves that a track is missing.
  const isAudio = f => (f.vcodec === 'none' || !f.vcodec) && f.url && (f.acodec ? f.acodec !== 'none' : (f.resolution === 'audio only' || (f.audio_ext && f.audio_ext !== 'none') || /audio/i.test(f.format_note || '') || /audio/i.test(f.format_id || '')));
  const isVideo = f => f.vcodec !== 'none' && f.ext !== 'mhtml' && f.url && f.resolution !== 'audio only';
  const videos = formats.filter(isVideo);
  const audio = formats.filter(isAudio);
  const choices = new Map();
  for (const video of videos) {
    const needsMerge = video.acodec === 'none' || video.audio_ext === 'none';
    if (needsMerge && (!hasFfmpeg || !audio.length)) continue;
    const candidates = [...audio].sort((a, b) => {
      const preferred = video.ext === 'mp4' ? (['m4a', 'mp4', 'aac'].includes(b.ext) - ['m4a', 'mp4', 'aac'].includes(a.ext)) : Number(b.ext === 'webm') - Number(a.ext === 'webm');
      return preferred || (b.source_preference ?? 0) - (a.source_preference ?? 0) || (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0);
    });
    const selectedAudio = needsMerge ? candidates[0] : null;
    const container = needsMerge ? (video.ext === 'mp4' && ['m4a', 'mp4', 'aac'].includes(selectedAudio?.ext) ? 'mp4' : 'mkv') : video.ext;
    const height = video.height || 0;
    const fps = Math.round(video.fps || 0);
    const key = `${height}:${fps}:${container}`;
    const score = video.tbr || video.vbr || 0;
    if (choices.has(key) && choices.get(key).score >= score) continue;
    const size = video.filesize || video.filesize_approx;
    const audioSize = selectedAudio && (selectedAudio.filesize || selectedAudio.filesize_approx);
    choices.set(key, {
      id: randomUUID(), height, fps, container, score,
      label: `${height ? `${height}p` : 'Original'}${fps > 30 ? ` · ${fps} fps` : ''} · ${container.toUpperCase()}`,
      bytes: size && (!needsMerge || audioSize) ? size + (audioSize || 0) : null,
      approximate: !!(video.filesize_approx || selectedAudio?.filesize_approx),
      selector: needsMerge ? `${video.format_id}+${selectedAudio.format_id}` : String(video.format_id),
      needsMerge,
    });
  }
  const options = [...choices.values()].sort((a, b) => b.height - a.height || b.fps - a.fps || a.container.localeCompare(b.container));
  if (!options.length) {
    if (info.formats?.some(format => format.has_drm === true)) throw protectedMedia();
    if (formats.length && formats.every(format => format.vcodec === 'none' || format.acodec === 'none') && (!videos.length || !audio.length)) {
      throw missingTracks({ hasVideo: Boolean(videos.length), hasAudio: Boolean(audio.length) });
    }
    throw new Error('No downloadable video with audio was found. The page may be unsupported or require login.');
  }
  return {
    token: randomUUID(), title: String(info.title || 'Video').slice(0, 300),
    duration: info.duration || null, site: String(info.extractor_key || info.extractor || 'Website').slice(0, 80),
    options,
  };
}

function publicMedia(media) {
  return { ...media, options: media.options.map(({ selector, needsMerge, score, ...option }) => option) };
}

function baseArgs(config) {
  return ['--ignore-config', '--no-plugin-dirs', '--no-cache-dir', '--no-playlist', '--no-colors',
    '--socket-timeout', '20', '--retries', '3', '--js-runtimes', `node:${config.nodePath || process.execPath}`];
}

function refererArgs(value) {
  if (value === undefined) return [];
  if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('Invalid video referrer.');
  return ['--referer', validateUrl(value)];
}

function sourceArgs(referer, context = {}) {
  const args = refererArgs(referer);
  if (context.userAgent !== undefined) {
    if (typeof context.userAgent !== 'string' || !context.userAgent || context.userAgent.length > 512 || /[\r\n]/.test(context.userAgent)) throw new Error('Invalid video user agent.');
    args.push('--user-agent', context.userAgent);
  }
  if (context.origin !== undefined) {
    if (typeof context.origin !== 'string' || /[\r\n]/.test(context.origin) || new URL(validateUrl(context.origin)).origin !== context.origin) throw new Error('Invalid video origin.');
    args.push('--add-header', 'Origin:' + context.origin);
  }
  return args;
}

function safeError(value) {
  return String(value).replace(/https?:\/\/[^\s<>"']+/g, raw => {
    try { const url = new URL(raw); return url.origin + url.pathname + (url.search ? '?[redacted]' : ''); }
    catch { return '[video URL]'; }
  });
}

function mergePairedInfos(videoInfo, audioInfo, options = {}) {
  const referer = options.referer;
  const audioReferer = options.audioReferer || referer;
  const title = (typeof options.title === 'string' && options.title.trim()) || videoInfo.title || audioInfo.title || 'Video';

  if (videoInfo.has_drm === true || audioInfo.has_drm === true) throw protectedMedia();

  const rawVideoFormats = Array.isArray(videoInfo.formats) && videoInfo.formats.length ? videoInfo.formats : (videoInfo.url ? [videoInfo] : []);
  const rawAudioFormats = Array.isArray(audioInfo.formats) && audioInfo.formats.length ? audioInfo.formats : (audioInfo.url ? [audioInfo] : []);

  const isVideoFormat = f => f.vcodec !== 'none' && f.resolution !== 'audio only' && f.ext !== 'mhtml' && f.url;
  const isAudioFormat = f => (f.vcodec === 'none' || !f.vcodec) && f.url && (f.acodec ? f.acodec !== 'none' : (f.resolution === 'audio only' || (f.audio_ext && f.audio_ext !== 'none') || /audio/i.test(f.format_note || '') || /audio/i.test(f.format_id || '')));

  const videoFormats = rawVideoFormats.filter(isVideoFormat).map((f, i) => {
    const format_id = `v-${f.format_id || i}`;
    const http_headers = { ...(f.http_headers || {}) };
    if (referer) http_headers.Referer = referer;
    return { ...f, format_id, acodec: 'none', http_headers };
  });

  const audioFormats = rawAudioFormats.filter(isAudioFormat).map((f, i) => {
    const format_id = `a-${f.format_id || i}`;
    const http_headers = { ...(f.http_headers || {}) };
    if (audioReferer) http_headers.Referer = audioReferer;
    return { ...f, format_id, vcodec: 'none', acodec: f.acodec && f.acodec !== 'none' ? f.acodec : 'unknown', http_headers };
  });

  return {
    ...videoInfo,
    id: videoInfo.id || 'paired',
    title: title.slice(0, 300),
    _type: 'video',
    formats: [...videoFormats, ...audioFormats]
  };
}

function downloadArgs(config, url, choice, referer, context, infoJsonPath) {
  const args = [...baseArgs(config), '--newline', '--progress', '--progress-delta', '0.5',
    '--progress-template', 'download:VIDRUSH_PROGRESS:%(progress)j',
    '--print', 'before_dl:VIDRUSH_INPUT:%(filename)j',
    '--print', 'after_move:VIDRUSH_FILE:%(filepath)j', '--no-simulate',
    '--windows-filenames', '--trim-filenames', '180', '--no-overwrites',
    '--paths', config.downloadDir, '--output', '%(title).120B [%(id)s] [%(format_id)s].%(ext)s',
    '--format', choice.selector];
  if (config.ffmpegPath) args.push('--ffmpeg-location', config.ffmpegPath);
  if (choice.needsMerge) args.push('--merge-output-format', choice.container);
  if (infoJsonPath) args.push(...sourceArgs(referer, context), '--load-info-json', infoJsonPath);
  else args.push(...sourceArgs(referer, context), '--', validateUrl(url));
  return args;
}

module.exports = { validateUrl, buildMedia, publicMedia, baseArgs, downloadArgs, refererArgs, sourceArgs, safeError, mergePairedInfos };
