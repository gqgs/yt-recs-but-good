// Shared by the Home content script and popup. Browsed videos store channel
// paths/URLs, while API imports store bare UC channel IDs.
(() => {
  const ORIGIN = 'https://www.youtube.com';
  function channelUrl(channelId) {
    if (typeof channelId !== 'string') return '';
    let value = channelId.trim();
    if (/^UC[A-Za-z0-9_-]{22}$/.test(value)) return ORIGIN + '/channel/' + value;
    if (value.startsWith('@')) value = '/' + value;
    if (!/^(?:https?:\/\/|\/(?!\/))/i.test(value)) return '';
    try {
      const url = new URL(value, ORIGIN);
      if (!['https:', 'http:'].includes(url.protocol) ||
          !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname) ||
          url.username || url.password || url.port) return '';
      const match = url.pathname.match(/^\/(?<channel>@[^/]+|channel\/UC[A-Za-z0-9_-]{22}|(?:c|user)\/[^/]+)(?:\/|$)/);
      if (!match) return '';
      const channel = match.groups.channel;
      const name = decodeURIComponent(channel.split('/').at(-1));
      if (/[\s/\\?#%\u0000-\u001f\u007f]/u.test(name)) return '';
      // Strip tracking, fragments and channel tabs. Never turn a stored value
      // into an off-site link, or guess a channel from its display name.
      return ORIGIN + '/' + channel;
    } catch {
      return '';
    }
  }
  globalThis.YTRBGChannelLink = Object.freeze({ channelUrl });
})();
