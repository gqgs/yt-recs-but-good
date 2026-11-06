// Pure, deterministic recommendation engine. No browser APIs or network requests.
// Deliberately a transparent baseline: direct weight-space programming is a later experiment.
const STOP = new Set('a an and are as at be been by for from has have how i in into is it its of on or our out the their this to was we what when where which who why with you your video official live new full mix music session 2025 2026 4k hd'.split(' '));
const DAY = 86_400_000;

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
  return { positive, negative, liked, likes };
}

export function relativeAgeDays(label) {
  const t = String(label || '').toLowerCase();
  if (/just now|today|hour|minute|second/.test(t)) return 0;
  if (/yesterday/.test(t)) return 1;
  const m = t.match(/(\d[\d,.]*)\s+(day|week|month|year)s?\s+ago/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return n * ({ day: 1, week: 7, month: 30, year: 365 }[m[2]]);
}

function freshness(video, now) {
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
export function rankVideos(items, options = {}, now = Date.now()) {
  const {
    mode = 'personalized', diversity = 55, exploration = 15,
    showSeen = false, limit = 30, halfLifeDays = 90
  } = options;
  const profile = preferenceProfile(items, now, halfLifeDays);
  const valid = Object.values(items || {}).filter(v =>
    v && v.id && v.title && v.candidate &&
    v.feedback !== 'less' &&
    (showSeen || (!v.watchedAt && v.feedback !== 'like')));
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
  const perChannel = new Map();
  const max = Math.max(1, Math.min(100, Number(limit) || 30));
  // Soft channel diversity limit; relax it if the candidate pool is too narrow.
  for (const enforceLimit of [true, false]) {
    while (selected.length < Math.min(max, candidates.length)) {
      let winner = null;
      let best = -Infinity;
      for (const v of candidates) {
        if (selected.some(x => x.id === v.id)) continue;
        const channel = v.channelId || v.channel || '?';
        if (enforceLimit && (perChannel.get(channel) || 0) >= 2) continue;
        const redundancy = selected.length ? Math.max(...selected.map(s => Math.max(0, cosine(v._features, s._features)))) : 0;
        const adjusted = v.utility - div * 0.25 * redundancy;
        if (adjusted > best) { best = adjusted; winner = v; }
      }
      if (!winner) break;
      selected.push(winner);
      const channel = winner.channelId || winner.channel || '?';
      perChannel.set(channel, (perChannel.get(channel) || 0) + 1);
    }
  }
  return selected.map(({ _features, utility, freshness, novelty, ...video }) => video);
}
