import test from 'node:test';
import assert from 'node:assert/strict';

const VID_A = 'abcdefghijk';
const VID_B = 'lmnopqrstuv';
const CHANNEL = 'UC' + 'z'.repeat(22);
const state = {};
let onMessage;
const oldChrome = globalThis.chrome;
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
    async remove(key) { delete state[key]; }
  }},
  permissions: { async contains() { return true; } },
  history: {
    async search() { return [
      { url: 'https://www.youtube.com/watch?v=lmnopqrstuv', lastVisitTime: 2000 },
      { url: 'https://www.youtube.com/watch?v=lmnopqrstuv&list=PL', lastVisitTime: 3000 },
      { url: 'https://example.org/private', lastVisitTime: 4000 }
    ]; }
  },
  runtime: {
    getManifest() { return { oauth2: { client_id: 'REPLACE_WITH_OAUTH_CLIENT_ID.apps.googleusercontent.com' } }; },
    onMessage: { addListener(fn) { onMessage = fn; } }
  }
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
    publishedAt: '2026-11-06T00:00:00Z'
  }] });
  const before = await message({ type: 'GET_RECOMMENDATIONS' });
  assert.equal(before.ok, true);
  assert.equal(before.result.counts.likes, 1);
  assert.equal(before.result.recommendations[0].id, VID_B);
  const saved = await message({ type: 'GET_STATE' });
  assert.equal(saved.state.items[VID_B].publishedAt, Date.parse('2026-11-06T00:00:00Z'));
  assert.equal(saved.state.items[VID_B].subscribed, true);
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
test.after(() => { globalThis.chrome = oldChrome; });
