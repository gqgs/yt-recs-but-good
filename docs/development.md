# Development and evaluation

[Back to README](../README.md)

## Run checks

No dependencies or build step are required. Tests need **Node.js 20+**. From
the repository root:

```sh
npm test
npm run check
```

`npm run check` runs JavaScript syntax checks and the test suite; CI uses Node.js
22. Load the repository root as an unpacked Chromium extension to try it.

[`lib/recommender.js`](../lib/recommender.js) is a pure JavaScript module with no
browser or network dependencies:

```js
import { rankVideos } from './lib/recommender.js';
const recommendations = rankVideos(items, {
  mode: 'personalized', diversity: 55, exploration: 15
});
```

## Recommendation baseline

1. Convert liked/disliked video titles and channel names into token profiles.
2. Weight feedback by age and apply negative-feedback penalties.
3. Estimate affinity with cosine similarity, plus recency and subscription priors.
4. In **For you** and **Explore**, select by mode, novelty, and diversity while
   limiting channel repetition. Recent instead sorts eligible videos chronologically.
5. Filter watched/disliked videos by default and provide human-readable reasons.

Scores are relative heuristics, not calibrated probabilities. The project has
no transcripts, captions, video decoding, embedding model, external LLM, or
direct weight-space programming. A more complicated model needs evidence that
it improves recommendations.

Discovery is limited to visited pages and bounded API imports, not a general
crawler. YouTube markup and confirmed Like/Subscribe state detection can change.
Even with discovery-only filtering, the candidate pool can retain YouTube's
selection biases. Broader independent discovery requires a new acquisition
pipeline, not merely a different ranker.

## Evaluate recommendations

1. Collect or import at least 30 actual likes.
2. Gather 100–500 candidates through subscriptions, API sync, or topic pages.
3. Review the top 20 in For you, Explore, and Recent.
4. Record novelty, willingness to click, likes after watching, and irrelevance.
5. Check channel/topic saturation and already-watched items slipping through.

A useful follow-up is a blind comparison on the same candidates between this
baseline, embedding similarity, and a direct-weight-generation model. Use human
ratings as the primary evaluation, not an LLM judging its own output. There is
no quantitative claim that this experiment beats YouTube.

## Shorts classifier

[`lib/thumbnail-classifier.js`](../lib/thumbnail-classifier.js) uses local image
features rather than oEmbed or portrait CDN variants:

1. Manual format labels take precedence, and durations over 180 seconds bypass
   automatic Shorts exclusion. Explicit Shorts metadata can identify shorter
   videos without an image check.
2. For unclassified candidates, the service worker fetches the landscape
   `https://i.ytimg.com/vi/<video-id>/mqdefault.jpg` thumbnail and decodes it into
   a hidden **128×72 OffscreenCanvas**. It does not insert temporary page images
   or rely on content-script canvas access.
3. Grayscale edge and texture features detect paired boundaries near one-third
   and two-thirds width, a narrow central panel, and darker/less textured sides.
4. A match is hidden; normal or inconclusive results are eligible. Home holds
   unverified cards until checks finish, preserving chronology in Recent.

Checks run in batches of up to 12 candidates with four concurrent requests,
capped at 300 per 10 minutes. Each check needs at most one thumbnail request,
often served from browser cache, and no YouTube Data API quota. Pixels are
processed locally and never uploaded to a model or classifier service.

Successful classifications are cached for 30 days; inconclusive results for
six hours. The `three-panel-image-v2` version key invalidates older classifier
results without deleting videos, likes, viewing history, durations, or manual
labels. False positives and missed Shorts remain possible; see
[user corrections](usage.md#shorts-and-duration).

### Offline image benchmark

[`scripts/benchmark-thumbnails.html`](../scripts/benchmark-thumbnails.html) uses
the same classifier on local images in sibling `shorts/` and `normal/` folders.
From the repository root:

```sh
python -m http.server 8765 --bind 127.0.0.1
```

Open `http://127.0.0.1:8765/scripts/benchmark-thumbnails.html`, extract your labeled
archive locally, and select the parent directory of the two folders. The page
reports precision, recall, specificity, accuracy, false positives/negatives, and
per-image features. A threshold slider exposes the precision/recall tradeoff.
Images stay on your machine; no upload or API access is involved.

An earlier public-CDN smoke test on November 7, 2026 identified 5/5 reported
Shorts and 3/3 available normal controls; another normal thumbnail returned 404
and was excluded. It helped tune a false-positive threshold but was too small
and non-random to estimate accuracy. Use a labeled collection before treating
the heuristic as validated.

## Runtime safeguards

API helpers are dependency-injected for testing pagination, quota bounds, and
failures without Google access. [API limits and authorization](youtube-api.md)
describe the bounded refresh and recovery behavior.

Interactive authorization starts directly from the user-triggered Sync message
before storage writes, preserving browser user activation. Home refresh stays
non-interactive. Serialized storage writes and debounced Home/popup reactions
avoid redundant ranking and reset races; full exports are loaded only on demand.
