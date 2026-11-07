// Best-effort visual-format probe for API-only videos. YouTube's Data API
// exposes no universal Shorts flag, but YouTube oEmbed sometimes reports
// a portrait player for a /shorts/{id} URL, even when ordinary watch links are
// also valid. Treat this as evidence of portrait format, not a guarantee of
// official Shorts classification.
const VALID_ID = /^[A-Za-z0-9_-]{11}$/;
export const SHORTS_PROBE_TIMEOUT_MS = 6500;
export const SHORTS_PROBE_MAX_BATCH = 24;
export const SHORTS_PROBE_WINDOW_MS = 10 * 60_000;

export function oEmbedProbeUrl(id) {
  if (!VALID_ID.test(id || '')) throw new Error('Invalid YouTube video ID');
  const url = new URL('https://www.youtube.com/oembed');
  url.searchParams.set('url', 'https://www.youtube.com/shorts/' + id);
  url.searchParams.set('format', 'json');
  return url.toString();
}

export function portraitFormatFromOEmbed(result) {
  const width = Number(result?.width);
  const height = Number(result?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) ||
      width <= 0 || height <= 0) return 'unknown';
  if (height / width >= 1.4) return 'portrait';
  return 'landscape';
}

export async function probeVideoFormat(id, fetcher = fetch,
  timeoutMs = SHORTS_PROBE_TIMEOUT_MS) {
  const url = oEmbedProbeUrl(id);
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Shorts format probe timed out'));
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([
      fetcher(url, { method: 'GET', signal: controller.signal }),
      timeout
    ]);
    if (!response.ok) return 'unknown';
    return portraitFormatFromOEmbed(await response.json());
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

export async function probeFormatBatch(ids, {
  fetcher = fetch, concurrency = 4, timeoutMs = SHORTS_PROBE_TIMEOUT_MS
} = {}) {
  const unique = [...new Set(ids)].filter(id => VALID_ID.test(id || ''))
    .slice(0, SHORTS_PROBE_MAX_BATCH);
  const results = new Map();
  let next = 0;
  async function worker() {
    while (next < unique.length) {
      const id = unique[next++];
      results.set(id, await probeVideoFormat(id, fetcher, timeoutMs));
    }
  }
  await Promise.all(Array.from({
    length: Math.min(Math.max(1, concurrency), unique.length)
  }, () => worker()));
  return results;
}
