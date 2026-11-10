# Troubleshooting

[Back to README](../README.md)

After updating the checkout, reload the unpacked extension in
`chrome://extensions` or `brave://extensions`, then reload YouTube. Keep your
local data unless you actually intend to reset it.

## Upload refresh stays on Checking

Home reports progress such as `Checking subscribed channels: 16/200`. Work is
bounded to 40 channels per refresh, with a 12-second deadline per API request.
If the Manifest V3 service worker stops, 150 seconds without progress changes
the status to **Previous refresh interrupted** and re-enables Refresh uploads.

Reload the extension and YouTube, then click **Refresh uploads** once. If it
fails, record the displayed API error without credentials and inspect the
extension's service-worker console from the extensions page. Do not delete
local data or reconfigure OAuth just because a refresh was interrupted.

[Refresh limits and unavailable playlists](youtube-api.md#failures-and-recovery).

## Google authorization stalls

**Authorizing with your Google account…** means the OAuth stage is still running;
no likes or uploads have been imported yet.

1. Look for a separate Google sign-in window behind Brave or on another desktop.
   Complete consent there. If Google shows an error, record its name and
   description, not a token or full callback URL.
2. Compare the popup's **Copy redirect URI** with the Web application OAuth
   client's Authorized redirect URI. They must match exactly, including
   `/oauth2` and no trailing slash.
3. Confirm `manifest.json` uses the same Web application client ID, reload the
   extension, and verify your account is a test user in the app's Audience
   configuration when required.
4. Authorization times out after two minutes. Close any leftover authorization
   window before retrying. The popup also recovers authorization status left
   behind by a terminated service worker.

Automatic Home refresh never opens a login window; use **Sync from YouTube API**
for interactive authorization. [Full setup instructions](youtube-api.md#set-up-google-authorization).

## Missing duration, view count, or channel

Existing records can be enriched in place. Do not use Delete all data to repair
metadata: it removes likes and viewing history and pauses collection.

- Revisit and scroll the Subscriptions or channel page where videos were found,
  after reloading the extension and YouTube. This also repairs old title/channel
  extraction gaps. Invalid overlay-only titles are hidden until rediscovered.
- Use a full optional API import to retrieve available metadata in batches.
- **Refresh details** on Home looks up up to 50 already-collected videos missing
  duration or view counts with one `videos.list(part=contentDetails,statistics)`
  request. It reuses authorization, does not prompt for login, and does not
  revisit subscriptions or change likes, watched flags, manual Shorts labels,
  or ranking settings.

Home also attempts detail enrichment non-interactively for eligible videos.
Automatic attempts are throttled for one hour per video; clicking Refresh
details bypasses that cooldown. API errors appear beside the button. Import
status also records successful metadata batches, duration records, and failures
instead of silently dropping enrichment errors.

Live/upcoming streams may have no duration; unavailable/restricted videos may
have no view count. Missing values remain omitted. A missing channel appears as
**Channel unavailable**. Legacy upload ages incorrectly parsed as **Just now**
can be corrected at display time without deleting records.

## Recent has fewer results than the unseen count

The unseen count is not the number of display-ready recommendations. Discovery
sources, watched/liked status, invalid titles, and Shorts filtering reduce the
eligible pool. Recent loads an initial 100-video window, then expands by 100.
Pending format checks can temporarily hold back older videos to keep the feed
chronological. Use **Load next 100 recent candidates** when available.

If a normal video is hidden as a Short, disable Hide Shorts in **Tune**, find
the card, and choose **Why this video? → Not a Short**. Known durations over
three minutes protect long-form portrait videos from automatic exclusion.
No re-index or cache purge is needed after a classifier upgrade.

See [scrolling and counts](usage.md#scrolling-and-candidate-counts) and
[Shorts filtering](usage.md#shorts-and-duration).

## Empty feed after a reset

**Delete all data** pauses collection to prevent immediate repopulation. Use
**Resume collection** in the popup or **Resume and browse subscriptions** on
Home. Merely visiting Likes or Subscriptions while paused will not add videos.
API sync needs manual authorization again after a full reset.

An ordinary empty discovery pool is different: collect candidates from
subscriptions, channels, or searches, or explicitly turn off the discovery-only
filter. [Data controls](usage.md#privacy-and-data-controls).

## Popup confirmation or browser stall

Current delete controls use a non-blocking, keyboard-accessible confirmation
inside the popup. Cancel or Escape closes it without deleting anything.

If an older browser-native confirmation is stuck offscreen, press Escape to
cancel it, or restart Brave if necessary, then reload the extension. If Brave
froze during an earlier reset, restart it and temporarily disable the extension
if needed before reloading the updated checkout. Do not clear global browser
data to repair extension state.

Storage writes are serialized and UI updates debounced; the popup avoids full
dataset snapshots except during export. These safeguards address suspected
reset-stall paths, but the original freeze was not reproduced interactively,
so its root cause is not confirmed.
