# YouTube API setup and refresh

[Back to README](../README.md)

API access is optional. It imports likes, subscriptions, and a bounded sample of
subscribed-channel uploads without scrolling. Browsing-based recommendations
and Home replacement work without it. The repository does not ship with anyone
else's OAuth client.

## Set up Google authorization

1. Open [Google Cloud Console](https://console.cloud.google.com/) and enable
   **YouTube Data API v3** for your project.
2. In [Google Auth Platform → Audience](https://console.cloud.google.com/auth/audience),
   choose **External** and add your Google account as a test user if the app is
   in Testing mode. Configure [Branding](https://console.cloud.google.com/auth/branding)
   and add `https://www.googleapis.com/auth/youtube.readonly` in
   [Data Access](https://console.cloud.google.com/auth/data-access).
3. Load the unpacked extension in `chrome://extensions` or `brave://extensions`.
   Copy its **Extension ID**.
4. In [Clients](https://console.cloud.google.com/auth/clients), create an OAuth
   client of type **Web application**, not Chrome Extension. Register this exact
   **Authorized redirect URI**, substituting your extension ID:

   ```text
   https://<extension-id>.chromiumapp.org/oauth2
   ```

   Include `/oauth2` with no trailing slash. The popup's **Copy redirect URI**
   button provides the exact value.
5. Replace `REPLACE_WITH_WEB_OAUTH_CLIENT_ID.apps.googleusercontent.com` in
   [`manifest.json`](../manifest.json) with the Web application client ID.
   **Do not embed its client secret.**
6. Reload the extension, then click **Sync from YouTube API** in its popup.
   Complete Google's authorization window and approve the read-only scope.

**Brave:** An older Chrome Extension OAuth client cannot be reused. The current
flow uses `chrome.identity.launchWebAuthFlow()` with an HTTPS callback to avoid
the `getAuthToken()` error: `Custom URI scheme is not supported on Chrome apps`.

## Full manual import

**Sync from YouTube API** imports up to:

- 1,000 recent likes through `videos.list(myRating=like)`.
- 2,000 subscriptions (40 pages of 50) through `subscriptions.list(mine=true)`.
- Eight newest uploads per channel from the first 200 subscriptions, through
  `channels.list` and `playlistItems.list`.

Supplemental `videos.list` batches retrieve Shorts metadata, durations, and view
counts. An enrichment failure is reported without discarding successfully
imported videos. Historical likes receive an import-time feedback timestamp
because the API does not reveal when they were originally liked.

Rerun full sync manually when needed. It does not import watch history or
continuously synchronize likes and views from other devices.

## Refreshing subscribed uploads

Once authorized, Home checks for new uploads when you open or return to it. It
refreshes the candidate pool, rather than just reranking old videos. There is
no background polling, alarm, or automatic navigation to Subscriptions.

The popup's **Keep recommendations fresh** controls provide:

- **Check for new uploads when opening YouTube Home**, on by default.
- A minimum interval of 15 or 30 minutes, **1 hour (default)**, 2, 6, or 24 hours.
- **Refresh uploads now** to bypass the interval. Home has **Refresh uploads** too.
- Status showing the last success, new candidate count, progress, or an error.

Each successful check advances through a rotating batch of up to 40 channels
from the first 200 subscriptions, collecting up to five recent uploads per
channel. Covering 200 channels takes about five successful checks, not one
large scan. Manual Refresh uploads triggers the next batch. Only previously
unseen video IDs count as new discoveries.

These bounded refreshes retrieve Shorts metadata and durations but omit view
statistics to conserve quota. View counts can come from browsing, full manual
import, or [Refresh details](troubleshooting.md#missing-duration-view-count-or-channel).

Automatic Home authorization is non-interactive: it uses an unexpired session
token or attempts silent Google authorization. If user interaction is needed,
Home shows **Authorize YouTube API** rather than opening a login dialog. Manual
refresh may request authorization. Until configured, browsing still works and
Home shows a setup message instead of claiming to refresh.

### Failures and recovery

Each API request has a 12-second deadline. After 150 seconds without progress,
an interrupted refresh becomes retryable. Automatic failures have a 15-minute
retry backoff; refresh and full sync share a single-flight guard to avoid
concurrent imports. Existing candidates, likes, and history survive failures.

Missing uploads playlists (`playlistNotFound`, HTTP 404) and inaccessible ones
(`playlistItemsNotAccessible`, HTTP 403) are skipped per channel. Status reports
the unavailable count and other channels continue importing. If every playlist
is unavailable, the refresh fails. API-wide authorization, quota, and unexpected
errors are not silently ignored. Individual unavailable playlists require no
cache deletion, new permission, or OAuth reconfiguration.

A full local-data reset pauses collection and refresh and clears the session
token. Resume collection, then authorize manually again. Clearing candidates
only invalidates the previous refresh timestamp.

See [troubleshooting](troubleshooting.md) for stalled refreshes or authorization.

## Authorization and security

The current client-only flow uses Google's implicit access-token response with
OAuth state validation, an extension-owned HTTPS redirect, and read-only scope.
The short-lived token and expiry live in `chrome.storage.session`, not persistent
`chrome.storage.local`. There is no client secret or refresh token in the
extension, and no OAuth token is sent to a project server. A browser restart or
expiry can require manual authorization again.

Google discourages the implicit flow for modern production applications. This
is a personal experiment. Before broad distribution, replace it with a
production-approved architecture, such as a supported authorization-code/PKCE
flow or trusted token exchange, and complete any required Google review. Review
YouTube API Services policies, including data-retention and refresh obligations.

Google consent configuration, quota, or browser behavior may still prevent sync;
browsing-based recommendations remain available. Never put access tokens, full
callback URLs, or client secrets in public issues.
