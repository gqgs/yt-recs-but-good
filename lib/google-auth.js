// Brave-compatible Google OAuth using chrome.identity.launchWebAuthFlow.
// This client-side access-token flow uses an HTTPS chromiumapp.org redirect.
// No client secret or refresh token is included or persisted.
export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
export const TOKEN_KEY = 'yt-recs-google-access-token-session-v1';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const EXPIRY_MARGIN_MS = 60_000;
// An interactive window left open indefinitely must not leave API Sync stuck.
export const AUTH_TIMEOUT_MS = 120_000;

export function configuredGoogleClientId(manifest) {
  const id = String(manifest?.oauth2?.client_id || '').trim();
  if (!/^[a-zA-Z0-9-]+\.apps\.googleusercontent\.com$/.test(id) ||
      id.includes('REPLACE_WITH')) return '';
  return id;
}

export function googleRedirectUrl(identity) {
  const url = new URL(identity.getRedirectURL('oauth2'));
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.chromiumapp.org') ||
      url.pathname !== '/oauth2') {
    throw new Error('Unexpected extension OAuth redirect URL.');
  }
  return url.toString();
}

export function googleAuthorizationUrl({ clientId, redirectUrl, state, interactive }) {
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUrl);
  url.searchParams.set('response_type', 'token');
  url.searchParams.set('scope', GOOGLE_SCOPE);
  url.searchParams.set('state', state);
  if (!interactive) url.searchParams.set('prompt', 'none');
  return url.toString();
}

export function parseGoogleRedirect(responseUrl, redirectUrl, state) {
  if (!responseUrl) throw new Error('Google did not return an OAuth redirect.');
  const expected = new URL(redirectUrl);
  const actual = new URL(responseUrl);
  if (actual.origin !== expected.origin || actual.pathname !== expected.pathname)
    throw new Error('OAuth redirect did not match the extension redirect URI.');
  const params = new URLSearchParams(actual.hash.slice(1));
  // Check state before accepting any returned token.
  if (params.get('state') !== state) throw new Error('OAuth state mismatch.');
  if (params.has('error')) {
    const reason = String(params.get('error')).slice(0, 90);
    throw new Error('Google OAuth: ' + reason);
  }
  const token = params.get('access_token');
  const seconds = Number(params.get('expires_in'));
  if (!token || params.get('token_type')?.toLowerCase() !== 'bearer' ||
      !Number.isFinite(seconds) || seconds <= 60 || seconds > 86400)
    throw new Error('Google returned an invalid or expired access token.');
  return { token, expiresInSeconds: seconds };
}

export function generateOAuthState(random = crypto.getRandomValues.bind(crypto)) {
  return [...random(new Uint8Array(24))].map(n => n.toString(16).padStart(2, '0')).join('');
}

export async function getGoogleAccessToken({
  interactive = false,
  identity = chrome.identity,
  sessionStorage = chrome.storage.session,
  manifest = chrome.runtime.getManifest(),
  now = Date.now,
  createState = generateOAuthState,
  authTimeoutMs = AUTH_TIMEOUT_MS
} = {}) {
  const clientId = configuredGoogleClientId(manifest);
  if (!clientId) throw new Error(
    'Configure the Web application OAuth client ID in manifest.json (see README).');
  if (!interactive) {
    const existing = (await sessionStorage.get(TOKEN_KEY))[TOKEN_KEY];
    if (existing?.clientId === clientId &&
        existing.expiresAt > now() + EXPIRY_MARGIN_MS &&
        typeof existing.token === 'string') return existing.token;
  }
  const redirectUrl = googleRedirectUrl(identity);
  const state = createState();
  if (!/^[a-zA-Z0-9_-]{24,128}$/.test(state)) throw new Error('Invalid OAuth state.');
  // Start the browser auth UI immediately. Callers must invoke this on the
  // original user click; awaiting a storage write first can lose user activation.
  const authPromise = identity.launchWebAuthFlow({
    url: googleAuthorizationUrl({ clientId, redirectUrl, state, interactive }),
    interactive
  });
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(
      'Google authorization timed out. Check for an open Brave sign-in window, ' +
      'confirm the exact HTTPS redirect URI, and retry.'
    )), authTimeoutMs);
  });
  let responseUrl;
  try {
    responseUrl = await Promise.race([authPromise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
  const response = parseGoogleRedirect(responseUrl, redirectUrl, state);
  // Ephemeral session storage survives MV3 worker restarts, but not browser
  // restarts. Never use chrome.storage.local or expose the token to content scripts.
  await sessionStorage.set({ [TOKEN_KEY]: {
    token: response.token, clientId,
    expiresAt: now() + response.expiresInSeconds * 1000
  } });
  return response.token;
}

export async function clearGoogleAccessToken(sessionStorage = chrome.storage.session) {
  await sessionStorage.remove(TOKEN_KEY);
}
