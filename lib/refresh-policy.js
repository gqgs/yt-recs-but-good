// Candidate acquisition is not recommendation reranking. This policy governs
// homepage-triggered API requests only; no background alarms or polling.
export const DEFAULT_TTL_MINUTES = 60;
export const TTL_OPTIONS = [15, 30, 60, 120, 360, 1440];
export const FAILED_RETRY_MINUTES = 15;
export const MAX_SUBSCRIPTION_CHANNELS = 200;
export const CHANNELS_PER_REFRESH = 40;
export const REFRESH_STALE_MS = 150_000;

export function selectSubscriptionRefreshBatch(subscriptions, cursor = 0) {
  const channels = [...new Map((subscriptions || [])
    .filter(s => /^UC[A-Za-z0-9_-]{22}$/.test(s?.channelId || ''))
    .map(s => [s.channelId, s])).values()].slice(0, MAX_SUBSCRIPTION_CHANNELS);
  const total = channels.length;
  const start = Number.isInteger(cursor) && cursor >= 0 && cursor < total
    ? cursor : 0;
  const batch = channels.slice(start, start + CHANNELS_PER_REFRESH);
  const nextChannelIndex = start + batch.length >= total
    ? 0 : start + batch.length;
  return { batch, start, total, nextChannelIndex };
}

const MINUTE = 60_000;

export function normalizeTtlMinutes(value) {
  const n = Number(value);
  return TTL_OPTIONS.includes(n) ? n : DEFAULT_TTL_MINUTES;
}

export function shouldRefresh({
  now = Date.now(),
  lastSuccessAt = 0,
  lastAttemptAt = 0,
  ttlMinutes = DEFAULT_TTL_MINUTES,
  paused = false,
  enabled = true
} = {}) {
  if (!enabled || paused) return false;
  if (lastSuccessAt && now - lastSuccessAt < normalizeTtlMinutes(ttlMinutes) * MINUTE) {
    return false;
  }
  // Avoid repeated network or authentication failures whenever Home rerenders.
  if (lastAttemptAt && now - lastAttemptAt < FAILED_RETRY_MINUTES * MINUTE) {
    return false;
  }
  return true;
}

export function formatRefreshAge(lastSuccessAt, now = Date.now()) {
  if (!Number.isFinite(lastSuccessAt) || lastSuccessAt <= 0) return 'Never updated';
  const minutes = Math.max(0, Math.floor((now - lastSuccessAt) / MINUTE));
  if (minutes < 1) return 'Updated just now';
  if (minutes < 60) return 'Updated ' + minutes + 'm ago';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return 'Updated ' + hours + 'h ago';
  return 'Updated ' + Math.floor(hours / 24) + 'd ago';
}
