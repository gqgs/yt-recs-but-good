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

## Optional Google API import

You can import your likes, subscriptions, and a bounded sample of subscribed-channel uploads **without manually scrolling**. This requires one-time Google OAuth configuration; ordinary browsing and Home replacement do not require it.

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable **YouTube Data API v3**.
2. Configure the Google OAuth consent screen (Google Auth Platform). Add your own Google account as a test user if the app is in testing mode.
3. Load the extension unpacked and copy its ID from `chrome://extensions` (or `brave://extensions`).
4. In Google Cloud, create an **OAuth client ID** of type **Chrome Extension**, using that exact extension ID.
5. Replace `REPLACE_WITH_OAUTH_CLIENT_ID.apps.googleusercontent.com` in `manifest.json` with your OAuth client ID. Do **not** paste a client secret (none is needed).
6. Reload the extension, open its popup, and select **Sync from YouTube API**. Approve the YouTube read-only permission.

The user-initiated sync uses `videos.list(myRating=like)`, `subscriptions.list(mine=true)`, `channels.list`, and `playlistItems.list`. It currently imports up to 1,000 recent likes, up to 2,000 subscriptions (40 pages × 50), and the 8 newest uploads from each of the first 200 subscribed channels. These limits keep the first experiment bounded. You can rerun the sync manually; **no background polling** runs.

The Google access token is handled by Chrome's Identity API; it is never written to extension storage or sent to a project server. Imported video metadata and preferences are stored locally. Feedback timestamps for historical imported likes use the import time because the API does not supply the original like timestamp; we do not fabricate historical dates.

Google authorization, consent screen configuration, API quota, or Brave-specific Identity behavior may prevent syncing. If so, the extension still works through browsing. A public release would require an appropriate OAuth app, verification where applicable, and review of YouTube API policies, including data-retention and refresh obligations.

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
- **No OAuth needed for browsing and no background polling.** A Manifest V3 content script observes the YouTube pages you visit (home, search, subscriptions, related videos, channel pages and your liked playlist). Video titles, channel names, and upload-age text become candidates. There is no attempt to scrape unseen uploads.
- **Feedback captured as events.** Clicking YouTube's Like/Unlike button is recorded when the extension can confirm the button's changed pressed state. The extension also supports explicit local feedback. Subscriptions/unsubscriptions from the watch page are recorded on a best-effort basis.
- **Watch markers.** The extension records watches when playback starts, plus an approximate maximum playback position. A video merely appearing on screen does not count as watched.
- **Continuously updated preferences.** A preference profile is rebuilt from your current likes and dislikes, weighted by a configurable feedback half-life (30/90/365 days or nearly static). Earlier feedback decays; more recent feedback has greater influence.
- **Inspectability.** Recommendations include an optional collapsed explanation, such as matched liked topics or subscribed channels.
- **Control over the feed.** Three ranking modes (For you / Explore / Recent), an exploration setting, a diversity setting, a direct-discovery-only source filter (on by default), a cap of two recommendations per channel in the first selection pass, and a toggle for previously opened videos.
- **Private by default.** Video metadata, feedback, and event history are stored in `chrome.storage.local`. You can export a JSON snapshot or delete local data in the popup.

The **Like** button inside the extension updates its *own* model only. It does **not** click YouTube's Like button or modify your YouTube account.

## What isn't implemented

- No general-purpose crawling of all videos. Without optional API sync, discovery remains limited to pages you visit; API sync adds a bounded sample of uploads from subscribed channels.
- API sync imports likes and subscriptions but not watch history. Browsing on other devices is not automatically captured, and one-time imported signals are not continually synchronized.
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

The extension requests `storage` and `identity`, plus access to `https://www.youtube.com/*` and `https://www.googleapis.com/*`. The `history` permission is **optional** and requested only after you click the history-import button. Only explicit API sync invokes Google OAuth; the normal recommender does not access Google credentials. It does not send browsing history to a project server. Exported JSON is sensitive because it contains viewing preferences; keep it private.

Recommending only from the observed feed may reinforce YouTube's own candidate-selection biases. The future independent discovery pipeline should use the same preference and ranking engine, with a broader source of recent videos.

This is an experiment, not a claim that the current model solves value-aligned recommendation. The guiding question is whether a small personal model with explicit feedback and user-controlled exploration can discover more worthwhile videos than the feed you normally see.

## License

MIT — see [LICENSE](LICENSE).
