// Render frames headlessly: node tools/still.mjs out.png 0 12 30 ...
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { createScene, W, H } from '../src/scene.js';

const [out = 'still.png', ...times] = process.argv.slice(2);
const ts = times.length ? times.map(Number) : [0];
const SCALE = 2;
const scene = createScene();
const rgba = new Uint8ClampedArray(W * H * 4);
const OW = W * SCALE, OH = H * SCALE * ts.length;
const img = Buffer.alloc(OH * (OW * 4 + 1));
ts.forEach((t, f) => {
  const t0 = performance.now();
  scene.render(t, rgba);
  console.log(`t=${t} ${(performance.now() - t0).toFixed(1)}ms`);
  for (let y = 0; y < H * SCALE; y++) {
    const row = (f * H * SCALE + y) * (OW * 4 + 1);
    for (let x = 0; x < OW; x++) {
      const s = ((y / SCALE | 0) * W + (x / SCALE | 0)) * 4;
      img[row + 1 + x * 4] = rgba[s]; img[row + 2 + x * 4] = rgba[s + 1];
      img[row + 3 + x * 4] = rgba[s + 2]; img[row + 4 + x * 4] = 255;
    }
  }
});
const crc = (b) => { let c = ~0; for (const v of b) { c ^= v; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const hdr = Buffer.alloc(13); hdr.writeUInt32BE(OW, 0); hdr.writeUInt32BE(OH, 4); hdr[8] = 8; hdr[9] = 6;
writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', hdr), chunk('IDAT', deflateSync(img)), chunk('IEND', Buffer.alloc(0))]));
