// Pure, deterministic recommendation engine. No browser APIs or network requests.
// Deliberately a transparent baseline: direct weight-space programming is a later experiment.
const STOP = new Set('a an and are as at be been by for from has have how i in into is it its of on or our out the their this to was we what when where which who why with you your video official live new full mix music session 2025 2026 4k hd'.split(' '));
const DAY = 86_400_000;

// Reject known broken records captured by older versions (e.g. thumbnail
// overlays such as "Watch" or duration labels instead of actual video titles).
export function validVideoTitle(value) {
  const title = String(value || '').replace(/\s+/g, ' ').trim();
  return title.length >= 4 &&
    !/^(watch|watch now|play|play video|upcoming|live|premiere|advertisement|sponsored|skip ads?|ad|video)$/i.test(title) &&
    !/^\d{1,3}:\d\d(?::\d\d)?(?=$|\s|[A-Z])/.test(title);
}

export function tokenize(text) {
  return String(text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/)
    .filter(t => t.length > 2 && !STOP.has(t) && !/^\d+$/.test(t));
}

export function features(video) {
  const out = Object.create(null);
  for (const t of tokenize(video.title)) out[t] = (out[t] || 0) + 1;
  for (const t of tokenize(video.channel)) out['channel:' + t] = (out['channel:' + t] || 0) + 0.5;
  return out;
}

function magnitude(v) {
  return Math.sqrt(Object.values(v).reduce((sum, x) => sum + x * x, 0));
}

export function cosine(a, b) {
  const denom = magnitude(a) * magnitude(b);
  if (!denom) return 0;
  let dot = 0;
  for (const [key, weight] of Object.entries(a)) dot += weight * (b[key] || 0);
  return Math.max(-1, Math.min(1, dot / denom));
}

function halfLifeWeight(timestamp, now, halfLifeDays) {
  if (!timestamp || !Number.isFinite(Number(timestamp))) return 0.6;
  const ageDays = Math.max(0, (now - Number(timestamp)) / DAY);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

export function preferenceProfile(items, now = Date.now(), halfLifeDays = 90) {
  const positive = Object.create(null);
  const negative = Object.create(null);
  const liked = [];
  let likes = 0;
  for (const item of Object.values(items || {})) {
    if (item.feedback !== 'like' && item.feedback !== 'less') continue;
    const f = features(item);
    const weight = halfLifeWeight(item.feedbackAt, now, halfLifeDays);
    const target = item.feedback === 'like' ? positive : negative;
    if (item.feedback === 'like') { likes++; liked.push(f); }
    for (const [key, value] of Object.entries(f)) {
      target[key] = (target[key] || 0) + value * weight;
    }
  }
  // Keep novel-item scoring bounded after a 1,000-like API import.
  // The aggregated preference profile still uses *all* feedback.
  const maxSeeds = 96;
  const seeds = liked.length <= maxSeeds ? liked :
    Array.from({ length: maxSeeds }, (_, i) =>
      liked[Math.floor(i * (liked.length - 1) / (maxSeeds - 1))]);
  return { positive, negative, liked: seeds, likes };
}

export function relativeAgeDays(label) {
  const t = String(label || '').trim().toLowerCase();
  if (/^(just now|today)$/.test(t)) return 0;
  if (t === 'yesterday') return 1;
  const m = t.match(/^(?:(?:streamed|premiered)\s+)?(\d[\d,.]*)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return n * ({ second: 1/86400, minute: 1/1440, hour: 1/24,
    day: 1, week: 7, month: 30, year: 365 }[m[2]]);
}

// Older versions interpreted any label containing "hour", "minute" or
// "second" as zero days old. Their cached publication timestamp equals
// firstSeenAt, even if the real label said "8 hours ago". Correct such
// records in the read path without deleting user preferences or history.
export function effectivePublishedAt(video) {
  const stamp = Number(video?.publishedAt);
  if (!Number.isFinite(stamp) || stamp <= 0) return null;
  const firstSeenAt = Number(video?.firstSeenAt);
  const label = String(video?.publishedText || '').trim();
  if (Number.isFinite(firstSeenAt) && firstSeenAt > 0 &&
      Math.abs(stamp - firstSeenAt) < 60000 &&
      /^\d[\d,.]*\s+(?:second|minute|hour)s?\s+ago$/i.test(label)) {
    const ageDays = relativeAgeDays(label);
    if (ageDays !== null) return firstSeenAt - ageDays * DAY;
  }
  return stamp;
}

function freshness(video, now) {
  // Persist the publication estimate once; a saved label like "2 days ago"
  // must not remain "2 days ago" forever.
  const publishedAt = effectivePublishedAt(video);
  if (publishedAt !== null) {
    return Math.exp(-Math.max(0, (now - publishedAt) / DAY) / 45);
  }
  const days = relativeAgeDays(video.publishedText);
  if (days !== null) return Math.exp(-days / 45);
  return 0.35 * halfLifeWeight(video.lastSeenAt, now, 30);
}

function reasonFor(video, feat, profile, fresh) {
  const overlap = Object.entries(feat)
    .filter(([key]) => !key.startsWith('channel:') && profile.positive[key] > 0)
    .sort((a, b) => (profile.positive[b[0]] * b[1]) - (profile.positive[a[0]] * a[1]))
    .slice(0, 3).map(([key]) => key);
  if (overlap.length) return 'Matches your likes: ' + overlap.join(', ');
  if (video.subscribed) return 'From a channel you subscribe to';
  if (fresh >= 0.8) return 'Recent upload worth exploring';
  return 'An unfamiliar candidate';
}

// Selection policy is intentionally separate from the like predictor.
// Options: mode = personalized | recent | explore, diversity = 0..100,
// exploration = 0..100, showSeen = boolean, limit = positive integer.
export function isConfirmedShort(video) {
  // Explicit user correction wins over unreliable API heuristics.
  if (video?.shortOverride === true) return true;
  if (video?.shortOverride === false) return false;
  if (video?.isShort === true || video?.shortsFormat === 'portrait') return true;
  const url = video?.shortsUrl || video?.url;
  if (!url) return false;
  try {
    const parsed = new URL(url, 'https://www.youtube.com');
    return ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(parsed.hostname) &&
      /^\/shorts\/[A-Za-z0-9_-]{11}\/?$/.test(parsed.pathname);
  } catch { return false; }
}

export function rankVideos(items, options = {}, now = Date.now()) {
  const {
    mode = 'personalized', diversity = 55, exploration = 15,
    showSeen = false, discoveryOnly = true, hideShorts = true, limit = 30, halfLifeDays = 90
  } = options;
  const profile = preferenceProfile(items, now, halfLifeDays);
  const valid = Object.values(items || {}).filter(v => {
    if (!v || !v.id || !validVideoTitle(v.title) || v.isAd || !v.candidate ||
        v.feedback === 'less') return false;
    if (hideShorts && isConfirmedShort(v)) return false;
    if (!showSeen && (v.watchedAt || v.visitedAt || v.hasResume || v.feedback === 'like')) return false;
    // Discovery mode removes candidates seen only on YouTube's algorithmic
    // Home/Related feeds. An item can have multiple independent sources.
    if (discoveryOnly) {
      const sources = Array.isArray(v.sources) ? v.sources : [v.source];
      if (!sources.some(source => ['subscriptions', 'channel', 'search'].includes(source))) return false;
    }
    return true;
  });
  const div = Math.min(1, Math.max(0, Number(diversity) / 100));
  const explore = Math.min(1, Math.max(0, Number(exploration) / 100));
  const candidates = valid.map(v => {
    const f = features(v);
    const pos = Math.max(0, cosine(f, profile.positive));
    const neg = Math.max(0, cosine(f, profile.negative));
    const fresh = freshness(v, now);
    // Baseline predicts preference; it is not a calibrated probability.
    const affinity = Math.max(0, pos - 0.7 * neg);
    const base = profile.likes
      ? Math.max(0, 0.72 * affinity + 0.2 * fresh + 0.08 * Number(Boolean(v.subscribed)))
      : (0.8 * fresh + 0.2 * Number(Boolean(v.subscribed)));
    const familiar = profile.liked.length
      ? Math.max(...profile.liked.map(l => Math.max(0, cosine(f, l)))) : 0;
    const novelty = 1 - familiar;
    const utility = mode === 'recent' ? fresh
      : mode === 'explore' ? (0.45 * base + 0.35 * novelty + 0.2 * fresh)
      : (1 - explore) * base + explore * (0.65 * novelty + 0.35 * fresh);
    return { ...v, score: Math.round(100 * base), utility, freshness: fresh,
      novelty, reason: reasonFor(v, f, profile, fresh), _features: f };
  });
  candidates.sort((a, b) => b.utility - a.utility || a.id.localeCompare(b.id));
  const selected = [];
  const selectedIds = new Set();
  const perChannel = new Map();
  const maxRedundancy = new Map(candidates.map(v => [v.id, 0]));
  const max = Math.max(1, Math.min(100, Number(limit) || 30));
  // Greedy maximum-marginal-relevance selection. Track the highest similarity
  // to *any* previously selected item incrementally. Recomputing every pair
  // at every step would be cubic in the number of recommendations.
  for (const enforceLimit of [true, false]) {
    while (selected.length < Math.min(max, candidates.length)) {
      let winner = null;
      let best = -Infinity;
      for (const v of candidates) {
        if (selectedIds.has(v.id)) continue;
        const channel = v.channelId || v.channel || '?';
        if (enforceLimit && (perChannel.get(channel) || 0) >= 2) continue;
        const adjusted = v.utility - div * 0.25 * maxRedundancy.get(v.id);
        if (adjusted > best) { best = adjusted; winner = v; }
      }
      if (!winner) break;
      selected.push(winner);
      selectedIds.add(winner.id);
      const channel = winner.channelId || winner.channel || '?';
      perChannel.set(channel, (perChannel.get(channel) || 0) + 1);
      for (const v of candidates) {
        if (selectedIds.has(v.id)) continue;
        const similarity = Math.max(0, cosine(v._features, winner._features));
        if (similarity > maxRedundancy.get(v.id)) maxRedundancy.set(v.id, similarity);
      }
    }
  }
  return selected.map(({ _features, utility, freshness, novelty, ...video }) => video);
}
