// Shared duration parsing and formatting. Unknown/live duration stays absent.
// YouTube Data API contentDetails.duration uses ISO 8601; DOM cards show M:SS
// or H:MM:SS. Three-minute Shorts have duration <= 180 seconds.
export const MAX_SHORTS_SECONDS = 180;

export function parseIsoDurationSeconds(value) {
  if (typeof value !== 'string') return null;
  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match || match.slice(1).every(x => x === undefined)) return null;
  const [days, hours, minutes, seconds] = match.slice(1).map(x => Number(x || 0));
  const total = days * 86400 + hours * 3600 + minutes * 60 + seconds;
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

export function parseDurationLabel(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const first = Number(match[1]);
  const second = Number(match[2]);
  const third = match[3] === undefined ? null : Number(match[3]);
  if (second >= 60 && third !== null || third !== null && third >= 60) return null;
  const total = third === null ? first * 60 + second :
    first * 3600 + second * 60 + third;
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

export function formatDuration(seconds) {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) +
    ':' + String(s).padStart(2, '0');
}

export function isKnownLongForm(video) {
  return Number.isFinite(video?.durationSeconds) &&
    video.durationSeconds > MAX_SHORTS_SECONDS;
}
