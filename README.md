# yt-recs-but-good

**A local-first YouTube recommender that values the videos *you* like.**

YouTube's home feed often replays familiar content instead of helping you find new things worth watching. This experimental Chromium extension collects candidates as you browse YouTube, learns from your explicit feedback, and gives you a separate, inspectable recommendation feed.

This is an **MVP to test the hypothesis**, not a replacement for YouTube's entire recommendation infrastructure.

## Install (Chrome / Brave / Chromium)

1. Clone this repository: `git clone https://github.com/gqgs/yt-recs-but-good.git`
2. For the MVP PR, switch to `feat/extension-mvp` (until the PR is merged).
3. Open `chrome://extensions` or `brave://extensions` and enable **Developer mode**.
4. Click **Load unpacked**, selecting the repository's root directory (the one containing `manifest.json`).
5. Reload any already-open YouTube tabs so the content script can observe them.
6. Open **[Liked videos](https://www.youtube.com/playlist?list=LL)** and scroll if that playlist is available to your account. Visible cards are imported as positive examples.
7. Open **[Subscriptions](https://www.youtube.com/feed/subscriptions)**, scroll through recent uploads, then click the extension icon.

You can also start from scratch: use YouTube's normal **Like** button on videos you enjoy, or the extension's **Like** feedback button. Initially, a richer set of likes makes recommendations more meaningful.

**Expected behavior:** Use actual likes as explicit feedback when possible. A watched video is not automatically treated as liked; ignoring or skipping a video isn't automatically treated as dislike. If you don't like a recommendation, choose **Not for me**. Use **Seen** to hide something already watched elsewhere.

## What is implemented

- **No OAuth, API key, cloud service, or upload polling.** A Manifest V3 content script observes the YouTube pages you visit (home, search, subscriptions, related videos, channel pages and your liked playlist). Video titles, channel names, and upload-age text become candidates. There is no attempt to scrape unseen uploads.
- **Feedback captured as events.** Clicking YouTube's Like/Unlike button is recorded when the extension can confirm the button's changed pressed state. The extension also supports explicit local feedback. Subscriptions/unsubscriptions from the watch page are recorded on a best-effort basis.
- **Watch markers.** The extension records watches when playback starts, plus an approximate maximum playback position. A video merely appearing on screen does not count as watched.
- **Continuously updated preferences.** A preference profile is rebuilt from your current likes and dislikes, weighted by a configurable feedback half-life (30/90/365 days or nearly static). Earlier feedback decays; more recent feedback has greater influence.
- **Inspectability.** Recommendations include a short explanation, such as matched liked topics or subscribed channels.
- **Control over the feed.** Three ranking modes (For you / Explore / Recent), an exploration setting, a diversity setting, a cap of two recommendations per channel in the first selection pass, and a toggle for previously watched videos.
- **Private by default.** Video metadata, feedback, and event history are stored in `chrome.storage.local`. You can export a JSON snapshot or delete local data in the popup.

The **Like** button inside the extension updates its *own* model only. It does **not** click YouTube's Like button or modify your YouTube account.

## What isn't implemented

- No independent crawling of unseen videos. Candidate discovery is constrained by the YouTube pages you actually visit; event-driven feedback collection and independent candidate acquisition are separate problems.
- No reliable historical import of your entire Google account. Visiting the Liked videos playlist works only if your account exposes that playlist. Other browsers, devices, and old watches are not automatically synchronized.
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
2. Browse subscriptions and a few topic-related pages until 100–500 candidate videos are collected.
3. Review the top 20 in **For you**, **Explore**, and **Recent** modes.
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

The extension requests only `storage` permission and access to `https://www.youtube.com/*`. It does not send the history it collects to any server. It does not access your Google credentials. Exported JSON is sensitive because it contains viewing preferences; keep it private.

Recommending only from the observed feed may reinforce YouTube's own candidate-selection biases. The future independent discovery pipeline should use the same preference and ranking engine, with a broader source of recent videos.

This is an experiment, not a claim that the current model solves value-aligned recommendation. The guiding question is whether a small personal model with explicit feedback and user-controlled exploration can discover more worthwhile videos than the feed you normally see.

## License

MIT — see [LICENSE](LICENSE).
