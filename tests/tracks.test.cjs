'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { clearHlsSamples } = require('../host/tracks.cjs');

test('HLS probing samples clear same-origin segments and skips protected or unsupported playlists', async t => {
  const url = 'https://cdn.test/video/rendition?signature=private';
  const media = '#EXT-X-TARGETDURATION:3\n#EXTINF:3.0,\none.ts\n#EXTINF:3.0,\ntwo.ts\n#EXTINF:3.0,\nthree.ts\n#EXT-X-ENDLIST\n';
  let body = '#EXTM3U\n' + media;
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(body));
  assert.deepEqual(await clearHlsSamples(url, { referer: 'https://player.test/' }), [
    'https://cdn.test/video/one.ts', 'https://cdn.test/video/two.ts',
  ]);
  assert.equal(fetch.mock.calls[0].arguments[1].redirect, 'error');
  assert.deepEqual(fetch.mock.calls[0].arguments[1].headers, { Referer: 'https://player.test/' });
  for (const tag of [
    '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://license.test/"',
    '#EXT-X-KEY:METHOD=AES-128,URI="https://license.test/"',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXT-X-BYTERANGE:200@0',
  ]) {
    body = '#EXTM3U\n' + tag + '\n' + media;
    assert.deepEqual(await clearHlsSamples(url, {}), []);
  }
  body = '#EXTM3U\n' + media.replace('two.ts', 'https://unrelated.test/two.ts');
  assert.deepEqual(await clearHlsSamples(url, {}), []);
});
