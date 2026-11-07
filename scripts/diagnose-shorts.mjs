#!/usr/bin/env node
// Read-only diagnostic for the public YouTube thumbnail CDN.
// Usage: node scripts/diagnose-shorts.mjs VIDEO_ID [VIDEO_ID ...]
// Prints dimensions and HTTP status; no OAuth, user data or playback requests.
import { jpegDimensions } from '../lib/shorts-probe.js';

const VARIANTS = ['oar2', 'oardefault', 'frame0'];
const ids = process.argv.slice(2).map(arg => {
  const match = arg.match(/[A-Za-z0-9_-]{11}/g);
  if (/^[A-Za-z0-9_-]{11}$/.test(arg)) return arg;
  try {
    const url = new URL(arg);
    if (!/(^|\.)youtube\.com$/.test(url.hostname)) return null;
    if (url.pathname === '/watch') return url.searchParams.get('v');
    if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/')[2];
  } catch { /* Not a URL. */ }
  return match?.find(v => v.length === 11) || null;
}).filter(id => /^[A-Za-z0-9_-]{11}$/.test(id || ''));
if (!ids.length) {
  process.stderr.write('Pass one or more public 11-character YouTube video IDs.\n');
  process.exitCode = 1;
} else {
  const sample = [...new Set(ids)].slice(0, 25);
  for (const id of sample) {
    const results = [];
    for (const variant of VARIANTS) {
      const url = 'https://i.ytimg.com/vi/' + id + '/' + variant + '.jpg';
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(8000),
          headers: { Range: 'bytes=0-32767' }
        });
        const mime = response.headers.get('content-type') || '';
        const buf = await response.arrayBuffer();
        const dimensions = jpegDimensions(buf);
        results.push({
          variant, status: response.status, mime,
          length: buf.byteLength,
          size: dimensions ? dimensions.width + 'x' + dimensions.height : null,
          format: !response.ok || !dimensions ? 'unknown' :
            dimensions.height / dimensions.width >= 1.4 ? 'portrait' : 'landscape'
        });
      } catch (error) {
        results.push({ variant, error: String(error?.cause?.code || error?.name || 'Request failed') });
      }
    }
    console.log(JSON.stringify({ id, results }));
  }
}
