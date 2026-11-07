import test from 'node:test';
import assert from 'node:assert/strict';
import {
  requestYouTube, fetchLikedVideos, fetchSubscriptions, fetchUploads,
  likedVideo, subscription, uploadedVideo, hasShortsMetadata,
  YouTubeApiError, isUnavailableUploadPlaylist
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
      : { items: [{ id: VID, snippet: { title: 'First' }, statistics: { viewCount: '120000' } }], nextPageToken: 'next' } };
  };
  const liked = await fetchLikedVideos('secret-token', { fetcher });
  assert.equal(liked.length, 2);
  assert.equal(liked[0].viewCount, '120000');
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
    if (u.pathname.endsWith('/videos')) {
      assert.equal(u.searchParams.get('part'), 'snippet,statistics');
      assert.equal(u.searchParams.get('id'), VID);
      return { ok: true, json: async () => ({ items: [{
        id: VID, statistics: { viewCount: '243210' }
      }] }) };
    }
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
  assert.equal(batches[0][0].viewCount, '243210');
});
test('reports API failures without displaying credentials', async () => {
  await assert.rejects(requestYouTube('videos', {}, 'secret-token', async () => ({
    ok: false, status: 403, json: async () => ({ error: { message: 'Quota exceeded' } })
  })), /Quota exceeded/);
});

test('missing statistics do not prevent subscribed upload import', async () => {
  const fetcher = async url => {
    const u = new URL(url);
    if (u.pathname.endsWith('/channels')) return { ok: true, json: async () => ({
      items: [{ id: CID, contentDetails: { relatedPlaylists: { uploads: 'UU' + 'a'.repeat(22) } } }]
    }) };
    if (u.pathname.endsWith('/playlistItems')) return { ok: true, json: async () => ({
      items: [{ snippet: { title: 'A valid recent video' }, contentDetails: { videoId: VID } }]
    }) };
    if (u.pathname.endsWith('/videos')) return { ok: false, status: 403, json: async () => ({ error: { message: 'Not accessible' } }) };
    throw new Error('Unexpected endpoint');
  };
  const videos = [];
  const result = await fetchUploads('token', [{ channelId: CID }], {
    fetcher, onBatch: batch => videos.push(...batch)
  });
  assert.equal(result.videos, 1);
  assert.equal(videos[0].viewCount, undefined);
});

test('lightweight automatic upload checks request Shorts metadata but not view statistics', async () => {
  const requests = [];
  const fetcher = async url => {
    const parsed = new URL(url);
    requests.push(parsed.pathname);
    if (parsed.pathname.endsWith('/channels')) return { ok: true, json: async () => ({
      items: [{ id: CID, contentDetails: { relatedPlaylists: { uploads: 'UU' + 'a'.repeat(22) } } }]
    }) };
    if (parsed.pathname.endsWith('/playlistItems')) {
      assert.equal(parsed.searchParams.get('maxResults'), '5');
      return { ok: true, json: async () => ({
        items: [{ snippet: { title: 'Recent talk' }, contentDetails: { videoId: VID } }]
      }) };
    }
    if (parsed.pathname.endsWith('/videos')) {
      assert.equal(parsed.searchParams.get('part'), 'snippet');
      assert.equal(parsed.searchParams.get('id'), VID);
      return { ok: true, json: async () => ({ items: [{
        id: VID, snippet: { title: 'Recent talk',
          thumbnails: { shortsAspectRatio: { url: 'https://example.com/portrait.jpg' } }
        }
      }] }) };
    }
    throw new Error('Unexpected endpoint: ' + parsed.pathname);
  };
  const videos = [];
  const result = await fetchUploads('token', [{ channelId: CID }], {
    fetcher, maxPerChannel: 5, includeStatistics: false,
    onBatch: batch => videos.push(...batch)
  });
  assert.equal(result.videos, 1);
  assert.equal(videos[0].id, VID);
  assert.deepEqual(requests.map(p => p.split('/').at(-1)), ['channels', 'playlistItems', 'videos']);
  assert.equal(videos[0].isShort, true);
});

test('skips one unavailable uploads playlist but imports the other subscriptions', async () => {
  const badChannel = 'UC' + 'b'.repeat(22);
  const calls = [];
  const fetcher = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname.split('/').at(-1));
    if (u.pathname.endsWith('/channels')) return { ok: true, json: async () => ({
      items: [
        { id: CID, contentDetails: { relatedPlaylists: { uploads: 'UU' + 'a'.repeat(22) } } },
        { id: badChannel, contentDetails: { relatedPlaylists: { uploads: 'UU' + 'b'.repeat(22) } } }
      ]
    }) };
    if (u.pathname.endsWith('/playlistItems') &&
        u.searchParams.get('playlistId') === 'UU' + 'b'.repeat(22)) {
      return { ok: false, status: 404, json: async () => ({
        error: {
          message: 'The playlist identified with the request\'s <code>playlistId</code> parameter could not be found.',
          errors: [{ reason: 'playlistNotFound' }]
        }
      }) };
    }
    if (u.pathname.endsWith('/playlistItems')) return { ok: true, json: async () => ({
      items: [{ snippet: { title: 'A valid technical talk' }, contentDetails: { videoId: VID } }]
    }) };
    throw new Error('Unexpected request: ' + u);
  };
  const batches = [];
  const result = await fetchUploads('token', [
    { channelId: badChannel }, { channelId: CID }
  ], {
    fetcher, includeStatistics: false, onBatch: videos => batches.push(videos)
  });
  assert.equal(result.channels, 2);
  assert.equal(result.checked, 1);
  assert.equal(result.unavailable, 1);
  assert.equal(result.videos, 1);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map(v => v.id), [VID]);
  assert.equal(calls.filter(x => x === 'playlistItems').length, 2);
});

test('skips per-playlist access errors but never hides quota or credential failures', async () => {
  const inaccessible = new YouTubeApiError(403, 'playlistItemsNotAccessible', 'Not authorized for playlist');
  const quota = new YouTubeApiError(403, 'quotaExceeded', 'Quota exceeded');
  const notFoundVideo = new YouTubeApiError(404, 'videoNotFound', 'Video missing');
  assert.equal(isUnavailableUploadPlaylist(inaccessible), true);
  assert.equal(isUnavailableUploadPlaylist(new YouTubeApiError(404, 'playlistNotFound', 'Missing')), true);
  assert.equal(isUnavailableUploadPlaylist(quota), false);
  assert.equal(isUnavailableUploadPlaylist(notFoundVideo), false);
  for (const { status, reason } of [{ status: 403, reason: 'quotaExceeded' }, { status: 401, reason: 'authError' }]) {
    const fetcher = async url => {
      const u = new URL(url);
      if (u.pathname.endsWith('/channels')) return { ok: true, json: async () => ({
        items: [{ id: CID, contentDetails: { relatedPlaylists: { uploads: 'UU' + 'a'.repeat(22) } } }]
      }) };
      return { ok: false, status, json: async () => ({
        error: { message: 'Failure for playlist request', errors: [{ reason }] }
      }) };
    };
    await assert.rejects(
      fetchUploads('token', [{ channelId: CID }], { fetcher, includeStatistics: false }),
      err => err instanceof YouTubeApiError && err.status === status && err.reason === reason
    );
  }
});

test('does not treat an entirely unavailable subscription set as a successful refresh', async () => {
  const fetcher = async url => {
    if (new URL(url).pathname.endsWith('/channels')) return {
      ok: true, json: async () => ({ items: [
        { id: CID, contentDetails: { relatedPlaylists: { uploads: 'UU' + 'a'.repeat(22) } } }
      ] })
    };
    return {
      ok: false, status: 404, json: async () => ({
        error: { message: 'Playlist missing', errors: [{ reason: 'playlistNotFound' }] }
      })
    };
  };
  await assert.rejects(
    fetchUploads('token', [{ channelId: CID }], { fetcher, includeStatistics: false }),
    /all 1 upload playlists were unavailable/
  );
});

test('API error exposes structured reason and sanitizes inline code tags', async () => {
  await assert.rejects(
    requestYouTube('playlistItems', { playlistId: 'UUtest' }, 'token', async () => ({
      ok: false, status: 404, json: async () => ({
        error: {
          message: 'The <code>playlistId</code> is missing',
          errors: [{ reason: 'playlistNotFound' }]
        }
      })
    })),
    err => err instanceof YouTubeApiError && err.status === 404 &&
      err.reason === 'playlistNotFound' && err.message.includes('The playlistId is missing') &&
      !err.message.includes('<code>')
  );
});

test('an unresponsive YouTube API request times out and aborts rather than hanging refresh', async () => {
  let signal;
  await assert.rejects(
    requestYouTube('playlistItems', { playlistId: 'UUnonresponsive' }, 'token',
      async (_url, options) => {
        signal = options.signal;
        return new Promise(() => {});
      }, 12),
    /playlistItems request timed out/
  );
  assert.equal(signal.aborted, true);
});

test('automatic refresh can cap subscription pages without changing full imports', async () => {
  let calls = 0;
  const fetcher = async url => {
    const u = new URL(url);
    assert.equal(u.searchParams.get('maxResults'), '50');
    calls++;
    return { ok: true, json: async () => ({
      items: [{ snippet: {
        resourceId: { channelId: 'UC' + String(calls).padStart(22, '0') },
        title: 'Subscribed channel ' + calls
      } }],
      nextPageToken: 'page-' + calls
    }) };
  };
  const limited = await fetchSubscriptions('token', { fetcher, maxPages: 4 });
  assert.equal(limited.length, 4);
  assert.equal(calls, 4);
});

test('API metadata identifies Shorts with explicit evidence but never by duration alone', () => {
  assert.equal(hasShortsMetadata({
    thumbnails: { shortsAspectRatio: { url: 'https://i.ytimg.com/vi/id/shorts.jpg' } }
  }), true);
  assert.equal(hasShortsMetadata({
    title: 'Normal description', description: 'Made for #Shorts community'
  }), true);
  assert.equal(hasShortsMetadata({ title: 'Short lecture', description: '',
    thumbnails: { medium: { width: 320, height: 180 } } }), false);
  assert.equal(hasShortsMetadata({ title: 'Music video', tags: ['video', '#YouTubeShorts'] }), true);
  assert.equal(hasShortsMetadata({ title: 'A short introduction', tags: ['short introduction'] }), false);
});

test('playlist item metadata marks explicit Shorts without extra video details', () => {
  const item = uploadedVideo({
    snippet: { title: 'Tiny clip #shorts' },
    contentDetails: { videoId: VID }
  }, CID);
  assert.equal(item.isShort, true);
});
