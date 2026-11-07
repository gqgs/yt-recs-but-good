// Best-effort portrait-format probe, not an official Shorts classification API.
// One bounded JPEG request to YouTube's portrait-thumbnail CDN variant per
// unclassified video. Check actual dimensions: oar2.jpg can exist for normal
// landscape videos too. Do not download/decode the already displayed thumbnail.
const VALID_ID = /^[A-Za-z0-9_-]{11}$/;
export const SHORTS_PROBE_SOURCE = 'oar2-frame0-jpeg-v2';
export const SHORTS_PROBE_TIMEOUT_MS = 6500;
export const SHORTS_PROBE_MAX_BATCH = 24;
export const SHORTS_PROBE_WINDOW_MS = 10 * 60_000;
export const SHORTS_THUMBNAIL_HEADER_BYTES = 32768;

export function thumbnailProbeUrl(id) {
  if (!VALID_ID.test(id || '')) throw new Error('Invalid YouTube video ID');
  return 'https://i.ytimg.com/vi/' + id + '/oar2.jpg';
}

// Read JPEG SOF dimensions without decoding pixels. A 404 may still contain
// a small, valid grey JPEG placeholder; callers must reject non-2xx status
// before examining the header. Missing/truncated data is inconclusive.
export function jpegDimensions(data) {
  const bytes = data instanceof Uint8Array ? data :
    data instanceof ArrayBuffer ? new Uint8Array(data) : null;
  if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 3 < bytes.length) {
    if (bytes[at++] !== 0xff) return null;
    while (at < bytes.length && bytes[at] === 0xff) at++;
    if (at >= bytes.length) return null;
    const marker = bytes[at++];
    if (marker === 0xd9 || marker === 0xda) return null; // EOI or scan data.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (at + 2 > bytes.length) return null;
    const size = (bytes[at] << 8) | bytes[at + 1];
    if (size < 2 || at + size > bytes.length) return null;
    const isSof = (marker >= 0xc0 && marker <= 0xcf) &&
      ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) {
      if (size < 7) return null;
      const height = (bytes[at + 3] << 8) | bytes[at + 4];
      const width = (bytes[at + 5] << 8) | bytes[at + 6];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    at += size;
  }
  return null;
}

export function formatFromJpegHeader(data) {
  const dimensions = jpegDimensions(data);
  if (!dimensions) return 'unknown';
  return dimensions.height / dimensions.width >= 1.4 ? 'portrait' : 'landscape';
}

// A structured result is retained for diagnostics. One oar2 request is enough
// for ordinary cases; only an explicit 404 triggers a single frame0 fallback.
export async function probeThumbnailVariant(id, variant, fetcher = fetch,
  timeoutMs = SHORTS_PROBE_TIMEOUT_MS) {
  const url = variant === 'oar2' ? thumbnailProbeUrl(id) :
    variant === 'frame0' ? 'https://i.ytimg.com/vi/' + id + '/frame0.jpg' :
    (() => { throw new Error('Invalid thumbnail variant'); })();
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Shorts thumbnail probe timed out'));
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([fetcher(url, {
      method: 'GET', signal: controller.signal,
      headers: { Range: 'bytes=0-' + (SHORTS_THUMBNAIL_HEADER_BYTES - 1) }
    }), timeout]);
    const status = response.status;
    if (!response.ok) return { format: 'unknown', variant, status,
      reason: status === 404 ? 'missing' : 'http-error' };
    const mime = response.headers?.get?.('content-type');
    if (mime && !/^image\/jpeg\b/i.test(mime))
      return { format: 'unknown', variant, status, reason: 'wrong-mime' };
    // JPEG header parsing does not require decoding or downloading pixels.
    const dims = jpegDimensions(await Promise.race([response.arrayBuffer(), timeout]));
    if (!dims) return { format: 'unknown', variant, status, reason: 'invalid-jpeg' };
    return { format: dims.height / dims.width >= 1.4 ? 'portrait' : 'landscape',
      variant, status, width: dims.width, height: dims.height, reason: 'ok' };
  } catch (error) {
    return { format: 'unknown', variant, reason:
      error?.name === 'AbortError' || /timed out/i.test(String(error)) ? 'timeout' : 'network-error' };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeVideoFormatDetails(id, fetcher = fetch,
  timeoutMs = SHORTS_PROBE_TIMEOUT_MS) {
  const primary = await probeThumbnailVariant(id, 'oar2', fetcher, timeoutMs);
  if (primary.reason !== 'missing') return primary;
  const fallback = await probeThumbnailVariant(id, 'frame0', fetcher, timeoutMs);
  return fallback.format !== 'unknown' ? fallback : {
    ...primary,
    reason: 'both-missing-or-unavailable',
    fallbackReason: fallback.reason
  };
}

export async function probeVideoFormat(id, fetcher = fetch,
  timeoutMs = SHORTS_PROBE_TIMEOUT_MS) {
  return (await probeVideoFormatDetails(id, fetcher, timeoutMs)).format;
}

export async function probeFormatBatchDetails(ids, {
  fetcher = fetch, concurrency = 4, timeoutMs = SHORTS_PROBE_TIMEOUT_MS
} = {}) {
  const unique = [...new Set(ids)].filter(id => VALID_ID.test(id || ''))
    .slice(0, SHORTS_PROBE_MAX_BATCH);
  const results = new Map();
  let next = 0;
  async function worker() {
    while (next < unique.length) {
      const id = unique[next++];
      results.set(id, await probeVideoFormatDetails(id, fetcher, timeoutMs));
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
