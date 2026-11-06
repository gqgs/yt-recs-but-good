import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GOOGLE_SCOPE, TOKEN_KEY, googleAuthorizationUrl, googleRedirectUrl,
  configuredGoogleClientId, parseGoogleRedirect, getGoogleAccessToken
} from '../lib/google-auth.js';

const clientId = '123456789-abc.apps.googleusercontent.com';
const manifest = { oauth2: { client_id: clientId } };
const redirect = 'https://abcdefghijklmnop.chromiumapp.org/oauth2';
const NOW = 1000000000000;
const state = 'an-auth-state-that-is-long-enough';
const store = {};
const sessionStorage = {
  async get(k) { return { [k]: store[k] }; },
  async set(v) { Object.assign(store, v); },
  async remove(k) { delete store[k]; }
};
function identity({ error = null } = {}) {
  return {
    calls: [],
    getRedirectURL(path) { assert.equal(path, 'oauth2'); return redirect; },
    async launchWebAuthFlow({ url, interactive }) {
      this.calls.push({ url, interactive });
      const auth = new URL(url);
      const returnedState = auth.searchParams.get('state');
      return redirect + '#' + new URLSearchParams({
        ...(error ? { error } : { access_token: 'test-access-token', token_type: 'Bearer', expires_in: '3600' }),
        state: returnedState
      });
    }
  };
}
test('requires configured Google client without accepting placeholders', () => {
  assert.equal(configuredGoogleClientId(manifest), clientId);
  assert.equal(configuredGoogleClientId({ oauth2: { client_id: 'REPLACE_WITH_WEB_CLIENT_ID.apps.googleusercontent.com' } }), '');
});
test('authorization is HTTPS, scope-limited, and silent unless initiated by user', () => {
  const silent = new URL(googleAuthorizationUrl({ clientId, redirectUrl: redirect, state, interactive: false }));
  assert.equal(silent.origin, 'https://accounts.google.com');
  assert.equal(silent.searchParams.get('redirect_uri'), redirect);
  assert.equal(silent.searchParams.get('response_type'), 'token');
  assert.equal(silent.searchParams.get('scope'), GOOGLE_SCOPE);
  assert.equal(silent.searchParams.get('prompt'), 'none');
  assert.equal(silent.searchParams.get('state'), state);
  const manual = new URL(googleAuthorizationUrl({ clientId, redirectUrl: redirect, state, interactive: true }));
  assert.equal(manual.searchParams.has('prompt'), false);
});
test('rejects an unexpected redirect, state mismatch, or missing bearer token', () => {
  const valid = redirect + '#access_token=x&token_type=Bearer&expires_in=3600&state=' + state;
  assert.equal(parseGoogleRedirect(valid, redirect, state).token, 'x');
  assert.throws(() => parseGoogleRedirect('https://attacker.example/oauth2#access_token=x&state=' + state, redirect, state), /redirect/);
  assert.throws(() => parseGoogleRedirect(valid, redirect, 'incorrect-state'), /state mismatch/);
  assert.throws(() => parseGoogleRedirect(redirect + '#state=' + state, redirect, state), /invalid or expired/);
  assert.throws(() => parseGoogleRedirect(redirect + '#error=access_denied&state=' + state, redirect, state), /access_denied/);
});
test('uses session cache, reauthenticates silently when expired and never logs tokens', async () => {
  const id = identity();
  const args = { identity: id, sessionStorage, manifest, now: () => NOW, createState: () => state };
  const token = await getGoogleAccessToken({ ...args, interactive: true });
  assert.equal(token, 'test-access-token');
  assert.equal(store[TOKEN_KEY].token, token);
  assert.equal(store[TOKEN_KEY].expiresAt, NOW + 3600000);
  assert.equal(await getGoogleAccessToken({ ...args, interactive: false }), token);
  assert.equal(id.calls.length, 1);
  assert.equal(await getGoogleAccessToken({ ...args, interactive: false, now: () => NOW + 3700000 }), token);
  assert.equal(id.calls.length, 2);
  assert.equal(id.calls[1].interactive, false);
  assert.ok(!id.calls[1].url.includes('test-access-token'));
});
test('rejects malformed redirect generators', () => {
  assert.throws(() => googleRedirectUrl({ getRedirectURL: () => 'http://localhost:5555' }), /Unexpected/);
});
