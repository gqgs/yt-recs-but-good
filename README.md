# yt-recs-but-good

Local-first YouTube recommendations shaped by your likes. This experimental
Chrome / Brave / Chromium extension collects videos as you browse and replaces
YouTube Home with a personal feed. You can switch back to the original anytime.

## Install

```sh
git clone https://github.com/gqgs/yt-recs-but-good.git
```

1. Open `chrome://extensions` or `brave://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the repository root containing `manifest.json`.
3. Reload any open YouTube tabs.

No dependencies, build step, or Google API setup needed for browsing-based use.
After updating, reload both the extension and YouTube.

## Get started

1. Open [Liked videos](https://www.youtube.com/playlist?list=LL) and scroll to seed
   your preferences, if the playlist is available to your account. You can also
   start fresh by liking videos as you watch.
2. Browse [Subscriptions](https://www.youtube.com/feed/subscriptions), channel
   pages, or searches to collect candidates.
3. Visit [YouTube Home](https://www.youtube.com/) and choose **For you**,
   **Explore**, or **Recent**. Open **Tune** to adjust the feed.

Use **Like**, **Not for me**, and **Seen** for explicit feedback. The extension's
Like button only changes its local model, not your YouTube account. Watching or
skipping a video does not count as liking or disliking it.

Shorts and previously opened or liked videos are hidden by default. Discovery
uses subscriptions, channels, and searches rather than Home/Related-only
suggestions. Use **Show original YouTube** or the popup's **Replace YouTube Home**
setting to switch back.

## Optional Google API import

To import likes and subscribed-channel uploads without scrolling, follow the
[YouTube API setup guide](docs/youtube-api.md). This requires your own Google
OAuth client and read-only authorization. Once authorized, Home can check for new
uploads when you visit, at most once an hour by default. There is no background polling.

## Privacy

Preferences and viewing history stay in your browser; nothing is sent to a
project server. You can export or delete local data in the popup. Keep exports
private, and avoid a full reset just to refresh missing metadata.
[Permissions and data controls](docs/usage.md#privacy-and-data-controls).

## Documentation

- [Feed controls, filtering, and local data](docs/usage.md)
- [YouTube API setup, refresh, and authorization](docs/youtube-api.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Development, ranking, and classifier benchmarks](docs/development.md)

## License

[MIT](LICENSE).
