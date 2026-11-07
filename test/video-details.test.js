import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_DETAILS_BATCH, needsVideoDetails, videoDetails, fetchVideoDetails
} from '../lib/video-details.js';

const now = Date.parse('2026-11-07T12:00:00Z');
test('only stale or missing metadata requires an additional API request', () => {
  const item = { id: 'abcdefghijk', candidate: true, durationSeconds: null, viewCount: null };
  assert.equal(needsVideoDetails(item, now), true);
  item.detailsAttemptedAt = now - 5 * 60_000;
  assert.equal(needsVideoDetails(item, now), false);
  assert.equal(needsVideoDetails(item, now, true), true);
  item.detailsAttemptedAt = now - 61 * 60_000;
  assert.equal(needsVideoDetails(item, now), true);
  item.durationSeconds = 1431;
  item.viewCount = 100;
  assert.equal(needsVideoDetails(item, now), false);
});
test('duration parsing tolerates absent and live-stream metadata', () => {
  assert.deepEqual(videoDetails({
    contentDetails: { duration: 'PT23M51S' }, statistics: { viewCount: '1234' }
  }), { durationSeconds: 1431, viewCount: 1234 });
  assert.deepEqual(videoDetails({
    contentDetails: { duration: 'PT0S' }
  }), { durationSeconds: null, viewCount: null });
});
test('one request enriches up to 50 video IDs without inventing missing entries', async () => {
  const ids = Array.from({ length: 80 }, (_, i) => String(i).padStart(11, '0'));
  let calls = 0;
  const result = await fetchVideoDetails('token', [ids[0], ...ids, ids[0]], {
    fetcher: async (url, opts) => {
      calls++;
      const parsed = new URL(url);
      assert.equal(parsed.pathname, '/youtube/v3/videos');
      assert.equal(parsed.searchParams.get('part'), 'contentDetails,statistics');
      assert.equal(parsed.searchParams.get('id').split(',').length, MAX_DETAILS_BATCH);
      assert.equal(opts.headers.Authorization, 'Bearer token');
      return { ok: true, json: async () => ({
        items: [{ id: ids[0], contentDetails: { duration: 'PT48M59S' },
          statistics: { viewCount: '2345' } }]
      }) };
    }
  });
  assert.equal(calls, 1);
  assert.equal(result.ids.length, MAX_DETAILS_BATCH);
  assert.equal(result.results.size, 1);
  assert.equal(result.results.get(ids[0]).durationSeconds, 2939);
});
test('API failures are surfaced to the caller, not silently swallowed', async () => {
  await assert.rejects(fetchVideoDetails('token', ['abcdefghijk'], {
    fetcher: async () => ({
      ok: false, status: 403, json: async () => ({
        error: { message: 'quotaExceeded', errors: [{ reason: 'quotaExceeded' }] }
      })
    })
  }), /quotaExceeded/);
});
