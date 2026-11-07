// Decouple the visible feed from asynchronous format classification.
// Do not briefly show an unverified candidate and remove it after an oEmbed
// result arrives. These helpers are pure and can be tested without a browser.
(() => {
  const HOUR = 3600_000;
  const DAY = 24 * HOUR;
  const UNKNOWN_TTL = 6 * HOUR;
  const VERIFIED_TTL = 30 * DAY;

  function needsFormatCheck(video, now = Date.now()) {
    if (!video || video.shortOverride !== undefined || video.isShort === true)
      return false;
    // An old oEmbed classification is not enough to bypass the new CDN
    // check. It remains staged until probed without deleting its record.
    if (video.shortsProbeSource !== 'oar2-jpeg-v1') return true;
    const format = video.shortsFormat;
    if (!['landscape', 'portrait', 'unknown'].includes(format)) return true;
    const checkedAt = Number(video.shortsProbedAt || 0);
    if (!checkedAt || checkedAt > now) return true;
    return now - checkedAt >= (format === 'unknown' ? UNKNOWN_TTL : VERIFIED_TTL);
  }

  // The caller's ranking already removes confirmed Shorts. This only delays
  // uncertain cards until their format check finishes or times out.
  function splitCandidates(recommendations, hideShorts = true, now = Date.now()) {
    if (!hideShorts) return { ready: recommendations, pending: [] };
    const ready = [];
    const pending = [];
    for (const video of recommendations) {
      (needsFormatCheck(video, now) ? pending : ready).push(video);
    }
    return { ready, pending };
  }

  globalThis.YTRBGShortsVisibility = Object.freeze({ needsFormatCheck, splitCandidates });
})();
