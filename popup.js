import { rankVideos } from './lib/recommender.js';

const SETTINGS_KEY = 'yt-recs-settings-v1';
const defaults = { mode: 'personalized', diversity: 55, exploration: 15,
  halfLifeDays: 90, showSeen: false, limit: 30 };
let settings = { ...defaults };
let snapshot = { items: {}, channels: {}, events: [] };
const $ = id => document.getElementById(id);

function request(msg) {
  return chrome.runtime.sendMessage(msg).then(response => {
    if (!response?.ok) throw new Error(response?.error || 'Extension service unavailable');
    return response;
  });
}
function showError(error) {
  const el = $('error');
  el.textContent = String(error?.message || error);
  el.hidden = false;
}
function open(url) { chrome.tabs.create({ url }); }
function button(text, className, onClick) {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = text;
  el.className = className;
  el.addEventListener('click', onClick);
  return el;
}
function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function persistSettings() { return chrome.storage.local.set({ [SETTINGS_KEY]: settings }); }
function setMode(mode) {
  if (!['personalized', 'explore', 'recent'].includes(mode)) return;
  settings.mode = mode;
  for (const tab of document.querySelectorAll('[data-mode]')) {
    const selected = tab.dataset.mode === mode;
    tab.classList.toggle('selected', selected);
    tab.setAttribute('aria-pressed', String(selected));
  }
  void persistSettings(); render();
}
function syncOptions() {
  $('diversity').value = settings.diversity;
  $('exploration').value = settings.exploration;
  $('half-life').value = String(settings.halfLifeDays);
  $('show-seen').checked = settings.showSeen;
  $('diversity-value').textContent = settings.diversity + '%';
  $('exploration-value').textContent = settings.exploration + '%';
  for (const tab of document.querySelectorAll('[data-mode]')) {
    const selected = tab.dataset.mode === settings.mode;
    tab.classList.toggle('selected', selected);
    tab.setAttribute('aria-pressed', String(selected));
  }
}
async function refresh() {
  snapshot = (await request({ type: 'GET_STATE' })).state;
  render();
}
async function feedback(id, rating) {
  await request({ type: 'FEEDBACK', id, rating, origin: 'popup' });
  await refresh();
}
async function markSeen(id) {
  await request({ type: 'MARK_SEEN', id });
  await refresh();
}
function renderVideo(video, index) {
  const card = element('article', 'feed-item');
  const thumbnail = button('', 'thumb', () => open(video.url));
  thumbnail.title = 'Open on YouTube';
  const img = element('img');
  img.src = video.thumbnail;
  img.alt = '';
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  thumbnail.append(img);
  const info = element('div', 'details');
  const title = button(video.title, 'video-title', () => open(video.url));
  title.title = video.title;
  info.append(title);
  info.append(element('div', 'meta', [video.channel, video.publishedText].filter(Boolean).join(' · ') || 'YouTube'));
  info.append(element('div', 'why', video.reason || 'Discovered while browsing'));
  const actions = element('div', 'feed-actions');
  actions.append(
    button(video.feedback === 'like' ? '✓ Liked' : '♡ Like', '', () => {
      feedback(video.id, video.feedback === 'like' ? 'clear' : 'like').catch(showError);
    }),
    button('Not for me', '', () => feedback(video.id, 'less').catch(showError)),
    button('Seen', '', () => markSeen(video.id).catch(showError))
  );
  info.append(actions);
  card.append(thumbnail, info);
  card.setAttribute('aria-label', 'Recommendation ' + (index + 1) + ': ' + video.title);
  return card;
}
function render() {
  const items = Object.values(snapshot.items || {});
  const liked = items.filter(v => v.feedback === 'like');
  const candidates = items.filter(v => v.candidate);
  const unseen = candidates.filter(v => !v.watchedAt && v.feedback !== 'like' && v.feedback !== 'less');
  $('likes-count').textContent = String(liked.length);
  $('candidates-count').textContent = String(candidates.length);
  $('unseen-count').textContent = String(unseen.length);
  $('onboarding').hidden = liked.length > 0 && candidates.length > 0;

  const results = $('results');
  results.replaceChildren();
  const ranked = rankVideos(snapshot.items, settings);
  if (!ranked.length) {
    results.append(element('div', 'empty', candidates.length
      ? 'No eligible videos left in this pool. Browse subscriptions for fresh candidates, or enable previously watched videos.'
      : 'No candidates collected yet. Visit YouTube subscriptions, home, or search and scroll to collect some.'));
    return;
  }
  results.append(element('div', 'ranking-note',
    ranked.length + ' results · ' + ({ personalized: 'Preference first', explore: 'Exploration first', recent: 'Newest first' }[settings.mode])));
  for (const [i, video] of ranked.entries()) results.append(renderVideo(video, i));
}

async function initialize() {
  const saved = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
  if (saved && typeof saved === 'object') settings = { ...settings, ...saved };
  syncOptions();
  for (const tab of document.querySelectorAll('[data-mode]')) {
    tab.addEventListener('click', () => setMode(tab.dataset.mode));
  }
  $('toggle-options').addEventListener('click', () => {
    const hidden = !$('options').hidden;
    $('options').hidden = hidden;
    $('toggle-options').setAttribute('aria-expanded', String(!hidden));
  });
  for (const [id, setting] of [['diversity', 'diversity'], ['exploration', 'exploration']]) {
    $(id).addEventListener('input', () => {
      settings[setting] = Number($(id).value);
      $(id + '-value').textContent = settings[setting] + '%';
      void persistSettings();
      render();
    });
  }
  $('half-life').addEventListener('change', () => {
    settings.halfLifeDays = Number($('half-life').value);
    void persistSettings(); render();
  });
  $('show-seen').addEventListener('change', () => {
    settings.showSeen = $('show-seen').checked;
    void persistSettings(); render();
  });
  $('open-subs').addEventListener('click', () => open('https://www.youtube.com/feed/subscriptions'));
  $('open-likes').addEventListener('click', () => open('https://www.youtube.com/playlist?list=LL'));
  $('export-data').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), state: snapshot, settings }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'yt-recs-but-good-export.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  });
  $('reset-data').addEventListener('click', async () => {
    if (!confirm('Delete all locally collected videos, likes, history, and subscriptions? This does not affect YouTube.')) return;
    try { await request({ type: 'RESET' }); await refresh(); } catch (error) { showError(error); }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['yt-recs-state-v1']) refresh().catch(showError);
  });
  await refresh();
}
initialize().catch(showError);
