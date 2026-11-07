// Temporary read-only CDN smoke benchmark for public examples. No user data,
// OAuth, local files, or library dependency is required in the extension.
// Run with: npm install --no-save sharp && node scripts/diagnose-three-panel.mjs
import sharp from 'sharp';
import { classifyThumbnail, SAMPLE_WIDTH, SAMPLE_HEIGHT } from '../lib/thumbnail-classifier.js';
const examples = {
  shorts: ['EZy9KqeQKrA','HlhOrCrn7vk','zzITiIxxD8c','-prSdejMkaI','uo5VU-KtUZk'],
  normal: ['dQw4w9WgXcQ','jNQXAC9IVRw','aqz-KE-bpKQ','jfKfPfyJRdk']
};
for (const [label, ids] of Object.entries(examples)) {
  for (const id of ids) {
    try {
      const res = await fetch('https://i.ytimg.com/vi/' + id + '/mqdefault.jpg',
        { signal: AbortSignal.timeout(7000) });
      if (!res.ok) { console.log(JSON.stringify({label,id,http:res.status}));continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      const { data, info } = await sharp(buf)
        .resize(SAMPLE_WIDTH,SAMPLE_HEIGHT,{fit:'fill'}).ensureAlpha().raw()
        .toBuffer({resolveWithObject:true});
      const result = classifyThumbnail({data,width:info.width,height:info.height});
      console.log(JSON.stringify({label,id,format:result.format,score:result.score,
        features:result.features}));
    } catch (error) { console.log(JSON.stringify({label,id,error:String(error?.message||error)})); }
  }
}
