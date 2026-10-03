// ---------------------------------------------------------------------------
// A path through the wood, mid-morning.
//
// Every pixel holds a material ramp and a shade level, never a colour. Light
// is a shift of that level; fog and sun shafts are dithered blends applied in
// one resolve pass at the end. The frame is a pure function of time and the
// film loops every DURATION seconds, so every moving part is built from
// periodic functions of t.
//
// The wood is laid out in world space and seen through a camera that drifts
// slowly sideways, so near trunks slide past far ones. The sun is low and
// ahead: trunks throw long shadows toward the viewer and are rimmed on the
// side facing it, and the shafts are cast through whatever gaps the leaves
// leave around the sun, so they move when the canopy moves.
//
// No DOM in here: the same module renders in the browser and in Node.
// ---------------------------------------------------------------------------

import { TAU, R, GLOW, hex, mix, LUT, bay, bayerMaps, hash, vnoise, rng, clamp, smooth } from './pixel.js';

export const W = 384;
export const H = 216;
export const DURATION = 48;

const N = W * H;
const HY = 104;             // horizon row
const GH = H - HY;          // ground rows; also the camera height in world units
const F = 300;              // focal length: one unit of depth z is F world units
const SX = 240, SY = 56;    // the sun, low, behind the canopy
const PATH_HW = 62;         // path half-width in world units
const MARGIN = 34;          // extra ground baked either side for the camera drift
const GW = W + MARGIN * 2;

// --- dither -----------------------------------------------------------------

const [BAY, BAY2] = bayerMaps(W, H);

// --- the timeline -----------------------------------------------------------
// Everything periodic in DURATION so the loop is seamless.

const wave = (k, t, p = 0) => Math.sin(TAU * k * t / DURATION + p);

function windAt(t) {
  const gust = Math.exp(-(((t - 22) / 4) ** 2)) + Math.exp(-(((t - 22 + DURATION) / 4) ** 2));
  return 0.45 + 0.18 * wave(1, t) + 0.1 * wave(3, t, 1.2) + 0.9 * gust;
}

// The camera drifts sideways, as if on a slow slider. World units.
function camAt(t) { return 26 * wave(1, t, -Math.PI / 2) + 5 * wave(2, t, 0.8); }

// A cloud drifts over the sun around t = 30..44 and the wood dims.
function cloudX(t) { return -90 + ((t - 24) / 22) * 520; }
function sunAt(t) {
  const cx = cloudX(t) + 10;
  const cover = t > 22 && t < 48 ? smooth(0, 1, 1 - Math.abs(cx - SX) / 95) : 0;
  return 1 - 0.62 * cover;
}

// --- geometry ---------------------------------------------------------------
// Screen positions below are as seen from the camera's rest position; each
// frame shifts a thing at depth z by -camX / z.

const zOfRow = (y) => GH / (y - HY);
const rowOfZ = (z) => HY + GH / z;
// screen offset of the path centre at depth z: it swings right, then bends
// away left behind the trees.
function pathOx(z) { const s = Math.log(z); return -14 + 44 * Math.sin(s * 1.1); }
const pathLat = (z) => pathOx(z) * z;   // in world units

// Sunlight across the ground, in (X, depth*F): pointing away from the sun.
const TAN_ELEV = (HY - SY) / F;
const SUN_DX = (SX - W / 2) / F;
const SHD = (() => { const l = Math.hypot(SUN_DX, 1); return [-SUN_DX / l, -1 / l]; })();

// --- buffers ----------------------------------------------------------------

function makeLayer(n = N) {
  return {
    ramp: new Uint8Array(n), lvl: new Int8Array(n), depth: new Float32Array(n),
    kind: new Uint8Array(n), u: new Float32Array(n), v: new Float32Array(n), sun: new Float32Array(n),
  };
}
// kind: 0 sky, 1 ground, 2 trunk, 3 canopy (own shading), 4 plants & small things
// sun: how much direct sun a pixel can catch (ground light, trunk rim)

function plot(S, x, y, ramp, lvl, z, kind, sun = 0) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = y * W + x;
  if (z > S.depth[i]) return;
  S.ramp[i] = ramp; S.lvl[i] = clamp(Math.round(lvl), -4, 11); S.depth[i] = z; S.kind[i] = kind;
  S.u[i] = (x - W / 2) * z; S.v[i] = y * z; S.sun[i] = sun;
}

// --- bake: sky --------------------------------------------------------------

function bakeSky(S) {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const ds = Math.hypot(x - SX, (y - SY) * 1.15);
    let l = 1.6 + (y / HY) * 3 + 3.4 * Math.exp(-ds / 50) + 2.4 * Math.exp(-ds / 13);
    if (ds < 4.5) l = 11;
    S.ramp[i] = R.SKY; S.lvl[i] = clamp(Math.floor(l + BAY[i]), 0, 11);
    S.depth[i] = 1000; S.kind[i] = 0;
  }
}

// --- trees ------------------------------------------------------------------

function makeTrees(rand) {
  const trees = [];
  // the far wall: many thin trunks lost in the haze
  for (let k = 0; k < 170; k++) {
    const z = 14 + rand() * 50;
    trees.push({ x: -MARGIN + rand() * GW, z, w: 16, h: 620, lean: (rand() - 0.5) * 0.04, seed: k + 100 });
  }
  // the framing trees, placed by eye
  const hand = [
    { x: 14, z: 1.25, w: 30, top: -10 }, { x: 372, z: 1.15, w: 34, top: -10 },
    { x: 84, z: 2.4, w: 26, top: -10 }, { x: 300, z: 2.9, w: 28, top: -10 },
    { x: 136, z: 4.8, w: 22, top: -10 }, { x: 266, z: 6.3, w: 22, top: -10 },
    { x: 330, z: 4.2, w: 24, top: -10 }, { x: 44, z: 7.5, w: 20, h: 1300 },
    { x: 176, z: 9.5, w: 20, h: 1300 },
  ];
  hand.forEach((t, k) => trees.push({ lean: (k % 2 ? 1 : -1) * 0.015, h: 1400, seed: k + 1, ...t }));
  // and some in between, off the path
  for (let k = 0; k < 44; k++) {
    const z = 5 + rand() * 12;
    const x = -MARGIN + rand() * GW;
    if (Math.abs((x - W / 2) * z - pathLat(z)) < PATH_HW * 1.6) continue;
    trees.push({ x, z, w: 18, h: 1200, lean: (rand() - 0.5) * 0.05, seed: 50 + k });
  }
  for (const t of trees) {
    t.X = (t.x - W / 2) * t.z;           // world position
    t.H = t.top !== undefined ? 1600 : t.h;
  }
  return trees.sort((a, b) => b.z - a.z);
}

// A trunk is baked once into a sprite of pixels relative to its own column, so
// the camera can slide it by whole pixels without redrawing the bark.
function bakeTrunk(tr) {
  const px = [], py = [], rp = [], lv = [], rim = [];
  const put = (x, y, ramp, l, r) => { px.push(Math.round(x)); py.push(Math.round(y)); rp.push(ramp); lv.push(clamp(Math.round(l), -4, 11)); rim.push(r); };
  const baseY = rowOfZ(tr.z);
  const w = Math.max(1, tr.w / tr.z);
  const top = tr.top !== undefined ? tr.top : baseY - tr.h / tr.z;
  const side = Math.sign(SX - tr.x) || 1;       // the sun is ahead: the edge facing it catches a rim
  for (let y = Math.floor(top); y <= Math.ceil(baseY); y++) {
    const h = baseY - y;
    const cx = tr.lean * h;
    const hw = (w / 2) * (1 + 0.9 * Math.exp(-h / (w * 0.7)));
    for (let x = Math.floor(cx - hw); x <= Math.ceil(cx + hw); x++) {
      const t = (x + 0.5 - cx) / hw;
      if (t < -1.05 || t > 1.05) continue;
      const col = Math.round(x - cx + 40);
      // backlit: the face toward us is in shade, rounding off at both edges
      let l = 2 - Math.abs(t) * 0.9 - t * side * -0.5;
      l += (vnoise(col * 0.9, y * 0.12 * tr.z, tr.seed) - 0.5) * 1.8;     // vertical bark grain
      if (hash(col, Math.floor(y / 3), tr.seed) > 0.92) l -= 1;
      let ramp = R.BARK;
      const mossy = vnoise(col * 0.5, y * 0.15, tr.seed + 1);
      if (t * side < 0.1 && h < w * 3.2 * mossy + w * 0.5) { ramp = R.MOSS; l = 1.6 - Math.abs(t) + mossy * 1.5; }
      const edge = t * side;
      const r = edge > 0.45 ? smooth(0.45, 1, edge) * (hw > 1.5 ? 1 : 0.6) : 0;
      put(x, y, ramp, l + bay(x, y) * 0.5, r);
    }
  }
  // a few branch stubs on the near trees
  if (tr.z < 4) {
    const r = rng(tr.seed * 7);
    for (let k = 0; k < 3; k++) {
      const by = top + 20 + r() * (baseY - top) * 0.35;
      const dir = r() < 0.5 ? -1 : 1, len = (8 + r() * 12) / tr.z * 1.6;
      for (let j = 0; j < len; j++) {
        const cx = tr.lean * (baseY - by) + dir * (w / 2 + j);
        const yy = by - j * 0.6 - j * j * 0.02;
        const th = Math.max(1, (1 - j / len) * 3 / tr.z * 1.4);
        for (let q = 0; q < th; q++) put(cx, yy + q, R.BARK, 1.5 + (q === 0 ? 1 : 0), q === 0 && dir === side ? 0.7 : 0);
      }
    }
  }
  tr.sprite = { n: px.length, px: Int16Array.from(px), py: Int16Array.from(py), ramp: Uint8Array.from(rp), lvl: Int8Array.from(lv), rim: Float32Array.from(rim) };
}

function drawTrunk(S, tr, camX) {
  const sp = tr.sprite, z = tr.z;
  const ox = Math.round(tr.x - camX / z);
  for (let k = 0; k < sp.n; k++) {
    const x = ox + sp.px[k], y = sp.py[k];
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const i = y * W + x;
    if (z > S.depth[i]) continue;
    S.ramp[i] = sp.ramp[k]; S.lvl[i] = sp.lvl[k]; S.depth[i] = z; S.kind[i] = 2;
    S.u[i] = (x - W / 2) * z; S.v[i] = y * z; S.sun[i] = sp.rim[k];
  }
}

// --- bake: ground -----------------------------------------------------------
// Baked wider than the screen; each frame, every row is copied from its own
// offset, so near ground slides further than far ground.

function bakeGround(G, trees) {
  // trunks that can throw a visible shadow or sit in their own contact shade
  const casters = trees.filter((t) => t.z < 13);
  for (let y = HY + 1; y < H; y++) {
    const z = zOfRow(y), Z = z * F;
    const cx = W / 2 + pathOx(z);
    const hw = (PATH_HW / z) * (1 + 0.14 * (vnoise(z * 2.2, 0, 2) - 0.5));
    const grain = Math.min(1, 3 / z);
    for (let gx = 0; gx < GW; gx++) {
      const x = gx - MARGIN;
      const i = (y - HY - 1) * GW + gx;
      const u = (x - W / 2) * z, v = z * 100;
      const dist = Math.abs(x - cx) / hw;
      const ragged = vnoise(u / 16, v / 16, 3) * 0.5 + vnoise(u / 5, v / 5, 4) * 0.3;
      const edge = 0.92 + (ragged - 0.4) * 0.55;
      const g = (hash(Math.floor(u / 2), Math.floor(v / 2), 6) - 0.5) * grain;
      let ramp, l;
      if (dist < edge) {
        ramp = R.DIRT;
        l = 4.1 - dist * 1.6 + (vnoise(u / 5, v / 5, 5) - 0.5) * 1.1 + g * 1.6;
        if (dist < 0.45) l += 0.5;                                  // the worn line down the middle
        if (dist > edge - 0.12) l -= 1;                             // lip where grass overhangs
        const p = hash(Math.floor(u / 3), Math.floor(v / 3), 7);
        if (p > 0.975 && z < 12) { ramp = R.STONE; l = 4 + (p > 0.99 ? 1 : 0); }
        else if (p < 0.03 && z < 12) { ramp = R.GOLD; l = 1.5; }   // a fallen leaf
      } else {
        const n = vnoise(u / 22, v / 22, 8);
        ramp = n > 0.56 ? R.MOSS : R.GRASS;
        l = 2.5 + (vnoise(u / 4, v / 4, 9) - 0.5) * 2 + g * 1.4;
        if (dist < edge + 0.35) l -= 0.8;
        const f = hash(Math.floor(u / 2), Math.floor(v / 2), 11);
        if (z < 10) {
          if (f > 0.994) { ramp = R.WHITE; l = 6; }
          else if (f > 0.989) { ramp = R.GOLD; l = 5.5; }
          else if (f < 0.04) { ramp = R.DIRT; l = 2; }
        }
      }
      // trunk shadows run from each trunk straight back toward the viewer,
      // fanning out from the point under the sun; contact shade at the roots
      let shade = 0, ao = 0;
      for (const t of casters) {
        const dx = u - t.X, dz = Z - t.z * F;
        const along = dx * SHD[0] + dz * SHD[1];
        const rr = t.w * 0.5;
        const dd = Math.hypot(dx, dz * 0.5);
        if (dd < rr * 5) ao += Math.exp(-dd / (rr * 1.4));
        if (along < -rr) continue;
        const len = t.H / TAN_ELEV;
        if (along > len) continue;
        const perp = Math.abs(dx * SHD[1] - dz * SHD[0]);
        const half = rr * (1 + along / 1600);          // penumbra widens with distance
        const s = 1 - smooth(half * 0.8, half * 1.25, perp);
        shade = Math.max(shade, s * (1 - smooth(1200, 4200, along)) * 0.9);
      }
      l -= Math.min(1.6, ao * 1.2);
      // where the low sun reaches the floor through the opening
      const pool = Math.exp(-(((x - 214) / 120) ** 2 + ((y - 150) / 40) ** 2)) +
        0.6 * Math.exp(-(((x - 290) / 90) ** 2 + ((y - 195) / 34) ** 2)) + 0.15;
      G.ramp[i] = ramp; G.lvl[i] = clamp(Math.floor(l + bay(gx, y) * 0.999), -4, 11);
      G.u[i] = u; G.sun[i] = Math.min(1, pool) * (1 - shade);
    }
  }
}

function drawGround(S, G, camX) {
  for (let y = HY + 1; y < H; y++) {
    const z = zOfRow(y);
    const off = clamp(Math.round(MARGIN + camX / z), 0, MARGIN * 2);
    const src = (y - HY - 1) * GW + off, dst = y * W;
    S.ramp.set(G.ramp.subarray(src, src + W), dst);
    S.lvl.set(G.lvl.subarray(src, src + W), dst);
    S.u.set(G.u.subarray(src, src + W), dst);
    S.sun.set(G.sun.subarray(src, src + W), dst);
    S.depth.fill(z, dst, dst + W);
    S.kind.fill(1, dst, dst + W);
    S.v.fill(z * 100, dst, dst + W);
  }
}

// --- a stone or two and a ring of mushrooms ---------------------------------

function drawDetails(S, camX) {
  const stone = (x, y, rx, ry, z) => {
    x -= camX / z;
    for (let dy = -ry; dy <= 1; dy++) for (let dx = -rx; dx <= rx; dx++) {
      const d = (dx / rx) ** 2 + (dy / ry) ** 2;
      if (d > 1) continue;
      const lit = (dx / rx) * 0.3 - (dy / ry) * 0.5;
      const top = dy < -ry * 0.45;
      const rim = dy < -ry * 0.6 ? 0.8 : 0;             // the top edge catches the low sun
      plot(S, x + dx, y + dy, top && hash(dx, dy, 3) > 0.35 ? R.MOSS : R.STONE, 2.4 + lit * 1.6, z, 2, rim);
    }
    // its shadow, cast toward us
    for (let dx = -rx; dx <= rx; dx++) plot(S, x + dx - 1, y + 2, R.DIRT, 0, z - 0.02, 4);
  };
  stone(106, 200, 9, 6, 1.1);
  stone(118, 205, 5, 4, 1.05);
  stone(281, 150, 4, 3, 2.9);
  stone(171, 126, 2, 1, 5.5);

  const mush = (x, y, s, z) => {
    x = Math.round(x - camX / z);
    for (let j = 0; j < s + 1; j++) plot(S, x, y - j, R.WHITE, 3, z, 4);
    for (let dy = -s; dy <= 0; dy++) for (let dx = -s - 1; dx <= s + 1; dx++) {
      if ((dx / (s + 1.2)) ** 2 + ((dy + 0.2) / (s * 0.8)) ** 2 > 1) continue;
      const white = hash(dx, dy, x) > 0.84 && dy < 0;
      plot(S, x + dx, y - s - 1 + dy, white ? R.WHITE : R.MUSH, white ? 5 : 2.5 + dx * 0.25 - dy * 0.3, z - 0.01, 4);
    }
  };
  mush(336, 207, 3, 1.1);
  mush(345, 210, 2, 1.08);
  mush(328, 211, 1, 1.05);
}

// --- canopy -----------------------------------------------------------------

function gapAt(x, y) {
  const dx = (x - 226) / 70, dy = (y - 38) / 40;
  return Math.exp(-(dx * dx + dy * dy) * 1.6);
}

function makeClumps(rand) {
  const clumps = [];
  const add = (x, y, z, ramp, base, sway) => {
    const r = clamp((z > 12 ? 75 : 40) / z, 2.5, 30) * (0.7 + rand() * 0.6);
    // a clump is a handful of lobes, the lower ones drawn first so the upper,
    // sunnier ones sit on top of them
    const n = r < 4 ? 1 : 3 + Math.floor(rand() * 4);
    const lobes = [];
    for (let k = 0; k < n; k++) {
      const a = rand() * TAU, d = k === 0 ? 0 : r * (0.35 + rand() * 0.4);
      lobes.push({ ox: Math.cos(a) * d, oy: Math.sin(a) * d * 0.7, r: k === 0 ? r * 0.75 : r * (0.4 + rand() * 0.3) });
    }
    lobes.sort((p, q) => q.oy - p.oy);
    // leaves are lit through from behind: the rim toward the sun glows
    const sl = Math.hypot(SX - x, SY - y) || 1;
    clumps.push({ x, y, z, ramp, base, sway, r, lobes, phase: rand() * TAU, seed: (rand() * 1e6) | 0,
      lx: (SX - x) / sl, ly: (SY - y) / sl, rim: 0.35 + Math.exp(-sl / 70) * 1.6 });
  };
  // far crowns, sitting on the far trunks
  for (let k = 0; k < 2600; k++) {
    const z = 13 + rand() * 40;
    const x = -MARGIN + rand() * GW, y = HY - 380 / z - 2 - rand() * (520 / z);
    if (rand() < gapAt(x, y) * 0.8) continue;
    add(x, y, z, R.LEAF, 2.4, 0.35);
  }
  // mid canopy
  for (let k = 0; k < 560; k++) {
    const z = 4 + rand() * 9;
    const x = -MARGIN + rand() * GW, y = -10 + rand() * (HY - 380 / z + 14);
    if (rand() < gapAt(x, y) * 0.95) continue;
    add(x, y, z, R.LEAF, 1.8, 1.1);
  }
  // near overhang: heavy at the top and down both sides
  for (let k = 0; k < 160; k++) {
    const z = 1.3 + rand() * 2.4;
    const side = rand();
    let x, y;
    if (side < 0.55) { x = -30 + rand() * (W + 60); y = -24 + rand() * 38; }
    else if (side < 0.8) { x = -30 + rand() * 90; y = rand() * 110; }
    else { x = W - 70 + rand() * 100; y = rand() * 95; }
    if (rand() < gapAt(x, y) * 1.1) continue;
    add(x, y, z, R.LEAFD, 1.3, 2.6);
  }
  return clumps.sort((a, b) => b.z - a.z);
}

function drawClump(S, c, dx) {
  const cx = c.x + dx, cy = c.y + dx * 0.12;
  for (let li = 0; li < c.lobes.length; li++) {
    const lb = c.lobes[li];
    const rx = lb.r, ry = lb.r * 0.8;
    const bx = cx + lb.ox, by = cy + lb.oy;
    if (bx + rx < 0 || bx - rx >= W) continue;
    const ox = Math.round(bx), oy = Math.round(by);
    const lift = (li / c.lobes.length) * 0.7;          // upper lobes catch more light
    for (let y = Math.max(0, Math.floor(by - ry - 1)); y <= Math.min(H - 1, Math.ceil(by + ry + 1)); y++) {
      for (let x = Math.max(0, Math.floor(bx - rx - 1)); x <= Math.min(W - 1, Math.ceil(bx + rx + 1)); x++) {
        const lx = x - ox, ly = y - oy;          // lobe-local, so the texture travels with it
        const nx = lx / rx, ny = ly / ry;
        const d = Math.sqrt(nx * nx + ny * ny);
        const leaf = hash((lx + 64) >> 1, (ly + 64) >> 1, c.seed + li);
        if (d > 1 - (d > 0.5 ? leaf * 0.42 : 0)) continue;
        const i = y * W + x;
        if (c.z > S.depth[i]) continue;
        const top = -ny;                          // skylight from above
        const toward = nx * c.lx + ny * c.ly;     // facing the sun
        let l = c.base + lift + top * 0.9 + (leaf - 0.5) * 1.6 + (hash(lx, ly, c.seed) - 0.5) * 0.6;
        if (d > 0.72 && ny > 0.3) l -= 1;        // the underside of each lobe
        if (d > 0.6 && toward > 0.25) l += c.rim * 2.6 * (toward - 0.1);
        S.ramp[i] = c.ramp; S.lvl[i] = clamp(Math.round(l), -4, 11);
        S.depth[i] = c.z; S.kind[i] = 3;
      }
    }
  }
}

// --- undergrowth --------------------------------------------------------------

function makePlants(rand) {
  const ferns = [], tufts = [];
  const spot = (zMin, zMax, allowPath) => {
    for (;;) {
      const d = 1 / zMax + rand() * (1 / zMin - 1 / zMax);
      const z = 1 / d;
      const x = -MARGIN - 10 + rand() * (GW + 20);
      const off = Math.abs((x - W / 2) * z - pathLat(z)) / PATH_HW;
      if (off > 1.05 || (allowPath && off > 0.8)) return { x, z, y: rowOfZ(z) };
    }
  };
  for (let k = 0; k < 80; k++) {
    const p = spot(0.95, 14, false);
    const fr = 5 + Math.floor(rand() * 4);
    ferns.push({ ...p, s: 30 / p.z, phase: rand() * TAU, fronds: Array.from({ length: fr }, (_, j) => ({
      a: -1.35 + (2.7 * (j + 0.5)) / fr + (rand() - 0.5) * 0.25, len: 0.75 + rand() * 0.45,
    })) });
  }
  for (let k = 0; k < 720; k++) {
    const p = spot(0.9, 18, true);
    const n = 3 + Math.floor(rand() * 4);
    tufts.push({ ...p, phase: rand() * TAU, tone: rand() < 0.3 ? R.MOSS : R.GRASS, blades: Array.from({ length: n }, () => ({
      dx: (rand() - 0.5) * 5 / p.z, h: (6 + rand() * 11) / p.z * (p.z < 1.1 ? 1.8 : 1), lean: (rand() - 0.5) * 0.7,
    })) });
  }
  return { ferns, tufts };
}

function swayAt(t, wind, phase, k = 16) {
  return wind * (0.55 + 0.45 * wave(k, t, phase));
}

function drawFern(S, f, sway, camX) {
  const fx = f.x - camX / f.z;
  if (fx < -f.s * 1.5 || fx > W + f.s * 1.5) return;
  for (const fr of f.fronds) {
    const L = fr.len * f.s;
    const dx = Math.sin(fr.a), dy = -Math.cos(fr.a) * 0.85;
    const steps = Math.max(3, Math.ceil(L * 1.3));
    let px = fx, py = f.y;
    for (let j = 1; j <= steps; j++) {
      const t = j / steps;
      const x = fx + dx * L * t + sway * t * t * f.s * 0.12;
      const y = f.y + dy * L * t + t * t * L * 0.55 * (0.5 + Math.abs(dx));
      const tx = x - px, ty = y - py, tl = Math.hypot(tx, ty) || 1;
      plot(S, x, y, R.FERN, 1.6 + t * 2.4, f.z, 4, t);
      const ll = (1 - t * 0.85) * f.s * 0.2;
      const side = j % 2 ? 1 : -1;
      for (let m = 1; m <= ll; m++) {
        plot(S, x - (ty / tl) * m * side, y + (tx / tl) * m * side + m * 0.35, R.FERN, 2.6 + t * 2 - m * 0.25, f.z, 4, t);
      }
      px = x; py = y;
    }
  }
}

function drawTuft(S, tf, sway, camX) {
  const x0 = tf.x - camX / tf.z;
  if (x0 < -20 || x0 > W + 20) return;
  for (const b of tf.blades) {
    const h = b.h;
    for (let j = 0; j <= h; j++) {
      const t = j / h;
      // the tips are thin enough for the low sun to shine through
      plot(S, x0 + b.dx + (b.lean * t + sway * 0.25 * t * t) * h, tf.y - j, tf.tone, 1.2 + t * 4, tf.z, 4, t * t);
    }
  }
}

// --- small lives ------------------------------------------------------------

function makeLife(rand) {
  const leaves = Array.from({ length: 16 }, () => {
    const z = 2.2 + rand() * 6;
    return { z, x0: 40 + rand() * (W - 80), k: 1 + Math.floor(rand() * 3), phase: rand(), wob: rand() * TAU,
      gold: rand() < 0.55, y0: 10 + rand() * 30, y1: rowOfZ(z) - 1 };
  });
  const motes = Array.from({ length: 160 }, () => ({
    x: 60 + rand() * 280, y: 60 + rand() * 140, z: 1.5 + rand() * 8, k1: 1 + Math.floor(rand() * 3), k2: 1 + Math.floor(rand() * 3),
    p1: rand() * TAU, p2: rand() * TAU, tw: 3 + Math.floor(rand() * 8),
  }));
  return { leaves, motes };
}

const LEAF_FRAMES = [[[0, 0], [1, 0]], [[0, 0], [1, 1]], [[0, 0], [0, 1]], [[1, 0], [0, 1]]];

function drawLife(S, t, life, wind, camX) {
  for (const f of life.leaves) {
    const P = DURATION / f.k;
    const tau = ((t / P + f.phase) % 1 + 1) % 1;
    const x = f.x0 - camX / f.z + 14 * Math.sin(tau * TAU * 2 + f.wob) - 30 * tau * wind;
    const y = f.y0 + (f.y1 - f.y0) * tau;
    const fr = LEAF_FRAMES[Math.floor(tau * 60) % 4];
    for (const [a, b] of fr) plot(S, x + a, y + b, f.gold ? R.GOLD : R.LEAF, f.gold ? 4 : 5, f.z, 4, 1);
  }
  // two cabbage whites over the path
  const flies = [[205, 150, 0], [258, 172, 2.1]];
  for (const [bx, by, p] of flies) {
    const x0 = bx + 34 * wave(2, t, p) + 9 * wave(7, t, p * 2);
    const y = by + 13 * wave(3, t, p + 1) + 4 * wave(11, t, p);
    const z = zOfRow(Math.min(H - 1, y + 8));
    const x = x0 - camX / z;
    const open = Math.floor(t * 11 + p * 3) % 2 === 0;
    const px = open ? [[-1, -1], [1, -1], [-1, 0], [1, 0], [0, 0]] : [[0, -1], [0, 0]];
    for (const [a, b] of px) plot(S, x + a, y + b, R.WHITE, 5, z, 4, 1);
    // and a speck of shadow on the ground beneath
    plot(S, x - 1, rowOfZ(z) + 1, R.DIRT, 1, z + 0.01, 4);
  }
  // a pair of birds crossing the opening, dark against the glare
  for (let k = 0; k < 2; k++) {
    const tb = t - 9 - k * 0.7;
    if (tb < 0 || tb > 7) continue;
    const x = 150 + tb * 26 + k * 9, y = 40 - tb * 2 + k * 5 + Math.sin(tb * 2) * 2;
    const up = Math.floor(tb * 9) % 2 === 0;
    const px = up ? [[-2, -1], [-1, 0], [0, 0], [1, 0], [2, -1]] : [[-2, 1], [-1, 0], [0, 0], [1, 0], [2, 1]];
    for (const [a, b] of px) plot(S, x + a, y + b, R.BARK, 0, 30, 3);
  }
}

function drawCloud(S, t) {
  const cx = cloudX(t);
  if (cx < -100 || cx > W + 100) return;
  const blobs = [[0, 0, 34, 11], [-26, 5, 22, 8], [28, 4, 26, 8], [8, -8, 20, 9], [-8, 8, 30, 6]];
  for (let y = 0; y < HY; y++) for (let x = Math.max(0, Math.floor(cx - 70)); x < Math.min(W, cx + 70); x++) {
    const i = y * W + x;
    if (S.kind[i] !== 0) continue;
    let inside = 0, top = 0;
    for (const [bx, by, rx, ry] of blobs) {
      const d = ((x - cx - bx) / rx) ** 2 + ((y - SY + 4 - by) / ry) ** 2;
      if (d < 1) { inside = 1; top = Math.max(top, -(y - SY + 4 - by) / ry); }
    }
    if (!inside) continue;
    const near = Math.exp(-Math.hypot(x - SX, y - SY) / 30);
    S.lvl[i] = clamp(Math.floor(4.6 + top * 1.8 + near * 3.6 + BAY[i]), 0, 10);
  }
}

// --- static light & atmosphere ----------------------------------------------

function bakeAtmosphere() {
  const amb = new Float32Array(N), halo = new Float32Array(N), ang = new Uint16Array(N), env = new Float32Array(N);
  const haze = new Uint8Array(N * 3);
  const hzTop = hex('#8aa3a6'), hzLow = hex('#c4c8aa'), hzSun = hex('#f4e3b0');
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const vx = (x - W / 2) / (W / 2), vy = (y - H * 0.5) / (H * 0.55);
    amb[i] = -0.7 - 1.0 * (vx * vx * 0.55 + vy * vy * 0.45);
    if (y > H - 40) amb[i] -= (y - (H - 40)) / 40 * 0.6;           // the foreground sits in shade
    const r = Math.hypot(x - SX, (y - SY) * 1.1);
    halo[i] = Math.exp(-r / 9) * 0.9 + Math.exp(-r / 30) * 0.3;
    const a = Math.atan2(x - SX, y - SY);
    ang[i] = Math.min(BINS - 1, Math.floor(((a + Math.PI) / TAU) * BINS));
    // beams fall downward from the sun and fade as they spread
    env[i] = smooth(6, 30, r) * Math.exp(-r / 300) * smooth(0.2, 0.55, (y - SY) / (r + 1e-3));
    const c = mix(mix(hzTop, hzLow, clamp(y / HY, 0, 1)), hzSun, Math.exp(-r / 100) * 0.9);
    haze[i * 3] = c[0]; haze[i * 3 + 1] = c[1]; haze[i * 3 + 2] = c[2];
  }
  const mist = new Float32Array(4096), deep = new Float32Array(4096);
  for (let k = 0; k < 4096; k++) {
    const z = k / 32;
    mist[k] = 0.9 * (1 - Math.exp(-Math.max(0, z - 1.2) * 0.055));
    deep[k] = 1 - Math.exp(-Math.max(0, z - 0.6) * 0.3);   // how much lit air lies in front
  }
  return { amb, halo, ang, env, haze, mist, deep };
}

// --- sun shafts ---------------------------------------------------------------
// Beams are the gaps in whatever stands close around the sun. Each frame, rays
// are cast outward from the disc through the leaves and trunks near it; a ray
// that escapes through a hole carries a beam on down into the wood, one that
// is stopped leaves a wedge of shadow in the air. When the canopy sways, the
// holes open and close and the beams go with them.

const BINS = 1440;
const RING = 44;                 // how far out from the disc occluders count

function castBeams(S, prof, tmp, sun) {
  for (let b = 0; b < BINS; b++) {
    const a = (b / BINS) * TAU - Math.PI;
    const dx = Math.sin(a), dy = Math.cos(a);
    let T = 1;
    for (let r = 5; r < RING && T > 0.02; r += 0.75) {
      const x = Math.round(SX + dx * r), y = Math.round(SY + dy * r);
      if (x < 0 || y < 0 || x >= W || y >= H) break;
      const i = y * W + x;
      const k = S.kind[i];
      if (k === 0) continue;
      const z = S.depth[i];
      T *= z > 20 ? 0.985 : z > 12 ? 0.95 : z > 4 ? 0.5 : 0;   // far, thin crowns let most through
    }
    tmp[b] = T;
  }
  // a little angular blur: soft edges, no single-pixel sparkle
  for (let b = 0; b < BINS; b++) {
    const p = (b + BINS - 1) % BINS, n = (b + 1) % BINS;
    prof[b] = (tmp[p] + tmp[b] * 2 + tmp[n]) * 0.25 * sun;
  }
}

// --- the scene --------------------------------------------------------------

export function createScene() {
  const rand = rng(20260929);
  const sky = makeLayer();
  bakeSky(sky);
  const trees = makeTrees(rand);
  trees.forEach(bakeTrunk);
  const ground = makeLayer(GW * GH);
  bakeGround(ground, trees);
  const clumps = makeClumps(rand);
  const { ferns, tufts } = makePlants(rand);
  const life = makeLife(rand);
  const A = bakeAtmosphere();

  const S = makeLayer();
  const prof = new Float32Array(BINS), tmp = new Float32Array(BINS);
  const moteGlow = new Float32Array(N);
  const touched = [];

  function render(t, rgba) {
    const wind = windAt(t), sun = sunAt(t), camX = camAt(t);

    S.ramp.set(sky.ramp); S.lvl.set(sky.lvl); S.depth.set(sky.depth); S.kind.set(sky.kind);
    S.sun.fill(0);
    drawGround(S, ground, camX);
    for (const tr of trees) drawTrunk(S, tr, camX);
    drawDetails(S, camX);

    drawCloud(S, t);
    for (const c of clumps) {
      const s = c.sway * swayAt(t, wind, c.phase, c.z < 4 ? 9 : 14);
      drawClump(S, c, s * 1.6 - camX / c.z);
    }
    for (const f of ferns) drawFern(S, f, swayAt(t, wind, f.phase, 12) * (f.z < 2 ? 1.6 : 1), camX);
    for (const tf of tufts) drawTuft(S, tf, swayAt(t, wind, tf.phase + tf.x * 0.02, 18) * 3, camX);
    drawLife(S, t, life, wind, camX);

    // how much of the disc shows between the leaves: drives the glare
    let vis = 0, cnt = 0;
    for (let y = SY - 4; y <= SY + 4; y++) for (let x = SX - 4; x <= SX + 4; x++) {
      if ((x - SX) ** 2 + (y - SY) ** 2 > 18) continue;
      cnt++; const i = y * W + x;
      if (S.kind[i] === 0 && S.lvl[i] >= 10) vis++;
    }
    const glare = (0.25 + 0.75 * (vis / cnt)) * sun;

    castBeams(S, prof, tmp, 0.1 + 0.9 * clamp((sun - 0.38) / 0.62, 0, 1));

    // dust motes, visible only where they drift through a shaft
    for (const i of touched) moteGlow[i] = 0;
    touched.length = 0;
    for (const m of life.motes) {
      const x = Math.round(m.x - camX / m.z + 10 * wave(m.k1, t, m.p1) + 3 * wind * wave(7, t, m.p2));
      const y = Math.round(m.y + 7 * wave(m.k2, t, m.p2));
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = y * W + x;
      if (S.depth[i] < m.z) continue;
      const lit = prof[A.ang[i]] * A.env[i];
      const tw = 0.5 + 0.5 * wave(m.tw, t, m.p1);
      if (lit * tw > 0.04) { moteGlow[i] = Math.min(1, lit * tw * 5); touched.push(i); }
    }

    // dappled light drifts with the wind
    const ddx = 0.7 * wave(1, t) + wind * 0.22 * wave(9, t, 0.5);
    const ddy = 0.5 * wave(2, t, 1) + wind * 0.12 * wave(13, t);
    const skyShift = -1.0 * (1 - sun) / 0.62;
    const sunK = clamp((sun - 0.38) / 0.62, 0, 1);    // 1 in full sun, 0 under the cloud

    const lut = LUT, haze = A.haze;
    for (let i = 0; i < N; i++) {
      const k = S.kind[i];
      const sl = S.sun[i];
      let light;
      if (k === 0) light = skyShift;
      else if (k === 3) light = A.amb[i] * 0.6 - (1 - sun) * 1.4;
      else if (k === 2) {
        // backlit bark: only the rim facing the sun lights up, flickering with the leaves
        light = A.amb[i] - 0.2;
        if (sl > 0) {
          const n = vnoise(S.v[i] / 40 + ddy * 3, S.u[i] / 200, 23);
          light += sl * (1.5 + 5 * sunK * smooth(0.3, 0.55, n));
        }
      } else {
        light = A.amb[i];
        const n = vnoise(S.u[i] / 15 + ddx, S.v[i] / 15 + ddy, 21) * 0.65 + vnoise(S.u[i] / 5 + ddx * 2, S.v[i] / 5, 22) * 0.35;
        if (k === 1) {
          // sun on the floor: through the opening, cut by trunk shadows, broken by leaves
          // the pool of low sun, cut by trunk shadows and broken up by the leaves
          const leaf = smooth(0.4, 0.62, n);
          light += sl * (2.2 + 2.4 * leaf) * (0.2 + 0.8 * sunK) - 0.9 + (n > 0.7 ? 0.8 * sunK : 0);
        } else {
          // plants: backlit tips glow; dapple as on the ground
          light += sl * 1.4 * sunK + (n > 0.6 ? 1.2 * sunK : -0.2);
        }
      }
      const L = clamp(Math.floor(S.lvl[i] + light + BAY[i]), -4, 11);
      const e = (S.ramp[i] * 16 + L + 4) * 3;
      let r = lut[e], g = lut[e + 1], b = lut[e + 2];

      const zi = Math.min(4095, (S.depth[i] * 32) | 0);
      if (k !== 0) {
        const m = Math.floor((A.mist[zi] * (0.93 + 0.07 * sun)) * 6 + BAY2[i]) / 6;
        if (m > 0) {
          r += (haze[i * 3] - r) * m; g += (haze[i * 3 + 1] - g) * m; b += (haze[i * 3 + 2] - b) * m;
        }
      }
      const glow = prof[A.ang[i]] * A.env[i] * 1.7 * (k === 0 ? 0.3 : A.deep[zi]) + A.halo[i] * glare + moteGlow[i];
      if (glow > 0) {
        const q = Math.min(1, Math.floor(glow * 6 + BAY2[i]) / 6) * 0.8;
        if (q > 0) { r += (GLOW[0] - r) * q; g += (GLOW[1] - g) * q; b += (GLOW[2] - b) * q; }
      }
      const o = i * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
    }
  }

  return { render };
}
