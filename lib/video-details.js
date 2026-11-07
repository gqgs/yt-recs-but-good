// Small, bounded metadata enrichment for videos already in the local feed.
// Uses YouTube Data API videos.list (one request for up to 50 IDs).
// No new OAuth scopes or extra API calls for already enriched candidates.
import { requestYouTube } from './api-sync.js';
import { parseIsoDurationSeconds } from './video-duration.js';

const VALID_ID = /^[A-Za-z0-9_-]{11}$/;
export const MAX_DETAILS_BATCH = 50;
export const DETAIL_RETRY_MS = 60 * 60_000;

export function needsVideoDetails(video, now = Date.now(), force = false) {
  if (!video?.candidate || !VALID_ID.test(video.id || '')) return false;
  if (Number.isSafeInteger(video.durationSeconds) && video.durationSeconds > 0 &&
      video.viewCount !== null && video.viewCount !== undefined) return false;
  const attempted = Number(video.detailsAttemptedAt || 0);
  return force || !attempted || now - attempted >= DETAIL_RETRY_MS;
}

export function videoDetails(record) {
  const seconds = parseIsoDurationSeconds(record?.contentDetails?.duration);
  const count = record?.statistics?.viewCount;
  const numeric = count !== undefined && count !== null &&
    Number.isSafeInteger(Number(count)) && Number(count) >= 0 ? Number(count) : null;
  return { durationSeconds: seconds, viewCount: numeric };
}

export async function fetchVideoDetails(token, ids, { fetcher = fetch } = {}) {
  const validIds = [...new Set(ids)].filter(id => VALID_ID.test(id || ''))
    .slice(0, MAX_DETAILS_BATCH);
  if (!validIds.length) return { ids: [], results: new Map() };
  const response = await requestYouTube('videos', {
    part: 'contentDetails,statistics', id: validIds.join(',')
  }, token, fetcher);
  const results = new Map((response.items || [])
    .filter(item => validIds.includes(item?.id))
    .map(item => [item.id, videoDetails(item)]));
  return { ids: validIds, results };
}
