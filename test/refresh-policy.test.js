import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRefresh, normalizeTtlMinutes, formatRefreshAge,
  selectSubscriptionRefreshBatch, REFRESH_STALE_MS } from '../lib/refresh-policy.js';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const MINUTE = 60_000;

test('one-hour TTL is the default and can be configured', () => {
  assert.equal(normalizeTtlMinutes(undefined), 60);
  assert.equal(normalizeTtlMinutes(60), 60);
  assert.equal(normalizeTtlMinutes('120'), 120);
  assert.equal(normalizeTtlMinutes(-10), 60);
  assert.equal(shouldRefresh({ now: NOW, lastSuccessAt: NOW - 59 * MINUTE }), false);
  assert.equal(shouldRefresh({ now: NOW, lastSuccessAt: NOW - 61 * MINUTE }), true);
  assert.equal(shouldRefresh({ now: NOW, lastSuccessAt: NOW - 75 * MINUTE, ttlMinutes: 120 }), false);
});
test('disabled and paused collection never schedules a refresh', () => {
  assert.equal(shouldRefresh({ now: NOW, enabled: false }), false);
  assert.equal(shouldRefresh({ now: NOW, paused: true }), false);
});
test('a failed attempt is backed off without updating last successful sync', () => {
  assert.equal(shouldRefresh({ now: NOW, lastAttemptAt: NOW - 5 * MINUTE }), false);
  assert.equal(shouldRefresh({ now: NOW, lastAttemptAt: NOW - 16 * MINUTE }), true);
  assert.equal(shouldRefresh({ now: NOW, lastSuccessAt: NOW - 10 * MINUTE, lastAttemptAt: NOW - 16 * MINUTE }), false);
});
test('initial collection is due when no sync exists', () => {
  assert.equal(shouldRefresh({ now: NOW }), true);
});
test('status uses successful sync rather than most recent attempt', () => {
  assert.equal(formatRefreshAge(0, NOW), 'Never updated');
  assert.equal(formatRefreshAge(NOW - 5 * MINUTE, NOW), 'Updated 5m ago');
  assert.equal(formatRefreshAge(NOW - 3 * 60 * MINUTE, NOW), 'Updated 3h ago');
});

test('rotates 40 subscribed channels per refresh, wrapping after the last batch', () => {
  const channels = Array.from({ length: 95 }, (_, i) => ({
    channelId: 'UC' + String(i).padStart(22, '0')
  }));
  const first = selectSubscriptionRefreshBatch(channels);
  assert.equal(first.start, 0);
  assert.equal(first.batch.length, 40);
  assert.equal(first.nextChannelIndex, 40);
  const second = selectSubscriptionRefreshBatch(channels, first.nextChannelIndex);
  assert.equal(second.start, 40);
  assert.equal(second.batch.length, 40);
  assert.equal(second.nextChannelIndex, 80);
  const last = selectSubscriptionRefreshBatch(channels, second.nextChannelIndex);
  assert.equal(last.start, 80);
  assert.equal(last.batch.length, 15);
  assert.equal(last.nextChannelIndex, 0);
  assert.equal(selectSubscriptionRefreshBatch(channels, last.nextChannelIndex).start, 0);
});

test('rotation de-duplicates channels, enforces cap, and tolerates stale cursor', () => {
  const channels = Array.from({ length: 250 }, (_, i) => ({
    channelId: 'UC' + String(i).padStart(22, '0')
  }));
  channels.push(channels[0], { channelId: 'invalid' });
  const slice = selectSubscriptionRefreshBatch(channels, 2000);
  assert.equal(slice.total, 200);
  assert.equal(slice.start, 0);
  assert.equal(slice.batch.length, 40);
  assert.equal(selectSubscriptionRefreshBatch([], 40).nextChannelIndex, 0);
  assert.equal(REFRESH_STALE_MS, 75000);
});
