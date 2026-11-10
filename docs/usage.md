# Using the extension

[Back to README](../README.md)

## Feedback and discovery

The extension observes YouTube pages you visit: Home, search, subscriptions,
related videos, channel pages, and your liked playlist. It collects visible
video metadata, not unseen uploads. Recognizable sponsored slots and invalid
titles such as thumbnail overlays are excluded.

- YouTube's **Like / Unlike** actions are recorded when the extension can confirm
  a changed button state. Watch-page subscription changes are also best effort.
- The extension's **Like** and **Not for me** buttons train its local preference
  model only. They do not modify your YouTube account.
- Playback starting records a watch marker and approximate maximum playback
  position. Merely appearing on screen is not a watch; watching is not a like,
  and ignoring or skipping a video is not a dislike.
- Use **Seen** for videos you recognize as already watched elsewhere.

**Discovery sources only** is enabled by default. Candidates must have been
collected from subscriptions, channel pages, searches, or the optional API
import. Videos found only on Home or Related are excluded. The popup's **Only
candidates from subscriptions, channels and searches** setting disables this
restriction. An empty discovery pool is explained rather than silently filled
with Home suggestions.

## Feed controls

- **For you** ranks by preference, recency, and subscriptions.
- **Explore** gives more weight to novelty.
- **Recent** orders eligible videos by publication time, newest first, without
  personalization, diversity penalties, or per-channel caps.
- **Tune** controls exploration, diversity, feedback half-life (30, 90, 365 days,
  or nearly static), discovery sources, Shorts filtering, and repeat filtering.
- **Why this video?** expands a recommendation's explanation and format controls.
- **Show original YouTube** restores the original feed. The popup's **Replace
  YouTube Home** setting controls the default replacement.

For you and Explore limit channel repetition to two videos per channel in the
first selection pass. Preferences are rebuilt from current likes and dislikes,
with older feedback gradually carrying less weight according to the half-life.

### Scrolling and candidate counts

Home initially renders 12 recommendations and adds 12 as you approach the bottom.
A load-more button is available when automatic loading does not trigger.

Recent begins with a window of 100 eligible videos and expands by 100 as needed,
through scrolling or **Load next 100 recent candidates**. It works through the
existing local pool, not newly scraped content. For you and Explore use a bounded
shortlist and display **End of shortlist** when it is exhausted.

**Unseen in pool** counts stored videos not watched or dismissed. **Eligible in
Recent** is smaller after source, Shorts, and other filters. Neither count means
all videos are already classified or rendered. Format checks run lazily in
batches; automatic window expansion pauses while checks are pending, but the
explicit Load control remains available. Recent holds back older videos behind
unclassified newer ones to preserve chronology.

## Shorts and duration

**Hide Shorts and portrait clips (best effort)** is on by default. It uses known
Shorts metadata and a local thumbnail classifier. Videos with a known duration
over three minutes are protected from automatic Shorts exclusion, even when
their thumbnail is portrait-shaped. Manual **Mark as Short / Not a Short**
overrides take precedence.

The classifier is a heuristic, not an official Shorts identifier. Split-screen
thumbnails can be false positives; nonstandard Shorts thumbnails can be missed.
To correct a video, turn off Hide Shorts in **Tune**, then use **Why this video?
→ Not a Short**. Format corrections do not train the preference model.

Unclassified cards wait for their check before appearing, avoiding a brief
flash of Shorts. [Classifier details and benchmarking](development.md#shorts-classifier).

## Repeat filtering and browser history

By default, the feed excludes played videos, items marked Seen, liked videos,
and videos with YouTube resume-progress markers. **Include previously opened
and liked videos** overrides these filters.

For older visits, use **Import YouTube visits from browser history** in the popup.
The browser requests the optional `history` permission, which grants broader
history access. The import searches up to 20,000 matching YouTube watch-page
history entries and retains only video IDs and last-visit timestamps, never
unrelated browsing history. An opened page is not proof of a completed watch.

Browser history cannot recover watches from other devices, deleted history, or
incognito sessions. YouTube's progress marker may identify some other views but
is not a complete watch history. Continue using Seen for missed duplicates.

## Video metadata

Cards show channel names, view counts, relative upload ages, and duration badges
when available. Page collection reads native metadata and accessibility labels;
API import supplies exact timestamps and batched duration/statistics lookups.
Relative ages are recalculated from stored timestamps, and API statistics take
precedence over previously collected view-count labels.

Missing metadata is omitted, never invented. A missing channel displays **Channel
unavailable**. Live/upcoming or unavailable videos may lack duration or statistics.
View counts are not continuously refreshed. Revisit source pages, run an API
import, or use [Refresh details](troubleshooting.md#missing-duration-view-count-or-channel)
to enrich existing records without losing feedback.

## Privacy and data controls

Video metadata, preferences, and event history are stored in `chrome.storage.local`.
The extension requests `storage`, `identity`, and host access to YouTube, the
Google API, and YouTube's thumbnail CDN (`i.ytimg.com`). Thumbnail pixels are
processed locally, not sent to an external classifier. Browsing-based use needs
no OAuth. [Optional API authorization](youtube-api.md#authorization-and-security)
uses a short-lived session token, not persistent local storage.

- **Export local data** downloads a JSON snapshot containing viewing preferences
  and history. Keep it private. The full snapshot is transferred to the popup
  only on an explicit export.
- **Clear candidates only** removes the recommendation pool while preserving
  liked examples, subscriptions, and viewing history. It invalidates the last
  upload-refresh timestamp. Rebuild candidates by browsing or API import.
- **Delete all data** clears the local recommendation database and session token,
  then pauses collection and automatic refresh. It does not change your YouTube
  account. API use requires manual reauthorization afterward.
- **Resume collection** in the popup, or **Resume and browse subscriptions** in
  Home's empty state, resumes collection after a reset. Browsing while paused
  does not collect videos. Resuming lets visible cards be indexed again.

Both deletion controls first open an in-popup confirmation with Cancel and
Escape support. Data is removed only after the second confirmation button.
**Do not delete all data to repair missing metadata.** Try enrichment first;
clearing candidates is a more disruptive alternative when rebuilding the pool
is actually intended. See [troubleshooting](troubleshooting.md).
