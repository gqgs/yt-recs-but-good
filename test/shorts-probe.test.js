import test from 'node:test';
import assert from 'node:assert/strict';
import {
  thumbnailProbeUrl, probeVideoFormat, probeVideoFormatDetails,
  probeFormatBatchDetails, SHORTS_PROBE_SOURCE,
  SHORTS_PROBE_MAX_BATCH
} from '../lib/shorts-probe.js';

const positive = { format: 'portrait', reason: 'three-panel-match',
  score: 0.82, features: { edgeRatio: 4.4 } };
const negative = { format: 'landscape', reason: 'three-panel-not-detected',
  score: 0.18, features: { edgeRatio: 1.1 } };
function response(label = 'positive', status = 200) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: name => name.toLowerCase() === 'content-type' ? 'image/jpeg' : null },
    blob: async () => ({ size: 32000, label })
  };
}
const decode = async blob => blob.label === 'positive' ? positive : negative;

test('single request loads existing landscape thumbnail for local image classification', async () => {
  assert.equal(SHORTS_PROBE_SOURCE, 'three-panel-image-v1');
  assert.equal(thumbnailProbeUrl('abcdefghijk'),
    'https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg');
  assert.throws(() => thumbnailProbeUrl('too-long-video-identifier'), /Invalid/);
  let calls = 0;
  const result = await probeVideoFormatDetails('abcdefghijk', async (url, options) => {
    calls++;
    assert.equal(url, thumbnailProbeUrl('abcdefghijk'));
    assert.equal(options.method, 'GET');
    assert.ok(options.signal);
    return response();
  }, 6500, decode);
  assert.equal(calls, 1);
  assert.equal(result.format, 'portrait');
  assert.equal(result.reason, 'three-panel-match');
  assert.equal(result.score, .82);
  assert.equal(result.variant, 'mqdefault');
});

test('conventional image without three-panel signature remains eligible', async () => {
  const result = await probeVideoFormat('abcdefghijk', async () => response('normal'),
    6500, decode);
  assert.equal(result, 'landscape');
});

test('404 and non-image responses are inconclusive and do not decode placeholders', async () => {
  let decoded = 0;
  const decoder = async () => { decoded++; return positive; };
  assert.equal(await probeVideoFormat('abcdefghijk',
    async () => response('positive', 404), 6500, decoder), 'unknown');
  assert.equal(await probeVideoFormat('abcdefghijk', async () => ({
    ...response(), headers: { get: () => 'text/html' }
  }), 6500, decoder), 'unknown');
  assert.equal(decoded, 0);
});

test('timeout aborts the request; network and decode failures are inconclusive', async () => {
  let signal;
  assert.equal(await probeVideoFormat('abcdefghijk', async (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  }, 10, decode), 'unknown');
  assert.equal(signal.aborted, true);
  assert.equal(await probeVideoFormat('abcdefghijk',
    async () => { throw new Error('offline'); }, 6500, decode), 'unknown');
  const error = await probeVideoFormatDetails('abcdefghijk',
    async () => response(), 6500,
    async () => { throw new Error('Canvas 2D context unavailable'); });
  assert.equal(error.format, 'unknown');
  assert.equal(error.reason, 'image-decode-failed');
});

test('bounded and deduplicated batch processing respects concurrency', async () => {
  const ids = Array.from({ length: 40 }, (_, i) => String(i).padStart(11, '0'));
  let calls = 0, active = 0, highest = 0;
  const result = await probeFormatBatchDetails([ids[0], ...ids, ids[1]], {
    concurrency: 4, decode,
    fetcher: async () => {
      calls++;
      active++;
      highest = Math.max(highest, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
      return response();
    }
  });
  assert.equal(calls, SHORTS_PROBE_MAX_BATCH);
  assert.equal(result.size, SHORTS_PROBE_MAX_BATCH);
  assert.ok(highest <= 4);
  assert.equal(result.get(ids[0]).format, 'portrait');
});
