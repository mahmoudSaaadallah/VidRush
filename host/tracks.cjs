'use strict';

function trackError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function missingTracks(extra = {}) {
  return trackError('MISSING_MEDIA_TRACKS', 'This source does not contain both a video track and an audio track.', extra);
}

function protectedMedia() {
  return trackError('DRM_PROTECTED', 'This video is DRM protected. VidRush supports unprotected video sources.');
}

function readTracks(output) {
  const { streams } = JSON.parse(output);
  if (!Array.isArray(streams) || !streams.length) throw new Error('No media tracks could be verified.');
  if (streams.some(stream => ['encv', 'enca'].includes(stream.codec_tag_string))) throw protectedMedia();
  return {
    video: streams.find(stream => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1 && stream.width > 0 && stream.height > 0),
    audio: streams.find(stream => stream.codec_type === 'audio' && stream.channels > 0 && Number(stream.sample_rate) > 0),
  };
}

const directContainers = { mp4: 'mov', m4v: 'mov', mov: 'mov', webm: 'matroska' };
const unknown = codec => !codec || codec === 'unknown';

function isAmbiguousDirectFile(format) {
  return ['http', 'https'].includes(format.protocol) && Object.hasOwn(directContainers, format.ext) &&
    (unknown(format.vcodec) || unknown(format.acodec)) &&
    format.vcodec !== 'none' && format.acodec !== 'none' && !format.has_drm;
}

function isAmbiguousHlsPlaylist(format) {
  return ['m3u8', 'm3u8_native'].includes(format.protocol) && !format.manifest_url && !format.has_drm &&
    unknown(format.vcodec) && unknown(format.acodec);
}

async function clearHlsSamples(url, context) {
  const headers = {};
  if (context.userAgent) headers['User-Agent'] = context.userAgent;
  if (context.referer) headers.Referer = context.referer;
  if (context.origin) headers.Origin = context.origin;
  const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(3000) });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    return [];
  }
  const decoder = new TextDecoder();
  let playlist = '', size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 256 * 1024) return [];
    playlist += decoder.decode(chunk, { stream: true });
  }
  const lines = (playlist + decoder.decode()).split(/\r?\n/).map(line => line.trim());
  if (lines[0] !== '#EXTM3U' || !lines.includes('#EXT-X-ENDLIST') || !lines.some(line => line.startsWith('#EXTINF:')) ||
      lines.some(line => /^#EXT-X-(?:KEY|SESSION-KEY|MAP|BYTERANGE|STREAM-INF):/i.test(line))) return [];
  const segments = lines.filter(line => line && !line.startsWith('#'));
  if (!segments.length) return [];
  // Sample the start and a later segment in case the opening has delayed audio.
  const samples = [...new Set([segments[0], segments[Math.floor(segments.length / 2)]])].map(segment => new URL(segment, url));
  const origin = new URL(url).origin;
  if (samples.some(segment => segment.origin !== origin || !['http:', 'https:'].includes(segment.protocol) || segment.username || segment.password)) return [];
  return samples.map(segment => segment.href);
}

function trackProbeArgs(input, network) {
  const args = ['-v', 'error', '-probesize', '2097152', '-analyzeduration', '2000000',
    '-protocol_whitelist', network ? 'http,https,tcp,tls' : 'file',
    '-show_entries', 'stream=codec_type,codec_name,codec_tag_string,width,height,channels,sample_rate:stream_disposition=attached_pic', '-of', 'json'];
  if (network) {
    args.push('-rw_timeout', '6000000', '-f', network.ext === 'ts' ? 'mpegts' : directContainers[network.ext]);
    if (network.userAgent) args.push('-user_agent', network.userAgent);
    if (network.referer) args.push('-referer', network.referer);
    if (network.origin) args.push('-headers', 'Origin: ' + network.origin + '\r\n');
  }
  return [...args, '-i', input];
}

module.exports = { clearHlsSamples, isAmbiguousDirectFile, isAmbiguousHlsPlaylist, missingTracks, protectedMedia, readTracks, trackProbeArgs };
