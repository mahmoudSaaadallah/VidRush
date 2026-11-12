'use strict';

function trackError(code, message) {
  return Object.assign(new Error(message), { code });
}

function missingTracks() {
  return trackError('MISSING_MEDIA_TRACKS', 'This source does not contain both a video track and an audio track.');
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
    audio: streams.find(stream => stream.codec_type === 'audio'),
  };
}

const directContainers = { mp4: 'mov', m4v: 'mov', mov: 'mov', webm: 'matroska' };

function isAmbiguousDirectFile(format) {
  return ['http', 'https'].includes(format.protocol) && Object.hasOwn(directContainers, format.ext) &&
    (!format.vcodec || format.vcodec === 'unknown' || !format.acodec || format.acodec === 'unknown') &&
    format.vcodec !== 'none' && format.acodec !== 'none' && !format.has_drm;
}

function trackProbeArgs(input, network) {
  const args = ['-v', 'error', '-probesize', '2097152', '-analyzeduration', '2000000',
    '-protocol_whitelist', network ? 'http,https,tcp,tls' : 'file',
    '-show_entries', 'stream=codec_type,codec_name,codec_tag_string,width,height:stream_disposition=attached_pic', '-of', 'json'];
  if (network) {
    args.push('-rw_timeout', '6000000', '-f', directContainers[network.ext]);
    if (network.userAgent) args.push('-user_agent', network.userAgent);
    if (network.referer) args.push('-referer', network.referer);
    if (network.origin) args.push('-headers', 'Origin: ' + network.origin + '\r\n');
  }
  return [...args, '-i', input];
}

module.exports = { isAmbiguousDirectFile, missingTracks, protectedMedia, readTracks, trackProbeArgs };
