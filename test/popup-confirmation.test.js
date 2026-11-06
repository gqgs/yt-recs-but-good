import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Guard against a regression to synchronous browser-native dialogs.
// In a small extension popup, native confirm can be positioned offscreen and
// prevent interaction with other browser windows until dismissed.
const popup = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
const markup = readFileSync(new URL('../popup.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../popup.css', import.meta.url), 'utf8');

test('destructive operations never open blocking native confirmation dialogs', () => {
  assert.doesNotMatch(popup, /(?:\bwindow\s*\.\s*)?\bconfirm\s*\(/);
  assert.match(popup, /openConfirmation\('candidates'\)/);
  assert.match(popup, /openConfirmation\('all'\)/);
});

test('confirmation is bounded to the extension viewport and allows cancellation', () => {
  assert.match(markup, /id="confirm-overlay"/);
  assert.match(markup, /role="alertdialog"/);
  assert.match(markup, /aria-modal="true"/);
  assert.match(markup, /id="confirm-cancel"/);
  assert.match(markup, /id="confirm-proceed"/);
  assert.match(css, /\.confirm-overlay\{position:fixed;inset:0;/);
  assert.match(css, /max-height:calc\(100% - 8px\);overflow:auto/);
  assert.match(popup, /event\.key === 'Escape'/);
  assert.match(popup, /document\.querySelector\('main'\)\.inert = true/);
});

test('data deletion requires the second explicit confirm action', () => {
  assert.match(popup, /\$\('confirm-proceed'\)\.addEventListener\('click'/);
  assert.match(popup, /async function performDeletion\(\)/);
  assert.match(popup, /if \(!action \|\| resetting\) return/);
  assert.match(popup, /await request\(\{ type: 'RESET' \}\)/);
  assert.match(popup, /await request\(\{ type: 'CLEAR_CANDIDATES' \}\)/);
});
