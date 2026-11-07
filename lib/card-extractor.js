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
    'a.yt-shorts-lockup-view-model__title',
    '.shortsLockupViewModelHostInlineMetadataTitle',
    '.shortsLockupViewModelHostMetadataTitle',
    'h3 a[href*="/watch"]', 'h3 a[href*="/shorts"]',
    'h3', '.yt-lockup-metadata-view-model__title',
    '#video-title', 'yt-formatted-string#video-title'
  ];
  // Modern YouTube cards use different nested view-models, often putting the
  // channel in the first metadata row instead of ytd-channel-name.
  const SHORTS_CONTAINERS = [
    'ytd-rich-grid-slim-media', 'ytd-reel-item-renderer',
    'ytd-reel-video-renderer', 'yt-shorts-lockup-view-model',
    'ytm-shorts-lockup-view-model', '.shortsLockupViewModelHost'
  ].join(', ');
  // Only explicit Shorts links or known Shorts-only containers classify a
  // video as a Short. Duration and aspect ratio are not reliable signals.
  function isShortsCard(card, id) {
    if (card.matches?.(SHORTS_CONTAINERS) || card.closest?.(SHORTS_CONTAINERS)) return true;
    const shorts = card.querySelectorAll?.('a[href*="/shorts/"]') || [];
    return [...shorts].some(anchor =>
      videoId(anchor.href || get(anchor, 'href')) === id);
  }
  const CHANNEL_SELECTORS = [
    'ytd-channel-name a', '#channel-name a', '#channel-name #text',
    'yt-content-metadata-view-model a[href^="/@"]',
    'yt-content-metadata-view-model a[href^="/channel/"]',
    'yt-content-metadata-view-model a[href^="/c/"]',
    '.yt-lockup-metadata-view-model__metadata a[href^="/@"]',
    '.yt-lockup-metadata-view-model__metadata a[href^="/channel/"]',
    '.yt-content-metadata-view-model__metadata-row:first-child a',
    '.yt-content-metadata-view-model__metadata-text a',
    '.yt-lockup-metadata-view-model__metadata a'
  ];

  function clean(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }
  function get(node, attribute) {
    return clean(node?.getAttribute?.(attribute));
  }
  function validTitle(value) {
    const title = clean(value);
    if (title.length < 4 || title.length > 240) return false;
    if (/^(watch|watch now|play|play video|upcoming|live|premiere|advertisement|sponsored|skip ads?|ad|video)$/i.test(title)) return false;
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
    const channelNode = CHANNEL_SELECTORS.map(selector => card.querySelector(selector))
      .find(element => element && clean(element.textContent) &&
        !/^(?:\d+[\s\d,.KM]*\s+views?|\d+\s+(?:days?|hours?|weeks?|months?|years?)\s+ago)$/i.test(clean(element.textContent)));
    const row = card.querySelector('.yt-content-metadata-view-model__metadata-row:first-child');
    const rowText = clean(row?.textContent);
    // Use the first metadata row only when it looks like a channel, rather than
    // a view-count or time label. Never guess a channel from the video title.
    const rowChannel = rowText && !/\b(?:views?|ago|watching|streamed)\b/i.test(rowText)
      ? rowText : '';
    const channel = clean(channelNode?.textContent ||
      card.querySelector('ytd-channel-name')?.textContent || rowChannel);
    const channelId = get(channelNode, 'href').split('?')[0];
    // YouTube renders metadata differently in classic ytd cards and newer
    // lockup/view-model cards. A row can contain both "1.2M views" and
    // "3 weeks ago"; extract each label rather than copying the entire row.
    // YouTube currently mixes classic ytd renderers and multiple generations
    // of lockup/view-model renderers. In particular, the newer camelCase and
    // "wiz" metadata classes were previously missed entirely.
    const metadataSelectors = [
      '#metadata-line span', '.inline-metadata-item',
      '.yt-content-metadata-view-model__metadata-row',
      '.yt-content-metadata-view-model__metadata-text',
      '.yt-content-metadata-view-model-wiz__metadata-row',
      '.yt-content-metadata-view-model-wiz__metadata-text',
      '.ytContentMetadataViewModelMetadataRow',
      '.ytContentMetadataViewModelMetadataText',
      '.yt-lockup-metadata-view-model__metadata',
      '.yt-lockup-metadata-view-model-wiz__metadata',
      '.ytLockupMetadataViewModelMetadata'
    ];
    const metadataNodes = [...card.querySelectorAll(metadataSelectors.join(', '))];
    // aria-label can contain the full "42 thousand views" when the visible
    // metadata is only "42K". Favor real, scoped metadata over the card title.
    const metadata = metadataNodes.flatMap(n => [
      get(n, 'aria-label'), get(n, 'title'), clean(n.textContent)
    ]).filter(Boolean);
    const firstMatch = regex => {
      for (const label of metadata) {
        const match = label.match(regex);
        if (match) return match[0];
      }
      return '';
    };
    const viewCountText = firstMatch(/\b(?:no|\d[\d,.]*\s*(?:[kmb]|thousand|million|billion)?)\s+views?\b/i);
    const publishedText = firstMatch(/\b(?:(?:streamed|premiered)\s+)?(?:\d+(?:[,.]\d+)?\s+(?:minute|hour|day|week|month|year)s?\s+ago|yesterday|today|just now)\b/i);
    const hasResume = Boolean(card.querySelector(
      'ytd-thumbnail-overlay-resume-playback-renderer, yt-thumbnail-overlay-progress-bar-view-model'));
    return { id, title, channel: channel.slice(0, 120), channelId,
      publishedText, viewCountText, hasResume, isShort: isShortsCard(card, id) };
  }
  globalThis.YTRBGCardExtractor = Object.freeze({ extractCard, validTitle, videoId, isSponsored });
})();
