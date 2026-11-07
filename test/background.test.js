import test from 'node:test';
import assert from 'node:assert/strict';

const VID_A = 'abcdefghijk';
const VID_B = 'lmnopqrstuv';
const CHANNEL = 'UC' + 'z'.repeat(22);
const state = {};
const session = {};
let onMessage;
let oauthConfigured = false;
let authGranted = false;
const identityCalls = [];
let apiCalls = 0;
let failVideoDetails = false;
const oldChrome = globalThis.chrome;
const oldFetch = globalThis.fetch;
const oldBitmap = globalThis.createImageBitmap;
const oldCanvas = globalThis.OffscreenCanvas;
const SIZE = { width: 128, height: 72 };
function makeThumbnailPixels(portrait) {
  const { width: w, height: h } = SIZE;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const center = x >= w * .34 && x < w * .66;
    const seed = (x * 79 + y * 101 + x * y * 19) % 256;
    const side = (Math.floor(x / 8) * 39 + Math.floor(y / 8) * 17) % 120;
    const value = portrait && !center ? Math.round(side * .75) :
      (seed * .7 + 60) | 0;
    const pos = (y * w + x) * 4;
    data[pos] = data[pos + 1] = data[pos + 2] = value;
    data[pos + 3] = 255;
  }
  return { ...SIZE, data };
}
globalThis.createImageBitmap = async blob => ({ id: blob.id, close() {} });
globalThis.OffscreenCanvas = class {
  constructor(width, height) { this.width = width; this.height = height; }
  getContext() {
    return {
      drawImage: image => { this.imageId = image.id; },
      getImageData: () => makeThumbnailPixels(
        ['portrait123', 'uo5VU-KtUZk', 'hiddenlong1'].includes(this.imageId))
    };
  }
};
globalThis.chrome = {
  storage: { local: {
    async get(keys) {
      const result = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (state[key] !== undefined) result[key] = state[key];
      }
      return result;
    },
    async set(values) { Object.assign(state, values); },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
    }
  }, session: {
    async get(key) { return { [key]: session[key] }; },
    async set(values) { Object.assign(session, values); },
    async remove(key) { delete session[key]; }
  }},
  permissions: { async contains() { return true; } },
  history: {
    async search() { return [
      { url: 'https://www.youtube.com/watch?v=lmnopqrstuv', lastVisitTime: 2000 },
      { url: 'https://www.youtube.com/watch?v=lmnopqrstuv&list=PL', lastVisitTime: 3000 },
      { url: 'https://example.org/private', lastVisitTime: 4000 }
    ]; }
  },
  identity: {
    getRedirectURL(path) {
      assert.equal(path, 'oauth2');
      return 'https://abcdefghijklmno.chromiumapp.org/oauth2';
    },
    async launchWebAuthFlow({ interactive, url }) {
      identityCalls.push(interactive);
      const request = new URL(url);
      assert.equal(request.origin, 'https://accounts.google.com');
      assert.equal(request.searchParams.get('response_type'), 'token');
      assert.equal(request.searchParams.get('redirect_uri'),
        'https://abcdefghijklmno.chromiumapp.org/oauth2');
      if (!interactive && !authGranted) throw new Error('OAuth approval not granted');
      authGranted = true;
      return 'https://abcdefghijklmno.chromiumapp.org/oauth2#' +
        new URLSearchParams({
          access_token: 'testing-token', token_type: 'Bearer',
          expires_in: '3600', state: request.searchParams.get('state')
        }).toString();
    }
  },
  runtime: {
    getManifest() { return { oauth2: { client_id: oauthConfigured ?
      'test.apps.googleusercontent.com' : 'REPLACE_WITH_OAUTH_CLIENT_ID.apps.googleusercontent.com' } }; },
    onMessage: { addListener(fn) { onMessage = fn; } }
  }
};
// Simulate the official API with no external requests or credentials.
globalThis.fetch = async (url, options) => {
  const parsed = new URL(url);
  if (parsed.hostname === 'i.ytimg.com' &&
      parsed.pathname.endsWith('/mqdefault.jpg')) {
    const id = parsed.pathname.split('/')[2];
    return { ok: true, status: 200,
      headers: { get: () => 'image/jpeg' },
      blob: async () => ({ size: 16000, id }) };
  }
  if (parsed.hostname !== 'www.googleapis.com' ||
      options?.headers?.Authorization !== 'Bearer testing-token') {
    throw new Error('Unexpected network request during test');
  }
  apiCalls++;
  if (parsed.pathname.endsWith('/subscriptions')) return {
    ok: true, json: async () => ({ items: [{
      snippet: { resourceId: { channelId: CHANNEL }, title: 'Linux Lab' }
    }] })
  };
  if (parsed.pathname.endsWith('/channels')) return {
    ok: true, json: async () => ({ items: [{
      id: CHANNEL, contentDetails: { relatedPlaylists: { uploads: 'UU' + 'z'.repeat(22) } }
    }] })
  };
  if (parsed.pathname.endsWith('/playlistItems')) return {
    ok: true, json: async () => ({ items: [{
      snippet: { title: 'Brand-new systems talk', channelTitle: 'Linux Lab',
        videoOwnerChannelId: CHANNEL, publishedAt: '2026-11-06T00:00:00Z' },
      contentDetails: { videoId: 'newvid12345' }
    }] })
  };  if (parsed.pathname.endsWith('/videos')) {
    if (failVideoDetails) return {
      ok: false, status: 403, json: async () => ({
        error: { message: 'quotaExceeded', errors: [{ reason: 'quotaExceeded' }] }
      })
    };
    const ids = parsed.searchParams.get('id').split(',');
    return { ok: true, json: async () => ({
      items: ids.map(id => ({
        id, contentDetails: { duration: id === 'newvid12345' ? 'PT48M59S' : 'PT23M51S' },
        statistics: { viewCount: '56000' },
        snippet: { title: 'A systems talk' }
      }))
    }) };
  }

  throw new Error('Unexpected endpoint: ' + parsed.pathname);
};
await import('../background.js');

function message(request) {
  return new Promise(resolve => {
    const response = onMessage(request, {}, resolve);
    assert.equal(typeof response, 'boolean');
  });
}

test('Home and popup share hide-Shorts preference and preserve cached Shorts', async () => {
  const id = 'shortid1234';
  await message({ type: 'CANDIDATES', source: 'subscriptions', videos: [
    { id, title: 'A genuine YouTube Short', isShort: true, channel: 'Channel A' },
    { id: 'regular1234', title: 'A short but normal video', channel: 'Channel B' }
  ] });
  let home = await message({ type: 'GET_RECOMMENDATIONS' });
  let popup = await message({ type: 'GET_POPUP_DATA' });
  assert.deepEqual(home.result.recommendations.map(v => v.id), ['regular1234']);
  assert.deepEqual(popup.result.recommendations.map(v => v.id), ['regular1234']);
  await chrome.storage.local.set({ 'yt-recs-settings-v1': { hideShorts: false } });
  home = await message({ type: 'GET_RECOMMENDATIONS' });
  popup = await message({ type: 'GET_POPUP_DATA' });
  assert.equal(home.result.recommendations.some(v => v.id === id), true);
  assert.equal(popup.result.recommendations.some(v => v.id === id), true);
  await message({ type: 'CANDIDATES', source: 'subscriptions', videos: [
    { id, title: 'A genuine YouTube Short', channel: 'Channel A' }
  ] });
  const state = (await message({ type: 'GET_STATE' })).state;
  assert.equal(state.items[id].isShort, true);
  await message({ type: 'MARK_SEEN', id });
  await message({ type: 'MARK_SEEN', id: 'regular1234' });
  await chrome.storage.local.set({ 'yt-recs-settings-v1': {} });
});

test('records candidates, ranks on worker, and applies explicit feedback', async () => {
  await message({ type: 'CANDIDATES', source: 'liked', videos: [{
    id: VID_A, title: 'Linux performance kernel', channel: 'Linux Lab', channelId: CHANNEL
  }] });
  await message({ type: 'CANDIDATES', source: 'subscriptions', videos: [{
    id: VID_B, title: 'Linux kernel optimization', channel: 'Linux Lab', channelId: CHANNEL,
    publishedAt: '2026-11-06T00:00:00Z', viewCount: '267400'
  }] });
  const before = await message({ type: 'GET_RECOMMENDATIONS' });
  assert.equal(before.ok, true);
  assert.equal(before.result.counts.likes, 1);
  assert.equal(before.result.recommendations[0].id, VID_B);
  assert.match(before.result.recommendations[0].metadataLine, /267\.4K views|267K views/);
  const saved = await message({ type: 'GET_STATE' });
  assert.equal(saved.state.items[VID_B].publishedAt, Date.parse('2026-11-06T00:00:00Z'));
  assert.equal(saved.state.items[VID_B].subscribed, true);
  assert.equal(saved.state.items[VID_B].viewCount, 267400);
  await message({ type: 'MARK_SEEN', id: VID_B });
  const after = await message({ type: 'GET_RECOMMENDATIONS' });
  assert.equal(after.result.recommendations.length, 0);
});
test('local dislikes remove candidates and clearing dislikes restores them', async () => {
  await message({ type: 'CANDIDATES', source: 'subscriptions', videos: [{
    id: 'zyxwvutsrqp', title: 'Unfamiliar channel', channel: 'Unfamiliar'
  }] });
  await message({ type: 'FEEDBACK', id: 'zyxwvutsrqp', rating: 'less' });
  let result = await message({ type: 'GET_RECOMMENDATIONS' });
  assert.equal(result.result.recommendations.some(v => v.id === 'zyxwvutsrqp'), false);
  await message({ type: 'FEEDBACK', id: 'zyxwvutsrqp', rating: 'clear' });
  result = await message({ type: 'GET_RECOMMENDATIONS' });
  assert.equal(result.result.recommendations.some(v => v.id === 'zyxwvutsrqp'), true);
});
test('browser history import marks known candidates opened and retains only YouTube video IDs', async () => {
  await message({ type: 'CANDIDATES', source: 'subscriptions', videos: [{
    id: VID_B, title: 'Linux kernel optimization', channel: 'Linux Lab', channelId: CHANNEL
  }] });
  const imported = await message({ type: 'HISTORY_IMPORT' });
  assert.equal(imported.ok, true);
  assert.equal(imported.result.videoIds, 1);
  assert.equal(imported.result.matchedCandidates, 1);
  const saved = (await message({ type: 'GET_STATE' })).state;
  assert.equal(saved.items[VID_B].visitedAt, 3000);
  assert.equal(saved.visitedIds[VID_B], 3000);
  assert.equal(Object.keys(saved.visitedIds).length, 1);
  const result = await message({ type: 'GET_RECOMMENDATIONS' });
  assert.equal(result.result.recommendations.some(v => v.id === VID_B), false);
});
test('candidate provenance survives revisiting videos from YouTube Home', async () => {
  await message({ type: 'CANDIDATES', source: 'subscriptions', videos: [{
    id: 'aaabbbcccdd', title: 'Unseen embedded Linux talk', channel: 'Engineering Lab'
  }] });
  await message({ type: 'CANDIDATES', source: 'home', videos: [{
    id: 'aaabbbcccdd', title: 'Unseen embedded Linux talk', channel: ''
  }] });
  const result = await message({ type: 'GET_RECOMMENDATIONS' });
  const candidate = result.result.recommendations.find(v => v.id === 'aaabbbcccdd');
  assert.ok(candidate);
  assert.equal(candidate.channel, 'Engineering Lab');
  assert.deepEqual(candidate.sources, ['subscriptions', 'home']);
});
test('OAuth sync requires an explicitly configured application', async () => {
  const response = await message({ type: 'API_SYNC_START' });
  assert.equal(response.ok, false);
  assert.match(response.error, /OAuth.*client ID/);
});
test('popup summary avoids returning the entire local dataset', async () => {
  const payload = await message({ type: 'GET_POPUP_DATA' });
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.result.recommendations));
  assert.ok(payload.result.counts);
  assert.ok(payload.result.recommendations.length <= 12);
  assert.equal('items' in payload.result, false);
});
test('candidate-only purge preserves liked examples and history', async () => {
  const seed = 'aabbccdd123';
  const unseen = 'aabbccdd124';
  await message({ type: 'CANDIDATES', source: 'subscriptions', videos: [
    { id: seed, title: 'Loved physics lecture', channel: 'Physics' },
    { id: unseen, title: 'Another physics lecture', channel: 'Physics' }
  ] });
  await message({ type: 'FEEDBACK', id: seed, rating: 'like' });
  const purge = await message({ type: 'CLEAR_CANDIDATES' });
  assert.equal(purge.ok, true);
  assert.ok(purge.result.removed >= 2);
  const state = (await message({ type: 'GET_STATE' })).state;
  assert.equal(state.items[seed].feedback, 'like');
  assert.equal(state.items[seed].candidate, false);
  assert.equal(state.items[unseen], undefined);
  assert.ok(state.visitedIds[VID_B] > 0);
});
test('full reset pauses collection and cannot immediately reimport old candidates', async () => {
  const deleted = await message({ type: 'RESET' });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.result.paused, true);
  const after = (await message({ type: 'GET_STATE' })).state;
  assert.deepEqual(after.items, {});
  assert.deepEqual(after.visitedIds, {});
  const paused = await message({ type: 'CANDIDATES', source: 'subscriptions', videos: [
    { id: 'aabbccdd125', title: 'Should not return', channel: 'Video Test' }
  ] });
  assert.equal(paused.result.skipped, true);
  assert.equal(Object.keys((await message({ type: 'GET_STATE' })).state.items).length, 0);
  const summary = await message({ type: 'GET_POPUP_DATA' });
  assert.equal(summary.result.paused, true);
  assert.equal(summary.result.counts.candidates, 0);
  const home = await message({ type: 'GET_RECOMMENDATIONS' });
  assert.equal(home.ok, true);
  assert.equal(home.result.paused, true);
  assert.equal(home.result.recommendations.length, 0);
  const resumed = await message({ type: 'COLLECTION_RESUME' });
  assert.equal(resumed.result.paused, false);
  await message({ type: 'CANDIDATES', source: 'subscriptions', videos: [
    { id: 'aabbccdd125', title: 'Newly collected video', channel: 'Video Test' }
  ] });
  const state = (await message({ type: 'GET_STATE' })).state;
  assert.equal(state.items['aabbccdd125'].candidate, true);
  const resumedHome = await message({ type: 'GET_RECOMMENDATIONS' });
  assert.equal(resumedHome.result.paused, false);
  assert.equal(resumedHome.result.recommendations[0].id, 'aabbccdd125');
});
async function pollRefresh(phase) {
  for (let i = 0; i < 80; i++) {
    const response = await message({ type: 'GET_POPUP_DATA' });
    if (response.result.refresh.phase === phase) return response.result.refresh;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Candidate refresh did not reach ' + phase);
}

test('automatic refresh without an OAuth client reports setup requirements', async () => {
  const result = await message({ type: 'REFRESH_CANDIDATES' });
  assert.equal(result.result.started, false);
  assert.equal(result.result.reason, 'needs_setup');
  const status = await message({ type: 'GET_POPUP_DATA' });
  assert.equal(status.result.refresh.configured, false);
  assert.match(status.result.refresh.label, /Connect Google API/);
  assert.equal(identityCalls.length, 0);
});
test('automatic refresh never opens interactive authentication', async () => {
  oauthConfigured = true;
  authGranted = false;
  const result = await message({ type: 'REFRESH_CANDIDATES' });
  assert.equal(result.result.started, true);
  const refresh = await pollRefresh('needs_auth');
  assert.match(refresh.label, /Authorize YouTube API/);
  assert.deepEqual(identityCalls, [false]);
  const second = await message({ type: 'REFRESH_CANDIDATES' });
  assert.equal(second.result.started, false);
  assert.equal(second.result.reason, 'fresh-or-throttled');
});
test('manual refresh authorizes explicitly, adds new videos and applies 1h TTL', async () => {
  const triggered = await message({
    type: 'REFRESH_CANDIDATES', force: true, interactive: true
  });
  assert.equal(triggered.result.started, true);
  const status = await pollRefresh('ready');
  assert.equal(status.channels, 1);
  assert.equal(status.newVideos, 1);
  assert.ok(status.lastSuccessAt > 0);
  assert.equal(identityCalls.at(-1), true);
  assert.ok(apiCalls >= 3);
  const snapshot = await message({ type: 'GET_RECOMMENDATIONS' });
  assert.equal(snapshot.result.refresh.phase, 'ready');
  assert.equal(snapshot.result.recommendations.some(v => v.id === 'newvid12345'), true);
  const callsBefore = apiCalls;
  const again = await message({ type: 'REFRESH_CANDIDATES' });
  assert.equal(again.result.started, false);
  assert.equal(again.result.reason, 'fresh-or-throttled');
  assert.equal(apiCalls, callsBefore);
});
test('refreshing uploads carries duration and counts through worker storage and Home', async () => {
  const item = (await message({ type: 'GET_STATE' })).state.items['newvid12345'];
  assert.equal(item.durationSeconds, 2939);
  const home = await message({ type: 'GET_RECOMMENDATIONS' });
  const candidate = home.result.recommendations.find(v => v.id === 'newvid12345');
  assert.equal(candidate.durationSeconds, 2939);
  // Automatic upload refresh requests contentDetails but deliberately omits
  // statistics. A separate bounded detail lookup provides view counts.
  assert.equal(candidate.viewCount, null);
  assert.equal(home.result.refresh.metadata.failures, 0);
  assert.equal(home.result.refresh.metadata.durations, 1);
});
test('Home can enrich cached videos without revisiting subscribed channels', async () => {
  const id = 'duration123';
  await message({ type: 'CANDIDATES', source: 'subscriptions', videos: [
    { id, title: 'A vertical but long performance', channel: 'Music' }
  ] });
  let current = (await message({ type: 'GET_RECOMMENDATIONS' })).result;
  assert.equal(current.recommendations.find(v => v.id === id).durationSeconds, null);
  const beforeCalls = apiCalls;
  const result = await message({ type: 'REFRESH_VIDEO_DETAILS', ids: [id] });
  assert.equal(result.ok, true);
  assert.equal(result.result.durationUpdates, 1);
  assert.equal(result.result.viewUpdates, 1);
  assert.equal(apiCalls, beforeCalls + 1);
  current = (await message({ type: 'GET_RECOMMENDATIONS' })).result;
  assert.equal(current.recommendations.find(v => v.id === id).durationSeconds, 1431);
  assert.match(current.recommendations.find(v => v.id === id).metadataLine, /56K views/);
  assert.equal(current.detailStatus.phase, 'ready');
  const repeat = await message({ type: 'REFRESH_VIDEO_DETAILS', ids: [id] });
  assert.equal(repeat.result.reason, 'up-to-date');
  assert.equal(apiCalls, beforeCalls + 1);
  await message({ type: 'MARK_SEEN', id });
});
test('supplemental metadata lookup failure is visible and preserves preferences', async () => {
  const id = 'failure1234';
  await message({ type: 'CANDIDATES', source: 'subscriptions', videos: [
    { id, title: 'A normal science lecture', channel: 'Science' }
  ] });
  failVideoDetails = true;
  const request = await message({ type: 'REFRESH_VIDEO_DETAILS', ids: [id] });
  assert.equal(request.ok, true);
  assert.equal(request.result.started, false);
  assert.equal(request.result.reason, 'api-error');
  const current = await message({ type: 'GET_RECOMMENDATIONS' });
  assert.equal(current.result.detailStatus.phase, 'error');
  assert.match(current.result.detailStatus.message, /quotaExceeded/);
  const stored = (await message({ type: 'GET_STATE' })).state.items[id];
  assert.equal(stored.candidate, true);
  assert.equal(stored.durationSeconds, null);
  assert.ok(stored.detailsAttemptedAt);
  const automatic = await message({ type: 'REFRESH_VIDEO_DETAILS', ids: [id] });
  assert.equal(automatic.result.reason, 'up-to-date');
  failVideoDetails = false;
  const retry = await message({ type: 'REFRESH_VIDEO_DETAILS', ids: [id], force: true });
  assert.equal(retry.result.durationUpdates, 1);
  await message({ type: 'MARK_SEEN', id });
});
test('full reset clears last refresh and prevents automatic collection until resumed', async () => {
  const cleared = await message({ type: 'RESET' });
  assert.equal(cleared.ok, true);
  const skipped = await message({ type: 'REFRESH_CANDIDATES' });
  assert.equal(skipped.result.reason, 'paused');
  await message({ type: 'COLLECTION_RESUME' });
  const after = await message({ type: 'GET_POPUP_DATA' });
  assert.equal(after.result.refresh.lastSuccessAt, undefined);
  assert.deepEqual(session, {});
});
test.after(() => {
  globalThis.chrome = oldChrome;
  globalThis.fetch = oldFetch;
  globalThis.createImageBitmap = oldBitmap;
  globalThis.OffscreenCanvas = oldCanvas;
});

test('records view metadata discovered from page cards and prefers newer API statistics', async () => {
  const ID = 'abcefg12345';
  await message({ type: 'CANDIDATES', source: 'subscriptions', videos: [{
    id: ID, title: 'Performance talk', channel: 'Systems', 
    publishedText: '2 days ago', viewCountText: '1.2K views'
  }] });
  let state = (await message({ type: 'GET_STATE' })).state;
  assert.equal(state.items[ID].viewCountText, '1.2K views');
  assert.ok(state.items[ID].publishedAt > 0);
  await message({ type: 'CANDIDATES', source: 'subscriptions', videos: [{
    id: ID, title: 'Performance talk', channel: 'Systems',
    viewCount: '50234', publishedAt: '2025-05-01T00:00:00Z'
  }] });
  state = (await message({ type: 'GET_STATE' })).state;
  assert.equal(state.items[ID].viewCount, 50234);
  assert.equal(state.items[ID].publishedAt, Date.parse('2025-05-01T00:00:00Z'));
  const result = await message({ type: 'GET_RECOMMENDATIONS' });
  assert.match(result.result.recommendations.find(v => v.id === ID).metadataLine, /50\.2K views/);
});

test('an orphaned running refresh is reported as interrupted, enabling a retry', async () => {
  const oldTime = Date.now() - 200000;
  await chrome.storage.local.set({
    'yt-recs-candidate-refresh-v1': {
      phase: 'running', message: 'Checking subscribed uploads',
      lastAttemptAt: oldTime, lastProgressAt: oldTime
    }
  });
  const popup = await message({ type: 'GET_POPUP_DATA' });
  assert.equal(popup.result.refresh.phase, 'interrupted');
  assert.match(popup.result.refresh.label, /interrupted/i);
  const home = await message({ type: 'GET_RECOMMENDATIONS' });
  assert.equal(home.result.refresh.phase, 'interrupted');
});

test('manual Shorts labeling filters candidates without polluting preference feedback', async () => {
  const id = 'markshort34';
  await message({ type: 'CANDIDATES', source: 'subscriptions', videos: [
    { id, title: 'Video without API Shorts flag', channel: 'Clips' }
  ] });
  let view = await message({ type: 'GET_RECOMMENDATIONS' });
  assert.equal(view.result.recommendations.some(v => v.id === id), true);
  const changed = await message({ type: 'MARK_SHORT', id, isShort: true });
  assert.equal(changed.result.recorded, true);
  view = await message({ type: 'GET_RECOMMENDATIONS' });
  assert.equal(view.result.recommendations.some(v => v.id === id), false);
  let stored = (await message({ type: 'GET_STATE' })).state.items[id];
  assert.equal(stored.feedback, undefined);
  assert.equal(stored.shortOverride, true);
  await message({ type: 'CANDIDATES', source: 'subscriptions', videos: [{
    id, title: 'Video without API Shorts flag', isShort: false, channel: 'Clips'
  }] });
  stored = (await message({ type: 'GET_STATE' })).state.items[id];
  assert.equal(stored.shortOverride, true);
  await message({ type: 'MARK_SHORT', id, isShort: false });
  view = await message({ type: 'GET_RECOMMENDATIONS' });
  assert.equal(view.result.recommendations.some(v => v.id === id), true);
  await message({ type: 'MARK_SEEN', id });
});

test('on-demand CDN thumbnail probe filters API-only /watch URL videos', async () => {
  const id = 'portrait123';
  await message({ type: 'CANDIDATES', source: 'subscriptions', videos: [{
    id, title: 'Format probe candidate', channel: 'Clips'
  }] });
  const before = (await message({ type: 'GET_RECOMMENDATIONS' })).result;
  assert.equal(before.recommendations.some(v => v.id === id), true);
  const probed = await message({ type: 'PROBE_SHORTS_FORMAT', ids: [id] });
  assert.equal(probed.ok, true);
  assert.equal(probed.result.checked, 1);
  const state = (await message({ type: 'GET_STATE' })).state.items[id];
  assert.equal(state.shortsFormat, 'portrait');
  assert.equal(state.shortsProbeSource, 'three-panel-image-v2');
  assert.equal(state.shortsProbeDiagnostic.variant, 'mqdefault');
  assert.equal(state.shortsProbeDiagnostic.reason, 'three-panel-match');
  assert.ok(state.shortsProbeDiagnostic.score >= .55);
  assert.ok(state.shortsProbedAt);
  const after = (await message({ type: 'GET_RECOMMENDATIONS' })).result;
  assert.equal(after.recommendations.some(v => v.id === id), false);
  const repeated = await message({ type: 'PROBE_SHORTS_FORMAT', ids: [id] });
  assert.equal(repeated.result.reason, 'cached');
  await message({ type: 'MARK_SHORT', id, isShort: false });
  const restored = (await message({ type: 'GET_RECOMMENDATIONS' })).result;
  assert.equal(restored.recommendations.some(v => v.id === id), true);
});

test('three-panel thumbnail identifies known portrait candidate without CDN variants', async () => {
  const id = 'uo5VU-KtUZk';
  await message({ type: 'CANDIDATES', source: 'subscriptions', videos: [
    { id, title: 'Unlabeled portrait clip', channel: 'Example' }
  ] });
  const result = await message({ type: 'PROBE_SHORTS_FORMAT', ids: [id] });
  assert.equal(result.ok, true);
  assert.equal(result.result.portrait, 1);
  const state = (await message({ type: 'GET_STATE' })).state.items[id];
  assert.equal(state.shortsProbeSource, 'three-panel-image-v2');
  assert.equal(state.shortsProbeDiagnostic.variant, 'mqdefault');
  assert.equal(state.shortsProbeDiagnostic.reason, 'three-panel-match');
  assert.equal(state.shortsFormat, 'portrait');
  const after = await message({ type: 'GET_RECOMMENDATIONS' });
  assert.equal(after.result.recommendations.some(v => v.id === id), false);
});

test('duration metadata is preserved and protects long-form portrait candidates', async () => {
  const id = 'portraitLNG';
  await message({ type: 'CANDIDATES', source: 'subscriptions', videos: [
    { id, title: 'Full vertical interview', channel: 'Music', durationSeconds: 1431,
      isShort: true }
  ] });
  let view = await message({ type: 'GET_RECOMMENDATIONS' });
  assert.equal(view.result.recommendations.some(v => v.id === id), true);
  const check = await message({ type: 'PROBE_SHORTS_FORMAT', ids: [id] });
  assert.equal(check.result.reason, 'cached');
  await message({ type: 'CANDIDATES', source: 'subscriptions', videos: [
    { id, title: 'Full vertical interview', channel: 'Music' }
  ] });
  const candidate = (await message({ type: 'GET_STATE' })).state.items[id];
  assert.equal(candidate.durationSeconds, 1431);
  assert.equal(candidate.feedback, undefined);
  await message({ type: 'MARK_SEEN', id });
});

test('duration enrichment candidates include portrait videos excluded by ranking', async () => {
  const id = 'hiddenlong1';
  await message({ type: 'CANDIDATES', source: 'subscriptions', videos: [{
    id, title: 'Vertical talk wrongly identified as portrait short', channel: 'Talks'
  }] });
  await message({ type: 'PROBE_SHORTS_FORMAT', ids: [id] });
  const view = await message({ type: 'GET_RECOMMENDATIONS' });
  assert.equal(view.result.recommendations.some(v => v.id === id), false);
  assert.equal(view.result.detailCandidates.includes(id), true);
  const details = await message({ type: 'REFRESH_VIDEO_DETAILS', ids: [id], force: true });
  assert.equal(details.ok, true);
  const candidate = (await message({ type: 'GET_STATE' })).state.items[id];
  assert.equal(candidate.durationSeconds, 1431);
  assert.equal(candidate.shortsFormat, 'portrait');
  const restored = await message({ type: 'GET_RECOMMENDATIONS' });
  assert.equal(restored.result.recommendations.some(v => v.id === id), true);
  await message({ type: 'MARK_SEEN', id });
});

test('Recent worker sends a growing chronological window beyond 100 stored candidates', async () => {
  const now = Date.now();
  const all = Array.from({ length: 225 }, (_, i) => ({
    id: 'r' + String(i).padStart(10, '0'),
    title: 'Recent technical upload ' + i,
    channel: 'Subscribed channel',
    publishedAt: new Date(now - i * 60000).toISOString()
  }));
  for (let i = 0; i < all.length; i += 120)
    await message({ type: 'CANDIDATES', source: 'subscriptions',
      videos: all.slice(i, i + 120) });
  await chrome.storage.local.set({ 'yt-recs-settings-v1': {
    mode: 'recent', discoveryOnly: true, hideShorts: false
  } });
  const first = await message({ type: 'GET_RECOMMENDATIONS', recentLimit: 100 });
  assert.equal(first.result.recentHasMore, true);
  assert.ok(first.result.recentTotal >= 225);
  assert.equal(first.result.recommendations.length, 100);
  assert.deepEqual(first.result.recommendations.slice(0, 3).map(v => v.id),
    ['r0000000000','r0000000001','r0000000002']);
  const second = await message({ type: 'GET_RECOMMENDATIONS', recentLimit: 200 });
  assert.equal(second.result.recommendations.length, 200);
  assert.equal(second.result.recommendations[199].id, 'r0000000199');
  const expanded = await message({ type: 'GET_RECOMMENDATIONS', recentLimit: 4000 });
  assert.equal(expanded.result.recentHasMore, false);
  assert.ok(expanded.result.recommendations.length >= 225);
  const nonRecent = await message({ type: 'GET_RECOMMENDATIONS', recentLimit: 4000 });
  assert.ok(nonRecent.result.counts.unseen >= 225);
  await chrome.storage.local.set({ 'yt-recs-settings-v1': {} });
});
