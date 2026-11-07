import test from 'node:test';
import assert from 'node:assert/strict';
import {
  oEmbedProbeUrl, portraitFormatFromOEmbed, probeVideoFormat,
  probeFormatBatch, SHORTS_PROBE_MAX_BATCH
} from '../lib/shorts-probe.js';

test('asks oEmbed about Shorts URL instead of unreliable watch URL', () => {
  const parsed = new URL(oEmbedProbeUrl('abcdefghijk'));
  assert.equal(parsed.origin, 'https://www.youtube.com');
  assert.equal(parsed.pathname, '/oembed');
  assert.equal(parsed.searchParams.get('url'), 'https://www.youtube.com/shorts/abcdefghijk');
  assert.equal(parsed.searchParams.get('format'), 'json');
  assert.throws(() => oEmbedProbeUrl('invalid-id-too-long'), /Invalid/);
});
test('classifies portrait video formats while leaving ambiguous records unknown', () => {
  assert.equal(portraitFormatFromOEmbed({ width: 113, height: 200 }), 'portrait');
  assert.equal(portraitFormatFromOEmbed({ width: 200, height: 113 }), 'landscape');
  assert.equal(portraitFormatFromOEmbed({ width: 200, height: 150 }), 'landscape');
  assert.equal(portraitFormatFromOEmbed({ width: 0, height: 200 }), 'unknown');
  assert.equal(portraitFormatFromOEmbed({}), 'unknown');
});
test('probes both Shorts and conventional videos using reported player aspect ratio', async () => {
  const portrait = await probeVideoFormat('abcdefghijk',
    async () => ({ ok: true, json: async () => ({ width: 113, height: 200 }) }));
  const normal = await probeVideoFormat('lmnopqrstuv',
    async () => ({ ok: true, json: async () => ({ width: 200, height: 113 }) }));
  assert.equal(portrait, 'portrait');
  assert.equal(normal, 'landscape');
});
test('a hanging or unavailable response is inconclusive, not a dislike', async () => {
  assert.equal(await probeVideoFormat('abcdefghijk',
    async () => new Promise(() => {}), 10), 'unknown');
  assert.equal(await probeVideoFormat('abcdefghijk',
    async () => ({ ok: false, status: 403 }), 10), 'unknown');
});
test('batches are bounded and deduplicated', async () => {
  const ids = Array.from({ length: 40 }, (_, i) => String(i).padStart(11, '0'));
  const results = await probeFormatBatch([ids[0], ...ids, ids[1]], {
    fetcher: async () => ({ ok: true, json: async () => ({ width: 200, height: 113 }) })
  });
  assert.equal(results.size, SHORTS_PROBE_MAX_BATCH);
  assert.equal(results.get(ids[0]), 'landscape');
});
