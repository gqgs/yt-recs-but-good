// Isolated-world content-script helper. Keep title extraction separate from video
// link extraction: thumbnail/overlay anchors often say only "Watch" or "24:17".
// No YouTube network calls or private DOM APIs.
(() => {
  const AD_ANCESTORS = [
    'ytd-ad-slot-renderer', 'yt-ad-slot-renderer', 'ytd-promoted-video-renderer',
    'ytd-promoted-sparkles-web-renderer', 'ytd-in-feed-ad-layout-renderer',
    'ytd-display-ad-renderer', 'ytd-search-pyv-renderer',
    'ytd-companion-slot-renderer', '[data-ad-slot]'
  ].join(', ');
  const AD_INSIDE = [
    'ytd-ad-slot-renderer', 'yt-ad-slot-renderer',
    'ytd-ad-badge-renderer', '.badge-style-type-ad',
    '[aria-label="Sponsored"]', '[aria-label="Ad"]',
    '.ytp-ad-text', '.ytp-ad-badge', 'ytd-promoted-sparkles-web-renderer'
  ].join(', ');
  const TITLE_SELECTORS = [
    'a#video-title-link', 'a#video-title',
    'a.yt-lockup-metadata-view-model__title',
    'a.yt-lockup-view-model__title',
    'h3 a[href*="/watch"]', 'h3 a[href*="/shorts"]',
    'h3', '.yt-lockup-metadata-view-model__title',
    '#video-title', 'yt-formatted-string#video-title'
  ];
  const CHANNEL_SELECTOR = 'ytd-channel-name a, #channel-name a, .yt-content-metadata-view-model__metadata-text a, .yt-lockup-metadata-view-model__metadata a';

  function clean(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }
  function get(node, attribute) {
    return clean(node?.getAttribute?.(attribute));
  }
  function validTitle(value) {
    const title = clean(value);
    if (title.length < 4 || title.length > 240) return false;
    if (/^(watch|watch now|play|play video|upcoming|advertisement|sponsored|skip ads?|ad|video)$/i.test(title)) return false;
    if (/^\d{1,3}:\d\d(?::\d\d)?(?=$|\s|[A-Z])/.test(title)) return false;
    return true;
  }
  function videoId(url) {
    try {
      const parsed = new URL(url, location.origin);
      if (parsed.hostname !== 'www.youtube.com' && parsed.hostname !== 'youtube.com' && parsed.hostname !== 'm.youtube.com')
        return '';
      if (parsed.pathname === '/watch') return parsed.searchParams.get('v') || '';
      if (parsed.pathname.startsWith('/shorts/')) return parsed.pathname.split('/')[2] || '';
    } catch { /* Ignore bad URLs. */ }
    return '';
  }
  function isSponsored(card) {
    return Boolean(card.closest?.(AD_ANCESTORS) || card.querySelector?.(AD_INSIDE));
  }
  function extractCard(card) {
    if (isSponsored(card)) return null;
    // Never use an arbitrary watch-link's textContent as the title. The first
    // matching link can be a thumbnail or an ad call-to-action.
    let title = '';
    let titleNode = null;
    for (const selector of TITLE_SELECTORS) {
      const candidate = card.querySelector(selector);
      if (!candidate) continue;
      const options = [get(candidate, 'title'), clean(candidate.textContent),
        get(candidate, 'aria-label')];
      const found = options.find(validTitle);
      if (found) { title = found; titleNode = candidate; break; }
    }
    if (!title) return null;
    const watchLink = card.querySelector(
      'a#video-title-link[href], a#video-title[href], a[href*="/watch?v="], a[href*="/shorts/"]'
    );
    const id = videoId(titleNode?.href || titleNode?.getAttribute?.('href') ||
      watchLink?.href || watchLink?.getAttribute?.('href'));
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
    const channelNode = card.querySelector(CHANNEL_SELECTOR);
    const channel = clean(channelNode?.textContent ||
      card.querySelector('ytd-channel-name')?.textContent ||
      card.querySelector('.yt-content-metadata-view-model__metadata-text')?.textContent);
    const channelId = get(channelNode, 'href').split('?')[0];
    const metadata = [...card.querySelectorAll(
      '#metadata-line span, .inline-metadata-item, .yt-content-metadata-view-model__metadata-text'
    )];
    const publishedText = clean(metadata.find(n =>
      /ago|yesterday|streamed/i.test(clean(n.textContent)))?.textContent);
    return { id, title, channel: channel.slice(0, 120), channelId, publishedText };
  }
  globalThis.YTRBGCardExtractor = Object.freeze({ extractCard, validTitle, videoId, isSponsored });
})();
