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
  let refreshTimer = null;
  let staleStatusTimer = null;
  const PAGE_SIZE = 12;
  let visibleCount = 0;
  let rankedVideos = [];
  let gridElement = null;
  let loadButton = null;
  let pageStatus = null;
  let scrollObserver = null;
  let formatProbeInFlight = false;
  let formatProbeCooldownUntil = 0;
  let formatProbeRetryTimer = null;
  let pendingFormatCount = 0;
  // Received from the worker so cache validation follows classifier revisions.
  let currentShortsProbeSource = null;
  let detailsInFlight = false;
  let lastDetailsRequestAt = 0;
  let detailsCandidateIds = [];
  // Recent is a chronological inventory, not a fixed 100-result shortlist.
  // Expand only as the user scrolls; keep other recommendation modes bounded.
  const RECENT_CHUNK = 100;
  let recentWindow = RECENT_CHUNK;
  let recentTotal = 0;
  let recentHasMore = false;
  let recentLoading = false;


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
  function requestVideoDetails(force = false) {
    if (!enabled || !onHome() || detailsInFlight ||
        !force && Date.now() - lastDetailsRequestAt < 45_000) return;
    const ids = detailsCandidateIds.slice(0, 50);
    if (!ids.length) return;
    lastDetailsRequestAt = Date.now();
    detailsInFlight = true;
    send({ type: 'REFRESH_VIDEO_DETAILS', ids, force })
      .then(({ result }) => {
        if (result?.reason === 'upload-sync-running')
          lastDetailsRequestAt = 0;
      })
      .catch(showError)
      .finally(() => {
        detailsInFlight = false;
        if (enabled && onHome()) scheduleRefresh();
      });
  }
  function requestCandidateRefresh(force = false) {
    if (!enabled || !onHome()) return;
    send({ type: 'REFRESH_CANDIDATES', force, interactive: force })
      .then(({ result }) => {
        // If the user requested a forced update but setup is incomplete, the
        // worker persists a readable status rather than opening a prompt.
        if (force && result?.reason && result.reason !== 'fresh-or-throttled')
          scheduleRefresh();
      }).catch(showError);
  }
  function setEnabled(value) {
    // Persist so the popup and the Home page always agree.
    return chrome.storage.local.set({ [HOME_KEY]: Boolean(value) });
  }
  async function setMode(mode) {
    if (!Object.hasOwn(MODES, mode)) return;
    settings = { ...settings, mode };
    visibleCount = 0;
    recentWindow = RECENT_CHUNK;
    recentHasMore = false;
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  }
  function cleanUp() {
    clearTimeout(staleStatusTimer);
    staleStatusTimer = null;
    scrollObserver?.disconnect();
    scrollObserver = null;
    gridElement = null;
    visibleCount = 0;
    rankedVideos = [];
    recentWindow = RECENT_CHUNK;
    recentHasMore = false;
    recentTotal = 0;
    recentLoading = false;
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
    header.append(left);
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
    scrollObserver?.disconnect();
    scrollObserver = null;
    gridElement = null;
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
      type === 'MARK_SHORT' ? { type, id: video.id, isShort: rating } :
      { type, id: video.id, rating, origin: 'home-feed' };
    await send(data);
    await refresh();
  }
  function deferFormatProbe(ms) {
    formatProbeCooldownUntil = Date.now() + ms;
    clearTimeout(formatProbeRetryTimer);
    // One-shot retry, not recurring polling. The worker continues to own the
    // actual session request budget and cached classifications.
    formatProbeRetryTimer = setTimeout(() => {
      formatProbeRetryTimer = null;
      if (enabled && onHome()) scheduleRefresh();
    }, ms + 200);
  }

  function probeFormats(pending) {
    if (settings.hideShorts === false || !pending.length || !enabled || !onHome() ||
        formatProbeInFlight || Date.now() < formatProbeCooldownUntil) return;
    formatProbeInFlight = true;
    // Candidates are NOT rendered until this completes or returns unknown.
    // The worker serializes/caches probes and caps outbound requests.
    send({ type: 'PROBE_SHORTS_FORMAT', ids: pending.slice(0, 12).map(v => v.id) })
      .then(({ result }) => {
        if (result?.reason === 'rate-limited') {
          deferFormatProbe(10 * 60_000);
        } else if (!result?.started) {
          // A worker may already be checking these IDs; avoid rapid retries
          // and let its eventual storage update trigger the next refresh.
          deferFormatProbe(3000);
        }
      })
      .catch(() => {
        // Format checks are optional and must not prevent loading the page.
        // Keep uncertain videos withheld and retry on the next Home visit.
        deferFormatProbe(30_000);
      })
      .finally(() => {
        formatProbeInFlight = false;
        if (enabled && onHome()) scheduleRefresh();
      });
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
    const durationLabel = globalThis.YTRBGShortsVisibility.formatDuration(video.durationSeconds);
    if (durationLabel) {
      const duration = node('span', 'ytrbg-duration', durationLabel);
      duration.setAttribute('aria-label', 'Duration ' + durationLabel);
      anchor.append(duration);
    }
    const title = link(video.title, video.url, 'ytrbg-title');
    title.title = video.title;
    const channelUrl = globalThis.YTRBGChannelLink.channelUrl(video.channelId);
    const channel = video.channel && channelUrl
      ? link(video.channel, channelUrl, 'ytrbg-channel')
      : node('div', 'ytrbg-channel', video.channel || 'Channel unavailable');
    const meta = node('div', 'ytrbg-meta', video.metadataLine || '');
    const explain = node('details', 'ytrbg-why');
    const summary = node('summary', '', 'Why this video?');
    const explanation = node('p', '', video.reason || 'Selected by your local recommendation policy.');
    explain.append(summary, explanation);
    const check = video.shortsProbeDiagnostic;
    const formatStatus = node('p', 'ytrbg-format-status',
      check ? 'Format check: ' + (video.shortsFormat || 'unknown') +
        ' · ' + check.variant + (check.status ? ' · HTTP ' + check.status : '') +
        (check.score !== null && check.score !== undefined ? ' · score ' + check.score : '') +
        (check.reason && check.reason !== 'ok' ? ' · ' + check.reason : '') :
        'Format check: not yet completed');
    explain.append(formatStatus);
    // Manual format correction is not a dislike and does not affect the
    // preference profile. It can be reversed after toggling Hide Shorts off.
    const markedShort = video.shortOverride === undefined
      ? Boolean(video.isShort ||
        (video.shortsFormat === 'portrait' &&
         currentShortsProbeSource && video.shortsProbeSource === currentShortsProbeSource))
      : video.shortOverride;
    explain.append(button(markedShort ? 'Not a Short' : 'Mark as Short',
      'ytrbg-short-label', () => {
        mark(video, 'MARK_SHORT', !markedShort).catch(showError);
      }));
    const actions = node('div', 'ytrbg-actions');
    actions.append(button('Seen', '', () => {
      mark(video, 'MARK_SEEN').catch(showError);
    }), button('Not for me', '', () => {
      mark(video, 'FEEDBACK', 'less').catch(showError);
    }));
    el.append(anchor, title, channel, meta, actions, explain);
    return el;
  }

  function updatePagination() {
    const remaining = Math.max(0, rankedVideos.length - visibleCount);
    const moreToFetch = settings.mode === 'recent' && recentHasMore;
    // Do not auto-fetch the entire inventory while the current window is
    // waiting for Shorts classification. The manual button still works.
    const canAutoExpand = moreToFetch && pendingFormatCount === 0;
    if (pageStatus) {
      pageStatus.textContent = settings.mode === 'recent'
        ? 'Showing ' + visibleCount + ' of ' + rankedVideos.length +
          ' ready recommendations · ' + recentTotal + ' eligible in Recent' +
          (moreToFetch ? ' · More to load' :
            pendingFormatCount ? ' · Checking ' + pendingFormatCount + ' formats' :
            remaining ? '' : ' · All eligible loaded')
        : 'Showing ' + visibleCount + ' of ' + rankedVideos.length +
          ' shortlisted recommendations' + (remaining ? '' : ' · End of shortlist');
    }
    if (loadButton) {
      loadButton.hidden = remaining === 0 && !moreToFetch;
      loadButton.disabled = (remaining === 0 && !moreToFetch) || recentLoading;
      loadButton.textContent = remaining > 0 ? 'Load more recommendations'
        : 'Load next 100 recent candidates';
    }
    if (!remaining && !canAutoExpand) {
      scrollObserver?.disconnect();
      scrollObserver = null;
    }
  }

  async function loadMoreRecent() {
    if (recentLoading || !recentHasMore || !enabled || !onHome()) return;
    recentLoading = true;
    recentWindow = Math.min(4000, recentWindow + RECENT_CHUNK);
    updatePagination();
    try {
      await refresh();
      // After re-rendering, reveal the next batch if it has completed
      // classification; otherwise let the pending format queue progress.
      if (visibleCount < rankedVideos.length) appendPage();
    } finally {
      recentLoading = false;
      updatePagination();
    }
  }

  function appendPage() {
    if (!enabled || !onHome() || !gridElement?.isConnected) return;
    const next = Math.min(visibleCount + PAGE_SIZE, rankedVideos.length);
    if (next === visibleCount && settings.mode === 'recent' && recentHasMore) {
      void loadMoreRecent().catch(showError);
      return;
    }
    for (let i = visibleCount; i < next; i++) gridElement.append(card(rankedVideos[i]));
    visibleCount = next;
    updatePagination();
  }
  function render({ recommendations, counts, paused = false, refresh = {},
    detailStatus = {}, pendingFormats = [], heldBack = 0,
    recentTotal: totalEligible = null, recentHasMore: moreRecent = false }) {
    if (!ensureRoot() || !enabled) return;
    clearTimeout(staleStatusTimer);
    staleStatusTimer = null;
    // Update the status when an in-flight operation should have expired, even
    // if Brave killed the worker and no more storage events are emitted.
    if (refresh.phase === 'running') {
      const heartbeat = Number(refresh.lastProgressAt || refresh.lastAttemptAt || 0);
      if (heartbeat > 0) {
        const remaining = 150000 - (Date.now() - heartbeat);
        staleStatusTimer = setTimeout(() => {
          staleStatusTimer = null;
          scheduleRefresh();
        }, Math.max(500, remaining + 500));
      }
    }
    scrollObserver?.disconnect();
    scrollObserver = null;
    gridElement = null;
    rankedVideos = recommendations;
    recentTotal = Number.isInteger(totalEligible) ? totalEligible : 0;
    recentHasMore = settings.mode === 'recent' && moreRecent;
    const outsideWindow = settings.mode === 'recent'
      ? Math.max(0, recentTotal - recentWindow) : 0;
    pendingFormatCount = pendingFormats.length;
    const checkingPaused = pendingFormatCount && Date.now() < formatProbeCooldownUntil;
    const targetCount = Math.min(
      Math.max(PAGE_SIZE, visibleCount), rankedVideos.length);
    visibleCount = 0;
    const children = [makeHeader()];
    const toolbar = node('div', 'ytrbg-toolbar');
    const controls = node('div', 'ytrbg-controls');
    controls.append(makeTabs(), button('Original YouTube', 'ytrbg-native', () => {
      setEnabled(false).catch(showError);
    }));
    const sync = node('div', 'ytrbg-sync');
    const refreshButton = button('Refresh uploads', 'ytrbg-refresh-button', () => requestCandidateRefresh(true));
    refreshButton.disabled = paused || refresh.phase === 'running';
    refreshButton.title = 'Check new uploads from subscribed channels (requires YouTube API authorization)';
    const status = node('span', 'ytrbg-refresh-status', refresh.label || 'No upload refresh yet');
    status.title = refresh.message || status.textContent;
    status.setAttribute('role', 'status');
    const detailsButton = button('Refresh details', 'ytrbg-refresh-button', () =>
      requestVideoDetails(true));
    detailsButton.disabled = paused || detailStatus.phase === 'running';
    detailsButton.title = 'Refresh durations and view counts for already-collected videos';
    const detailLabel = detailStatus.phase === 'error'
      ? 'Details failed · ' + String(detailStatus.message || 'API error').slice(0, 65)
      : detailStatus.phase === 'running'
      ? 'Fetching video details…'
      : detailStatus.phase === 'ready'
      ? (detailStatus.durationUpdates || 0) + ' durations · ' +
        (detailStatus.viewUpdates || 0) + ' view counts updated'
      : '';
    const detailText = node('span', 'ytrbg-detail-status', detailLabel);
    detailText.title = detailStatus.message || '';
    detailText.setAttribute('role', 'status');
    sync.append(refreshButton, status, detailsButton, detailText);
    toolbar.append(controls, sync);
    toolbar.append(node('div', 'ytrbg-stats',
      counts.likes + ' likes · ' + counts.unseen + ' unseen in pool · ' +
      (settings.mode === 'recent' ? recentTotal + ' eligible in Recent · ' : '') +
      (outsideWindow ? outsideWindow + ' outside loaded window · ' : '') +
      (settings.discoveryOnly !== false ? 'Discovery sources only' : 'All sources') +
      (pendingFormatCount ? ' · ' + pendingFormatCount + ' checking format in current window' : '') +
      (heldBack ? ' · ' + heldBack + ' older uploads awaiting newer checks' : '')));
    children.push(toolbar);
    if (!recommendations.length) {
      const empty = node('section', 'ytrbg-empty');
      empty.append(node('h2', '', paused ? 'Collection paused after reset' :
        pendingFormatCount ? (checkingPaused ? 'Format checks temporarily paused' :
          'Checking video formats') : 'No recommendations yet'),
        node('p', '', paused
          ? 'Your data was deleted successfully. Collection is still paused, so visiting Likes or Subscriptions cannot index videos. Resume collection to begin again.'
          : pendingFormatCount
          ? (checkingPaused
            ? 'Some formats have not been verified yet. The extension will retry automatically; unverified videos stay hidden rather than flashing on screen.'
            : 'Unclassified videos are held back until their format check completes. They will not briefly appear and disappear as Shorts are detected.')
          : settings.discoveryOnly !== false
          ? 'Discovery mode excludes candidates seen only on YouTube Home or Related. Visit subscriptions, channels, or searches to populate the independent candidate pool, or import subscriptions through the API.'
          : 'Collect more candidates by visiting subscriptions or performing an optional API import. Previously saved ads and broken titles are filtered.'));
      const actions = node('div', 'ytrbg-empty-actions');
      if (paused) {
        actions.append(button('Resume and browse subscriptions', 'ytrbg-primary', async () => {
          try {
            await send({ type: 'COLLECTION_RESUME' });
            location.assign('/feed/subscriptions');
          } catch (error) { showError(error); }
        }));
      } else {
        actions.append(link('Browse subscriptions', '/feed/subscriptions', 'ytrbg-primary'),
          link('Open Liked videos', '/playlist?list=LL', 'ytrbg-secondary'));
        if (settings.discoveryOnly !== false) {
          actions.append(button('Include Home candidates', 'ytrbg-secondary', () => {
            chrome.storage.local.set({ [SETTINGS_KEY]: { ...settings, discoveryOnly: false } })
              .catch(showError);
          }));
        }
      }
      empty.append(actions);
      children.push(empty);
    } else {
      gridElement = node('div', 'ytrbg-grid');
      children.push(gridElement);
      const pagination = node('div', 'ytrbg-pagination');
      pageStatus = node('p', 'ytrbg-page-status');
      loadButton = button('Load more recommendations', 'ytrbg-load-more', appendPage);
      const sentinel = node('div', 'ytrbg-scroll-sentinel');
      sentinel.setAttribute('aria-hidden', 'true');
      pagination.append(pageStatus, loadButton, sentinel);
      children.push(pagination);
      children.push(node('p', 'ytrbg-footer',
        'Recommendations are local. Like videos on YouTube to teach your preferences; "Not for me" here trains only this extension.' +
        (pendingFormatCount ? ' ' + pendingFormatCount + ' candidate formats are awaiting checks.' : '')));
    }
    root.replaceChildren(...children);
    // Run the checks only AFTER the page has been built without provisional
    // Shorts. Completing a check saves the format and refreshes this feed.
    probeFormats(pendingFormats);
    if (!recommendations.length) return;
    // Preserve the number of visible cards when feedback or candidates change.
    // This avoids jumping back to the first page after every local write.
    while (visibleCount < targetCount) appendPage();
    updatePagination();
    const sentinel = root.querySelector('.ytrbg-scroll-sentinel');
    if (sentinel && (visibleCount < rankedVideos.length ||
        (recentHasMore && pendingFormatCount === 0)) &&
        typeof IntersectionObserver !== 'undefined') {
      scrollObserver = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) appendPage();
      }, { rootMargin: '450px 0px' });
      scrollObserver.observe(sentinel);
    }
  }

  function scheduleRefresh() {
    if (refreshTimer !== null) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (onHome()) void refresh();
    }, 300);
  }
  async function refresh() {
    if (!ensureRoot()) return;
    if (!enabled) { renderDisabled(); return; }
    const id = ++requestId;
    try {
      const response = await send({ type: 'GET_RECOMMENDATIONS',
        recentLimit: settings.mode === 'recent' ? recentWindow : undefined });
      if (id !== requestId || !enabled || !onHome()) return;
      currentShortsProbeSource = response.result.shortsProbeSource || null;
      const { ready, pending, heldBack } = globalThis.YTRBGShortsVisibility.splitCandidates(
        response.result.recommendations, settings.hideShorts !== false,
        Date.now(), settings.mode, currentShortsProbeSource);
      detailsCandidateIds = response.result.detailCandidates || [];
      render({ ...response.result, recommendations: ready, pendingFormats: pending,
        heldBack });
      // Enrich cached API-only items, including portrait videos currently
      // withheld by the Shorts heuristic but actually long-form.
      requestVideoDetails(false);
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
    requestCandidateRefresh(false);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[HOME_KEY]) {
        enabled = changes[HOME_KEY].newValue !== false;
        if (enabled) requestCandidateRefresh(false);
      }
      if (changes[SETTINGS_KEY]) {
        const next = { mode: 'personalized', ...(changes[SETTINGS_KEY].newValue || {}) };
        if (next.mode !== settings.mode) {
          visibleCount = 0;
          recentWindow = RECENT_CHUNK;
        }
        settings = next;
      }
      // Retry a detail lookup immediately after an upload import finishes;
      // the earlier attempt may have been postponed to avoid overlapping APIs.
      const refreshChange = changes['yt-recs-candidate-refresh-v1'];
      if (refreshChange?.newValue?.phase &&
          refreshChange.newValue.phase !== 'running')
        lastDetailsRequestAt = 0;
      if (changes[HOME_KEY] || changes[SETTINGS_KEY] ||
          changes['yt-recs-state-v1'] || changes['yt-recs-collection-paused-v1'] ||
          refreshChange || changes['yt-recs-video-details-status-v1'])
        scheduleRefresh();
    });
    document.addEventListener('yt-navigate-finish', () => {
      if (!onHome()) cleanUp();
      else { scheduleMount(); void refresh(); requestCandidateRefresh(false); }
    });
    window.addEventListener('popstate', scheduleMount);
    // Revisiting a tab left open for hours is effectively another Home visit.
    // This does not set a periodic timer or poll while the page stays hidden.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && onHome() && enabled) {
        requestCandidateRefresh(false);
        scheduleRefresh();
      }
    });
    // YouTube uses client-side navigation and may replace the browse element.
    new MutationObserver(() => {
      if ((onHome() && !root?.isConnected) || (!onHome() && root)) scheduleMount();
    }).observe(document.documentElement, { childList: true, subtree: true });
    scheduleMount();
  }
  void initialize().catch(() => {});
})();
