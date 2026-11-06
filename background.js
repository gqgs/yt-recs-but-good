// Privacy-first persistence and event log. All activity remains in chrome.storage.local.
const KEY = 'yt-recs-state-v1';
const MAX_ITEMS = 4000;
const MAX_EVENTS = 1500;
const clean = (value, length = 200) => String(value || '').trim().slice(0, length);
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id);
const empty = () => ({ items: {}, channels: {}, events: [] });

async function readState() {
  const result = await chrome.storage.local.get(KEY);
  const state = result[KEY];
  if (!state || typeof state !== 'object') return empty();
  return { items: state.items || {}, channels: state.channels || {}, events: state.events || [] };
}
async function saveState(state) {
  const ids = Object.keys(state.items);
  if (ids.length > MAX_ITEMS) {
    const removable = ids.filter(id => !state.items[id].feedback)
      .sort((a, b) => (state.items[a].lastSeenAt || 0) - (state.items[b].lastSeenAt || 0));
    for (const id of removable.slice(0, ids.length - MAX_ITEMS)) delete state.items[id];
  }
  if (state.events.length > MAX_EVENTS) state.events = state.events.slice(-MAX_EVENTS);
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
  const next = {
    ...old,
    id: data.id,
    title: clean(data.title, 240) || old.title || '',
    channel,
    channelId,
    thumbnail: 'https://i.ytimg.com/vi/' + data.id + '/mqdefault.jpg',
    url: 'https://www.youtube.com/watch?v=' + data.id,
    publishedText: clean(data.publishedText, 80) || old.publishedText || '',
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

// Serialize all writes so rapid content-script and popup events cannot overwrite each other.
let queue = Promise.resolve();
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || typeof msg.type !== 'string') return false;
  if (msg.type === 'GET_STATE') {
    queue.then(readState).then(s => reply({ ok: true, state: s }),
      e => reply({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'RESET') {
    const job = queue.then(async () => { await chrome.storage.local.remove(KEY); return { reset: true }; });
    queue = job.catch(() => {});
    job.then(result => reply({ ok: true, result }), e => reply({ ok: false, error: String(e) }));
    return true;
  }
  const job = queue.then(async () => {
    const state = await readState();
    const result = process(state, msg);
    await saveState(state);
    return result;
  });
  queue = job.catch(() => {});
  job.then(result => reply({ ok: true, result }), e => reply({ ok: false, error: String(e) }));
  return true;
});
