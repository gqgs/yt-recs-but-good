// Dependency-free portrait-in-landscape thumbnail heuristic.
// Operates on a small, pre-scaled ImageData (128x72 recommended). It looks
// for two strong vertical boundaries enclosing a narrow central panel plus
// evidence that the outer panels are darker or blurrier. This is an intentionally
// conservative classifier, not YouTube's official Shorts format flag.
export const THUMBNAIL_CLASSIFIER_SOURCE = 'three-panel-image-v1';
export const SAMPLE_WIDTH = 128;
export const SAMPLE_HEIGHT = 72;

function clamp(x, lo = 0, hi = 1) {
  return Math.max(lo, Math.min(hi, x));
}
function mean(numbers) {
  return numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : 0;
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
function regionStats(luma, w, h, left, right) {
  const x0 = Math.max(1, Math.round(left * w));
  const x1 = Math.min(w - 1, Math.round(right * w));
  let brightness = 0, gradient = 0, count = 0;
  for (let y = 2; y < h - 2; y += 2) {
    for (let x = x0; x < x1 - 1; x += 2) {
      const p = y * w + x;
      brightness += luma[p];
      gradient += Math.abs(luma[p] - luma[p + 1]) +
        Math.abs(luma[p] - luma[p + w]);
      count++;
    }
  }
  return { brightness: brightness / Math.max(1, count),
    texture: gradient / Math.max(1, count) };
}

export function classifyThumbnail({ data, width, height } = {}, options = {}) {
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 0.55;
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width < 48 || height < 26) {
    return { format: 'unknown', reason: 'bad-image-size', score: 0 };
  }
  const luma = imageLuma(data, width, height);
  if (!luma) return { format: 'unknown', reason: 'missing-pixels', score: 0 };
  const edges = new Float32Array(width);
  const startY = Math.max(1, Math.round(height * 0.08));
  const stopY = Math.min(height - 1, Math.round(height * 0.92));
  for (let x = 1; x < width; x++) {
    let total = 0;
    for (let y = startY; y < stopY; y += 2) {
      const i = y * width + x;
      total += Math.abs(luma[i] - luma[i - 1]);
    }
    edges[x] = total / Math.max(1, Math.ceil((stopY - startY) / 2));
  }
  // Look for symmetric boundaries enclosing approximately 9:16 portrait
  // content inside 16:9 source thumbnail (~32% central width), but allow
  // cropping and overlays to shift the edges somewhat.
  let best = { strength: 0, left: 0, right: 0 };
  const xStart = Math.round(width * 0.26);
  const xStop = Math.round(width * 0.43);
  const rStart = Math.round(width * 0.57);
  const rStop = Math.round(width * 0.74);
  for (let l = xStart; l <= xStop; l++) {
    for (let r = rStart; r <= rStop; r++) {
      const span = (r - l) / width;
      const offset = Math.abs((r + l) / (2 * width) - 0.5);
      if (span < 0.22 || span > 0.42 || offset > 0.075) continue;
      const strength = Math.min(edges[l], edges[r]) *
        (1 - 2 * offset) * (1 - 1.8 * Math.abs(span - 0.32));
      if (strength > best.strength) best = { strength, left: l, right: r };
    }
  }
  const averageEdge = mean([...edges].slice(1));
  const edgeRatio = best.strength / Math.max(0.006, averageEdge);
  const left = regionStats(luma, width, height, 0, best.left / width);
  const center = regionStats(luma, width, height, best.left / width, best.right / width);
  const right = regionStats(luma, width, height, best.right / width, 1);
  const sidesBrightness = (left.brightness + right.brightness) / 2;
  const sidesTexture = (left.texture + right.texture) / 2;
  const brightnessGap = (center.brightness - sidesBrightness) /
    Math.max(center.brightness, 0.1);
  const textureRatio = center.texture / Math.max(sidesTexture, 0.015);
  const balance = Math.abs(left.brightness - right.brightness);
  const boundariesStrong = edgeRatio >= 1.7 && best.strength >= 0.032;
  const panelEvidence = brightnessGap >= 0.14 ||
    (textureRatio >= 1.65 && brightnessGap >= -0.05);
  const reasonableSides = balance <= 0.3;
  const score = clamp(0.45 * clamp((edgeRatio - 1) / 2) +
    0.32 * clamp(brightnessGap / 0.35) +
    0.23 * clamp((textureRatio - 1) / 1.2));
  const detected = boundariesStrong && panelEvidence &&
    reasonableSides && score >= minScore;
  return {
    format: detected ? 'portrait' : 'landscape',
    reason: detected ? 'three-panel-match' : 'three-panel-not-detected',
    score: Math.round(score * 1000) / 1000,
    features: {
      edgeRatio: Math.round(edgeRatio * 100) / 100,
      brightnessGap: Math.round(brightnessGap * 100) / 100,
      textureRatio: Math.round(textureRatio * 100) / 100,
      leftBoundary: Math.round(1000 * best.left / width) / 1000,
      rightBoundary: Math.round(1000 * best.right / width) / 1000
    }
  };
}
