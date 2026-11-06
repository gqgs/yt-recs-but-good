import { formatMetadataLine } from './lib/video-metadata.js';

const SETTINGS_KEY = 'yt-recs-settings-v1';
const HOME_KEY = 'yt-recs-home-enabled-v1';
const API_SYNC_KEY = 'yt-recs-api-sync-v1';
const defaults = { mode: 'personalized', diversity: 55, exploration: 15,
  halfLifeDays: 90, showSeen: false, discoveryOnly: true, limit: 30 };
let settings = { ...defaults };
let snapshot = { counts: { liked: 0, candidates: 0, unseen: 0 }, recommendations: [], paused: false };
let resetting = false;
let refreshTimer = null;
const $ = id => document.getElementById(id);

function request(msg) {
  return chrome.runtime.sendMessage(msg).then(response => {
    if (!response?.ok) throw new Error(response?.error || 'Extension service unavailable');
    return response;
  });
}

function renderSyncStatus(status) {
  const area = $('api-sync-status');
  if (!status) return;
  const counts = status.counts || {};
  const numbers = [counts.likes !== undefined ? counts.likes + ' likes' : null,
    counts.subscriptions !== undefined ? counts.subscriptions + ' channels' : null,
    counts.uploads !== undefined ? counts.uploads + ' uploads' : null].filter(Boolean);
  area.textContent = (status.message || '') + (numbers.length ? ' (' + numbers.join(', ') + ')' : '');
  $('api-sync').disabled = !['complete', 'error'].includes(status.phase);
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
  void persistSettings(); scheduleRefresh();
}
function syncOptions() {
  $('diversity').value = settings.diversity;
  $('exploration').value = settings.exploration;
  $('half-life').value = String(settings.halfLifeDays);
  $('show-seen').checked = settings.showSeen;
  $('discovery-only').checked = settings.discoveryOnly !== false;
  $('diversity-value').textContent = settings.diversity + '%';
  $('exploration-value').textContent = settings.exploration + '%';
  for (const tab of document.querySelectorAll('[data-mode]')) {
    const selected = tab.dataset.mode === settings.mode;
    tab.classList.toggle('selected', selected);
    tab.setAttribute('aria-pressed', String(selected));
  }
}
async function refresh() {
  if (resetting) return;
  snapshot = (await request({ type: 'GET_POPUP_DATA' })).result;
  render();
}
function scheduleRefresh() {
  if (resetting || refreshTimer !== null) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refresh().catch(showError);
  }, 300);
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
  info.append(element('div', 'meta', [video.channel, formatMetadataLine(video)].filter(Boolean).join(' · ') || 'YouTube'));
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
  const counts = snapshot.counts || { liked: 0, candidates: 0, unseen: 0 };
  $('likes-count').textContent = String(counts.liked || 0);
  $('candidates-count').textContent = String(counts.candidates || 0);
  $('unseen-count').textContent = String(counts.unseen || 0);
  const paused = snapshot.paused === true;
  $('collection-paused').hidden = !paused;
  $('resume-collection').disabled = !paused;
  $('onboarding').hidden = paused || ((counts.liked || 0) > 0 && (counts.candidates || 0) > 0);
  const results = $('results');
  results.replaceChildren();
  const ranked = snapshot.recommendations || [];
  if (!ranked.length) {
    results.append(element('div', 'empty', paused
      ? 'Collection is paused after deleting all data. Resume it explicitly when ready.'
      : counts.candidates
        ? 'No eligible recommendations. Browse subscriptions for more candidates or change your filters.'
        : 'No candidates yet. Visit subscriptions or perform the optional import.'));
    return;
  }
  results.append(element('div', 'ranking-note', ranked.length + ' preview recommendations'));
  for (const [i, video] of ranked.entries()) results.append(renderVideo(video, i));
}

// Unlike native browser dialogs, this confirmation cannot block the event loop
// or escapes the bounds of the extension popup.
let pendingDeletion = null;
let previousFocus = null;

function closeConfirmation() {
  const overlay = $('confirm-overlay');
  overlay.hidden = true;
  document.querySelector('main').inert = false;
  document.body.classList.remove('confirming');
  pendingDeletion = null;
  $('confirm-proceed').disabled = false;
  $('confirm-cancel').disabled = false;
  previousFocus?.focus?.();
  previousFocus = null;
}

function openConfirmation(action) {
  if (resetting || pendingDeletion || !['candidates', 'all'].includes(action)) return;
  pendingDeletion = action;
  previousFocus = document.activeElement;
  if (action === 'all') {
    $('confirm-title').textContent = 'Delete all extension data?';
    $('confirm-description').textContent =
      'This permanently clears your locally collected videos, likes, subscriptions, and viewing history. Your YouTube account is unaffected. Collection will stay paused until you resume it.';
    $('confirm-proceed').textContent = 'Delete all data';
  } else {
    $('confirm-title').textContent = 'Clear recommendation candidates?';
    $('confirm-description').textContent =
      'This removes the collected recommendation pool, but retains your likes, subscriptions, and viewing history.';
    $('confirm-proceed').textContent = 'Clear candidates';
  }
  $('confirm-overlay').hidden = false;
  document.querySelector('main').inert = true;
  document.body.classList.add('confirming');
  $('confirm-cancel').focus();
}

async function performDeletion() {
  const action = pendingDeletion;
  if (!action || resetting) return;
  resetting = true;
  $('confirm-proceed').disabled = true;
  $('confirm-cancel').disabled = true;
  $('confirm-proceed').textContent = 'Clearing…';
  $('reset-data').disabled = true;
  $('clear-candidates').disabled = true;
  try {
    if (action === 'all') {
      $('reset-status').textContent = 'Clearing extension data…';
      await request({ type: 'RESET' });
      $('reset-status').textContent =
        'Data cleared. Automatic collection is paused until you choose Resume.';
    } else {
      const response = await request({ type: 'CLEAR_CANDIDATES' });
      $('reset-status').textContent =
        'Cleared ' + response.result.removed + ' candidate records. Your likes and history were retained.';
    }
  } catch (error) {
    showError(error);
    $('reset-status').textContent = 'Could not complete the deletion.';
  } finally {
    resetting = false;
    closeConfirmation();
    $('reset-data').disabled = false;
    $('clear-candidates').disabled = false;
    await refresh().catch(showError);
  }
}

async function initialize() {
  const saved = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
  if (saved && typeof saved === 'object') settings = { ...settings, ...saved };
  syncOptions();
  const home = (await chrome.storage.local.get(HOME_KEY))[HOME_KEY];
  $('replace-home').checked = home !== false;
  $('replace-home').addEventListener('change', () => {
    chrome.storage.local.set({ [HOME_KEY]: $('replace-home').checked }).catch(showError);
  });
  $('open-home').addEventListener('click', () => open('https://www.youtube.com/'));
  const syncStatus = (await chrome.storage.local.get(API_SYNC_KEY))[API_SYNC_KEY];
  if (syncStatus) renderSyncStatus(syncStatus);
  $('api-sync').addEventListener('click', async () => {
    const btn = $('api-sync');
    btn.disabled = true;
    try {
      const response = await request({ type: 'API_SYNC_START' });
      $('api-sync-status').textContent = response.result.started
        ? 'Google authorization requested…' : 'An import is already running.';
    } catch (error) {
      showError(error);
      btn.disabled = false;
    }
  });
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
    void persistSettings(); scheduleRefresh();
  });
  $('show-seen').addEventListener('change', () => {
    settings.showSeen = $('show-seen').checked;
    void persistSettings(); render();
  });
  $('discovery-only').addEventListener('change', () => {
    settings.discoveryOnly = $('discovery-only').checked;
    void persistSettings(); render();
  });
  $('import-history').addEventListener('click', async () => {
    const button = $('import-history');
    button.disabled = true;
    const status = $('history-status');
    try {
      // Required to be invoked directly within the click gesture.
      const granted = await chrome.permissions.request({ permissions: ['history'] });
      if (!granted) {
        status.textContent = 'Browser history permission was declined. No data imported.';
        return;
      }
      status.textContent = 'Looking for previously opened YouTube watch pages…';
      const response = await request({ type: 'HISTORY_IMPORT' });
      const report = response.result;
      status.textContent = 'Found ' + report.videoIds + ' YouTube video IDs and matched ' +
        report.matchedCandidates + ' locally collected candidates.' +
        (report.reachedLimit ? ' Search hit the 20,000-page cap.' : '');
      await refresh();
    } catch (error) {
      showError(error);
      status.textContent = 'Import unsuccessful; no other browser history is stored.';
    } finally {
      button.disabled = false;
    }
  });
  $('open-subs').addEventListener('click', () => open('https://www.youtube.com/feed/subscriptions'));
  $('open-likes').addEventListener('click', () => open('https://www.youtube.com/playlist?list=LL'));
  $('export-data').addEventListener('click', async () => {
    try {
      // Full data is transferred to the popup only on demand, never on every
      // onChanged event or during a reset.
      const fullState = (await request({ type: 'GET_STATE' })).state;
      const blob = new Blob([JSON.stringify({
        exportedAt: new Date().toISOString(), state: fullState, settings
      }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'yt-recs-but-good-export.json';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    } catch (error) { showError(error); }
  });
  $('confirm-cancel').addEventListener('click', closeConfirmation);
  $('confirm-proceed').addEventListener('click', () => { void performDeletion(); });
  $('confirm-overlay').addEventListener('click', event => {
    if (event.target === $('confirm-overlay') && !resetting) closeConfirmation();
  });
  document.addEventListener('keydown', event => {
    if ($('confirm-overlay').hidden || resetting) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeConfirmation();
    } else if (event.key === 'Tab') {
      // Keep keyboard focus within the two dialog controls.
      const focused = document.activeElement;
      if (event.shiftKey && focused === $('confirm-cancel')) {
        event.preventDefault();
        $('confirm-proceed').focus();
      } else if (!event.shiftKey && focused === $('confirm-proceed')) {
        event.preventDefault();
        $('confirm-cancel').focus();
      }
    }
  });
  $('clear-candidates').addEventListener('click', () => openConfirmation('candidates'));
  $('reset-data').addEventListener('click', () => openConfirmation('all'));
  $('resume-collection').addEventListener('click', async () => {
    try {
      await request({ type: 'COLLECTION_RESUME' });
      $('reset-status').textContent = 'Collection resumed. Reload YouTube to gather fresh candidates.';
      await refresh();
    } catch (error) { showError(error); }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[HOME_KEY]) $('replace-home').checked = changes[HOME_KEY].newValue !== false;
    if (changes[API_SYNC_KEY]) renderSyncStatus(changes[API_SYNC_KEY].newValue);
    if (changes['yt-recs-state-v1'] || changes['yt-recs-collection-paused-v1']) scheduleRefresh();
  });
  await refresh();
}
initialize().catch(showError);
