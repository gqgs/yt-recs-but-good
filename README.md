# yt-recs-but-good

**A local-first YouTube recommender that values the videos *you* like.**

YouTube's home feed often replays familiar content instead of helping you find new things worth watching. This experimental Chromium extension collects candidates as you browse YouTube, learns from your explicit feedback, and replaces YouTube's original Home recommendations with a personalized, inspectable feed (while keeping the original available).

This is an **MVP to test the hypothesis**, not a replacement for YouTube's entire recommendation infrastructure.

## Install (Chrome / Brave / Chromium)

1. Clone this repository: `git clone https://github.com/gqgs/yt-recs-but-good.git`
2. For the MVP PR, switch to `feat/extension-mvp` (until the PR is merged).
3. Open `chrome://extensions` or `brave://extensions` and enable **Developer mode**.
4. Click **Load unpacked**, selecting the repository's root directory (the one containing `manifest.json`).
5. Reload any already-open YouTube tabs so the content script can observe them.
6. Open **[Liked videos](https://www.youtube.com/playlist?list=LL)** and scroll if that playlist is available to your account. Visible cards are imported as positive examples.
7. Open **[Subscriptions](https://www.youtube.com/feed/subscriptions)**, scroll to collect candidates, or use the optional API sync below.
8. Visit **[youtube.com](https://www.youtube.com/)** to see the new Home feed. Click **Show original YouTube** to restore the normal feed, or use the popup's **Replace YouTube Home** setting.

You can also start from scratch: use YouTube's normal **Like** button on videos you enjoy, or the extension's **Like** feedback button. Initially, a richer set of likes makes recommendations more meaningful.

**Expected behavior:** Use actual likes as explicit feedback when possible. A watched video is not automatically treated as liked; ignoring or skipping a video isn't automatically treated as dislike. If you don't like a recommendation, choose **Not for me**. Use **Seen** to hide something already watched elsewhere.

## Unavailable subscribed-channel uploads playlists

A subscribed channel's uploads playlist can be missing (YouTube API
`playlistNotFound`, HTTP 404) or inaccessible to the current authorization
(`playlistItemsNotAccessible`, HTTP 403). These are **per-channel** failures.
The extension now skips those specific playlists and continues importing
videos from the other subscribed channels rather than aborting the entire
refresh.

The popup's full-import status and the Home refresh status report how many
playlists were unavailable. A complete failure (all playlists unavailable)
still reports an error; API-wide authorization, quota, and other unexpected
errors remain failures and are **not** silently ignored. View and upload
metadata for successfully imported videos are preserved. No cache deletion,
new permission, or OAuth reconfiguration is needed to recover from an
individual unavailable playlist.

## Automatic candidate refresh (default: 1 hour)

The personalized YouTube Home now **checks for fresh uploads when you open or return
to the Home tab**. It refreshes the source pool, rather than just reranking old
candidates. It does not poll continuously, use background alarms, or navigate to
Subscriptions on your behalf.

In the extension popup, **Keep recommendations fresh** provides:

- **Check for new uploads when opening YouTube Home** — on by default.
- **Minimum time between successful checks** — 15 minutes, 30 minutes,
  **1 hour (default)**, 2 hours, 6 hours, or 24 hours.
- **Refresh uploads now** — explicitly bypasses the TTL.
- A status label showing the last successful refresh, new candidate count, or
  any authorization/error status. Home also has a **Refresh uploads** button.

**Prerequisite:** Automatic upload discovery uses the official YouTube Data API,
not the browser's existing signed-in page. To enable it, configure a Google
OAuth client ID as described below and complete the one-time **Sync from YouTube
API** authorization in the popup. The public repository intentionally does not
ship with somebody else's OAuth client. Until configured, the extension
continues to rank candidates gathered by browsing, and displays a useful setup
message rather than silently pretending to refresh.

Home-triggered authorization is always **non-interactive** and uses an unexpired
session token or an attempted silent Google authorization. If authorization has
expired or needs interaction, the extension shows **Authorize YouTube API** rather
than opening a login dialog. Manual refresh is an explicit user action and may
request authorization.

An automatic check fetches the subscriptions list and checks a **rotating batch
of up to 40 channels** from the first 200 subscriptions, collecting up to five
recent uploads per channel. Successful checks advance to the next batch, so
with 200 subscriptions and the default one-hour TTL the whole set is covered
over approximately five successful visits/checks, not in one fragile
long-running request. **Refresh uploads** explicitly triggers the next batch,
bypassing the TTL. This bounded pass skips extra view-statistics lookups to
conserve API quota; view counts can still come from normal browsing or a full
manual API import. Only previously unseen video IDs count as new discoveries.

The Home status reports how many channels have been processed during a scan.
Each YouTube API request has a **12-second deadline**; an unresponsive request
fails visibly instead of leaving the UI permanently on "Checking…". If Brave
terminates the Manifest V3 service worker mid-refresh, the stored status is
reported as interrupted after **150 seconds without progress**, and the
manual Refresh button becomes available again. Automatic checks retain a
**15-minute retry backoff** after a failed attempt and share a single-flight
guard with full API sync, preventing redundant concurrent requests. Existing
candidates, likes, and watch history are preserved on failure.

A full data reset pauses both collection and automatic refresh, clears the
short-lived session token, and requires manual reauthorization to use API sync
again. **Resume collection** re-enables collection; clearing only candidates
invalidates the previous refresh timestamp. No OAuth secrets or access tokens
are written to persistent local storage.

## Troubleshooting an upload refresh stuck on "Checking…"

If **Refresh uploads** stays on **Checking new subscribed uploads…**, the scan
may be slow, an API request may be unresponsive, or Brave may have stopped its
service worker. The extension now displays progress (e.g. `Checking subscribed
channels: 16/200`), bounds work to 40 channels, and times out API requests.
If status has received no progress for 150 seconds, the Home page reports
**Previous refresh interrupted** and enables **Refresh uploads** to retry.

There is no reason to delete your local data or reconfigure Google OAuth for
this issue. Reload the unpacked extension in `brave://extensions`, refresh
YouTube, and click **Refresh uploads** once. If it fails, note the displayed
API error (without any credentials) and check the extension service worker's
console in `brave://extensions`.

## Troubleshooting a stalled Google authorization

If **Sync from YouTube API** stays on **"Authorizing with your Google
account…"**, that is the OAuth stage: no likes or uploads have been imported
yet. Brave's `chrome.identity.launchWebAuthFlow()` opens a separate browser
authorization window and completes only when Google redirects to the registered
`https://<extension-id>.chromiumapp.org/oauth2` callback.

1. Look for a separate Google sign-in window behind Brave or on another desktop.
   Complete the consent screen there. If Google shows an error, open its **error
   details** and record the error name and description, not any tokens or full
   callback URL.
2. Confirm that the popup's **Copy redirect URI** matches the *Authorized
   redirect URI* on the **Web application** OAuth client **exactly**, including
   `/oauth2` without a trailing slash.
3. Confirm that `manifest.json` uses that same Web application client ID,
   reload the unpacked extension in `brave://extensions`, and verify your
   Google account is a test user under the app's Audience configuration.
4. If no window opens or Google's redirect never completes, the flow now times
   out after **two minutes** and displays a specific error. The popup also
   recognizes authorization states left behind if the MV3 service worker
   terminated, rather than disabling Sync forever. Close any leftover
   authorization window before retrying.

The extension starts the interactive identity call immediately from the
user-triggered Sync message, before waiting for storage writes. This avoids
losing the browser's user-activation context. Automatic homepage refresh remains
**non-interactive**. Never paste an access token, complete redirect URL, or
client secret into a public issue.

## Optional Google API import

You can import your likes, subscriptions, and a bounded sample of subscribed-channel uploads **without manually scrolling**. This requires one-time Google OAuth configuration; ordinary browsing and Home replacement do not require it.

1. Open [Google Cloud Console](https://console.cloud.google.com/) and enable **YouTube Data API v3** for your project.
2. Open [Google Auth Platform → Audience](https://console.cloud.google.com/auth/audience); choose **External** and add your Google account as a test user if the app is in Testing mode. Configure [Branding](https://console.cloud.google.com/auth/branding) and add the `https://www.googleapis.com/auth/youtube.readonly` scope in [Data Access](https://console.cloud.google.com/auth/data-access).
3. In `brave://extensions` (or `chrome://extensions`), enable Developer mode, load the unpacked extension, and copy its **Extension ID**.
4. In [Google Auth Platform → Clients](https://console.cloud.google.com/auth/clients), create a new OAuth client of type **Web application** (not Chrome Extension). Add the **Authorized redirect URI** below, replacing `<extension-id>` with the ID from step 3:

   ```text
   https://<extension-id>.chromiumapp.org/oauth2
   ```

   Register this URL **exactly**, including the `/oauth2` path (no trailing slash).
5. Replace `REPLACE_WITH_WEB_OAUTH_CLIENT_ID.apps.googleusercontent.com` in `manifest.json` with this new **Web application client ID**. Do **not** embed its client secret.
6. Reload the unpacked extension and click **Sync from YouTube API** in its popup. Approve the requested read-only scope. After this first authorization, Home can attempt silent TTL refreshes.

The user-initiated sync uses `videos.list(myRating=like)`, `subscriptions.list(mine=true)`, `channels.list`, and `playlistItems.list`. It currently imports up to 1,000 recent likes, up to 2,000 subscriptions (40 pages × 50), and the 8 newest uploads from each of the first 200 subscribed channels. These limits keep the first experiment bounded. You can rerun the full sync manually; automatic **homepage-triggered** upload refresh is separate and also uses no background polling.

Authorization uses `chrome.identity.launchWebAuthFlow()` with a registered HTTPS `chromiumapp.org` callback. Google returns a **short-lived access token**; only that token and its expiry are kept in `chrome.storage.session` (not persistent `chrome.storage.local`), and full local-data reset clears it. No OAuth token or client secret is sent to a project server. A silent authorization attempt may fail after expiry or browser restart, in which case use the manual **Sync from YouTube API** button to authorize again. Historical likes receive an import-time feedback timestamp because the API doesn't reveal the original like time.

**Brave compatibility:** Brave's `chrome.identity.getAuthToken()` produced Google's `Error 400: invalid_request — Custom URI scheme is not supported on Chrome apps`. This version uses `launchWebAuthFlow()` and an HTTPS callback instead. A previous **Chrome Extension** OAuth client cannot be reused; create the **Web application** client from step 4.

**Security trade-off:** The client-only fallback currently uses Google's OAuth implicit access-token response, which Google discourages for modern production applications. This is a local personal experiment: it uses OAuth state validation, an extension-owned HTTPS redirect, short-lived in-memory/session credentials and read-only scopes, but has **no refresh token**. Before publishing a broadly distributed extension, replace it with a production-approved authorization architecture (such as a correctly configured authorization-code/PKCE flow with suitable client support or a trusted token exchange) and complete any required Google review.

Google authorization, consent configuration, API quota, or browser behavior may still prevent syncing; browsing-based recommendations remain available. For broader distribution, review the YouTube API Services policies, including data-retention and refresh obligations.

## Hide YouTube Shorts (default: enabled)

The extension hides **confirmed YouTube Shorts** from its curated recommendations
by default. In the popup, open **Tune** and uncheck **Hide YouTube Shorts in
recommendations** to show them again immediately. This filter applies to both
the YouTube Home replacement and the popup's recommendation preview. It is
stored with your local preferences and does not delete candidates, likes, or
watch history.

Shorts classification uses actual YouTube `/shorts/<video-id>` links and
Shorts-specific YouTube card containers. **Video duration is not a Shorts
classifier**: ordinary short music performances, demos, and educational
videos remain eligible.

**Limitation:** YouTube Data API upload records don't expose a reliable
Shorts-type flag. API-only candidates with no Shorts evidence remain eligible
until the extension encounters the corresponding Shorts link or card in
YouTube's interface. This deliberately avoids hiding regular videos based on
unreliable duration or aspect-ratio guesses. This setting does not remove Shorts
from YouTube's own shelves, search results, or native pages.

## Discovery and repeat filtering

After testing the first curated Home feed, it became clear that ranking videos taken
straight from YouTube's Home and Related feeds largely reproduces YouTube's own
selection bias.

**Default: Discovery sources only.** The ranking now prioritizes candidates actually
collected from your **Subscriptions feed, direct channel pages, or searches**, including
those imported through the authorized API. Videos found *only* via YouTube Home or
Related suggestions are excluded by default. The popup's **Only candidates from
subscriptions, channels and searches** checkbox can turn this restriction off.
If the independent pool is empty, the Home page explains why and lets you opt back
into Home candidates instead of silently falling back.

**Repeat suppression.** By default, the extension excludes items that are known to
have been played since installation, manually marked Seen, liked, or identified by
YouTube's resume-progress overlay. For older views, you can optionally click
**Import YouTube visits from browser history** in the popup. The browser explicitly
requests the optional `history` permission. The import searches for YouTube
watch-page URLs (up to the latest 20,000 history search results) and retains only
their video IDs and last-visit timestamps, never unrelated browsing history.
A visit is treated as **previously opened**, not proof the full video was watched.
The option to **Include previously opened and liked videos** overrides the filters.

**Limits:** Chrome/Brave history does not include watches from other devices,
deleted history, or incognito sessions. YouTube's visual progress marker may help
identify some of these views, but it isn't a complete watch history. Users should
continue using the **Seen** button for manually recognized duplicates. For genuinely
new discovery beyond subscribed channels, we'll need a candidate acquisition system
independent of YouTube Home; changing only the ranker is insufficient.

**Channel metadata:** the Home card now displays the channel name under the title.
Newly observed cards use additional selectors for modern YouTube channel view-models.
Old cached entries with no recognizable metadata show "Channel unavailable" until
rediscovered or enriched via the optional API import; we don't invent a channel name.

## Cached metadata after upgrading

**Do not use Delete all data simply to refresh metadata.** That operation
removes useful likes and viewing history and pauses collection until resumed.

Previously collected video records may still have no view count or upload age.
Revisiting the Subscriptions or channel page where they were originally found
lets the extension merge newly captured metadata into the existing records.
**Clear candidates only** is an optional, more disruptive alternative that
preserves preferences but requires rebuilding the discovery pool.

A prior parser also interpreted `4 hours ago` and `30 minutes ago` as zero
days old, producing incorrect **Just now** labels. This has been fixed and
legacy affected records can be corrected at display time without deleting
the local dataset. Current view counts still depend on the source page/API
providing them.

## Video metadata

The curated Home cards show the channel name, **view count** and **relative upload age**
where YouTube provides that information, using a familiar line such as
`243K views · 3 weeks ago`.

- DOM-collected cards parse the view-count label and upload age separately from
  classic and modern YouTube metadata rows. The extractor recognizes YouTube's
  newer camelCase (`ytContentMetadataViewModelMetadataText`) and `wiz`
  variants, and reads accessibility labels when the visual label is abbreviated.
  This fixes the all-blank metadata reported after visiting subscriptions.
  After updating the extension, reload both the unpacked extension and the
  open YouTube tab, then visit/scroll subscriptions again to refresh existing
  candidate records.
- The optional Google API import retrieves exact publication timestamps and
  requests `videos.list(part=statistics)` for recently collected uploads in
  bounded batches (up to 50 video IDs per lookup).
- Relative upload ages are recalculated from stored timestamps. API statistics
  are preferred over previously collected, possibly stale view-count labels.
- Existing local records are retained. Previously collected videos may be
  missing view counts or upload ages until you revisit their source page or
  run a new opt-in API sync; missing metadata is omitted, not fabricated.
- Video view counts are not refreshed continuously in the background.

## Fix for offscreen, browser-blocking delete confirmations

The original extension used the native JavaScript `confirm()` API for destructive
actions. In Brave, that browser-modal dialog could appear partially offscreen
when invoked from the small extension popup, blocking other browser windows
until dismissed. This looked like a browser freeze even without any data
deletion occurring.

**Delete all data** and **Clear candidates only** now open a non-blocking,
keyboard-accessible confirmation *inside* the popup. The panel is bounded
to the popup viewport, supports Cancel and Escape, and never calls the
browser-native confirmation API. Clicking an action only opens the confirmation;
data is deleted after explicitly clicking its second action button.

If an old native confirmation is currently stuck, press **Escape** to cancel it
(or close/restart Brave if necessary), then reload the extension before trying
either action again.

## Safe data reset and cache management

A previous popup reset could cause a severe browser stall when large storage
snapshots were repeatedly read and re-ranked while the Home page and popup
responded to storage changes. The new implementation minimizes the data sent
to the popup and batches UI updates.

- **Clear candidates only:** The popup can delete the gathered recommendation
  pool without deleting your liked examples, subscriptions, visited-video IDs,
  or other viewing history. This is the recommended way to refresh collected
  candidates and metadata.
- **Delete all data:** This clears the entire local recommendation database and
  **pauses further collection** until you explicitly press **Resume collection**
  in the popup. That prevents YouTube Home from immediately repopulating the
  database as soon as it is emptied.
- **Resume collection:** After a full reset, collection remains paused. The
  YouTube Home empty state shows **Collection paused after reset** with a
  **Resume and browse subscriptions** action. The popup also shows a prominent
  **Resume collection** control. Resuming clears the current content script's
  deduplication cache so already-visible cards can be indexed again without
  waiting for another reload. The reset does not affect your YouTube account.
- **Export local data:** The large full-dataset snapshot is only transferred
  into the popup when you explicitly export it, not every time the UI updates.
- Popup and homepage storage reactions are debounced to avoid redundant
  recommendation recalculations. Full resets and candidate-pool resets are
  serialized with other storage writes.

**If Brave froze during an earlier reset:** restart Brave, disable the
extension temporarily if needed, and reload the updated unpacked extension.
Do not clear global Brave browsing data to repair extension state.

Note: the freeze itself was not reproduced in an interactive Brave session,
so this is a prevention-oriented fix based on the code paths rather than a
confirmed root cause.

## Homepage reset recovery and navigation controls

The YouTube Home page now explicitly distinguishes **collection paused after
reset** from an ordinary empty candidate pool. Users can resume collection and
open subscriptions directly from the empty state. Merely visiting the Likes or
Subscriptions pages while collection is paused will not add data.

The **Original YouTube** toggle is located in the controls row beneath the
headline, avoiding the YouTube masthead and top overlay that could partially
hide the old header-mounted button.

## Homepage quality-of-life fixes

- **Actual video titles:** candidate extraction now finds explicit title elements before considering the video's watch link. Thumbnail overlays like "Watch" or video-duration badges are not used as titles.
- **Advertisement filtering:** recognizable YouTube-sponsored slots/badges are excluded during collection. Previously saved candidates whose title was only "Watch", "Upcoming", or a duration are excluded from ranking.
- **Explanations on demand:** the explanation for a recommendation is behind a collapsed *Why this video?* control instead of being visible on every card.
- **Progressive feed:** the Home grid initially shows 12 recommendations and appends 12 more as you approach the bottom. A *Load more recommendations* button is available if automatic scrolling does not trigger.
- **Finite pool:** scrolling continues only while eligible locally discovered/imported videos remain; it does not scrape or fabricate additional content.

**After updating the extension:** reload it in `brave://extensions` or `chrome://extensions`, then reload YouTube. Some previously collected entries are deliberately hidden because they contained overlay/duration text instead of real titles; revisiting subscriptions or running the opt-in API import will refill the local pool with correctly titled videos. The fix does not silently delete your stored likes or watch-history events.

## What is implemented

- **Home-page replacement.** Your ranked feed is the default at youtube.com, showing channel, view count and upload age when available, with progressive loading and a switch to restore original YouTube. The popup controls preferences and optional import.
- **No OAuth needed for browsing and no background polling.** An authorized, TTL-guarded API refresh runs only when Home is visited or a refresh button is clicked. A Manifest V3 content script observes the YouTube pages you visit (home, search, subscriptions, related videos, channel pages and your liked playlist). Video titles, channel names, and upload-age text become candidates. There is no attempt to scrape unseen uploads.
- **Feedback captured as events.** Clicking YouTube's Like/Unlike button is recorded when the extension can confirm the button's changed pressed state. The extension also supports explicit local feedback. Subscriptions/unsubscriptions from the watch page are recorded on a best-effort basis.
- **Watch markers.** The extension records watches when playback starts, plus an approximate maximum playback position. A video merely appearing on screen does not count as watched.
- **Continuously updated preferences.** A preference profile is rebuilt from your current likes and dislikes, weighted by a configurable feedback half-life (30/90/365 days or nearly static). Earlier feedback decays; more recent feedback has greater influence.
- **Inspectability.** Recommendations include an optional collapsed explanation, such as matched liked topics or subscribed channels.
- **Control over the feed.** Three ranking modes (For you / Explore / Recent), an exploration setting, a diversity setting, a direct-discovery-only source filter (on by default), a cap of two recommendations per channel in the first selection pass, and a toggle for previously opened videos.
- **Private by default.** Video metadata, feedback, and event history are stored in `chrome.storage.local`. You can export a JSON snapshot or delete local data in the popup.

The **Like** button inside the extension updates its *own* model only. It does **not** click YouTube's Like button or modify your YouTube account.

## What isn't implemented

- No general-purpose crawling of all videos. Without optional API sync, discovery remains limited to pages you visit; API sync adds a bounded sample of uploads from subscribed channels.
- Manual API sync imports likes and subscriptions but not watch history. Home-triggered refresh obtains recent uploads after authorization, but does not continuously synchronize likes or views from other devices.
- No transcripts, captions, video decoding, embedding model, external LLM, or direct weight-space programming **yet**.
- No calibrated probabilities or quantitative claim that this system beats YouTube. Scores are relative heuristics, not probabilities.
- YouTube changes its page markup frequently. Like and subscribe button detection is **best effort**, and only confirmed state transitions are recorded.

## Initial algorithm

`lib/recommender.js` is deliberately a pure JavaScript module with no browser or network dependencies.

1. Convert liked and disliked video titles and channel names into a token-based preference profile.
2. Weight each example by how recently that feedback was provided. Apply negative-feedback penalties.
3. Predict affinity using cosine similarity, plus a modest recency and subscription prior.
4. Rerank the candidate set according to the selected mode, novelty, and diversity. Filter watched/disliked videos by default and limit channel repetition.
5. Show a human-readable reason for each suggestion.

The baseline is intentionally simple. It provides an objective to compare against later semantic embeddings, online training, contextual bandits, and a directly weight-space-programmed classifier. **We should not assume a more complicated model is better without measuring it.**

## How to validate the idea

A useful first trial:

1. Import or collect at least 30 actual likes.
2. Browse subscriptions, run optional API sync, or visit topic-related pages until 100–500 candidate videos are collected.
3. Review the top 20 on YouTube Home in **For you**, **Explore**, and **Recent** modes.
4. Record which recommendations are new, which you would click, which you liked after watching, and which were irrelevant.
5. Check for saturation by a single channel/topic and for already-watched items slipping through.

A strong follow-up experiment would blind-rank the same candidate set using this baseline, embedding similarity, and a direct-weight-generation model. User ratings—not an LLM judging its own output—should be the primary evaluation.

## Developer commands

No dependencies or build step required. Requires Node.js 20+ for tests.

```bash
npm test
npm run check
```

Load the checked-out root folder as an unpacked Chromium extension. The recommendation logic can be imported and tested without Chrome:

```js
import { rankVideos } from './lib/recommender.js';
const recommendations = rankVideos(items, { mode: 'personalized', diversity: 55, exploration: 15 });
```

## Privacy and limitations

The extension requests `storage` and `identity`, plus access to `https://www.youtube.com/*` and `https://www.googleapis.com/*`. The `history` permission is **optional** and requested only after you click the history-import button. Browsing-based recommendations don't require OAuth; optional homepage refresh may use an already-authorized session token or attempt a silent OAuth flow, while manual API sync may open Google consent. It does not send browsing history to a project server. Exported JSON is sensitive because it contains viewing preferences; keep it private.

Recommending only from the observed feed may reinforce YouTube's own candidate-selection biases. The future independent discovery pipeline should use the same preference and ranking engine, with a broader source of recent videos.

This is an experiment, not a claim that the current model solves value-aligned recommendation. The guiding question is whether a small personal model with explicit feedback and user-controlled exploration can discover more worthwhile videos than the feed you normally see.

## License

MIT — see [LICENSE](LICENSE).
