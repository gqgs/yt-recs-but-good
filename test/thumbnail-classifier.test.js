import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyThumbnail, SAMPLE_WIDTH, SAMPLE_HEIGHT } from '../lib/thumbnail-classifier.js';

function synthetic({ panels = false, dim = 0.3, blur = false,
  uniform = false } = {}) {
  const w = SAMPLE_WIDTH, h = SAMPLE_HEIGHT;
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const center = x >= w * .34 && x < w * .66;
      const seed = ((x * 79 + y * 101 + (x * y) * 19) % 256);
      const smoothed = ((Math.floor(x / 8) * 39 + Math.floor(y / 8) * 17) % 120);
      const val = uniform ? 122 : panels && !center
        ? Math.round(smoothed * (1 - dim))
        : (seed * .7 + 60) | 0;
      const p = (y * w + x) * 4;
      pixels[p] = pixels[p + 1] = pixels[p + 2] = val;
      pixels[p + 3] = 255;
    }
  }
  return { width: w, height: h, data: pixels };
}

test('detects a centered portrait panel with darker blurred side panels', () => {
  const result = classifyThumbnail(synthetic({ panels: true, dim: .25 }));
  assert.equal(result.format, 'portrait', JSON.stringify(result));
  assert.ok(result.features.leftBoundary > .25);
  assert.ok(result.features.rightBoundary < .75);
});

test('rejects ordinary landscape thumbnails and blank images', () => {
  assert.equal(classifyThumbnail(synthetic()).format, 'landscape');
  assert.equal(classifyThumbnail(synthetic({ uniform: true })).format, 'landscape');
});

test('rejects missing or malformed image pixel buffers without guessing', () => {
  assert.equal(classifyThumbnail({ width: 128, height: 72 }).format, 'unknown');
  assert.equal(classifyThumbnail({ width: 1, height: 1, data: new Uint8Array(4) }).format, 'unknown');
});

test('classifier output includes bounded diagnostics for tuning', () => {
  const item = classifyThumbnail(synthetic({ panels: true }));
  assert.ok(item.score >= 0 && item.score <= 1);
  assert.equal(typeof item.features.brightnessGap, 'number');
  assert.equal(typeof item.features.edgeRatio, 'number');
});
