'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateUrl, buildMedia, publicMedia, downloadArgs, sourceArgs } = require('../host/media.cjs');
const { extensionId, checksumFor } = require('../scripts/install.cjs');
const formats = [
  { format_id: '22', url: 'https://cdn.test/v', height: 720, fps: 30, ext: 'mp4', vcodec: 'avc1', acodec: 'aac', tbr: 500, filesize: 100 },
  { format_id: '137', url: 'https://cdn.test/hd', height: 1080, fps: 60, ext: 'mp4', vcodec: 'avc1', acodec: 'none', tbr: 2000, filesize: 200 },
  { format_id: '140', url: 'https://cdn.test/a', ext: 'm4a', vcodec: 'none', acodec: 'aac', abr: 128, filesize: 20 },
  { format_id: '251', url: 'https://cdn.test/opus', ext: 'webm', vcodec: 'none', acodec: 'opus', abr: 160, filesize: 25 },
];

test('source context only allows validated referrer, user agent and origin arguments', () => {
  assert.deepEqual(sourceArgs('https://player.test/', { userAgent: 'Browser', origin: 'https://player.test', Cookie: 'ignored' }), ['--referer', 'https://player.test/', '--user-agent', 'Browser', '--add-header', 'Origin:https://player.test']);
  for (const context of [{ userAgent: 'bad\r\nCookie: secret' }, { origin: 'file:///private' }, { origin: 'https://player.test/path' }, { origin: 'https://player.test/\nInjected: yes' }, { userAgent: 'a'.repeat(513) }]) assert.throws(() => sourceArgs(undefined, context), /Invalid|HTTP/);
});

test('URL validation rejects non-web protocols, credentials, options, and malformed values', () => {
  for (const value of ['file:///C:/secret', 'javascript:alert(1)', '--exec=calc', 'https://user:pass@example.com', {}, '']) {
    assert.throws(() => validateUrl(value));
  }
  assert.equal(validateUrl('https://example.com/watch?v=1'), 'https://example.com/watch?v=1');
});

test('format choices combine matching audio, preserve exact quality, and hide selectors', () => {
  const media = buildMedia({ title: '<script>bad</script>', formats }, true);
  assert.equal(media.options[0].height, 1080);
  assert.equal(media.options[0].selector, '137+140');
  assert.equal(media.options[0].container, 'mp4');
  assert.equal(media.options[0].bytes, 220);
  assert.equal(publicMedia(media).options[0].selector, undefined);
  assert.equal(media.title, '<script>bad</script>');
});

test('without FFmpeg only formats containing both video and audio are offered', () => {
  const media = buildMedia({ formats }, false);
  assert.deepEqual(media.options.map(option => option.selector), ['22']);
});

test('generic direct-video extractors with unknown codecs remain downloadable', () => {
  const media = buildMedia({ formats: [{ format_id: 'mp4', url: 'https://example.com/video.mp4', ext: 'mp4' }] }, true);
  assert.equal(media.options[0].selector, 'mp4');
  assert.equal(media.options[0].needsMerge, false);
});

test('DRM, silent-only formats, playlists and unsupported pages are not offered', () => {
  assert.throws(() => buildMedia({ formats: formats.map(f => ({ ...f, has_drm: true })) }, true), /No downloadable/);
  assert.throws(() => buildMedia({ formats: [formats[1]] }, true), /No downloadable/);
  assert.throws(() => buildMedia({ _type: 'playlist', entries: [] }, true), /individual/);
  assert.throws(() => buildMedia({ is_live: true, formats }, true), /Live streams/);
});

test('same-resolution duplicates select higher bitrate, differing fps remain selectable', () => {
  const highBitrate = { ...formats[0], format_id: 'better', tbr: 800 };
  const highFps = { ...formats[0], format_id: 'smooth', fps: 60 };
  const media = buildMedia({ formats: [formats[0], highBitrate, highFps] }, true);
  assert.equal(media.options.length, 2);
  assert.equal(media.options[0].selector, 'smooth');
  assert.equal(media.options[1].selector, 'better');
});

test('download command fixes destination and selected format and isolates URL arguments', () => {
  const media = buildMedia({ formats }, true);
  const config = { downloadDir: 'C:\\Videos with spaces', ffmpegPath: 'C:\\Tools', nodePath: 'C:\\Node\\node.exe' };
  const url = 'https://example.com/video?title=$(calc)&x=1';
  const args = downloadArgs(config, url, media.options[0]);
  assert.deepEqual(args.slice(-2), ['--', url]);
  assert.equal(args[args.indexOf('--format') + 1], '137+140');
  assert.equal(args[args.indexOf('--paths') + 1], config.downloadDir);
  assert.ok(args.includes('--ignore-config'));
  assert.ok(args.includes('--no-plugin-dirs'));
  assert.equal(args[args.indexOf('--merge-output-format') + 1], 'mp4');
});

test('installer computes stable Chrome extension ID and validates release checksums', () => {
  const manifest = require('../extension/manifest.json');
  assert.match(extensionId(manifest.key), /^[a-p]{32}$/);
  assert.equal(extensionId(manifest.key), extensionId(manifest.key));
  assert.equal(checksumFor(`${'a'.repeat(64)}  yt-dlp.exe\n`, 'yt-dlp.exe'), 'a'.repeat(64));
  assert.equal(checksumFor(`${'b'.repeat(64)} *ffmpeg.zip\n`, 'ffmpeg.zip'), 'b'.repeat(64));
  assert.throws(() => checksumFor('invalid yt-dlp.exe', 'yt-dlp.exe'), /checksum/);
});
