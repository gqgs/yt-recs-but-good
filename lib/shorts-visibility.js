// Decouple the visible feed from asynchronous format classification.
// Do not briefly show an unverified candidate and remove it after an oEmbed
// result arrives. These helpers are pure and can be tested without a browser.
(() => {
  const HOUR = 3600_000;
  const DAY = 24 * HOUR;
  const UNKNOWN_TTL = 6 * HOUR;
  const VERIFIED_TTL = 30 * DAY;

  function needsFormatCheck(video, now = Date.now()) {
    if (!video || video.shortOverride !== undefined || video.isShort === true ||
        Number.isFinite(video.durationSeconds) && video.durationSeconds > 180)
      return false;
    // An old oEmbed classification is not enough to bypass the new CDN
    // check. It remains staged until probed without deleting its record.
    if (video.shortsProbeSource !== 'three-panel-image-v1') return true;
    const format = video.shortsFormat;
    if (!['landscape', 'portrait', 'unknown'].includes(format)) return true;
    const checkedAt = Number(video.shortsProbedAt || 0);
    if (!checkedAt || checkedAt > now) return true;
    return now - checkedAt >= (format === 'unknown' ? UNKNOWN_TTL : VERIFIED_TTL);
  }

  // The caller's ranking already removes confirmed Shorts. This only delays
  // uncertain cards until their format check finishes or times out.
  function splitCandidates(recommendations, hideShorts = true,
    now = Date.now(), mode = 'personalized') {
    if (!hideShorts) return { ready: recommendations, pending: [], heldBack: 0 };
    const ready = [], pending = [];
    let blockedByNewer = false, heldBack = 0;
    for (const video of recommendations) {
      if (needsFormatCheck(video, now)) {
        pending.push(video);
        blockedByNewer = true;
      } else if (mode === 'recent' && blockedByNewer) {
        // Strict chronology: do not promote an older, cached video above an
        // unresolved newer upload. It becomes visible when the earlier item
        // finishes classification (or is removed as a Short).
        heldBack++;
      } else {
        ready.push(video);
      }
    }
    return { ready, pending, heldBack };
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
