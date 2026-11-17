// Decouple the visible feed from asynchronous format classification.
// Do not briefly show an unverified candidate and remove it after an oEmbed
// result arrives. These helpers are pure and can be tested without a browser.
(() => {
  const HOUR = 3600_000;
  const DAY = 24 * HOUR;
  const UNKNOWN_TTL = 6 * HOUR;
  const VERIFIED_TTL = 30 * DAY;

  function needsFormatCheck(video, now = Date.now(), expectedProbeSource) {
    if (!video || video.shortOverride !== undefined || video.isShort === true ||
        Number.isFinite(video.durationSeconds) && video.durationSeconds > 180)
      return false;
    // An old oEmbed classification is not enough to bypass the new CDN
    // check. It remains staged until probed without deleting its record.
    // The worker is the authority on the classifier version. An absent version
    // must never make an unverified video appear in the feed.
    if (!expectedProbeSource || video.shortsProbeSource !== expectedProbeSource) return true;
    const format = video.shortsFormat;
    if (!['landscape', 'portrait', 'unknown'].includes(format)) return true;
    const checkedAt = Number(video.shortsProbedAt || 0);
    if (!checkedAt || checkedAt > now) return true;
    return now - checkedAt >= (format === 'unknown' ? UNKNOWN_TTL : VERIFIED_TTL);
  }

  // The caller's ranking already removes confirmed Shorts. This only delays
  // uncertain cards until their format check finishes or times out.
  function splitCandidates(recommendations, hideShorts = true,
    now = Date.now(), expectedProbeSource) {
    if (!hideShorts) return { ready: recommendations, pending: [] };
    const ready = [], pending = [];
    // Preserve the relative order of ready cards, without making a pending
    // format at the front of Recent block unrelated, verified uploads.
    for (const video of recommendations) {
      (needsFormatCheck(video, now, expectedProbeSource) ? pending : ready).push(video);
    }
    return { ready, pending };
  }

  function formatDuration(seconds) {
    if (!Number.isSafeInteger(seconds) || seconds <= 0) return '';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return (hours ? hours + ':' + String(minutes).padStart(2, '0') : String(minutes)) +
      ':' + String(secs).padStart(2, '0');
  }

  globalThis.YTRBGShortsVisibility = Object.freeze({
    needsFormatCheck, splitCandidates, formatDuration
  });
})();
