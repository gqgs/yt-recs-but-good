import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const sandbox = {};
sandbox.globalThis = sandbox;
runInNewContext(readFileSync(new URL('../lib/shorts-visibility.js', import.meta.url), 'utf8'), sandbox);
const { needsFormatCheck, splitCandidates } = sandbox.YTRBGShortsVisibility;

const NOW = Date.parse('2026-11-07T12:00:00Z');
function candidate(id, extra = {}) {
  return { id, title: 'Example video', url: 'https://www.youtube.com/watch?v=abcdefghijk',
    candidate: true, ...extra };
}

test('unclassified candidates are withheld until the format result arrives', () => {
  const videos = [candidate('unverified'),
    candidate('landscape', { shortsFormat: 'landscape', shortsProbedAt: NOW - 1000 }),
    candidate('unknown', { shortsFormat: 'unknown', shortsProbedAt: NOW - 1000 })];
  const { ready, pending } = splitCandidates(videos, true, NOW);
  assert.deepEqual(ready.map(v => v.id).join(','), 'landscape,unknown');
  assert.deepEqual(pending.map(v => v.id).join(','), 'unverified');
  assert.equal(videos.length, 3);
});

test('further format classification never requires a destructive cache reset', () => {
  const item = candidate('v');
  assert.equal(needsFormatCheck(item, NOW), true);
  item.shortsFormat = 'landscape';
  item.shortsProbedAt = NOW;
  assert.equal(needsFormatCheck(item, NOW), false);
});

test('disabled filter and user overrides never defer videos', () => {
  const items = [
    candidate('a'),
    candidate('b', { isShort: true }),
    candidate('c', { shortOverride: false }),
    candidate('d', { shortOverride: true })
  ];
  assert.equal(splitCandidates(items, false, NOW).ready.length, 4);
  assert.equal(splitCandidates(items, true, NOW).pending.length, 1);
  assert.equal(needsFormatCheck(items[2], NOW), false);
  assert.equal(needsFormatCheck(items[3], NOW), false);
});

test('stale unknowns and stale landscapes are withheld for revalidation', () => {
  assert.equal(needsFormatCheck(candidate('unknown', {
    shortsFormat: 'unknown', shortsProbedAt: NOW - 7 * 3600_000
  }), NOW), true);
  assert.equal(needsFormatCheck(candidate('fresh', {
    shortsFormat: 'unknown', shortsProbedAt: NOW - 5 * 3600_000
  }), NOW), false);
  assert.equal(needsFormatCheck(candidate('old', {
    shortsFormat: 'landscape', shortsProbedAt: NOW - 31 * 86400_000
  }), NOW), true);
  assert.equal(needsFormatCheck(candidate('current', {
    shortsFormat: 'landscape', shortsProbedAt: NOW - 29 * 86400_000
  }), NOW), false);
});

test('portrait results are already excluded by ranking and do not need reprobes', () => {
  const portrait = candidate('portrait', {
    shortsFormat: 'portrait', shortsProbedAt: NOW
  });
  assert.equal(needsFormatCheck(portrait, NOW), false);
});
