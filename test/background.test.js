import test from 'node:test';
import assert from 'node:assert/strict';

const VID_A = 'abcdefghijk';
const VID_B = 'lmnopqrstuv';
const CHANNEL = 'UC' + 'z'.repeat(22);
const state = {};
let onMessage;
let oauthConfigured = false;
let authGranted = false;
const identityCalls = [];
let apiCalls = 0;
const oldChrome = globalThis.chrome;
const oldFetch = globalThis.fetch;
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
    async getAuthToken({ interactive }) {
      identityCalls.push(interactive);
      if (!interactive && !authGranted) throw new Error('OAuth approval not granted');
      authGranted = true;
      return { token: 'testing-token' };
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
  };
  throw new Error('Unexpected endpoint: ' + parsed.pathname);
};
await import('../background.js');

function message(request) {
  return new Promise(resolve => {
    const response = onMessage(request, {}, resolve);
    assert.equal(typeof response, 'boolean');
  });
}

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
test('full reset clears last refresh and prevents automatic collection until resumed', async () => {
  const cleared = await message({ type: 'RESET' });
  assert.equal(cleared.ok, true);
  const skipped = await message({ type: 'REFRESH_CANDIDATES' });
  assert.equal(skipped.result.reason, 'paused');
  await message({ type: 'COLLECTION_RESUME' });
  const after = await message({ type: 'GET_POPUP_DATA' });
  assert.equal(after.result.refresh.lastSuccessAt, undefined);
});
test.after(() => {
  globalThis.chrome = oldChrome;
  globalThis.fetch = oldFetch;
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
