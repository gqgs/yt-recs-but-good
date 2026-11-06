import test from 'node:test';
import assert from 'node:assert/strict';
import {
  requestYouTube, fetchLikedVideos, fetchSubscriptions, fetchUploads,
  likedVideo, subscription, uploadedVideo
} from '../lib/api-sync.js';

const CID = 'UC' + 'a'.repeat(22);
const VID = 'abcdefghijk';
test('parses API likes and subscription metadata safely', () => {
  assert.equal(likedVideo({ id: VID, snippet: { title: 'An interesting talk', channelId: CID } }).id, VID);
  assert.equal(likedVideo({ id: 'invalid id', snippet: { title: 'bad' } }), null);
  assert.equal(subscription({ snippet: { resourceId: { channelId: CID }, title: 'Linux Lab' } }).channelId, CID);
  assert.equal(subscription({ snippet: { resourceId: { channelId: 'invalid' } } }), null);
});
test('uses video publication timestamp instead of playlist addition timestamp', () => {
  const video = uploadedVideo({
    snippet: { title: 'The talk', channelTitle: 'Linux Lab', publishedAt: '2026-11-06T00:00:00Z' },
    contentDetails: { videoId: VID, videoPublishedAt: '2026-11-01T00:00:00Z' }
  }, CID);
  assert.equal(video.publishedAt, '2026-11-01T00:00:00Z');
});
test('paginates likes and sends token only as Authorization header', async () => {
  const urls = [];
  const fetcher = async (url, options) => {
    urls.push({ url, options });
    const pageToken = new URL(url).searchParams.get('pageToken');
    return { ok: true, json: async () => pageToken
      ? { items: [{ id: 'lmnopqrstuv', snippet: { title: 'Second' } }] }
      : { items: [{ id: VID, snippet: { title: 'First' } }], nextPageToken: 'next' } };
  };
  const liked = await fetchLikedVideos('secret-token', { fetcher });
  assert.equal(liked.length, 2);
  assert.equal(urls.length, 2);
  assert.equal(new URL(urls[0].url).searchParams.get('myRating'), 'like');
  assert.ok(!urls[0].url.includes('secret-token'));
  assert.equal(urls[0].options.headers.Authorization, 'Bearer secret-token');
});
test('retrieves subscriptions and recent uploads in bounded batches', async () => {
  const fetcher = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/subscriptions')) return { ok: true, json: async () => ({ items: [{
      snippet: { resourceId: { channelId: CID }, title: 'Linux Lab' }
    }] }) };
    if (u.pathname.endsWith('/channels')) return { ok: true, json: async () => ({ items: [{
      id: CID, contentDetails: { relatedPlaylists: { uploads: 'UU' + 'a'.repeat(22) } }
    }] }) };
    if (u.pathname.endsWith('/playlistItems')) return { ok: true, json: async () => ({ items: [{
      snippet: { title: 'An actual upload' }, contentDetails: { videoId: VID }
    }] }) };
    throw new Error('unexpected request');
  };
  const subs = await fetchSubscriptions('secret-token', { fetcher });
  assert.equal(subs.length, 1);
  const batches = [];
  const result = await fetchUploads('secret-token', subs, {
    fetcher, onBatch: videos => batches.push(videos)
  });
  assert.equal(result.channels, 1);
  assert.equal(result.videos, 1);
  assert.equal(batches[0][0].id, VID);
});
test('reports API failures without displaying credentials', async () => {
  await assert.rejects(requestYouTube('videos', {}, 'secret-token', async () => ({
    ok: false, status: 403, json: async () => ({ error: { message: 'Quota exceeded' } })
  })), /Quota exceeded/);
});
