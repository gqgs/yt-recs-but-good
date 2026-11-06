import { effectivePublishedAt } from './recommender.js';

// Display helpers: keep rendering independent from ranking and from DOM extraction.
// Missing counts/dates are omitted, never fabricated from firstSeenAt or lastSeenAt.
export function formatViewCount(video) {
  if (video?.viewCount !== null && video?.viewCount !== undefined && video?.viewCount !== '') {
    const count = Number(video.viewCount);
    if (Number.isSafeInteger(count) && count >= 0) {
      const compact = new Intl.NumberFormat('en', {
        notation: 'compact', maximumFractionDigits: 1
      }).format(count);
      return compact + (count === 1 ? ' view' : ' views');
    }
  }
  const text = String(video?.viewCountText || '').trim();
  // A label from a real video card is preferable to inventing a view count.
  const namedCount = text.match(/^([\d,]+(?:\.\d+)?)\s+(thousand|million|billion)\s+views?$/i);
  if (namedCount) {
    const scale = { thousand: 1e3, million: 1e6, billion: 1e9 }[namedCount[2].toLowerCase()];
    const count = Number(namedCount[1].replace(/,/g, '')) * scale;
    if (Number.isSafeInteger(count)) {
      return new Intl.NumberFormat('en', {
        notation: 'compact', maximumFractionDigits: 1
      }).format(count) + (count === 1 ? ' view' : ' views');
    }
  }
  if (/^(?:no|\d[\d,\.\s]*[kmb]?)\s+views?$/i.test(text)) return text;
  return '';
}

export function formatUploadAge(video, now = Date.now()) {
  const stamp = effectivePublishedAt(video);
  if (Number.isFinite(stamp) && stamp > 0) {
    const elapsed = Math.max(0, now - stamp);
    const units = [
      [365 * 86400000, 'year'], [30 * 86400000, 'month'],
      [7 * 86400000, 'week'], [86400000, 'day'],
      [3600000, 'hour'], [60000, 'minute']
    ];
    for (const [ms, label] of units) {
      if (elapsed >= ms) {
        const n = Math.floor(elapsed / ms);
        return n + ' ' + label + (n === 1 ? '' : 's') + ' ago';
      }
    }
    return 'Just now';
  }
  const text = String(video?.publishedText || '').trim();
  // Old records without absolute timestamps retain the last observed label.
  // A subsequent visit or API import can update it with a better timestamp.
  return /^(?:streamed\s+|premiered\s+)?(?:\d+[\d,.]*\s+(?:minutes?|hours?|days?|weeks?|months?|years?)\s+ago|yesterday|today|just now)$/i.test(text)
    ? text : '';
}

export function formatMetadataLine(video, now = Date.now()) {
  return [formatViewCount(video), formatUploadAge(video, now)].filter(Boolean).join(' · ');
}
