// Sharpness-profile variant of the portrait-in-landscape thumbnail heuristic.
// Drop-in replacement for thumbnail-classifier.js (same exports, same return shape).
//
// Idea: in a 9:16 video placed inside a 16:9 frame, the side bars are a blurred,
// enlarged copy of the content. So instead of looking for strong vertical
// *edges* (which vanish when the blur matches the center colors), we build a
// per-column sharpness profile (mean |Laplacian| down each column) and look for
// "sharp center, flat sides, with a step near each boundary".
//
// Input should be the thumbnail at NATIVE resolution (320x180). Downscaling to
// 128x72 averages away much of the sharp/blurry difference. The code is
// resolution-independent (everything is a fraction of width/height), so smaller
// samples still work, just with less contrast.
export const THUMBNAIL_CLASSIFIER_SOURCE = 'three-panel-sharpness-v2';
export const SAMPLE_WIDTH = 320;
export const SAMPLE_HEIGHT = 180;

const PORTRAIT_ASPECT = 9 / 16;
// Added to denominators so flat / black sides don't produce infinite ratios.
const SHARPNESS_FLOOR = 0.001;

function clamp(x, lo = 0, hi = 1) {
  return Math.max(lo, Math.min(hi, x));
}
function round(x, digits = 3) {
  const k = 10 ** digits;
  return Math.round(x * k) / k;
}
function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}
function imageLuma(data, width, height) {
  if (!data || data.length < width * height * 4) return null;
  const result = new Float32Array(width * height);
  for (let i = 0; i < result.length; i++) {
    const offset = i * 4;
    result[i] = (0.2126 * data[offset] +
      0.7152 * data[offset + 1] + 0.0722 * data[offset + 2]) / 255;
  }
  return result;
}

// Mean absolute 4-neighbour Laplacian per column, lightly box-smoothed.
function columnSharpness(luma, w, h) {
  const col = new Float32Array(w);
  const y0 = Math.max(1, Math.round(h * 0.06));
  const y1 = Math.min(h - 1, Math.round(h * 0.94));
  const rows = Math.max(1, y1 - y0);
  for (let y = y0; y < y1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const p = row + x;
      col[x] += Math.abs(4 * luma[p] - luma[p - 1] - luma[p + 1] -
        luma[p - w] - luma[p + w]);
    }
  }
  for (let x = 1; x < w - 1; x++) col[x] /= rows;
  col[0] = col[1];
  col[w - 1] = col[w - 2];

  const radius = Math.max(1, Math.round(w * 0.006));
  const smooth = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let sum = 0, n = 0;
    for (let k = -radius; k <= radius; k++) {
      const i = x + k;
      if (i >= 0 && i < w) { sum += col[i]; n++; }
    }
    smooth[x] = sum / n;
  }
  return smooth;
}

// O(1) mean over [a, b) using prefix sums.
function makeRangeMean(values) {
  const prefix = new Float64Array(values.length + 1);
  for (let i = 0; i < values.length; i++) prefix[i + 1] = prefix[i] + values[i];
  return (a, b) => {
    const s = Math.max(0, Math.round(a));
    const e = Math.min(values.length, Math.round(b));
    return e > s ? (prefix[e] - prefix[s]) / (e - s) : 0;
  };
}

export function classifyThumbnail({ data, width, height } = {}, options = {}) {
  const minScore = finiteOr(options.minScore, 0.65);
  const minRatio = finiteOr(options.minRatio, 2.2);       // center / side sharpness
  const minStep = finiteOr(options.minStep, 0.1);         // mean boundary jump, relative to center (lenient)
  const minCenterSharpness = finiteOr(options.minCenterSharpness, 0.006);

  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width < 48 || height < 26) {
    return { format: 'unknown', reason: 'bad-image-size', score: 0 };
  }
  const luma = imageLuma(data, width, height);
  if (!luma) return { format: 'unknown', reason: 'missing-pixels', score: 0 };

  const col = columnSharpness(luma, width, height);
  const rangeMean = makeRangeMean(col);

  // Geometry: a 9:16 panel inside this frame, allowing some shift / width error.
  const expectedSpan = PORTRAIT_ASPECT * height / width;  // ~0.316 for 16:9
  const minSpan = expectedSpan * 0.7;
  const maxSpan = expectedSpan * 1.3;
  const maxOffset = 0.075;                                // allowed center shift
  const margin = Math.max(1, Math.round(width * 0.0125)); // skip transition zone
  const band = Math.max(3, Math.round(width * 0.03));     // width used for step test

  const lLo = Math.max(margin + band + 1,
    Math.round(width * (0.5 - maxSpan / 2 - maxOffset)));
  const lHi = Math.round(width * (0.5 - minSpan / 2 + maxOffset));
  const rLo = Math.round(width * (0.5 + minSpan / 2 - maxOffset));
  const rHi = Math.min(width - margin - band - 2,
    Math.round(width * (0.5 + maxSpan / 2 + maxOffset)));

  let best = null;
  for (let l = lLo; l <= lHi; l++) {
    for (let r = Math.max(rLo, l + 1); r <= rHi; r++) {
      const span = (r - l) / width;
      const offset = Math.abs((r + l) / (2 * width) - 0.5);
      if (span < minSpan || span > maxSpan || offset > maxOffset) continue;
      const center = rangeMean(l + margin, r - margin);
      const leftSide = rangeMean(1, l - margin);
      const rightSide = rangeMean(r + margin, width - 1);
      const ratio = center / (Math.max(leftSide, rightSide) + SHARPNESS_FLOOR);
      // Prefer big contrast, but nudge toward the nominal 9:16, centered layout.
      const objective = Math.log(ratio) -
        4 * Math.abs(span - expectedSpan) - 4 * offset;
      if (!best || objective > best.objective) {
        best = { objective, l, r, span, offset, center, leftSide, rightSide, ratio };
      }
    }
  }
  if (!best) return { format: 'unknown', reason: 'no-candidate', score: 0 };

  const { l, r, span, offset, center, leftSide, rightSide, ratio } = best;
  const denom = center + SHARPNESS_FLOOR;
  const inner = Math.max(band, Math.round(width * 0.08));
  const outer = band;
  const shiftMax = margin + 2;
  let stepLeft = -Infinity, stepRight = -Infinity;
  for (let s = -shiftMax; s <= shiftMax; s++) {
    stepLeft = Math.max(stepLeft, (rangeMean(l + s + margin, l + s + margin + inner) -
      rangeMean(l + s - margin - outer, l + s - margin)) / denom);
    stepRight = Math.max(stepRight, (rangeMean(r + s - margin - inner, r + s - margin) -
      rangeMean(r + s + margin, r + s + margin + outer)) / denom);
  }
  const meanStep = (stepLeft + stepRight) / 2;
  const sideSharpness = Math.max(leftSide, rightSide);

  // The sharpness ratio carries the decision. The boundary step and the 9:16
  // geometry only refine it: the panel's own content is often dark or flat right
  // at its edge, so a hard step requirement rejects many true positives.
  const ratioScore = clamp((Math.log2(Math.max(ratio, 1e-6)) - 0.4) / 1.6);
  const stepScore = clamp(meanStep / 0.6);
  const geometryScore =
    clamp(1 - Math.abs(span - expectedSpan) / (expectedSpan * 0.3)) *
    clamp(1 - offset / (maxOffset * 2));
  const score = clamp(0.75 * ratioScore + 0.15 * stepScore + 0.1 * geometryScore);

  const checks = {
    sharpnessContrast: ratio >= minRatio,
    boundarySteps: meanStep >= minStep,
    centerHasDetail: center >= minCenterSharpness,
    minimumScore: score >= minScore
  };
  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => !passed).map(([name]) => name);
  const detected = failedChecks.length === 0;

  const result = {
    format: detected ? 'portrait' : 'landscape',
    reason: detected ? 'three-panel-match' : 'three-panel-not-detected',
    score: round(score),
    checks, failedChecks,
    features: {
      sharpnessRatio: round(ratio, 2),
      stepLeft: round(stepLeft, 2),
      stepRight: round(stepRight, 2),
      centerSharpness: round(center, 4),
      sideSharpness: round(sideSharpness, 4),
      span: round(span),
      leftBoundary: round(l / width),
      rightBoundary: round(r / width)
    }
  };
  // Raw 1D profile, handy for training a small model on top (logistic regression etc.).
  if (options.includeProfile) result.profile = Array.from(col);
  return result;
}