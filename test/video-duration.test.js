import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SHORTS_SECONDS, parseIsoDurationSeconds, parseDurationLabel,
  formatDuration, isKnownLongForm
} from '../lib/video-duration.js';

test('parses ISO 8601 YouTube API durations', () => {
  assert.equal(parseIsoDurationSeconds('PT23M51S'), 1431);
  assert.equal(parseIsoDurationSeconds('PT48M59S'), 2939);
  assert.equal(parseIsoDurationSeconds('PT1H3M5S'), 3785);
  assert.equal(parseIsoDurationSeconds('PT45S'), 45);
  assert.equal(parseIsoDurationSeconds('P1DT2H3M4S'), 93784);
  assert.equal(parseIsoDurationSeconds('PT3M'), 180);
  for (const invalid of ['LIVE', '', 'PT0S', 'PT1.5M', 'P1D', 'PT90Q', null])
    assert.equal(parseIsoDurationSeconds(invalid), null);
});

test('parses YouTube thumbnail overlays without mistaking LIVE or counts for durations', () => {
  assert.equal(parseDurationLabel('23:51'), 1431);
  assert.equal(parseDurationLabel('48:59'), 2939);
  assert.equal(parseDurationLabel('1:03:05'), 3785);
  assert.equal(parseDurationLabel('0:42'), 42);
  for (const invalid of ['LIVE', '23:99', '1:03:99', '2 weeks ago', 'Upcoming'])
    assert.equal(parseDurationLabel(invalid), null);
});

test('formats durations as YouTube thumbnail badges', () => {
  assert.equal(formatDuration(1431), '23:51');
  assert.equal(formatDuration(2939), '48:59');
  assert.equal(formatDuration(3785), '1:03:05');
  assert.equal(formatDuration(42), '0:42');
  assert.equal(formatDuration(null), '');
});

test('known long portrait videos are not Shorts under the three-minute limit', () => {
  assert.equal(MAX_SHORTS_SECONDS, 180);
  assert.equal(isKnownLongForm({ durationSeconds: 1431 }), true);
  assert.equal(isKnownLongForm({ durationSeconds: 2939 }), true);
  assert.equal(isKnownLongForm({ durationSeconds: 180 }), false);
  assert.equal(isKnownLongForm({ durationSeconds: null }), false);
});
