// Native YouTube Home replacement. All ranking happens in the background worker;
// this content script only renders the results and forwards explicit feedback.
(() => {
  const HOME_KEY = 'yt-recs-home-enabled-v1';
  const SETTINGS_KEY = 'yt-recs-settings-v1';
  const HOME_SELECTOR = 'ytd-browse[page-subtype="home"]';
  const ROOT_ID = 'ytrbg-home';
  const MODES = { personalized: 'For you', explore: 'Explore', recent: 'Recent' };
  let enabled = true;
  let settings = { mode: 'personalized' };
  let root = null;
  let mountTimer = null;
  let requestId = 0;

  const onHome = () => location.pathname === '/';
  const node = (tag, className, label) => {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (label !== undefined) result.textContent = label;
    return result;
  };
  const button = (label, className, callback) => {
    const result = node('button', className, label);
    result.type = 'button';
    result.addEventListener('click', callback);
    return result;
  };
  const link = (label, url, className) => {
    const result = node('a', className, label);
    result.href = url;
    return result;
  };
  function send(message) {
    return chrome.runtime.sendMessage(message).then(response => {
      if (!response?.ok) throw new Error(response?.error || 'Extension unavailable');
      return response;
    });
  }
  function setEnabled(value) {
    // Persist so the popup and the Home page always agree.
    return chrome.storage.local.set({ [HOME_KEY]: Boolean(value) });
  }
  async function setMode(mode) {
    if (!Object.hasOwn(MODES, mode)) return;
    settings = { ...settings, mode };
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  }
  function cleanUp() {
    requestId++;
    root?.remove();
    root = null;
    document.documentElement.classList.remove('ytrbg-home-active');
  }
  function ensureRoot() {
    if (!onHome()) { if (root) cleanUp(); return false; }
    const browse = [...document.querySelectorAll(HOME_SELECTOR)].find(el =>
      !el.hidden && el.getAttribute('hidden') === null) || document.querySelector(HOME_SELECTOR);
    if (!browse) return false;
    if (root && root.parentElement !== browse) cleanUp();
    if (!root) {
      root = node('section', 'ytrbg-root');
      root.id = ROOT_ID;
      root.setAttribute('aria-label', 'yt-recs-but-good personalized YouTube homepage');
      // The normal YouTube feed remains intact immediately below this element.
      browse.insertBefore(root, browse.firstChild);
    }
    document.documentElement.classList.toggle('ytrbg-home-active', enabled);
    return true;
  }
  function scheduleMount() {
    if (mountTimer !== null) return;
    mountTimer = setTimeout(() => {
      mountTimer = null;
      const wasMounted = Boolean(root?.isConnected);
      if (ensureRoot() && !wasMounted) void refresh();
    }, 180);
  }
  function makeHeader() {
    const header = node('div', 'ytrbg-header');
    const left = node('div', 'ytrbg-heading');
    left.append(node('div', 'ytrbg-eyebrow', 'A DIFFERENT KIND OF HOME'),
      node('h1', '', 'Your feed, reconsidered.'),
      node('p', '', 'Based on your likes, not somebody else\'s engagement metrics.'));
    header.append(left, button('Show original YouTube', 'ytrbg-native', () => {
      setEnabled(false).catch(showError);
    }));
    return header;
  }
  function showError(error) {
    if (!root?.isConnected || !onHome()) return;
    const alert = root.querySelector('.ytrbg-error') || node('p', 'ytrbg-error');
    alert.setAttribute('role', 'alert');
    alert.textContent = String(error?.message || error);
    root.prepend(alert);
  }
  function renderDisabled() {
    if (!ensureRoot()) return;
    const bar = node('div', 'ytrbg-disabled');
    bar.append(node('span', '', 'YouTube\'s original recommendations are showing.'),
      button('Switch to yt-recs-but-good', 'ytrbg-primary', () => {
        setEnabled(true).catch(showError);
      }));
    root.replaceChildren(bar);
  }
  function makeTabs() {
    const tabs = node('div', 'ytrbg-tabs');
    tabs.setAttribute('role', 'group');
    tabs.setAttribute('aria-label', 'Recommendation strategy');
    for (const [mode, label] of Object.entries(MODES)) {
      const active = (settings.mode || 'personalized') === mode;
      const tab = button(label, active ? 'ytrbg-selected' : '', () => {
        setMode(mode).catch(showError);
      });
      tab.setAttribute('aria-pressed', String(active));
      tabs.append(tab);
    }
    return tabs;
  }
  async function mark(video, type, rating) {
    const data = type === 'MARK_SEEN' ? { type, id: video.id } :
      { type, id: video.id, rating, origin: 'home-feed' };
    await send(data);
    await refresh();
  }
  function card(video) {
    const el = node('article', 'ytrbg-card');
    const anchor = link('', video.url, 'ytrbg-thumbnail');
    anchor.setAttribute('aria-label', 'Watch ' + video.title);
    const img = node('img');
    img.src = video.thumbnail;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    anchor.append(img);
    const title = link(video.title, video.url, 'ytrbg-title');
    title.title = video.title;
    const meta = node('div', 'ytrbg-meta',
      [video.channel, video.publishedText].filter(Boolean).join(' · '));
    const reason = node('div', 'ytrbg-reason', video.reason);
    const actions = node('div', 'ytrbg-actions');
    actions.append(button('Seen', '', () => {
      mark(video, 'MARK_SEEN').catch(showError);
    }), button('Not for me', '', () => {
      mark(video, 'FEEDBACK', 'less').catch(showError);
    }));
    el.append(anchor, title, meta, reason, actions);
    return el;
  }
  function render({ recommendations, counts }) {
    if (!ensureRoot() || !enabled) return;
    const children = [makeHeader()];
    const toolbar = node('div', 'ytrbg-toolbar');
    toolbar.append(makeTabs(), node('div', 'ytrbg-stats',
      counts.likes + ' likes · ' + counts.unseen + ' unseen candidates'));
    children.push(toolbar);
    if (!recommendations.length) {
      const empty = node('section', 'ytrbg-empty');
      empty.append(node('h2', '', 'No recommendations yet'),
        node('p', '', 'Visit Subscriptions or Liked videos to collect candidates. This first version only discovers videos from pages you visit.'));
      const actions = node('div', 'ytrbg-empty-actions');
      actions.append(link('Browse subscriptions', '/feed/subscriptions', 'ytrbg-primary'),
        link('Open Liked videos', '/playlist?list=LL', 'ytrbg-secondary'));
      empty.append(actions);
      children.push(empty);
    } else {
      const grid = node('div', 'ytrbg-grid');
      for (const video of recommendations) grid.append(card(video));
      children.push(grid);
      const footer = node('p', 'ytrbg-footer',
        'Recommendations are local. Use YouTube\'s Like button on videos you enjoy; "Not for me" here trains only this extension.');
      children.push(footer);
    }
    root.replaceChildren(...children);
  }
  async function refresh() {
    if (!ensureRoot()) return;
    if (!enabled) { renderDisabled(); return; }
    const id = ++requestId;
    try {
      const response = await send({ type: 'GET_RECOMMENDATIONS' });
      if (id !== requestId || !enabled || !onHome()) return;
      render(response.result);
    } catch (error) {
      if (id === requestId) showError(error);
    }
  }

  async function initialize() {
    const values = await chrome.storage.local.get([HOME_KEY, SETTINGS_KEY]);
    enabled = values[HOME_KEY] !== false;
    if (values[SETTINGS_KEY] && typeof values[SETTINGS_KEY] === 'object')
      settings = { ...settings, ...values[SETTINGS_KEY] };
    ensureRoot();
    void refresh();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[HOME_KEY]) enabled = changes[HOME_KEY].newValue !== false;
      if (changes[SETTINGS_KEY])
        settings = { mode: 'personalized', ...(changes[SETTINGS_KEY].newValue || {}) };
      if (changes[HOME_KEY] || changes[SETTINGS_KEY] || changes['yt-recs-state-v1'])
        void refresh();
    });
    document.addEventListener('yt-navigate-finish', () => {
      if (!onHome()) cleanUp();
      else { scheduleMount(); void refresh(); }
    });
    window.addEventListener('popstate', scheduleMount);
    // YouTube uses client-side navigation and may replace the browse element.
    new MutationObserver(() => {
      if ((onHome() && !root?.isConnected) || (!onHome() && root)) scheduleMount();
    }).observe(document.documentElement, { childList: true, subtree: true });
    scheduleMount();
  }
  void initialize().catch(() => {});
})();
