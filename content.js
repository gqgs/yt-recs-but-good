// Works with the YouTube pages the user actually visits. No credentials, private
// network calls, background subscription polling, or hidden browsing.
(() => {
  const seenCards = new Set();
  let previousUrl = location.href;
  let scanTimer = null;
  let currentVideoId = null;
  let boundPlayer = null;
  let progressLastSent = 0;

  function send(message) {
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch { /* Reloaded/disabled extension context. */ }
  }

  function videoId(url) {
    try {
      const parsed = new URL(url, location.origin);
      if (parsed.pathname === '/watch') return parsed.searchParams.get('v') || '';
      if (parsed.pathname.startsWith('/shorts/')) return parsed.pathname.split('/')[2] || '';
    } catch { /* Invalid URL. */ }
    return '';
  }
  function pageSource() {
    const path = location.pathname;
    if (path === '/playlist' && new URLSearchParams(location.search).get('list') === 'LL') return 'liked';
    if (path.startsWith('/feed/subscriptions')) return 'subscriptions';
    if (path === '/') return 'home';
    if (path === '/results') return 'search';
    if (/^\/(?:@|channel\/|c\/|user\/)/.test(path)) return 'channel';
    if (path === '/watch') return 'related';
    return 'other';
  }
  function text(node) { return node?.textContent?.trim() || ''; }
  function href(node) { return node?.getAttribute('href') || ''; }

  const extractCard = globalThis.YTRBGCardExtractor.extractCard;

  function scan() {
    scanTimer = null;
    const source = pageSource();
    if (source === 'other') return;
    const cards = document.querySelectorAll(
      'ytd-rich-grid-media, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-playlist-video-renderer, yt-lockup-view-model, ytd-rich-grid-slim-media, ytd-reel-item-renderer, yt-shorts-lockup-view-model');
    const fresh = [];
    for (const card of cards) {
      if (fresh.length >= 120) break;
      const video = extractCard(card);
      if (!video) continue;
      const key = source + ':' + video.id + ':' + video.title + ':' + video.channel + ':' + video.publishedText + ':' + video.hasResume + ':' + video.viewCountText + ':' + video.isShort + ':' + video.durationSeconds;
      if (seenCards.has(key)) continue;
      seenCards.add(key);
      fresh.push(video);
    }
    if (fresh.length) send({ type: 'CANDIDATES', source, videos: fresh });
    attachPlayer();
  }
  function scheduleScan() {
    if (scanTimer !== null) return;
    scanTimer = setTimeout(scan, 600);
  }

  function watchMetadata(id) {
    const title = text(document.querySelector('ytd-watch-metadata h1, h1.ytd-watch-metadata')) ||
      document.title.replace(/ - YouTube$/, '');
    const channelNode = document.querySelector('#owner ytd-channel-name a, #upload-info ytd-channel-name a, ytd-video-owner-renderer a.yt-simple-endpoint');
    return { id, title, channel: text(channelNode), channelId: href(channelNode).split('?')[0] };
  }
  function recordPlay(player) {
    const id = videoId(location.href);
    if (!id || location.pathname !== '/watch' || player.paused) return;
    if (currentVideoId !== id) {
      currentVideoId = id;
      progressLastSent = 0;
      send({ type: 'WATCH', video: watchMetadata(id) });
    }
  }
  function attachPlayer() {
    if (location.pathname !== '/watch') return;
    const player = document.querySelector('video.html5-main-video');
    if (!player) return;
    if (player !== boundPlayer) {
      boundPlayer = player;
      player.addEventListener('play', () => {
        if (player === boundPlayer) recordPlay(player);
      });
      player.addEventListener('timeupdate', () => {
        if (player !== boundPlayer || player.paused || location.pathname !== '/watch') return;
        const now = Date.now();
        if (now - progressLastSent < 15000) return;
        recordPlay(player);
        progressLastSent = now;
        const id = videoId(location.href);
        if (id) send({ type: 'PROGRESS', id, seconds: player.currentTime });
      });
    }
    if (!player.paused) recordPlay(player);
  }

    function readLikeState() {
    const selector = '#segmented-like-button button[aria-pressed], like-button-view-model button[aria-pressed], ytd-toggle-button-renderer#segmented-like-button button[aria-pressed]';
    const button = document.querySelector(selector);
    if (!button) return null;
    const value = button.getAttribute('aria-pressed');
    return value === 'true' ? 'like' : value === 'false' ? 'clear' : null;
  }
  function subscribeState() {
    const button = document.querySelector('#subscribe-button button, ytd-subscribe-button-renderer button, yt-subscribe-button-view-model button');
    const value = (button?.getAttribute('aria-label') || text(button)).trim().toLowerCase();
    if (/^subscribed|^unsubscribe/.test(value)) return true;
    if (/^subscribe$|^subscribe to/.test(value)) return false;
    return null;
  }
  // Record confirmed *state changes*, not merely clicks.
  document.addEventListener('click', event => {
    const origin = event.target instanceof Element ? event.target : null;
    if (!origin || location.pathname !== '/watch') return;
    const like = origin.closest('#segmented-like-button, like-button-view-model, ytd-toggle-button-renderer#segmented-like-button');
    if (like) {
      const before = readLikeState();
      const id = videoId(location.href);
      for (const delay of [250, 1100]) setTimeout(() => {
        const after = readLikeState();
        if (id && before !== null && after !== null && before !== after) {
          send({ type: 'FEEDBACK', id, video: watchMetadata(id), rating: after, origin: 'youtube-like-button' });
        }
      }, delay);
      return;
    }
    const subscribe = origin.closest('#subscribe-button, ytd-subscribe-button-renderer, yt-subscribe-button-view-model');
    if (subscribe) {
      const before = subscribeState();
      const metadata = watchMetadata(videoId(location.href));
      setTimeout(() => {
        const after = subscribeState();
        if (before !== null && after !== null && before !== after && metadata.channel) {
          send({ type: 'SUBSCRIBE', channel: metadata.channel, channelId: metadata.channelId, subscribed: after });
        }
      }, 850);
    }
  }, true);

  function navigation() {
    if (location.href !== previousUrl) {
      previousUrl = location.href;
      seenCards.clear();
      currentVideoId = null;
    }
    scheduleScan();
  }
  // Reset clears storage but the in-page deduplication cache survives until
  // navigation. On explicit resume, clear that cache and re-index the current
  // page without requiring an extra browser reload.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const change = changes['yt-recs-collection-paused-v1'];
    if (!change || change.newValue !== false) return;
    seenCards.clear();
    scheduleScan();
  });
  document.addEventListener('yt-navigate-finish', navigation);
  window.addEventListener('popstate', navigation);
  new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true });
  navigation();
})();
