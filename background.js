import { relativeAgeDays, rankVideos } from './lib/recommender.js';
import { formatMetadataLine } from './lib/video-metadata.js';
import { fetchLikedVideos, fetchSubscriptions, fetchUploads } from './lib/api-sync.js';
import { normalizeTtlMinutes, shouldRefresh, formatRefreshAge } from './lib/refresh-policy.js';
import { getGoogleAccessToken, clearGoogleAccessToken, configuredGoogleClientId } from './lib/google-auth.js';

// Privacy-first persistence and event log. All activity remains in chrome.storage.local.
const KEY = 'yt-recs-state-v1';
const SETTINGS_KEY = 'yt-recs-settings-v1';
const API_SYNC_KEY = 'yt-recs-api-sync-v1';
const REFRESH_KEY = 'yt-recs-candidate-refresh-v1';
const PAUSED_KEY = 'yt-recs-collection-paused-v1';
const MAX_ITEMS = 4000;
const MAX_EVENTS = 1500;
const clean = (value, length = 200) => String(value || '').trim().slice(0, length);
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id);
const empty = () => ({ items: {}, channels: {}, events: [], visitedIds: {} });
const DAY = 86_400_000;
function estimatePublishedAt(label, now) {
  const days = relativeAgeDays(label);
  return days === null ? null : now - days * DAY;
}

async function readState() {
  const result = await chrome.storage.local.get(KEY);
  const state = result[KEY];
  if (!state || typeof state !== 'object') return empty();
  return { items: state.items || {}, channels: state.channels || {}, events: state.events || [],
    visitedIds: state.visitedIds || {}, historyImportedAt: state.historyImportedAt || null };
}
async function saveState(state) {
  const ids = Object.keys(state.items);
  if (ids.length > MAX_ITEMS) {
    const removable = ids.filter(id => !state.items[id].feedback)
      .sort((a, b) => (state.items[a].lastSeenAt || 0) - (state.items[b].lastSeenAt || 0));
    for (const id of removable.slice(0, ids.length - MAX_ITEMS)) delete state.items[id];
  }
  if (state.events.length > MAX_EVENTS) state.events = state.events.slice(-MAX_EVENTS);
  // History imports contain only YouTube video IDs, never arbitrary page URLs.
  const visited = Object.entries(state.visitedIds || {});
  if (visited.length > 20000) {
    visited.sort((a, b) => (b[1] || 0) - (a[1] || 0));
    state.visitedIds = Object.fromEntries(visited.slice(0, 20000));
  }
  await chrome.storage.local.set({ [KEY]: state });
}
function event(state, type, id, value, now) {
  state.events.push({ type, id, value, at: now });
}
function updateItem(state, data, now, source = '') {
  if (!data || !validId(data.id)) return null;
  const old = state.items[data.id] || {};
  const channel = clean(data.channel, 120) || old.channel || '';
  const channelId = clean(data.channelId, 120) || old.channelId || '';
  const subscriptionKey = channelId || channel;
  const knownSubscription = state.channels[subscriptionKey]?.subscribed;
  const candidate = Boolean(old.candidate || data.candidate);
  const sources = [...new Set([
    ...(Array.isArray(old.sources) ? old.sources : (old.source ? [old.source] : [])),
    ...[source, data.source].filter(Boolean)
  ])].slice(-10);
  const next = {
    ...old,
    id: data.id,
    title: clean(data.title, 240) || old.title || '',
    channel,
    channelId,
    sources,
    visitedAt: old.visitedAt || state.visitedIds?.[data.id] || null,
    hasResume: Boolean(data.hasResume || old.hasResume),
    thumbnail: 'https://i.ytimg.com/vi/' + data.id + '/mqdefault.jpg',
    url: 'https://www.youtube.com/watch?v=' + data.id,
    publishedText: clean(data.publishedText, 80) || old.publishedText || '',
    viewCountText: clean(data.viewCountText, 40) || old.viewCountText || '',
    viewCount: data.viewCount !== null && data.viewCount !== undefined &&
      data.viewCount !== '' && Number.isSafeInteger(Number(data.viewCount)) &&
      Number(data.viewCount) >= 0 ? Number(data.viewCount) : (old.viewCount ?? null),
    // An API timestamp is exact and should replace older estimates from
    // relative DOM labels such as "2 days ago".
    publishedAt: (data.publishedAt && Number.isFinite(Date.parse(data.publishedAt))
      ? Date.parse(data.publishedAt) : null) ||
      old.publishedAt || estimatePublishedAt(data.publishedText, now),
    candidate,
    subscribed: typeof knownSubscription === 'boolean' ? knownSubscription : Boolean(data.subscribed || old.subscribed),
    source: clean(data.source, 50) || source || old.source || '',
    firstSeenAt: old.firstSeenAt || now,
    lastSeenAt: now
  };
  state.items[data.id] = next;
  return next;
}
function updateFeedback(state, id, rating, now, origin = 'extension') {
  const item = state.items[id];
  if (!item || !['like', 'less', 'clear'].includes(rating)) return;
  const before = item.feedback || '';
  const after = rating === 'clear' ? '' : rating;
  if (before === after) return;
  if (after) { item.feedback = after; item.feedbackAt = now; }
  else { delete item.feedback; delete item.feedbackAt; }
  event(state, 'feedback', id, { rating: after, origin }, now);
}
function process(state, msg) {
  const now = Date.now();
  switch (msg.type) {
    case 'CANDIDATES': {
      const likedImport = msg.source === 'liked';
      let count = 0;
      for (const data of (Array.isArray(msg.videos) ? msg.videos : []).slice(0, 120)) {
        const video = updateItem(state, { ...data, candidate: !likedImport,
          subscribed: msg.source === 'subscriptions', source: msg.source }, now, msg.source);
        if (!video) continue;
        count++;
        if (likedImport) updateFeedback(state, video.id, 'like', now, 'liked-playlist');
      }
      return { collected: count };
    }
    case 'WATCH': {
      const v = updateItem(state, { ...msg.video, candidate: false, source: 'watch' }, now);
      if (v && !v.watchedAt) {
        v.watchedAt = now;
        event(state, 'watch', v.id, null, now);
      }
      return { recorded: Boolean(v) };
    }
    case 'MARK_SEEN': {
      const v = state.items[msg.id];
      if (!v) return { recorded: false };
      if (!v.watchedAt) {
        v.watchedAt = now;
        event(state, 'manually-seen', v.id, null, now);
      }
      return { recorded: true };
    }
    case 'PROGRESS': {
      const v = state.items[msg.id];
      const seconds = Number(msg.seconds);
      if (v && Number.isFinite(seconds) && seconds >= 0 && seconds < 864000) {
        v.maxPositionSeconds = Math.max(v.maxPositionSeconds || 0, Math.round(seconds));
      }
      return { recorded: Boolean(v) };
    }
    case 'FEEDBACK': {
      if (validId(msg.id)) {
        if (!state.items[msg.id] && msg.video) updateItem(state, msg.video, now);
        updateFeedback(state, msg.id, msg.rating, now, msg.origin || 'extension');
      }
      return { recorded: Boolean(state.items[msg.id]) };
    }
    case 'SUBSCRIBE': {
      const channelId = clean(msg.channelId, 120);
      const channel = clean(msg.channel, 120);
      const key = channelId || channel;
      if (!key || typeof msg.subscribed !== 'boolean') return { recorded: false };
      state.channels[key] = { name: channel, subscribed: msg.subscribed, updatedAt: now };
      for (const item of Object.values(state.items)) {
        if ((channelId && item.channelId === channelId) || (!channelId && item.channel === channel)) {
          item.subscribed = msg.subscribed;
        }
      }
      event(state, 'subscription', key, msg.subscribed, now);
      return { recorded: true };
    }
    default:
      throw new Error('Unknown operation: ' + msg.type);
  }
}

// Browser history is optional and queried only after an explicit UI permission
// grant. A past visit means "opened", not proof the whole video was watched.
function youtubeHistoryId(value) {
  try {
    const url = new URL(value);
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) return '';
    if (url.pathname !== '/watch') return '';
    const id = url.searchParams.get('v');
    return validId(id) ? id : '';
  } catch { return ''; }
}
async function importBrowserHistory() {
  const allowed = await chrome.permissions.contains({ permissions: ['history'] });
  if (!allowed || !chrome.history?.search) {
    throw new Error('Browser history permission was not granted.');
  }
  const results = await chrome.history.search({
    text: 'youtube.com/watch', startTime: 0, maxResults: 20000
  });
  const ids = new Map();
  for (const entry of results) {
    const id = youtubeHistoryId(entry.url || '');
    if (!id) continue;
    const at = Number(entry.lastVisitTime) || Date.now();
    ids.set(id, Math.max(at, ids.get(id) || 0));
  }
  return enqueueWrite(state => {
    state.visitedIds ||= {};
    for (const [id, at] of ids) {
      state.visitedIds[id] = Math.max(state.visitedIds[id] || 0, at);
      if (state.items[id]) state.items[id].visitedAt = state.visitedIds[id];
    }
    state.historyImportedAt = Date.now();
    event(state, 'browser-history-import', '', ids.size, state.historyImportedAt);
    return { inspected: results.length, videoIds: ids.size,
      matchedCandidates: [...ids.keys()].filter(id => state.items[id]?.candidate).length,
      reachedLimit: results.length === 20000 };
  });
}

// Serialize all writes so rapid content-script and popup events cannot overwrite each other.
let queue = Promise.resolve();

function enqueueWrite(fn) {
  const task = queue.then(async () => {
    const paused = (await chrome.storage.local.get(PAUSED_KEY))[PAUSED_KEY] === true;
    if (paused) throw new Error('Collection is paused after a reset. Resume it from the popup.');
    const state = await readState();
    const result = await fn(state);
    await saveState(state);
    return result;
  });
  queue = task.catch(() => {});
  return task;
}

let apiSyncPromise = null;
async function syncStatus(phase, message, counts = {}) {
  await chrome.storage.local.set({ [API_SYNC_KEY]: {
    phase, message, counts, updatedAt: Date.now()
  } });
}
async function importVideos(source, videos) {
  if (!videos.length) return 0;
  // A single serialized storage transaction avoids rebuilding the Home feed
  // dozens of times while importing hundreds of subscribed-channel uploads.
  return enqueueWrite(state => {
    let newCount = 0;
    for (let i = 0; i < videos.length; i += 120) {
      const batch = videos.slice(i, i + 120);
      const newIds = new Set(batch.filter(v => !state.items[v.id]).map(v => v.id));
      newCount += newIds.size;
      process(state, { type: 'CANDIDATES', source, videos: batch });
    }
    return newCount;
  });
}
async function importSubscriptions(subs) {
  await enqueueWrite(state => {
    const now = Date.now();
    for (const s of subs) {
      state.channels[s.channelId] = {
        name: s.channel, subscribed: true, updatedAt: now
      };
    }
    // Existing DOM-collected candidates may have a matching canonical channel ID.
    for (const item of Object.values(state.items)) {
      if (item.channelId && state.channels[item.channelId]?.subscribed) item.subscribed = true;
    }
    event(state, 'api-subscriptions-imported', '', subs.length, now);
  });
}
async function runApiSync() {
  try {
    await syncStatus('auth', 'Authorizing with your Google account…');
    const token = await getGoogleAccessToken({ interactive: true });
    await syncStatus('likes', 'Importing your most recent 1,000 liked videos…');
    const likes = await fetchLikedVideos(token);
    await importVideos('liked', likes);
    await syncStatus('subscriptions', 'Importing your subscriptions…', { likes: likes.length });
    const subs = await fetchSubscriptions(token);
    await importSubscriptions(subs);
    await syncStatus('uploads', 'Collecting recent uploads from subscribed channels…', {
      likes: likes.length, subscriptions: subs.length, uploads: 0
    });
    let uploads = 0;
    const imported = await fetchUploads(token, subs, {
      maxChannels: 200,
      maxPerChannel: 8,
      onBatch: async (videos, processed, total) => {
        await importVideos('subscriptions', videos);
        uploads += videos.length;
        if (processed % 20 === 0 || processed === total) {
          await syncStatus('uploads', 'Imported uploads from ' + processed + '/' + total + ' channels', {
            likes: likes.length, subscriptions: subs.length, uploads
          });
        }
      }
    });
    await syncStatus('complete', 'Google import complete. Open YouTube Home to see your feed.', {
      likes: likes.length, subscriptions: subs.length, uploads: imported.videos,
      channelsScanned: imported.channels
    });
    await saveRefreshStatus({
      phase: 'ready', lastSuccessAt: Date.now(),
      message: 'Imported uploads from ' + imported.channels + ' subscribed channels',
      channels: imported.channels, newVideos: imported.videos
    });
  } catch (error) {
    await syncStatus('error', String(error?.message || error));
  }
}
function configuredOAuth() {
  return Boolean(configuredGoogleClientId(chrome.runtime.getManifest()));
}
async function saveRefreshStatus(patch) {
  const saved = (await chrome.storage.local.get(REFRESH_KEY))[REFRESH_KEY] || {};
  const next = { ...saved, ...patch };
  await chrome.storage.local.set({ [REFRESH_KEY]: next });
  return next;
}
function refreshSummary(status, configured, paused, now = Date.now()) {
  if (paused) return 'Collection paused';
  if (!configured) return 'Connect Google API in the extension popup for new uploads';
  if (status?.phase === 'running') return 'Checking new subscribed uploads…';
  if (status?.phase === 'needs_auth') return 'Authorize YouTube API from the extension popup';
  if (status?.phase === 'error') return 'Refresh failed · ' + String(status.message || 'Try again').slice(0, 100);
  const age = formatRefreshAge(status?.lastSuccessAt || 0, now);
  if (status?.lastSuccessAt) return age +
    (Number.isFinite(status.newVideos) ? ' · ' + status.newVideos + ' newly found' : '');
  return 'Never synced · authorize YouTube API to discover new uploads';
}
async function refreshDetails(paused = false) {
  const status = (await chrome.storage.local.get(REFRESH_KEY))[REFRESH_KEY] || {};
  return { ...status, configured: configuredOAuth(), paused,
    label: refreshSummary(status, configuredOAuth(), paused) };
}

// A homepage visit triggers only a non-interactive, TTL-guarded refresh.
// Explicit user clicks can force a refresh and request Google authorization.
let candidateRefreshPromise = null;
let refreshKickoffPromise = null;
async function performCandidateRefresh(interactive) {
  try {
    const token = await getGoogleAccessToken({ interactive });
    const subscriptions = await fetchSubscriptions(token);
    await importSubscriptions(subscriptions);
    const newUploads = [];
    const summary = await fetchUploads(token, subscriptions, {
      maxChannels: 200, maxPerChannel: 5, includeStatistics: false,
      onBatch: async videos => { newUploads.push(...videos); }
    });
    const newlyFound = await importVideos('subscriptions', newUploads);
    const paused = (await chrome.storage.local.get(PAUSED_KEY))[PAUSED_KEY] === true;
    if (paused) return;
    await saveRefreshStatus({
      phase: 'ready', message: 'Subscribed uploads refreshed',
      lastSuccessAt: Date.now(), channels: summary.channels,
      newVideos: newlyFound
    });
  } catch (error) {
    const paused = (await chrome.storage.local.get(PAUSED_KEY))[PAUSED_KEY] === true;
    if (paused) return;
    const message = String(error?.message || error);
    await saveRefreshStatus({
      phase: !interactive && /auth|sign.?in|token|consent|not granted/i.test(message)
        ? 'needs_auth' : 'error', message: message.slice(0, 180)
    });
  }
}
function startCandidateRefresh({ force = false, interactive = false } = {}) {
  if (refreshKickoffPromise) return refreshKickoffPromise;
  const kickoff = (async () => {
    if (candidateRefreshPromise || apiSyncPromise) return { started: false, reason: 'running' };
    const keys = [REFRESH_KEY, SETTINGS_KEY, PAUSED_KEY];
    const saved = await chrome.storage.local.get(keys);
    const last = saved[REFRESH_KEY] || {};
    const settings = saved[SETTINGS_KEY] || {};
    const paused = saved[PAUSED_KEY] === true;
    if (paused) return { started: false, reason: 'paused' };
    if (!force && !shouldRefresh({
      now: Date.now(), lastSuccessAt: last.lastSuccessAt,
      lastAttemptAt: last.lastAttemptAt,
      ttlMinutes: normalizeTtlMinutes(settings.refreshTtlMinutes),
      enabled: settings.autoRefreshEnabled !== false
    })) return { started: false, reason: 'fresh-or-throttled' };
    if (!configuredOAuth()) {
      if (last.phase !== 'needs_setup') await saveRefreshStatus({
        phase: 'needs_setup', message: 'Set up a YouTube Data API OAuth client in manifest.json'
      });
      return { started: false, reason: 'needs_setup' };
    }
    await saveRefreshStatus({
      phase: 'running', message: 'Checking subscribed uploads',
      lastAttemptAt: Date.now()
    });
    candidateRefreshPromise = performCandidateRefresh(interactive)
      .finally(() => { candidateRefreshPromise = null; });
    return { started: true };
  })();
  refreshKickoffPromise = kickoff;
  // Observe both resolve and reject so no orphaned promise can create an
  // unhandled rejection after a service-worker event has returned.
  void kickoff.then(() => {
    if (refreshKickoffPromise === kickoff) refreshKickoffPromise = null;
  }, () => {
    if (refreshKickoffPromise === kickoff) refreshKickoffPromise = null;
  });
  return kickoff;
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || typeof msg.type !== 'string') return false;
  if (msg.type === 'REFRESH_CANDIDATES') {
    startCandidateRefresh({
      force: msg.force === true,
      interactive: msg.force === true && msg.interactive === true
    }).then(result => reply({ ok: true, result }),
      error => reply({ ok: false, error: String(error) }));
    return true;
  }
  if (msg.type === 'HISTORY_IMPORT') {
    importBrowserHistory().then(result => reply({ ok: true, result }),
      error => reply({ ok: false, error: String(error) }));
    return true;
  }
  if (msg.type === 'API_SYNC_START') {
    const oauth = chrome.runtime.getManifest().oauth2?.client_id || '';
    if (!oauth || oauth.includes('REPLACE_WITH')) {
      reply({ ok: false, error: 'Configure a Google Web application OAuth client ID in manifest.json and register the chromiumapp.org redirect. See README.md.' });
      return false;
    }
    if (apiSyncPromise || candidateRefreshPromise || refreshKickoffPromise) {
      reply({ ok: true, result: { started: false, running: true } });
      return false;
    }
    // The authorization prompt is only opened after the user explicitly clicks Sync.
    apiSyncPromise = runApiSync().finally(() => { apiSyncPromise = null; });
    reply({ ok: true, result: { started: true } });
    return false;
  }
  if (msg.type === 'GET_POPUP_DATA') {
    queue.then(async () => {
      const state = await readState();
      const stored = (await chrome.storage.local.get([SETTINGS_KEY, PAUSED_KEY]));
      const settings = stored[SETTINGS_KEY] || {};
      const items = Object.values(state.items);
      const liked = items.filter(v => v.feedback === 'like').length;
      const candidates = items.filter(v => v.candidate).length;
      const unseen = items.filter(v => v.candidate && !v.watchedAt &&
        !v.visitedAt && !v.hasResume && v.feedback !== 'like' && v.feedback !== 'less').length;
      const recommendations = rankVideos(state.items, {
        mode: settings.mode || 'personalized',
        diversity: Number.isFinite(settings.diversity) ? settings.diversity : 55,
        exploration: Number.isFinite(settings.exploration) ? settings.exploration : 15,
        halfLifeDays: settings.halfLifeDays || 90,
        showSeen: settings.showSeen === true,
        discoveryOnly: settings.discoveryOnly !== false,
        limit: 12
      }).map(video => ({
        ...video, metadataLine: formatMetadataLine(video)
      }));
      return { counts: { liked, candidates, unseen }, recommendations,
        paused: stored[PAUSED_KEY] === true,
        refresh: await refreshDetails(stored[PAUSED_KEY] === true) };
    }).then(result => reply({ ok: true, result }),
      error => reply({ ok: false, error: String(error) }));
    return true;
  }
  if (msg.type === 'GET_STATE') {
    queue.then(readState).then(s => reply({ ok: true, state: s }),
      e => reply({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'GET_RECOMMENDATIONS') {
    queue.then(async () => {
      const state = await readState();
      const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
      const settings = {
        mode: ['personalized', 'explore', 'recent'].includes(stored.mode) ? stored.mode : 'personalized',
        diversity: Number.isFinite(stored.diversity) ? stored.diversity : 55,
        exploration: Number.isFinite(stored.exploration) ? stored.exploration : 15,
        halfLifeDays: [30, 90, 365, 3650].includes(stored.halfLifeDays) ? stored.halfLifeDays : 90,
        showSeen: stored.showSeen === true,
        discoveryOnly: stored.discoveryOnly !== false,
        limit: 100
      };
      const items = Object.values(state.items);
      const likes = items.filter(v => v.feedback === 'like').length;
      const unseen = items.filter(v =>
        v.candidate && !v.watchedAt && !v.visitedAt && !v.hasResume &&
        v.feedback !== 'like' && v.feedback !== 'less').length;
      const paused = (await chrome.storage.local.get(PAUSED_KEY))[PAUSED_KEY] === true;
      return { recommendations: rankVideos(state.items, settings).map(video => ({
        ...video, metadataLine: formatMetadataLine(video)
      })),
        paused, refresh: await refreshDetails(paused),
        counts: { likes, unseen, candidates: items.filter(v => v.candidate).length } };
    }).then(result => reply({ ok: true, result }),
      e => reply({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'RESET' || msg.type === 'CLEAR_CANDIDATES') {
    // Put a barrier in the serial queue. Writes queued before a reset finish
    // first; writes queued afterwards see the paused flag and cannot refill it.
    const job = queue.then(async () => {
      if (msg.type === 'RESET') {
        // Persist the pause before removing the state so a Home-page MutationObserver
        // cannot immediately re-import candidates while the user clears them.
        await chrome.storage.local.set({ [PAUSED_KEY]: true });
        await chrome.storage.local.remove([KEY, REFRESH_KEY]);
        await clearGoogleAccessToken();
        return { reset: true, paused: true };
      }
      const state = await readState();
      let removed = 0;
      for (const [id, item] of Object.entries(state.items)) {
        if (!item.candidate) continue;
        removed++;
        if (!item.feedback && !item.watchedAt && !item.visitedAt && !item.maxPositionSeconds) {
          delete state.items[id];
        } else {
          // Retain preferences and viewing history, but forget its eligibility
          // as a recommendation until rediscovered on a different page.
          item.candidate = false;
          item.sources = [];
          item.source = '';
        }
      }
      await saveState(state);
      // Clearing candidate records invalidates the previous refresh TTL.
      await chrome.storage.local.remove(REFRESH_KEY);
      return { removed, preservedPreferences: true };
    });
    queue = job.catch(() => {});
    job.then(result => reply({ ok: true, result }),
      e => reply({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'COLLECTION_RESUME') {
    const job = queue.then(async () => {
      await chrome.storage.local.set({ [PAUSED_KEY]: false });
      await chrome.storage.local.remove(REFRESH_KEY);
      return { paused: false };
    });
    queue = job.catch(() => {});
    job.then(result => reply({ ok: true, result }),
      e => reply({ ok: false, error: String(e) }));
    return true;
  }
  const job = queue.then(async () => {
    // Block automatic re-population after a full reset. Nothing will be saved
    // until the user chooses "Resume collection" in the popup.
    const paused = (await chrome.storage.local.get(PAUSED_KEY))[PAUSED_KEY] === true;
    if (paused) return { skipped: true, paused: true };
    const state = await readState();
    const result = process(state, msg);
    await saveState(state);
    return result;
  });
  queue = job.catch(() => {});
  job.then(result => reply({ ok: true, result }), e => reply({ ok: false, error: String(e) }));
  return true;
});
