import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, cosine, preferenceProfile, relativeAgeDays, rankVideos, validVideoTitle } from '../lib/recommender.js';

const NOW = Date.parse('2026-11-05T12:00:00Z');
function video(id, title, extra = {}) {
  return { id, title, channel: 'Science Lab', candidate: true,
    lastSeenAt: NOW, publishedText: '1 day ago', ...extra };
}

test('tokenization removes stopwords and normalizes accents', () => {
  assert.deepEqual(tokenize('The Música of Gödel and Physics'), ['musica', 'godel', 'physics']);
});
test('cosine handles empty vectors and orthogonal vectors', () => {
  assert.equal(cosine({}, { a: 1 }), 0);
  assert.equal(cosine({ x: 1 }, { y: 2 }), 0);
  assert.equal(cosine({ x: 2 }, { x: 1 }), 1);
});
test('relative age parsing is predictable', () => {
  assert.equal(relativeAgeDays('2 weeks ago'), 14);
  assert.equal(relativeAgeDays('3 months ago'), 90);
  assert.equal(relativeAgeDays('Live stream'), null);
});
test('liked content makes related content rank higher when freshness is equal', () => {
  const items = {
    seed: video('seed', 'Rust programming tutorial', { feedback: 'like', feedbackAt: NOW, candidate: false }),
    a: video('a', 'Rust programming patterns'),
    b: video('b', 'Ancient Greek architecture')
  };
  assert.equal(rankVideos(items, { exploration: 0, diversity: 0, discoveryOnly: false }, NOW)[0].id, 'a');
  assert.equal(preferenceProfile(items, NOW).likes, 1);
});
test('seen items and disliked candidates are excluded by default', () => {
  const items = {
    a: video('a', 'A good discovery'),
    b: video('b', 'Already watched', { watchedAt: NOW }),
    c: video('c', 'Dismissed', { feedback: 'less', feedbackAt: NOW })
  };
  assert.deepEqual(rankVideos(items, { discoveryOnly: false }, NOW).map(x => x.id), ['a']);
  assert.equal(rankVideos(items, { showSeen: true, discoveryOnly: false }, NOW).some(x => x.id === 'b'), true);
});
test('liked seeds are never candidates unless explicitly marked as such, then showSeen controls them', () => {
  const items = { a: video('a', 'Liked', { feedback: 'like', feedbackAt: NOW }) };
  assert.equal(rankVideos(items, {}, NOW).length, 0);
  assert.equal(rankVideos(items, { showSeen: true, discoveryOnly: false }, NOW).length, 1);
});
test('selection limits channel saturation when alternatives exist', () => {
  const items = {};
  for (let i = 0; i < 5; i++) items['a' + i] = video('a' + i, 'Rust tutorial ' + i, { channel: 'Channel A', channelId: 'A' });
  for (let i = 0; i < 5; i++) items['b' + i] = video('b' + i, 'Science presentation ' + i, { channel: 'Channel B', channelId: 'B' });
  const result = rankVideos(items, { limit: 4, discoveryOnly: false }, NOW);
  assert.equal(result.length, 4);
  assert.equal(result.filter(x => x.channelId === 'A').length, 2);
  assert.equal(result.filter(x => x.channelId === 'B').length, 2);
});
test('a cold-start profile still produces recommendations', () => {
  const items = { a: video('a', 'New talk'), b: video('b', 'Older talk', { publishedText: '2 years ago' }) };
  assert.equal(rankVideos(items, { discoveryOnly: false }, NOW)[0].id, 'a');
});
test('changing recency of feedback changes preference profile', () => {
  const items = {
    a: video('a', 'Rust', { feedback: 'like', feedbackAt: NOW }),
    b: video('b', 'Physics', { feedback: 'like', feedbackAt: NOW - 365 * 86_400_000 })
  };
  const p = preferenceProfile(items, NOW, 30);
  assert.ok(p.positive.rust > p.positive.physics);
});

test('saved publication dates age over time instead of keeping stale relative labels', () => {
  const items = {
    a: video('a', 'Old video', { publishedText: '1 day ago', publishedAt: NOW - 200 * 86_400_000 }),
    b: video('b', 'Fresh video', { publishedText: '10 days ago', publishedAt: NOW - 86_400_000 })
  };
  assert.equal(rankVideos(items, { mode: 'recent', discoveryOnly: false }, NOW)[0].id, 'b');
});

test('old invalid titles and advertisement markers are filtered from recommendations', () => {
  const items = {
    a: video('a', 'Watch'),
    b: video('b', '23:28Exclusive Access'),
    c: video('c', '24:17'),
    d: video('d', 'A genuine Linux presentation', { isAd: true }),
    e: video('e', 'A genuine Linux presentation')
  };
  assert.deepEqual(rankVideos(items, { discoveryOnly: false }, NOW).map(v => v.id), ['e']);
  assert.equal(validVideoTitle('Watch'), false);
  assert.equal(validVideoTitle('Interesting performance'), true);
});

test('discovery mode rejects Home-only and Related-only videos, not independent sources', () => {
  const items = {
    home: video('home', 'Home video', { sources: ['home'] }),
    related: video('related', 'Related video', { sources: ['related'] }),
    both: video('both', 'Found through subscriptions', { sources: ['home', 'subscriptions'] }),
    search: video('search', 'Explicit search result', { sources: ['search'] })
  };
  assert.deepEqual(rankVideos(items, {}, NOW).map(v => v.id).sort(), ['both', 'search']);
  assert.equal(rankVideos(items, { discoveryOnly: false }, NOW).length, 4);
});
test('visited and YouTube progress marked videos are excluded unless showSeen', () => {
  const items = {
    a: video('a', 'Watch progress video', { source: 'subscriptions', hasResume: true }),
    b: video('b', 'Visited in browser', { source: 'subscriptions', visitedAt: NOW - 5000 }),
    c: video('c', 'Never viewed', { source: 'subscriptions' })
  };
  assert.deepEqual(rankVideos(items, {}, NOW).map(v => v.id), ['c']);
  assert.equal(rankVideos(items, { showSeen: true }, NOW).length, 3);
});
