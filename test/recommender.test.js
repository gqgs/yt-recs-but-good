import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, cosine, preferenceProfile, relativeAgeDays, rankVideos } from '../lib/recommender.js';

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
  assert.equal(rankVideos(items, { exploration: 0, diversity: 0 }, NOW)[0].id, 'a');
  assert.equal(preferenceProfile(items, NOW).likes, 1);
});
test('seen items and disliked candidates are excluded by default', () => {
  const items = {
    a: video('a', 'A good discovery'),
    b: video('b', 'Already watched', { watchedAt: NOW }),
    c: video('c', 'Dismissed', { feedback: 'less', feedbackAt: NOW })
  };
  assert.deepEqual(rankVideos(items, {}, NOW).map(x => x.id), ['a']);
  assert.equal(rankVideos(items, { showSeen: true }, NOW).some(x => x.id === 'b'), true);
});
test('liked seeds are never candidates unless explicitly marked as such, then showSeen controls them', () => {
  const items = { a: video('a', 'Liked', { feedback: 'like', feedbackAt: NOW }) };
  assert.equal(rankVideos(items, {}, NOW).length, 0);
  assert.equal(rankVideos(items, { showSeen: true }, NOW).length, 1);
});
test('selection limits channel saturation when alternatives exist', () => {
  const items = {};
  for (let i = 0; i < 5; i++) items['a' + i] = video('a' + i, 'Rust tutorial ' + i, { channel: 'Channel A', channelId: 'A' });
  for (let i = 0; i < 5; i++) items['b' + i] = video('b' + i, 'Science presentation ' + i, { channel: 'Channel B', channelId: 'B' });
  const result = rankVideos(items, { limit: 4 }, NOW);
  assert.equal(result.length, 4);
  assert.equal(result.filter(x => x.channelId === 'A').length, 2);
  assert.equal(result.filter(x => x.channelId === 'B').length, 2);
});
test('a cold-start profile still produces recommendations', () => {
  const items = { a: video('a', 'New talk'), b: video('b', 'Older talk', { publishedText: '2 years ago' }) };
  assert.equal(rankVideos(items, {}, NOW)[0].id, 'a');
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
  assert.equal(rankVideos(items, { mode: 'recent' }, NOW)[0].id, 'b');
});
