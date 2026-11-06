import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMetadataLine, formatUploadAge, formatViewCount } from '../lib/video-metadata.js';

const NOW = Date.parse('2026-11-06T12:00:00Z');
test('displays compact view counts and relative upload dates', () => {
  assert.equal(formatMetadataLine({
    viewCount: 1245600, publishedAt: NOW - 3 * 86400000
  }, NOW), '1.2M views · 3 days ago');
  assert.equal(formatViewCount({ viewCount: 1 }), '1 view');
  assert.equal(formatViewCount({ viewCount: 0 }), '0 views');
});
test('preserves explicit view labels when API statistics are missing', () => {
  assert.equal(formatMetadataLine({
    viewCountText: '24K views', publishedText: '2 weeks ago'
  }, NOW), '24K views · 2 weeks ago');
});
test('never invents values from first or last collected timestamps', () => {
  assert.equal(formatMetadataLine({ firstSeenAt: NOW, lastSeenAt: NOW }, NOW), '');
  assert.equal(formatViewCount({ viewCountText: 'Popular video' }), '');
  assert.equal(formatUploadAge({ publishedText: 'Upcoming' }, NOW), '');
});
test('renders available metadata independently when the other value is absent', () => {
  assert.equal(formatMetadataLine({ publishedAt: NOW - 3600000 }, NOW), '1 hour ago');
  assert.equal(formatMetadataLine({ viewCount: '1234' }, NOW), '1.2K views');
});
test('formats old relative timestamps as time passes', () => {
  const item = { publishedAt: NOW - 2 * 86400000, publishedText: '2 days ago' };
  assert.equal(formatUploadAge(item, NOW + 5 * 86400000), '1 week ago');
});

test('formats fully spelled out accessibility view counts', () => {
  assert.equal(formatViewCount({ viewCountText: '1.7 million views' }), '1.7M views');
  assert.equal(formatViewCount({ viewCountText: '42 thousand views' }), '42K views');
});
