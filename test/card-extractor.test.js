import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const global = { URL, location: { origin: 'https://www.youtube.com' } };
global.globalThis = global;
runInNewContext(readFileSync(new URL('../lib/card-extractor.js', import.meta.url), 'utf8'), global);
const { extractCard, videoId, validTitle } = global.YTRBGCardExtractor;

function el(text, attrs = {}) {
  return { textContent: text, href: attrs.href, getAttribute: key => attrs[key] || null };
}
function fakeCard({ title, titleAttrs = {}, watchHref, promoted = false, badge = false, channel = 'Linux Foundation' }) {
  const titleNode = title === undefined ? null : el(title, titleAttrs);
  const watchNode = el('Watch', { href: watchHref || '/watch?v=abcdefghijk' });
  const channelNode = el(channel, { href: '/@LinuxFoundation' });
  return {
    closest() { return promoted ? {} : null; },
    querySelector(selector) {
      if (selector.includes('ad-badge-renderer')) return badge ? {} : null;
      if (selector === 'a#video-title-link') return titleNode;
      if (selector === 'a#video-title') return null;
      if (selector.includes('a[href*="/watch?v="]')) return watchNode;
      if (selector.includes('channel-name') || selector.includes('metadata-text a')) return channelNode;
      return null;
    },
    querySelectorAll() { return []; }
  };
}

test('extracts real video title instead of thumbnail Watch label', () => {
  const result = extractCard(fakeCard({
    title: 'Linux performance under heavy I/O',
    titleAttrs: { title: 'Linux performance under heavy I/O', href: '/watch?v=abcdefghijk' }
  }));
  assert.equal(result.title, 'Linux performance under heavy I/O');
  assert.equal(result.id, 'abcdefghijk');
});
test('never treats a thumbnail CTA or duration as a title', () => {
  assert.equal(extractCard(fakeCard({ title: undefined })), null);
  assert.equal(extractCard(fakeCard({ title: 'Watch' })), null);
  assert.equal(extractCard(fakeCard({ title: '24:17' })), null);
  assert.equal(extractCard(fakeCard({ title: '23:28Exclusive Access' })), null);
  assert.equal(extractCard(fakeCard({ title: 'Upcoming' })), null);
});
test('rejects sponsored placements before extracting video links', () => {
  assert.equal(extractCard(fakeCard({ title: 'A very convincing title', promoted: true })), null);
  assert.equal(extractCard(fakeCard({ title: 'A very convincing title', badge: true })), null);
});
test('validates video ID host and rejects malformed titles', () => {
  assert.equal(videoId('https://www.youtube.com/watch?v=abcdefghijk'), 'abcdefghijk');
  assert.equal(videoId('https://ads.example/watch?v=abcdefghijk'), '');
  assert.equal(validTitle('An interesting performance'), true);
  assert.equal(validTitle('9:56'), false);
  assert.equal(validTitle('Watch'), false);
});

test('filters generic LIVE overlays in previously broken card titles', () => {
  assert.equal(validTitle('LIVE'), false);
  assert.equal(extractCard(fakeCard({ title: 'LIVE' })), null);
});
test('extracts the modern channel metadata row and watch-progress marker', () => {
  const fixture = fakeCard({ title: 'Embedded Linux Talk' });
  const original = fixture.querySelector.bind(fixture);
  fixture.querySelector = selector => {
    if (selector === '.yt-content-metadata-view-model__metadata-row:first-child')
      return el('The Linux Foundation');
    if (selector === 'ytd-thumbnail-overlay-resume-playback-renderer, yt-thumbnail-overlay-progress-bar-view-model')
      return {};
    // Modern layout: none of the channel link selectors match.
    if (selector.includes('channel-name') || selector.includes('metadata-text a') ||
        selector.includes('metadata-row:first-child a') ||
        selector.includes('view-model a[href^=')) return null;
    return original(selector);
  };
  const parsed = extractCard(fixture);
  assert.equal(parsed.channel, 'The Linux Foundation');
  assert.equal(parsed.hasResume, true);
});
