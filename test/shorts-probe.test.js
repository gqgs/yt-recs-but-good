import test from 'node:test';
import assert from 'node:assert/strict';
import {
  thumbnailProbeUrl, jpegDimensions, formatFromJpegHeader, probeVideoFormat,
  probeFormatBatch, SHORTS_PROBE_MAX_BATCH, SHORTS_PROBE_SOURCE
} from '../lib/shorts-probe.js';

// A deliberately minimal JPEG header with a proper SOI, APP0 and SOF0
// segment. Pixel decoding is unnecessary: only dimensions are inspected.
function jpeg(width, height) {
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe0, 0, 4, 0, 0,
    0xff, 0xc0, 0, 17, 8,
    height >> 8, height & 255, width >> 8, width & 255,
    3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0
  ]).buffer;
}

function response(width, height, status = 206) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: key => key === 'content-type' ? 'image/jpeg' : null },
    arrayBuffer: async () => jpeg(width, height)
  };
}

test('uses one oar2 thumbnail request per video, not an oEmbed JSON request', async () => {
  assert.equal(thumbnailProbeUrl('abcdefghijk'),
    'https://i.ytimg.com/vi/abcdefghijk/oar2.jpg');
  assert.equal(SHORTS_PROBE_SOURCE, 'oar2-jpeg-v1');
  assert.throws(() => thumbnailProbeUrl('invalid-id-too-long'), /Invalid/);
  let calls = 0;
  const result = await probeVideoFormat('abcdefghijk', async (url, options) => {
    calls++;
    assert.equal(url, thumbnailProbeUrl('abcdefghijk'));
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Range, 'bytes=0-32767');
    assert.ok(options.signal);
    return response(1080, 1920);
  });
  assert.equal(calls, 1);
  assert.equal(result, 'portrait');
});

test('reads JPEG dimensions without decoding image pixels', () => {
  assert.deepEqual(jpegDimensions(jpeg(1080, 1920)), { width: 1080, height: 1920 });
  assert.equal(formatFromJpegHeader(jpeg(1080, 1920)), 'portrait');
  assert.equal(formatFromJpegHeader(jpeg(720, 1280)), 'portrait');
  assert.equal(formatFromJpegHeader(jpeg(1920, 1080)), 'landscape');
  assert.equal(formatFromJpegHeader(jpeg(320, 240)), 'landscape');
});

test('a normal video may have oar2.jpg; availability alone is not a Shorts signal', async () => {
  assert.equal(await probeVideoFormat('lmnopqrstuv',
    async () => response(1920, 1080, 200)), 'landscape');
});

test('rejects 404 placeholder images even if their bytes are valid JPEG', async () => {
  let reads = 0;
  const placeholder = {
    ...response(120, 90, 404),
    arrayBuffer: async () => { reads++; return jpeg(120, 90); }
  };
  assert.equal(await probeVideoFormat('abcdefghijk', async () => placeholder), 'unknown');
  assert.equal(reads, 0);
});

test('non-JPEG, truncated or malformed headers are inconclusive', async () => {
  assert.equal(formatFromJpegHeader(new Uint8Array([1, 2, 3]).buffer), 'unknown');
  assert.equal(formatFromJpegHeader(jpeg(1080, 1920).slice(0, 14)), 'unknown');
  assert.equal(await probeVideoFormat('abcdefghijk', async () => ({
    ...response(720, 1280),
    headers: { get: () => 'image/png' }
  })), 'unknown');
});

test('timeouts and network failures return unknown and abort the request', async () => {
  let signal;
  assert.equal(await probeVideoFormat('abcdefghijk',
    async (_url, args) => {
      signal = args.signal;
      return new Promise(() => {});
    }, 12), 'unknown');
  assert.equal(signal.aborted, true);
  assert.equal(await probeVideoFormat('abcdefghijk', async () => {
    throw new Error('offline');
  }), 'unknown');
});

test('batches are deduplicated and bounded to the configured concurrency', async () => {
  const ids = Array.from({ length: 40 }, (_, i) => String(i).padStart(11, '0'));
  let calls = 0, inFlight = 0, maxInFlight = 0;
  const result = await probeFormatBatch([ids[0], ...ids, ids[1]], {
    concurrency: 4,
    fetcher: async () => {
      calls++;
      inFlight++;
      maxInFlight = Math.max(inFlight, maxInFlight);
      await new Promise(resolve => setTimeout(resolve, 1));
      inFlight--;
      return response(1920, 1080);
    }
  });
  assert.equal(result.size, SHORTS_PROBE_MAX_BATCH);
  assert.equal(calls, SHORTS_PROBE_MAX_BATCH);
  assert.ok(maxInFlight <= 4);
  assert.equal(result.get(ids[0]), 'landscape');
});
