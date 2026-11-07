import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const home = readFileSync(new URL('../home.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../home.css', import.meta.url), 'utf8');
const content = readFileSync(new URL('../content.js', import.meta.url), 'utf8');

test('empty Home distinguishes paused collection from an empty recommendation pool', () => {
  assert.match(home, /function render\(\{ recommendations, counts, paused = false, refresh = \{\} \}\)/);
  assert.match(home, /'Collection paused after reset'/);
  assert.match(home, /'Resume and browse subscriptions'/);
  assert.match(home, /send\(\{ type: 'COLLECTION_RESUME' \}\)/);
});

test('original YouTube toggle is located in the controls row instead of the header', () => {
  const header = home.slice(home.indexOf('function makeHeader()'), home.indexOf('function showError('));
  assert.doesNotMatch(header, /Show original YouTube|Original YouTube/);
  assert.match(home, /controls\.append\(makeTabs\(\), button\('Original YouTube'/);
  assert.match(styles, /#ytrbg-home \.ytrbg-controls/);
  assert.match(styles, /#ytrbg-home \.ytrbg-controls \.ytrbg-native/);
});

test('resuming collection clears stale in-page deduplication state', () => {
  assert.match(content, /changes\['yt-recs-collection-paused-v1'\]/);
  assert.match(content, /seenCards\.clear\(\)/);
  assert.match(content, /scheduleScan\(\)/);
});

test('Home checks the candidate TTL without interactive login on page visits', () => {
  assert.match(home, /requestCandidateRefresh\(false\)/);
  assert.match(home, /document\.addEventListener\('visibilitychange'/);
  assert.match(home, /REFRESH_CANDIDATES', force, interactive: force/);
  assert.match(home, /button\('Refresh uploads'/);
  assert.match(home, /refresh\.label/);
  assert.match(styles, /\.ytrbg-refresh-status/);
});

test('Home schedules a recovery status check if an in-flight refresh stops updating', () => {
  assert.match(home, /staleStatusTimer = setTimeout/);
  assert.match(home, /refresh\.lastProgressAt \|\| refresh\.lastAttemptAt/);
  assert.match(home, /clearTimeout\(staleStatusTimer\)/);
});
