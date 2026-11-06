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
function fakeCard({ title, titleAttrs = {}, watchHref, promoted = false, badge = false, channel = 'Linux Foundation', metadata = [] }) {
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
    querySelectorAll() { return metadata.map(text => el(text)); }
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

test('captures views and upload age separately from modern combined metadata rows', () => {
  const result = extractCard(fakeCard({
    title: 'Understanding nonlinear dynamics',
    metadata: ['1.4M views · 3 weeks ago']
  }));
  assert.equal(result.viewCountText, '1.4M views');
  assert.equal(result.publishedText, '3 weeks ago');
});
test('captures classic metadata and leaves missing values absent', () => {
  const withMetadata = extractCard(fakeCard({
    title: 'Mathematics of black holes',
    metadata: ['12,403 views', 'Streamed 2 days ago']
  }));
  assert.equal(withMetadata.viewCountText, '12,403 views');
  assert.equal(withMetadata.publishedText, 'Streamed 2 days ago');
  const without = extractCard(fakeCard({ title: 'Mathematics of black holes' }));
  assert.equal(without.viewCountText, '');
  assert.equal(without.publishedText, '');
});

test('extracts metadata from current camelCase YouTube view-model elements', () => {
  const card = fakeCard({ title: 'A new mathematics lecture', metadata: [] });
  card.querySelectorAll = selectors => {
    assert.match(selectors, /ytContentMetadataViewModelMetadataText/);
    assert.match(selectors, /yt-content-metadata-view-model-wiz__metadata-text/);
    return [
      el('1.7M views', { 'aria-label': '1.7 million views' }),
      el('4 hours ago')
    ];
  };
  const result = extractCard(card);
  assert.equal(result.viewCountText, '1.7 million views');
  assert.equal(result.publishedText, '4 hours ago');
});
test('reads wiz metadata rows with combined views and upload age', () => {
  const card = fakeCard({ title: 'The art of finding things', metadata: [] });
  card.querySelectorAll = selector => {
    assert.match(selector, /yt-content-metadata-view-model-wiz__metadata-row/);
    return [el('15K views · 2 days ago')];
  };
  const result = extractCard(card);
  assert.equal(result.viewCountText, '15K views');
  assert.equal(result.publishedText, '2 days ago');
});
test('does not treat title text as view metadata', () => {
  const card = fakeCard({ title: 'A million views in two days', metadata: [] });
  const result = extractCard(card);
  assert.equal(result.viewCountText, '');
  assert.equal(result.publishedText, '');
});
