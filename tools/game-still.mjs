// Render game frames headlessly: node tools/game-still.mjs out.png [seed] [view ...]
// A view is "walk,turn,t[,pitch[,eye]]": walk that far along the start heading,
// turn by that many radians, at game time t, looking up by pitch radians
// (negative looks down) from eye height eye. Views stack vertically.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { createWorld } from '../src/game/world.js';
import { createRenderer, W, H, PX } from '../src/game/render.js';

const [out = 'game.png', seedArg = '1', ...views] = process.argv.slice(2);
const world = createWorld(Number(seedArg));
const t0 = performance.now();
const ren = createRenderer(world);
console.log(`bake ${(performance.now() - t0).toFixed(0)}ms`);
const st0 = world.start();
const vs = (views.length ? views : ['0,0,0']).map((v) => v.split(',').map(Number));
const SCALE = Math.max(1, 2 / PX);   // the picture is written at 768 wide whatever the frame size
const rgba = new Uint8ClampedArray(W * H * 4);
const OW = W * SCALE, OH = H * SCALE * vs.length;
const img = Buffer.alloc(OH * (OW * 4 + 1));
vs.forEach(([walk = 0, turn = 0, t = 0, pitch = 0, eye], f) => {
  const st = { x: st0.x + Math.sin(st0.heading) * walk, z: st0.z + Math.cos(st0.heading) * walk, heading: st0.heading + turn, t, pitch, eye };
  for (let k = 0; k < 3; k++) {
    const a = performance.now();
    ren.render(st, rgba);
    console.log(`view ${f} pass ${k}: ${(performance.now() - a).toFixed(1)}ms`);
  }
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
