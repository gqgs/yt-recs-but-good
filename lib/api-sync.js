// YouTube Data API import helpers. Pure dependency-injected fetch functions so
// pagination, conversion and quota limits are testable without Google access.
const BASE = 'https://www.googleapis.com/youtube/v3/';
const VALID_ID = /^[A-Za-z0-9_-]{11}$/;

export async function requestYouTube(path, params, token, fetcher = fetch) {
  const url = new URL(path, BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const response = await fetcher(url.toString(), {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
  });
  if (!response.ok) {
    let message = 'YouTube API HTTP ' + response.status;
    try {
      const body = await response.json();
      if (body.error?.message) message += ': ' + body.error.message;
    } catch { /* API returned text instead of JSON. */ }
    throw new Error(message);
  }
  return response.json();
}

export async function fetchPages(path, params, token, { fetcher = fetch, maxPages = 40, onPage } = {}) {
  const items = [];
  let pageToken;
  for (let p = 0; p < maxPages; p++) {
    const response = await requestYouTube(path, {
      ...params, ...(pageToken ? { pageToken } : {})
    }, token, fetcher);
    const page = Array.isArray(response.items) ? response.items : [];
    items.push(...page);
    if (onPage) await onPage(page, p);
    if (!response.nextPageToken || page.length === 0) break;
    pageToken = response.nextPageToken;
  }
  return items;
}

export function likedVideo(v) {
  if (!VALID_ID.test(v.id || '') || !v.snippet?.title) return null;
  return {
    id: v.id, title: v.snippet.title,
    channel: v.snippet.channelTitle || '', channelId: v.snippet.channelId || '',
    publishedAt: v.snippet.publishedAt || null
  };
}

export function subscription(s) {
  const id = s.snippet?.resourceId?.channelId;
  if (!/^UC[A-Za-z0-9_-]{22}$/.test(id || '')) return null;
  return { channelId: id, channel: s.snippet?.title || '', subscribed: true };
}

export function uploadPlaylist(channel) {
  const id = channel.contentDetails?.relatedPlaylists?.uploads;
  return id ? { channelId: channel.id, playlistId: id } : null;
}

export function uploadedVideo(item, channelId) {
  const s = item.snippet || {};
  const id = item.contentDetails?.videoId || s.resourceId?.videoId;
  if (!VALID_ID.test(id || '') || !s.title ||
    s.title === 'Private video' || s.title === 'Deleted video') return null;
  return {
    id, title: s.title, channel: s.videoOwnerChannelTitle || s.channelTitle || '',
    channelId: s.videoOwnerChannelId || channelId,
    publishedAt: item.contentDetails?.videoPublishedAt || s.publishedAt || null
  };
}

export async function fetchLikedVideos(token, { fetcher = fetch, onPage } = {}) {
  const resources = await fetchPages('videos', {
    part: 'snippet', myRating: 'like', maxResults: 50
  }, token, { fetcher, maxPages: 20, onPage });
  return resources.map(likedVideo).filter(Boolean);
}

export async function fetchSubscriptions(token, { fetcher = fetch, onPage } = {}) {
  const resources = await fetchPages('subscriptions', {
    part: 'snippet', mine: 'true', maxResults: 50
  }, token, { fetcher, maxPages: 40, onPage });
  return resources.map(subscription).filter(Boolean);
}

export async function fetchUploads(token, subscriptions, {
  fetcher = fetch, maxChannels = 200, maxPerChannel = 8, onBatch
} = {}) {
  const channelIds = [...new Set(subscriptions.map(s => s.channelId))]
    .filter(id => /^UC[A-Za-z0-9_-]{22}$/.test(id))
    .slice(0, maxChannels);
  const playlists = [];
  // channels.list costs 1 quota unit per batch, rather than per subscription.
  for (let i = 0; i < channelIds.length; i += 50) {
    const data = await requestYouTube('channels', {
      part: 'contentDetails', id: channelIds.slice(i, i + 50).join(',')
    }, token, fetcher);
    playlists.push(...(data.items || []).map(uploadPlaylist).filter(Boolean));
  }
  let processed = 0;
  let totalVideos = 0;
  // Bound concurrency to avoid an uncontrolled request burst.
  for (let i = 0; i < playlists.length; i += 4) {
    const batch = playlists.slice(i, i + 4);
    const results = await Promise.all(batch.map(async item => {
      const data = await requestYouTube('playlistItems', {
        part: 'snippet,contentDetails', playlistId: item.playlistId,
        maxResults: Math.min(50, Math.max(1, maxPerChannel))
      }, token, fetcher);
      return (data.items || []).map(v => uploadedVideo(v, item.channelId)).filter(Boolean);
    }));
    const videos = results.flat();
    totalVideos += videos.length;
    processed += batch.length;
    if (onBatch) await onBatch(videos, processed, playlists.length);
  }
  return { channels: playlists.length, videos: totalVideos };
}
