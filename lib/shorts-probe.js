// Local thumbnail classification rather than oEmbed or portrait CDN probes.
// The MV3 service worker loads the same landscape thumbnail URL that Home
// displays, decodes it into a small OffscreenCanvas, and classifies its pixels.
// No screenshot API, image uploads, DOM mutation, or YouTube Data API quota.
import {
  classifyThumbnail, SAMPLE_WIDTH, SAMPLE_HEIGHT,
  THUMBNAIL_CLASSIFIER_SOURCE
} from './thumbnail-classifier.js';

const VALID_ID = /^[A-Za-z0-9_-]{11}$/;
export const SHORTS_PROBE_SOURCE = THUMBNAIL_CLASSIFIER_SOURCE;
export const SHORTS_PROBE_TIMEOUT_MS = 6500;
export const SHORTS_PROBE_MAX_BATCH = 24;
export const SHORTS_PROBE_WINDOW_MS = 10 * 60_000;
const MAX_THUMBNAIL_BYTES = 1_500_000;

export function thumbnailProbeUrl(id) {
  if (!VALID_ID.test(id || '')) throw new Error('Invalid YouTube video ID');
  return 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg';
}

export async function decodeThumbnail(blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(SAMPLE_WIDTH, SAMPLE_HEIGHT);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas 2D context unavailable');
    context.drawImage(bitmap, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
    return classifyThumbnail(context.getImageData(
      0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT));
  } finally {
    bitmap.close?.();
  }
}

export async function probeVideoFormatDetails(id, fetcher = fetch,
  timeoutMs = SHORTS_PROBE_TIMEOUT_MS, decode = decodeThumbnail) {
  const url = thumbnailProbeUrl(id);
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Thumbnail classification timed out'));
    }, timeoutMs);
  });
  try {
    const inspect = async () => {
      const response = await fetcher(url, { method: 'GET',
        signal: controller.signal });
      if (!response.ok) return { format: 'unknown', reason: 'http-error',
        variant: 'mqdefault', status: response.status };
      const mime = response.headers?.get?.('content-type') || '';
      if (mime && !/^image\/(jpeg|jpg|webp)\b/i.test(mime))
        return { format: 'unknown', reason: 'wrong-mime',
          variant: 'mqdefault', status: response.status };
      const blob = await response.blob();
      if (blob.size > MAX_THUMBNAIL_BYTES)
        return { format: 'unknown', reason: 'image-too-large',
          variant: 'mqdefault', status: response.status };
      const result = await decode(blob);
      return { ...result, variant: 'mqdefault', status: response.status };
    };
    return await Promise.race([inspect(), timeout]);
  } catch (error) {
    return { format: 'unknown', variant: 'mqdefault',
      reason: controller.signal.aborted ? 'timeout' :
        error?.message?.includes('Canvas') || error?.name === 'EncodingError'
          ? 'image-decode-failed' : 'network-error' };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeVideoFormat(id, fetcher = fetch,
  timeoutMs = SHORTS_PROBE_TIMEOUT_MS, decode = decodeThumbnail) {
  return (await probeVideoFormatDetails(id, fetcher, timeoutMs, decode)).format;
}

export async function probeFormatBatchDetails(ids, {
  fetcher = fetch, concurrency = 4,
  timeoutMs = SHORTS_PROBE_TIMEOUT_MS, decode = decodeThumbnail
} = {}) {
  const unique = [...new Set(ids)].filter(id => VALID_ID.test(id || ''))
    .slice(0, SHORTS_PROBE_MAX_BATCH);
  const results = new Map();
  let next = 0;
  async function worker() {
    while (next < unique.length) {
      const id = unique[next++];
      results.set(id, await probeVideoFormatDetails(
        id, fetcher, timeoutMs, decode));
    }
  }
  await Promise.all(Array.from({
    length: Math.min(Math.max(1, concurrency), unique.length)
  }, () => worker()));
  return results;
}
export async function probeFormatBatch(ids, options = {}) {
  const details = await probeFormatBatchDetails(ids, options);
  return new Map([...details].map(([id, value]) => [id, value.format]));
}
