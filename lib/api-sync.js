// YouTube Data API import helpers. Pure dependency-injected fetch functions so
// pagination, conversion and quota limits are testable without Google access.
const BASE = 'https://www.googleapis.com/youtube/v3/';
const VALID_ID = /^[A-Za-z0-9_-]{11}$/;

export class YouTubeApiError extends Error {
  constructor(status, reason, message) {
    super('YouTube API HTTP ' + status +
      (reason ? ' (' + reason + ')' : '') + (message ? ': ' + message : ''));
    this.name = 'YouTubeApiError';
    this.status = status;
    this.reason = reason;
  }
}

export function isUnavailableUploadPlaylist(error) {
  // Only catch well-understood *per-playlist* errors, never account errors,
  // exhausted quota, an invalid API parameter, or a missing video.
  return error instanceof YouTubeApiError &&
    ((error.status === 404 && error.reason === 'playlistNotFound') ||
     (error.status === 403 && error.reason === 'playlistItemsNotAccessible'));
}

export const API_REQUEST_TIMEOUT_MS = 12_000;

export async function requestYouTube(path, params, token, fetcher = fetch, timeoutMs = API_REQUEST_TIMEOUT_MS) {
  const url = new URL(path, BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('YouTube API ' + path + ' request timed out. Retry the refresh.'));
    }, timeoutMs);
  });
  let response;
  try {
    response = await Promise.race([
      fetcher(url.toString(), {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
        signal: controller.signal
      }),
      timeout
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    let reason = '';
    let message = '';
    try {
      const body = await response.json();
      reason = String(body?.error?.errors?.[0]?.reason || '').slice(0, 90);
      // YouTube sometimes includes literal HTML tags such as <code>playlistId</code>.
      // Keep error text concise and readable without treating it as markup.
      message = String(body?.error?.message || '').replace(/<[^>]*>/g, '').slice(0, 220);
    } catch { /* API returned text instead of JSON. */ }
    throw new YouTubeApiError(response.status, reason, message);
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
    publishedAt: v.snippet.publishedAt || null,
    viewCount: v.statistics?.viewCount ?? null
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
    part: 'snippet,statistics', myRating: 'like', maxResults: 50
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
  fetcher = fetch, maxChannels = 200, maxPerChannel = 8, includeStatistics = true, onBatch
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
  let unavailable = 0;
  let checked = 0;
  // Bound concurrency to avoid an uncontrolled request burst.
  for (let i = 0; i < playlists.length; i += 4) {
    const batch = playlists.slice(i, i + 4);
    const results = await Promise.all(batch.map(async item => {
      try {
        const data = await requestYouTube('playlistItems', {
          part: 'snippet,contentDetails', playlistId: item.playlistId,
          maxResults: Math.min(50, Math.max(1, maxPerChannel))
        }, token, fetcher);
        return { videos: (data.items || []).map(v => uploadedVideo(v, item.channelId)).filter(Boolean), unavailable: false };
      } catch (error) {
        if (!isUnavailableUploadPlaylist(error)) throw error;
        // A deleted, hidden, or inaccessible uploads playlist must not prevent
        // the remaining subscribed channels from contributing candidates.
        return { videos: [], unavailable: true };
      }
    }));
    unavailable += results.filter(result => result.unavailable).length;
    checked += results.filter(result => !result.unavailable).length;
    const videos = results.flatMap(result => result.videos);
    // playlistItems omits view counts. One batched videos.list(statistics)
    // request per up-to-50 IDs supplies them without expensive searches.
    // Statistics are optional: unavailable or failing counts do not block discovery.
    if (includeStatistics) for (let offset = 0; offset < videos.length; offset += 50) {
      const subset = videos.slice(offset, offset + 50);
      if (!subset.length) continue;
      try {
        const data = await requestYouTube('videos', {
          part: 'statistics', id: subset.map(video => video.id).join(',')
        }, token, fetcher);
        const counts = new Map((data.items || []).map(item => [
          item.id, item.statistics?.viewCount ?? null
        ]));
        for (const video of subset) {
          if (counts.get(video.id) != null) video.viewCount = counts.get(video.id);
        }
      } catch {
        // Import remains usable even when view statistics are unavailable.
      }
    }
    totalVideos += videos.length;
    processed += batch.length;
    if (onBatch) await onBatch(videos, processed, playlists.length);
  }
  if (playlists.length > 0 && checked === 0 && unavailable > 0) {
    throw new Error('No subscribed-channel uploads could be checked: all ' +
      unavailable + ' upload playlists were unavailable. Other YouTube data was preserved.');
  }
  return { channels: playlists.length, checked, unavailable, videos: totalVideos };
}
