// ---------------------------------------------------------------------------
// The wood, seen by a walker. The same pipeline as the film: every pixel holds
// a material ramp and a shade level, light is a shift of that level, and fog,
// glare and sun shafts are dithered blends in one resolve pass at the end.
//
// What changes is that nothing is placed by eye any more. The floor is cast
// row by row from the world's noise fields; trees, plants and stones come
// from the world's cells and are projected each frame; trunk shadows are cut
// out of each floor row analytically; and beyond the near wood a 360-degree
// panorama of far trunks and crowns stands in for the rest of the forest.
//
// The sun keeps one bearing in the world, so turning toward it brings the
// backlit, shaft-filled view of the film, and turning away lights the trunks
// from the front.
//
// No DOM in here: the same module renders in the browser and in Node.
// ---------------------------------------------------------------------------

import { TAU, R, hex, mix, makeLUT, bayerMaps, hash, vnoise, rng, clamp, smooth } from '../pixel.js';
import { CELL, TRAIL_HW, SUN_AZ, SP, MUSH, PLANT } from './world.js';

// Everything measured in pixels comes from one scale, PX: 1 is the original
// 384x216 frame, 2 is 768x432. Distances in the world never change with it.
// Depth z is world units per pixel (Z / F), so where a test means "how far
// away" rather than "how big on screen" it reads z * PX: the same at any scale.
export let PX, W, H, LOOK, PITCH_MAX;
let N, HY, F, SY, PW, GXW, CONE, GYH, RING, BAY, BAY2, TW, TH;
const GH = 112;             // camera height in world units
const ZMAX = 6600;          // the near wood is drawn out to here
const PLANT_Z = 2900;       // grass, ferns and small things out to here
const SHADOW_LEN = 3400;    // trunk shadows fade out by here
const BINS = 1440;
const TS = 4, TILE = 1 << TS;   // occlusion tiles, 16px square

// Set the frame size before making a renderer.
export function setScale(s = 2) {
  PX = s;
  W = 384 * s; H = 216 * s; N = W * H;
  HY = 104 * s;             // horizon row
  F = 300 * s;              // focal length
  SY = 56 * s;              // the sun's row when it is in view
  PW = Math.round(TAU * F); // panorama columns: one per pixel at screen centre
  GXW = W * 3;              // sun-relative lookup grids span +-1.5 screens
  RING = 44 * s;            // how far out from the sun the shafts are traced
  CONE = (W / 2) / F;       // tan of the half field of view
  // Looking up and down shears the view: the horizon and the sun slide up and
  // down the frame by up to LOOK rows, and everything else is drawn relative to them.
  LOOK = 200 * s;
  PITCH_MAX = Math.atan(LOOK / F);
  GYH = H + 2 * LOOK;       // rows in the sun-relative grids
  [BAY, BAY2] = bayerMaps(W, H);
  TW = Math.ceil(W / TILE); TH = Math.ceil(H / TILE);
}
setScale(2);

const wrap = (a) => a - TAU * Math.floor((a + Math.PI) / TAU);

// The game's own light: shade falls toward a warm umber rather than the film's
// night blue, strong light climbs toward a buttery gold, and lit air glows amber.
const GLUT = makeLUT(hex('#16130c'), hex('#fff0bf'));
const GLOW = hex('#ffdf9e');
// How much of a texture feature of size p (world units) to keep when one pixel
// spans fp world units. Point-sampling detail finer than a pixel is what makes
// it shimmer as the view moves, so it fades out first, as a mipmap would.
const band = (p, fp) => 1 - smooth(p * 0.35, p * 0.8, fp);

// --- the weather ---------------------------------------------------------------

const wave = (p, t, ph = 0) => Math.sin(TAU * t / p + ph);
function windAt(t) {
  const g = (t % 61) - 30;
  return 0.45 + 0.18 * wave(48, t) + 0.1 * wave(16, t, 1.2) + 0.9 * Math.exp(-((g / 4) ** 2));
}
// now and then a cloud slides over the sun and the wood dims
const CLOUD_P = 83;
const cloudOff = (t) => -300 + (((t + 40) % CLOUD_P) / 22) * 520;
function sunAt(t) {
  const c = cloudOff(t) + 10;
  return 1 - 0.3 * smooth(0, 1, 1 - Math.abs(c) / 95);   // a thin cloud: the wood dims, never goes grey
}
const swayAt = (t, wind, phase, p = 3) => wind * (0.55 + 0.45 * wave(p, t, phase));

// --- layers --------------------------------------------------------------------

function makeLayer(w, h, tiles = false) {
  const n = w * h;
  // depth at full precision: things standing at the same distance (a trunk and
  // its own boughs) must tie exactly, so the one drawn later always wins. In
  // single precision the rounding decided, differently every frame.
  const L = { w, ramp: new Uint8Array(n), lvl: new Int8Array(n), depth: new Float64Array(n),
    kind: new Uint8Array(n), u: new Float32Array(n), v: new Float32Array(n), sun: new Float32Array(n), tmax: null, tdirty: null };
  if (tiles) { L.tmax = new Float64Array(TW * TH); L.tdirty = new Uint8Array(TW * TH); }
  return L;
}

// --- occlusion tiles -----------------------------------------------------------------
// The farthest depth in each 16px tile. Things are drawn nearest first, so a far
// crown is mostly hidden by the time it is drawn: if everything in a tile is
// already nearer than it, the whole tile is skipped without testing a pixel.
// Tiles only ever skip work, so the picture is the same as without them.

// every depth write marks its tile, to be measured again before it is relied on
const touch = (S, x, y) => { if (S.tdirty) S.tdirty[(y >> TS) * TW + (x >> TS)] = 1; };
function measureTile(S, t) {
  const tx = (t % TW) * TILE, ty = ((t / TW) | 0) * TILE;
  let m = 0;
  for (let y = ty, ye = Math.min(H, ty + TILE); y < ye; y++) for (let i = y * W + tx, ie = y * W + Math.min(W, tx + TILE); i < ie; i++) if (S.depth[i] > m) m = S.depth[i];
  S.tmax[t] = m; S.tdirty[t] = 0;
}
function measureTiles(S, all = false) {
  for (let t = 0; t < TW * TH; t++) if (all || S.tdirty[t]) measureTile(S, t);
}
// is anything in the tile under (x, y) farther than z?
const open = (S, x, y, z) => !S.tmax || S.tmax[(y >> TS) * TW + (x >> TS)] >= z;
// kind: 0 sky, 1 floor, 2 bark & stone, 3 leaves (own shading), 4 plants, 5 glints

// --- static light & atmosphere ---------------------------------------------------

function bakeAtmosphere() {
  // ambient: the frame's edges and foot sit in shade
  const amb = new Float32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const vx = (x - W / 2) / (W / 2), vy = (y - H * 0.5) / (H * 0.55);
    let a = -0.4 - 1.0 * (vx * vx * 0.55 + vy * vy * 0.45);
    if (y > H - 40 * PX) a -= (y - (H - 40 * PX)) / (40 * PX) * 0.6;
    amb[y * W + x] = a;
  }
  // everything that hangs off the sun's position, on a grid keyed by the
  // offset from it, so it can be looked up wherever the sun has turned to
  const n = GXW * GYH;
  const skyl = new Float32Array(n), halo = new Float32Array(n), env = new Float32Array(n), hz = new Float32Array(n), bloom = new Float32Array(n);
  const ang = new Uint16Array(n);
  for (let gy = 0; gy < GYH; gy++) for (let gx = 0; gx < GXW; gx++) {
    const i = gy * GXW + gx, dx = gx - GXW / 2, dy = gy - LOOK - SY;
    const ang0 = Math.atan2(dx, dy);
    // distances from the sun, in original pixels so the look is the same at any scale
    const ds = Math.hypot(dx, dy * 1.15) / PX;
    skyl[i] = ds < 4.5 ? 99 : 3.4 * Math.exp(-ds / 50) + 2.4 * Math.exp(-ds / 13);
    const r = Math.hypot(dx, dy * 1.1) / PX;
    halo[i] = Math.exp(-r / 9) * 0.9 + Math.exp(-r / 30) * 0.3;
    // the warm bloom of a low sun: wide, and there whether or not the disc shows
    bloom[i] = Math.exp(-r / 120) * 0.32 + Math.exp(-r / 45) * 0.12;
    ang[i] = Math.min(BINS - 1, Math.floor(((ang0 + Math.PI) / TAU) * BINS));
    env[i] = smooth(6, 30, r) * Math.exp(-r / 300) * smooth(0.2, 0.55, dy / PX / (r + 1e-3));
    hz[i] = Math.exp(-r / 100) * 0.9;
  }
  // keyed like the grids: row y of the frame reads row y - shift + LOOK
  const hzTop = hex('#a9b59c'), hzLow = hex('#dad1a3');
  const hzRow = new Float32Array(GYH * 3);
  for (let gy = 0; gy < GYH; gy++) { const c = mix(hzTop, hzLow, clamp((gy - LOOK) / HY, 0, 1)); hzRow.set(c, gy * 3); }
  const mist = new Float32Array(4096), deep = new Float32Array(4096);
  for (let k = 0; k < 4096; k++) {
    const z = k / 32;
    mist[k] = 0.9 * (1 - Math.exp(-Math.max(0, z - 1.2) * 0.055));
    deep[k] = 1 - Math.exp(-Math.max(0, z - 0.6) * 0.3);
  }
  return { amb, skyl, halo, env, hz, bloom, ang, hzRow, hzSun: hex('#fadb9a'), mist, deep };
}

// --- leaves ----------------------------------------------------------------------
// A clump is a handful of round lobes, the lower ones drawn first so the upper,
// sunnier ones sit on top. Sizes are in world units; the leaf texture is keyed
// to pixels relative to each lobe so it travels with it and never swims.

function makeLobes(r, rad) {
  const n = rad < 30 ? 2 : 3 + Math.floor(r() * 4);
  const lobes = [];
  for (let k = 0; k < n; k++) {
    const a = r() * TAU, d = k === 0 ? 0 : rad * (0.35 + r() * 0.4);
    lobes.push({ ox: Math.cos(a) * d, oy: Math.sin(a) * d * 0.7, r: k === 0 ? rad * 0.75 : rad * (0.4 + r() * 0.3) });
  }
  return lobes.sort((p, q) => q.oy - p.oy);
}

// light: { lx, ly, rim, front } for this clump this frame
function drawLobes(S, lobes, cx, cy, z, ramp, base, seed, light, Wd = W, wrapX = false, shrink = 1) {
  const n = lobes.length;
  for (let li = 0; li < n; li++) {
    const lb = lobes[li];
    const rx = Math.max(0.6, (lb.r / z) * shrink), ry = rx * 0.8;
    const bx = cx + lb.ox / z, by = cy + lb.oy / z;
    if (!wrapX && (bx + rx < 0 || bx - rx >= Wd)) continue;
    const ox = Math.round(bx), oy = Math.round(by);
    const lift = (li / n) * 0.7;
    const y0 = Math.max(0, Math.floor(by - ry - 1)), y1 = Math.min(H - 1, Math.ceil(by + ry + 1));
    let x0 = Math.floor(bx - rx - 1), x1 = Math.ceil(bx + rx + 1);
    if (!wrapX) { x0 = Math.max(0, x0); x1 = Math.min(Wd - 1, x1); }
    for (let y = y0; y <= y1; y++) {
      // only the span of this row inside the ellipse
      const ny0 = (y - oy) / ry;
      if (ny0 * ny0 > 1) continue;
      const half = rx * Math.sqrt(1 - ny0 * ny0);
      let xa = Math.ceil(ox - half), xb = Math.floor(ox + half);
      if (!wrapX) { xa = Math.max(xa, x0); xb = Math.min(xb, x1); }
      for (let x = xa; x <= xb; x++) {
        if (!wrapX && ((x & (TILE - 1)) === 0 || x === xa) && !open(S, x, y, z)) { x |= TILE - 1; continue; }
        const lx = x - ox, ly = y - oy;
        const nx = lx / rx, ny = ly / ry;
        const d2 = nx * nx + ny * ny;
        if (d2 > 1) continue;
        const xx = wrapX ? ((x % Wd) + Wd) % Wd : x;
        const i = y * Wd + xx;
        if (z > S.depth[i]) continue;
        const d = Math.sqrt(d2);
        const leaf = hash((lx + 64) >> 1, (ly + 64) >> 1, seed + li);
        if (d > 0.5 && d > 1 - leaf * 0.42) continue;
        const top = -ny;
        const toward = nx * light.lx + ny * light.ly;
        let l = base + lift + top * 0.9 + (leaf - 0.5) * 1.6 + (hash(lx, ly, seed) - 0.5) * 0.6;
        if (d > 0.72 && ny > 0.3) l -= 1;
        if (d > 0.6 && toward > 0.25) l += light.rim * 2.6 * (toward - 0.1);
        l += light.front * (0.5 + 0.6 * top);
        S.ramp[i] = ramp; S.lvl[i] = clamp(Math.round(l), -4, 11);
        S.depth[i] = z; S.kind[i] = 3; touch(S, xx, y);
      }
    }
  }
}

// --- the far wood -------------------------------------------------------------------
// A ring of thin trunks and small crowns lost in the haze, baked once. It turns
// with the walker but does not come nearer: it is the rest of the forest.

function bakePanorama(seed) {
  const P = makeLayer(PW, H);
  P.depth.fill(1e9);
  const rand = rng(seed * 31 + 5);
  const sunCol = (SUN_AZ / TAU) * PW;
  // laid out in original pixels (z is the original depth), then scaled by PX;
  // depths are stored as z / PX like everything else
  const nearSun = (x, y) => {
    let dx = Math.abs(x - sunCol) % PW; dx = Math.min(dx, PW - dx);
    return Math.exp(-((dx / (80 * PX)) ** 2) * 1.6 - (((y - 38 * PX) / (40 * PX)) ** 2) * 1.6);
  };
  for (let k = 0; k < 760; k++) {
    const z = 20 + rand() * 42, x = Math.floor(rand() * PW), baseY = HY + (GH / z) * PX;
    const top = baseY - (620 / z) * PX;
    for (let y = Math.max(0, Math.floor(top)); y <= Math.ceil(baseY); y++) for (let xx = x; xx < x + PX; xx++) {
      const i = y * PW + (xx % PW);
      if (z / PX > P.depth[i]) continue;
      P.ramp[i] = R.BARK; P.lvl[i] = clamp(Math.round(2 + (vnoise(x / PX, (y / PX) * 0.3, 7) - 0.5) * 1.6), -4, 11);
      P.depth[i] = z / PX; P.kind[i] = 2;
    }
  }
  const clumps = [];
  for (let k = 0; k < 10500; k++) {
    const z = 20 + rand() * 40;
    const x = rand() * PW, y = HY - (380 / z + 2 + rand() * (520 / z)) * PX;
    if (rand() < nearSun(x, y) * 0.8) continue;
    const r = clamp(75 / z, 2.5, 30) * (0.7 + rand() * 0.6);
    clumps.push({ x, y, z: z / PX, r, lobes: makeLobes(rand, r * z), seed: (rand() * 1e6) | 0 });
  }
  clumps.sort((a, b) => b.z - a.z);
  for (const c of clumps) {
    let dx = sunCol - c.x; dx -= PW * Math.round(dx / PW);
    const dy = SY - c.y, sl = Math.hypot(dx, dy) / PX || 1;
    const light = { lx: dx / PX / sl, ly: dy / PX / sl, rim: 0.35 + Math.exp(-sl / 70) * 1.6, front: 0 };
    drawLobes(P, c.lobes, c.x, c.y, c.z, R.LEAF, 2.4, c.seed, light, PW, true);
  }
  // which rows hold anything at all
  let y0 = H, y1 = 0;
  for (let i = 0; i < PW * H; i++) if (P.kind[i]) { const y = (i / PW) | 0; y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  P.y0 = y0; P.y1 = y1;
  return P;
}

// --- crowns ---------------------------------------------------------------------------

function crownOf(t) {
  if (t.crown) return t.crown;
  const r = rng(t.seed);
  if (t.sp === SP.PINE) {
    // A spruce grows a whorl of boughs each year: a ring of them at one height,
    // each pointing its own way, with a few shorter ones between whorls. Every
    // bough is its own length, rise and droop, and now and then one is missing,
    // so the outline is ragged and different from every side.
    const R0 = 150 + r() * 80, h0 = t.H * (0.13 + r() * 0.12), top = t.H + 40, span = top - h0;
    const shape = 0.65 + r() * 0.45;                  // < 1 a fuller, columnar crown; > 1 a slender cone
    const whorls = 10 + Math.floor(r() * 5);
    const boughs = [];
    const bough = (hb, phi, L, small) => boughs.push({
      hb, phi, L, small,
      rise: 0.08 + r() * 0.2, droop: 0.3 + r() * 0.35,
      sw: L * (0.3 + r() * 0.14), th: (small ? 8 : 11) + r() * 7, seed: (r() * 1e6) | 0,
    });
    let phase = r() * TAU;
    for (let k = 0; k < whorls; k++) {
      const q = (k + 0.5 + (r() - 0.5) * 0.45) / whorls;          // 0 at the tip
      const hb = top - 30 - span * Math.pow(q, 1.12);
      const Lw = R0 * Math.pow(q, shape) + 18;
      const n = 4 + Math.floor(r() * 3 + q * 2);
      phase += 2.4;                                                // the golden turn between whorls
      for (let j = 0; j < n; j++) {
        if (q > 0.2 && r() < 0.12) continue;                       // a lost bough leaves a gap
        bough(hb, phase + (j + (r() - 0.5) * 0.6) * TAU / n, Lw * (0.7 + r() * 0.45), false);
      }
      // shorter boughs in the space under the whorl
      if (k < whorls - 1) for (let j = 0, m = 1 + Math.floor(r() * 3); j < m; j++)
        bough(hb - span / whorls * (0.35 + r() * 0.4), r() * TAU, Lw * (0.35 + r() * 0.3), true);
    }
    t.crown = { pine: true, h0, top, R: R0 * 1.2 + 30, span, boughs, coreR: R0 * 0.16 };
    return t.crown;
  }
  const birch = t.sp === SP.BIRCH;
  const clumps = [];
  const add = (h, spread, rad, ramp, base, sway) => {
    const a = r() * TAU, d = Math.sqrt(r()) * spread;
    clumps.push({ ox: Math.cos(a) * d + t.lx * h, oz: Math.sin(a) * d + t.lz * h, h, ramp, base, sway,
      lobes: makeLobes(r, rad), phase: r() * TAU, seed: (r() * 1e6) | 0 });
  };
  const n = birch ? 8 + Math.floor(r() * 4) : 10 + Math.floor(r() * 5);
  for (let k = 0; k < n; k++) {
    const q = r();
    add(t.H * (0.42 + q * 0.58), (birch ? 140 : 270) * (1.1 - q * 0.6), birch ? 70 + r() * 55 : 120 + r() * 110, R.LEAF, birch ? 2.8 : 2.1, 1);
  }
  // low limbs on the oaks reach out over the walker
  if (!birch) {
    const low = Math.floor(r() * 3.2);
    for (let k = 0; k < low; k++) {
      add(300 + r() * 330, 0, 70 + r() * 80, R.LEAF, 1.6, 2.4);
      // pushed out along a limb that leaves the trunk a little lower down
      const c = clumps[clumps.length - 1], a = r() * TAU, d = 150 + r() * 170;
      c.ox += Math.cos(a) * d; c.oz += Math.sin(a) * d;
      c.limb = { h0: c.h - 60 - r() * 120, th: 5 + r() * 4 };
    }
  }
  t.crown = { clumps };
  return t.crown;
}

// --- the scene ----------------------------------------------------------------------------

export function createRenderer(world) {
  const A = bakeAtmosphere();
  const P = bakePanorama(world.seed);
  const S = makeLayer(W, H, true);
  const prof = new Float32Array(BINS), tmp = new Float32Array(BINS);
  const moteGlow = new Float32Array(N);
  const touched = [];
  const shadeRow = new Float32Array(W), aoRow = new Float32Array(W);
  const STEP = 4 * PX, trailRow = new Float32Array(W / STEP + 2), openRow = new Float32Array(W / STEP + 2);
  const dapRow = new Float32Array(W / STEP + 2), dap = new Float32Array(N);
  const n16Row = new Float32Array(W / STEP + 2), n24Row = new Float32Array(W / STEP + 2), n30Row = new Float32Array(W / STEP + 2), n40Row = new Float32Array(W / STEP + 2);
  const colAng = Float64Array.from({ length: W }, (_, x) => Math.atan((x + 0.5 - W / 2) / F));
  const life = makeLife();
  let casters = new Float64Array(4 * 4096);
  let glareS = 0, glareT = null;

  function render(st, rgba) {
    const { x: px, z: pz, heading, t } = st;
    const eye = st.eye ?? GH;
    // looking up slides the horizon (and the sun) down the frame
    const shift = Math.round(clamp(F * Math.tan(st.pitch ?? 0), -LOOK, LOOK));
    const hy = HY + shift, sy = SY + shift, gRow = LOOK - shift;
    const fx = Math.sin(heading), fz = Math.cos(heading);
    const rx = Math.cos(heading), rz = -Math.sin(heading);
    const toCamZ = (x, z) => (x - px) * fx + (z - pz) * fz;
    const toCamX = (x, z) => (x - px) * rx + (z - pz) * rz;

    // where the sun stands relative to the view
    const a = wrap(SUN_AZ - heading), sa = Math.sin(a), ca = Math.cos(a);
    const SX = ca > 0.03 ? clamp(W / 2 + F * sa / ca, -4000 * PX, 4000 * PX) : sa > 0 ? 4000 * PX : -4000 * PX;
    const sxi = Math.round(SX);
    const back = Math.max(0, ca), front = Math.max(0, -ca);
    const sunOn = 1 - smooth(W * 0.5, W * 1.1, Math.abs(SX - W / 2));
    // the bloom of a low sun still warms that side of the sky when it is just out of frame
    const bloomOn = 1 - smooth(W * 0.5, W * 1.5, Math.abs(SX - W / 2));
    const wind = windAt(t), sun = sunAt(t), sunK = clamp((sun - 0.38) / 0.62, 0, 1);
    const gOff = GXW / 2 - sxi;        // grid column of screen x is x + gOff
    const gcol = (x) => (x + gOff < 0 ? 0 : x + gOff >= GXW ? GXW - 1 : x + gOff);
    // the light on a lump of leaves at screen (x, y)
    const leafLight = (x, y) => {
      const dx = SX - x, dy = sy - y, sl = Math.hypot(dx, dy) || 1;
      return { lx: dx / sl, ly: dy / sl, rim: (0.35 + Math.exp(-sl / (70 * PX)) * 1.6) * back * back, front: front * 0.9 };
    };

    // --- sky
    for (let y = 0; y <= Math.min(hy, H - 1); y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, g = A.skyl[(y + gRow) * GXW + gcol(x)];
      const l = g > 50 ? (sunOn > 0.5 ? 11 : 6) : 1.6 + Math.max(-0.9, ((y - shift) / HY) * 3) + g;
      S.ramp[i] = R.SKY; S.lvl[i] = clamp(Math.floor(l + BAY[i]), 0, 11);
      S.depth[i] = 1000; S.kind[i] = 0; S.sun[i] = 0;
    }
    drawCloud(S, SX, sy, hy, t);

    // --- what stands within reach this frame
    const vis = { trees: [], bushes: [], ferns: [], tufts: [], rocks: [], logs: [], stumps: [], mush: [], plants: [] };
    const inView = (Z, X, pad) => Z > -pad && Z < ZMAX + pad && Math.abs(X) < Math.max(0, Z) * CONE + pad;
    world.forCells(px, pz, ZMAX, (c, cx, cz) => {
      const ox = (cx + 0.5) * CELL, oz = (cz + 0.5) * CELL;
      const Zc = toCamZ(ox, oz), Xc = toCamX(ox, oz);
      if (!inView(Zc, Xc, CELL * 1.6)) return;
      const near = Zc < PLANT_Z + CELL;
      for (const tr of c.trees) {
        tr._Z = toCamZ(tr.x, tr.z); tr._X = toCamX(tr.x, tr.z);
        if (inView(tr._Z, tr._X, 400) && tr._Z > 20) vis.trees.push(tr);
      }
      for (const k of ['bushes', 'rocks', 'logs', 'stumps', 'mush', 'plants', ...(near ? ['ferns', 'tufts'] : [])]) {
        for (const o of c[k]) {
          o._Z = toCamZ(o.x, o.z); o._X = toCamX(o.x, o.z);
          if (k === 'logs' || (o._Z > 15 && o._Z < (k === 'bushes' || k === 'rocks' ? ZMAX : PLANT_Z) && Math.abs(o._X) < o._Z * CONE + 120)) vis[k].push(o);
        }
      }
    });

    // --- trunk shadows: every trunk whose shadow can fall in view
    const Dx = -Math.sin(SUN_AZ), Dz = -Math.cos(SUN_AZ);   // away from the sun
    const Nx = -Dz, Nz = Dx;
    let nc = 0;
    world.forCells(px, pz, SHADOW_LEN + 200, (c) => {
      for (const tr of c.trees) {
        const Za = toCamZ(tr.x, tr.z), Zb = Za + SHADOW_LEN * (Dx * fx + Dz * fz);
        if (Za < -400 && Zb < -400) continue;
        const Xa = toCamX(tr.x, tr.z), Xb = Xa + SHADOW_LEN * (Dx * rx + Dz * rz);
        const ma = Math.max(0, Za) * CONE + 300, mb = Math.max(0, Zb) * CONE + 300;
        if ((Xa > ma && Xb > mb) || (Xa < -ma && Xb < -mb)) continue;
        if (nc * 4 >= casters.length) { const nb = new Float64Array(casters.length * 2); nb.set(casters); casters = nb; }
        casters[nc * 4] = tr.x; casters[nc * 4 + 1] = tr.z; casters[nc * 4 + 2] = tr.w * 0.5; nc++;
      }
      for (const s of c.stumps) {
        if (nc * 4 >= casters.length) continue;
        casters[nc * 4] = s.x; casters[nc * 4 + 1] = s.z; casters[nc * 4 + 2] = -s.w * 0.5; nc++;   // negative: short shadow
      }
    });
    const a1 = rx * Dx + rz * Dz, p1 = rx * Nx + rz * Nz;

    // --- the floor, cast row by row
    // dappled light drifts with the wind (the resolve reads its broad part from here)
    const ddx = 0.7 * wave(48, t) + wind * 0.22 * wave(5.3, t, 0.5);
    const ddy = 0.5 * wave(24, t, 1) + wind * 0.12 * wave(3.7, t);
    for (let y = Math.max(0, hy + 1); y < H; y++) {
      const z = eye / (y - hy), Z = z * F;
      const bx = px + fx * Z, bz = pz + fz * Z;
      // fine texture fades out before it gets small enough to alias. A row of
      // floor is foreshortened: one pixel spans fp world units along the view.
      const fp = (z * z * F) / eye;
      // grain, pebbles and flowers are kept a little past the limit: near the
      // feet they read as texture, and they are gone before they sparkle
      const b2 = band(5, fp), b3 = band(7, fp), b6 = band(6, fp), b7 = band(7, fp), b8 = band(8, fp), b16 = band(16, fp), b24 = band(24, fp), b40 = band(40, fp);
      shadeRow.fill(0); aoRow.fill(0);
      for (let k = 0; k < nc; k++) {
        const ex = bx - casters[k * 4], ez = bz - casters[k * 4 + 1];
        let rr = casters[k * 4 + 2];
        const len = rr < 0 ? 300 : SHADOW_LEN;
        rr = Math.abs(rr);
        const ao2 = rr * rr * 25, aoK = 1 / (rr * 1.4);
        const a0 = ex * Dx + ez * Dz, p0 = ex * Nx + ez * Nz;
        const hmax = rr * (1 + len / 2000) * 1.25 + 1;
        let lo = -1e9, hi = 1e9;
        if (Math.abs(p1) < 1e-9) { if (Math.abs(p0) > Math.max(hmax, rr * 5)) continue; }
        else { const m = Math.max(hmax, rr * 5), s1 = (-m - p0) / p1, s2 = (m - p0) / p1; lo = Math.max(lo, Math.min(s1, s2)); hi = Math.min(hi, Math.max(s1, s2)); }
        if (Math.abs(a1) < 1e-9) { if (a0 < -rr * 5 || a0 > len) continue; }
        else { const s1 = (-rr * 5 - a0) / a1, s2 = (len - a0) / a1; lo = Math.max(lo, Math.min(s1, s2)); hi = Math.min(hi, Math.max(s1, s2)); }
        if (lo > hi) continue;
        // every other pixel: the penumbra is soft and the dither hides the rest
        const x0 = Math.max(0, Math.floor(W / 2 + lo / z)) & ~1, x1 = Math.min(W - 1, Math.ceil(W / 2 + hi / z));
        for (let x = x0; x <= x1; x += 2) {
          const s = (x + 1 - W / 2) * z;
          const al = a0 + a1 * s, pe = p0 + p1 * s;
          const d2 = al * al + pe * pe;
          if (d2 < ao2) aoRow[x] += Math.exp(-Math.sqrt(d2) * aoK);
          if (al < -rr || al > len) continue;
          const half = rr * (1 + al / 2000), ape = pe < 0 ? -pe : pe;
          if (ape >= half * 1.25 || shadeRow[x] >= 0.9) continue;
          const sh = (1 - smooth(half * 0.8, half * 1.25, ape)) * (1 - smooth(len * 0.28, len, al)) * 0.9;
          if (sh > shadeRow[x]) shadeRow[x] = sh;
        }
      }
      // the trail, the openness and the broad mottling change slowly: sample
      // them every few pixels. (Where that spacing would be coarser than the
      // mottling, it has already faded out with distance.)
      for (let k = 0; k <= W / STEP; k++) {
        const s = (k * STEP + 0.5 - W / 2) * z, wx = bx + rx * s, wz = bz + rz * s;
        trailRow[k] = world.trailSigned(wx, wz) / TRAIL_HW;
        openRow[k] = world.openness(wx, wz);
        n16Row[k] = b16 > 0 ? vnoise(wx / 16, wz / 16, 12) : 0.5;
        n24Row[k] = b24 > 0 ? vnoise(wx / 24, wz / 24, 3) : 0.5;
        n30Row[k] = vnoise(wx / 30, wz / 30, 8);
        n40Row[k] = b40 > 0 ? vnoise(wx / 40, wz / 40, 10) : 0.5;
        dapRow[k] = vnoise(wx / 20 + ddx, wz / 20 + ddy, 21);
      }
      for (let x = 0; x < W; x += 2) { shadeRow[x + 1] = shadeRow[x]; aoRow[x + 1] = aoRow[x]; }
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const s = (x + 0.5 - W / 2) * z;
        const wx = bx + rx * s, wz = bz + rz * s;
        const k = (x / STEP) | 0, fr = (x % STEP) / STEP;
        const dist = Math.abs(trailRow[k] + (trailRow[k + 1] - trailRow[k]) * fr);
        const g = b2 > 0 ? (hash(Math.floor(wx / 2), Math.floor(wz / 2), 6) - 0.5) * b2 : 0;
        let ramp, l, edge = 0;
        if (dist < 1.4) {
          const n24 = n24Row[k] + (n24Row[k + 1] - n24Row[k]) * fr;
          const ragged = 0.25 + (n24 - 0.5) * 0.5 * b24 + 0.15 + (b8 > 0 ? (vnoise(wx / 8, wz / 8, 4) - 0.5) * 0.3 * b8 : 0);
          edge = 0.92 + (ragged - 0.4) * 0.55;
        }
        if (dist < edge) {
          ramp = R.DIRT;
          l = 4.1 - dist * 1.6 + (b7 > 0 ? (vnoise(wx / 7, wz / 7, 5) - 0.5) * 1.1 * b7 : 0) + g * 1.6;
          // a coarser mottle carries the texture on once the fine one has faded
          if (b16 > 0) l += (n16Row[k] + (n16Row[k + 1] - n16Row[k]) * fr - 0.5) * 1.3 * b16;
          if (dist < 0.45) l += 0.5;                        // the worn line down the middle
          if (dist > edge - 0.12) l -= 1;                   // lip where the grass overhangs
          if (b3 > 0) {
            // pebbles and fallen leaves thin out, rather than sparkle, as they shrink
            const p = hash(Math.floor(wx / 3), Math.floor(wz / 3), 7);
            if (p > 1 - 0.025 * b3) { ramp = R.STONE; l = 4 + (p > 1 - 0.01 * b3 ? 1 : 0); }
            else if (p < 0.03 * b3) { ramp = R.GOLD; l = 1.5; }  // a fallen leaf
          }
        } else {
          const n = n30Row[k] + (n30Row[k + 1] - n30Row[k]) * fr;
          ramp = n > 0.56 ? R.MOSS : R.GRASS;
          l = 2.5 + (b6 > 0 ? (vnoise(wx / 6, wz / 6, 9) - 0.5) * 2 * b6 : 0) + (n40Row[k] + (n40Row[k + 1] - n40Row[k]) * fr - 0.5) * 1.2 * b40 + g * 1.4;
          if (dist < edge + 0.35) l -= 0.8;
          if (b2 > 0) {
            const f = hash(Math.floor(wx / 2), Math.floor(wz / 2), 11);
            if (f > 1 - 0.006 * b2) { ramp = R.WHITE; l = 6; }
            else if (f > 1 - 0.011 * b2) { ramp = R.GOLD; l = 5.5; }
            else if (f < 0.04 * b2) { ramp = R.DIRT; l = 2; }
          }
        }
        l -= Math.min(1.6, aoRow[x] * 1.2);
        // its own dither phase, so it doesn't beat against the resolve's
        S.ramp[i] = ramp; S.lvl[i] = clamp(Math.floor(l + BAY2[i] * 0.999), -4, 11);
        S.depth[i] = z; S.kind[i] = 1; S.u[i] = wx; S.v[i] = wz;
        dap[i] = dapRow[k] + (dapRow[k + 1] - dapRow[k]) * fr;
        S.sun[i] = (openRow[k] + (openRow[k + 1] - openRow[k]) * fr) * (1 - shadeRow[x]);
      }
    }

    // --- the far wood
    for (let x = 0; x < W; x++) {
      let c = Math.floor(((heading + colAng[x]) / TAU) * PW) % PW;
      if (c < 0) c += PW;
      for (let y = Math.max(0, P.y0 + shift); y <= Math.min(H - 1, P.y1 + shift); y++) {
        const j = (y - shift) * PW + c;
        if (!P.kind[j]) continue;
        const i = y * W + x;
        if (P.depth[j] > S.depth[i]) continue;
        S.ramp[i] = P.ramp[j]; S.lvl[i] = P.lvl[j]; S.depth[i] = P.depth[j]; S.kind[i] = P.kind[j]; S.sun[i] = 0;
      }
    }

    // --- trees
    measureTiles(S, true);
    // nearest first, so hidden pixels further back fail the depth test early
    for (const k of ['trees', 'bushes', 'rocks', 'stumps', 'logs']) vis[k].sort((p, q) => p._Z - q._Z);
    // leaves standing between the walker and the low sun are eaten away by
    // its glare, so looking toward it there is usually a way through
    const glareAt = (x, y) => {
      if (sunOn <= 0) return 0;
      const dx = (x - SX) / (80 * PX), dy = (y - sy) / (62 * PX);
      return sunOn * Math.exp(-(dx * dx + dy * dy) * 1.4);
    };
    const cam = { eye, hy, sy, sa, ca, front, rx, rz, fx, fz, wind, t, leafLight, glareAt, SX };
    for (const tr of vis.trees) { measureTiles(S); drawTree(S, tr, cam); }
    measureTiles(S);
    for (const s of vis.stumps) drawStump(S, s, cam);
    for (const l of vis.logs) drawLog(S, l, cam, toCamZ, toCamX);
    for (const k of vis.rocks) drawRock(S, k, cam);
    for (const b of vis.bushes) drawBush(S, b, cam);
    for (const f of vis.ferns) drawFern(S, f, cam);
    for (const tf of vis.tufts) drawTuft(S, tf, cam);
    for (const m of vis.mush) drawMush(S, m, cam);
    for (const p of vis.plants) drawPlant(S, p, cam);
    life.draw(S, st, cam, toCamZ, toCamX);

    // --- how much of the disc shows between the leaves: drives the glare
    let visn = 0, cnt = 0;
    const dr = 4 * PX;
    if (sxi >= dr && sxi < W - dr && sy >= dr && sy < H - dr) {
      for (let y = sy - dr; y <= sy + dr; y++) for (let x = sxi - dr; x <= sxi + dr; x++) {
        if ((x - sxi) ** 2 + (y - sy) ** 2 > 18 * PX * PX) continue;
        cnt++; const i = y * W + x;
        if (S.kind[i] === 0 && S.lvl[i] >= 10) visn++;
      }
    }
    // how much the disc shows flickers as leaves pass in front of it: let the
    // glare follow that gently rather than pump with every leaf
    const glareTo = (0.25 + 0.75 * (cnt ? visn / cnt : 0)) * sun * sunOn;
    const gdt = glareT === null ? 1 : t - glareT;
    glareS = gdt < 0 || gdt > 0.5 ? glareTo : glareS + (glareTo - glareS) * (1 - Math.exp(-gdt * 3));
    glareT = t;
    const glare = glareS;
    castBeams(S, prof, tmp, sxi, sy, (0.1 + 0.9 * sunK) * sunOn);

    // --- dust motes, seen only where they drift through a shaft
    for (const i of touched) moteGlow[i] = 0;
    touched.length = 0;
    if (sunOn > 0) for (const m of life.motes) {
      let x = (m.x + 10 * wave(m.p1, t) + 3 * wind * wave(m.p2, t)) * PX - heading * F;
      const span = W + 40 * PX;
      x = Math.round(((x % span) + span) % span) - 20 * PX;
      const y = Math.round((m.y + 7 * wave(m.p2, t, m.ph)) * PX + shift);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = y * W + x;
      if (S.depth[i] * PX < m.z) continue;
      const gi = (y + gRow) * GXW + gcol(x);
      const lit = prof[A.ang[gi]] * A.env[gi];
      const tw = 0.5 + 0.5 * wave(m.tw, t, m.ph);
      if (lit * tw > 0.04) { moteGlow[i] = Math.min(1, lit * tw * 5); touched.push(i); }
    }

    // looking into the light the air itself is bright: lift the shade, so the
    // wood is as cheerful toward the sun as away from it
    const fill = 0.25 + 0.95 * back * (0.6 + 0.4 * sunOn);
    resolve(S, rgba, { t, wind, sun, sunK, gcol, gRow, glare, sunOn, bloomOn, fill, ddx, ddy });
  }

  // --- resolve: light, mist and glow ---------------------------------------------------

  function resolve(S, rgba, f) {
    const { t, wind, sun, sunK, gcol, gRow, glare, sunOn, bloomOn, fill, ddx, ddy } = f;
    const skyShift = -1.0 * (1 - sun) / 0.62;
    const lut = GLUT, amb = A.amb;
    const hzS = A.hzSun;
    for (let y = 0; y < H; y++) {
      const gy = y + gRow;
      const hr = A.hzRow[gy * 3], hg = A.hzRow[gy * 3 + 1], hb = A.hzRow[gy * 3 + 2];
      for (let x = 0; x < W; x++) {
        const i = y * W + x, gi = gy * GXW + gcol(x);
        const k = S.kind[i];
        const sl = S.sun[i];
        let light;
        if (k === 0) light = skyShift;
        else if (k === 3) light = amb[i] * 0.6 - (1 - sun) * 1.4 + fill * 0.8;
        else if (k === 5) light = 0;
        else if (k === 2) {
          // bark: only the side toward the sun lights up, flickering with the leaves
          light = amb[i] - 0.2 + fill;
          if (sl > 0) {
            const n = vnoise(S.v[i] / 40 + ddy * 3, S.u[i] / 30, 23);
            light += sl * (1.2 + 4.6 * sunK * smooth(0.3, 0.55, n));
          }
        } else {
          light = amb[i] + fill;
          const u = S.u[i], v = S.v[i];
          const z = S.depth[i] * PX, fd = z < 2.5 ? 0.35 : z < 5 ? 0.35 * (5 - z) / 2.5 : 0;
          const broad = k === 1 ? dap[i] : vnoise(u / 20 + ddx, v / 20 + ddy, 21);
          const n = broad * (1 - fd) + (fd > 0 ? vnoise(u / 7 + ddx * 2, v / 7, 22) * fd : 0);
          if (k === 1) {
            // sun on the floor: open sky above, cut by trunk shadows, broken by leaves
            const leaf = smooth(0.4, 0.62, n);
            light += sl * (2.2 + 2.4 * leaf) * (0.2 + 0.8 * sunK) - 0.9 + (n > 0.7 ? 0.8 * sunK : 0);
          } else {
            light += sl * 1.4 * sunK + (n > 0.6 ? 1.2 * sunK : -0.2);
          }
        }
        const L = clamp(Math.floor(S.lvl[i] + light + BAY[i]), -4, 11);
        const e = (S.ramp[i] * 16 + L + 4) * 3;
        let r = lut[e], g = lut[e + 1], b = lut[e + 2];

        const zi = Math.min(4095, (S.depth[i] * PX * 32) | 0);
        if (k !== 0) {
          const m = Math.floor((A.mist[zi] * (0.93 + 0.07 * sun)) * 6 + BAY2[i]) / 6;
          if (m > 0) {
            const w = Math.min(1, 0.25 + A.hz[gi] * sunOn);
            const cr = hr + (hzS[0] - hr) * w, cg = hg + (hzS[1] - hg) * w, cb = hb + (hzS[2] - hb) * w;
            r += (cr - r) * m; g += (cg - g) * m; b += (cb - b) * m;
          }
        }
        const glow = (sunOn > 0 ? prof[A.ang[gi]] * A.env[gi] * 1.35 * (k === 0 ? 0.3 : A.deep[zi]) + A.halo[gi] * glare + moteGlow[i] : 0) + A.bloom[gi] * sun * bloomOn;
        if (glow > 0) {
          const q = Math.min(1, Math.floor(glow * 6 + BAY2[i]) / 6) * 0.8;
          if (q > 0) { r += (GLOW[0] - r) * q; g += (GLOW[1] - g) * q; b += (GLOW[2] - b) * q; }
        }
        const o = i * 4;
        rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
      }
    }
  }

  return { render, layer: S };   // the layer is for tools that look inside a frame
}

// --- drawing helpers -------------------------------------------------------------------

function plot(S, x, y, ramp, lvl, z, kind, sun = 0, u = 0, v = 0) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = y * W + x;
  if (z > S.depth[i]) return;
  S.ramp[i] = ramp; S.lvl[i] = clamp(Math.round(lvl), -4, 11); S.depth[i] = z; S.kind[i] = kind;
  S.u[i] = u + x * z; S.v[i] = v + y * z; S.sun[i] = sun; touch(S, x, y);
}

// a sprite's dot: one original pixel, PX by PX
function dot(S, x, y, ramp, lvl, z, kind, sun = 0, u = 0, v = 0) {
  x = Math.round(x); y = Math.round(y);
  for (let j = 0; j < PX; j++) for (let k = 0; k < PX; k++) plot(S, x + k, y + j, ramp, lvl, z, kind, sun, u, v);
}

// a standing cylinder of bark: trunks and stumps
function drawColumn(S, X, Z, wW, hW, lean, sp, seed, cam) {
  const z = Z / F;
  const sx = W / 2 + X / z;
  const baseY = cam.hy + cam.eye / z;
  const topY = cam.hy + (cam.eye - hW) / z;
  const wpx = wW / z;
  const reach = wpx * 1.9 + 2 + Math.abs(lean) * (baseY - topY);
  if (sx + reach < 0 || sx - reach >= W) return;
  const { sa, ca } = cam;
  // bark texture finer than a pixel (z world units) fades rather than shimmers
  const b1 = band(1.1, z), b2 = band(2.2, z), b3 = band(3.3, z), b4 = band(4, z);
  const y0 = Math.max(0, Math.floor(topY)), y1 = Math.min(H - 1, Math.ceil(baseY));
  for (let y = y0; y <= y1; y++) {
    const hpx = baseY - y, h = hpx * z;
    const cx = sx + lean * hpx;
    const hw = (wpx / 2) * (1 + 0.9 * Math.exp(-h / (wW * 0.7)));
    let xa, xb;
    if (hw < 0.6) { xa = xb = Math.floor(cx); } else { xa = Math.floor(cx - hw); xb = Math.ceil(cx + hw); }
    for (let x = Math.max(0, xa); x <= Math.min(W - 1, xb); x++) {
      if (((x & (TILE - 1)) === 0 || x === Math.max(0, xa)) && !open(S, x, y, z)) { x |= TILE - 1; continue; }
      const t = hw < 0.6 ? 0 : (x + 0.5 - cx) / hw;
      if (t < -1.05 || t > 1.05) continue;
      const i = y * W + x;
      if (z > S.depth[i]) continue;
      const tc = clamp(t, -1, 1);
      const nL = tc * sa - Math.sqrt(1 - tc * tc) * ca;    // facing the sun?
      const col = tc * wW * 0.5;                          // world units round the trunk
      let ramp = R.BARK, l;
      if (sp === SP.BIRCH) {
        ramp = R.WHITE;
        l = 3.3 - Math.abs(tc) * 1.3 + nL * 0.7 + (vnoise(col * 0.3, h * 0.05, seed) - 0.5) * 0.8 * b3;
        // dark lenticels and the rough black foot
        if ((b4 > 0 && hash(Math.floor(col / 4 + seed), Math.floor(h / 7), seed) > 1 - 0.14 * b4) ||
          (h < 70 && 0.5 + (vnoise(col * 0.4, h * 0.06, seed + 2) - 0.5) * b2 > 0.45 + h / 160)) { ramp = R.BARK; l = 0.6 + nL * 0.5; }
      } else {
        l = 2 - Math.abs(tc) * 0.9 + nL * 0.5 + (vnoise(col * 0.45, h * (sp === SP.PINE ? 0.04 : 0.12), seed) - 0.5) * 1.8 * b2;
        if (sp === SP.PINE) l += 0.4;
        if (b1 > 0 && hash(Math.floor(col * 0.9), Math.floor(h / 6), seed) > 1 - 0.08 * b1) l -= 1;
        const mossy = 0.5 + (vnoise(col * 0.25, h * 0.05, seed + 1) - 0.5) * b4;
        if (nL < 0.1 + (BAY[i] - 0.5) * 0.3 && h < wW * (2.6 * mossy + 0.4) + (BAY[i] - 0.5) * wW * 0.6) { ramp = R.MOSS; l = 1.6 - Math.abs(tc) + mossy * 1.5; }
      }
      const rim = smooth(-0.15, 0.75, nL) * (hw > 1.5 ? 1 : 0.6);
      S.ramp[i] = ramp; S.lvl[i] = clamp(Math.round(l + BAY[i] * 0.5), -4, 11);
      S.depth[i] = z; S.kind[i] = 2; S.u[i] = col + seed % 997; S.v[i] = h; S.sun[i] = rim; touch(S, x, y);
    }
  }
}

function drawTree(S, tr, cam) {
  const Z = tr._Z, z = Z / F;
  const lean = (tr.lx * cam.rx + tr.lz * cam.rz) * 1;
  const crown = crownOf(tr);
  drawColumn(S, tr._X, Z, tr.w, crown.pine ? crown.top - 60 : tr.H, lean, tr.sp, tr.seed, cam);
  const sway = swayAt(cam.t, cam.wind, tr.seed % 7);
  if (crown.pine) { drawPine(S, tr, crown, z, lean, sway, cam); return; }
  for (const c of crown.clumps) {
    const cZ = Z + c.ox * cam.fx + c.oz * cam.fz;
    if (cZ < 40) continue;
    const cz = cZ / F;
    const cX = tr._X + c.ox * cam.rx + c.oz * cam.rz;
    const s = c.sway * swayAt(cam.t, cam.wind, c.phase, cz * PX < 4 ? 3.2 : 2.4) * Math.min(2.5 * PX, 4 / cz);
    const sx = W / 2 + cX / cz + s * 1.6, sy = cam.hy + (cam.eye - c.h) / cz + s * 0.2;
    const rp = 260 / cz;
    const shrink = 1 - cam.glareAt(sx, sy) * (0.55 + 0.4 * hash(c.seed, 1, 2));
    if (c.limb && shrink > 0.6) drawLimb(S, tr, c, sx, sy, cz, cam);
    if (sx + rp < 0 || sx - rp >= W || sy + rp < 0 || sy - rp >= H) continue;
    if (shrink < 0.08) continue;
    drawLobes(S, c.lobes, sx, sy, cz, c.ramp, c.base, c.seed, cam.leafLight(sx, sy), W, false, shrink);
  }
}

// a bough from the trunk out to a low clump of leaves, drooping a little
function drawLimb(S, tr, c, ex, ey, cz, cam) {
  const z0 = tr._Z / F;
  const lean = tr.lx * cam.rx + tr.lz * cam.rz;
  const sx = W / 2 + tr._X / z0 + lean * c.limb.h0 / z0, sy = cam.hy + (cam.eye - c.limb.h0) / z0;
  const n = Math.ceil(Math.hypot(ex - sx, ey - sy)) + 1;
  if (n > 900 * PX) return;
  for (let j = 0; j <= n * 0.8; j++) {
    const t = j / n, z = z0 + (cz - z0) * t;
    const x = sx + (ex - sx) * t, y = sy + (ey - sy) * t - Math.sin(t * Math.PI) * (26 / z);
    const th = Math.max(1, (c.limb.th * (1.3 - t)) / z);
    for (let q = 0; q < th; q++) plot(S, x, y + q, R.BARK, q === 0 && th > 1.5 ? 1.8 : 0.9, z + 0.02, 2, q === 0 ? 0.3 : 0, t * 50, q);
  }
}

// a spruce: a dark core round the trunk, and in front of and behind it each
// bough drawn as a chain of drooping needle sprays, each in its own perspective
function drawPine(S, tr, c, z, lean, sway, cam) {
  const Z = tr._Z, X = tr._X, eye = cam.eye, hy = cam.hy;
  const sx = W / 2 + X / z, baseY = hy + eye / z;
  const rmax = c.R / z + 4;
  if (sx + rmax < 0 || sx - rmax >= W) return;
  const front = Math.max(0, -cam.ca);
  const swp = sway * Math.min(3 * PX, 3 / z);

  // --- the core: the shaded inside of the crown, close round the trunk. A narrow,
  // ragged cone that thins away at its foot; it only shows through the gaps.
  const yTop = Math.max(0, Math.floor(hy + (eye - c.top + 20) / z)), yBot = Math.min(H - 1, Math.ceil(hy + (eye - c.h0) / z));
  const b12 = band(12, z);
  for (let y = yTop; y <= yBot; y++) {
    const h = (baseY - y) * z, q = clamp((c.top - h) / c.span, 0, 1);
    const cx = sx + lean * (baseY - y);
    const rw = (c.coreR * q * smooth(0, 0.3, (h - c.h0) / c.span)) / z;
    if (rw < 0.75 || rw * z < tr.w * 0.8) continue;   // no thinner than the trunk it hides
    for (let x = Math.max(0, Math.floor(cx - rw)); x <= Math.min(W - 1, Math.ceil(cx + rw)); x++) {
      const i = y * W + x;
      if (z > S.depth[i]) continue;
      const xw = (x + 0.5 - cx) * z, e = Math.abs(xw) / (rw * z);
      // the edge frays in tufts that belong to the tree, not to rows of the screen
      const n = 0.5 + (vnoise(xw / 12 + 50, h / 12, tr.seed) - 0.5) * b12;
      if (e > 0.35 + 0.55 * n) continue;
      const l = 0.3 + (1 - q) * 0.6 + (n - 0.5) * 1.6 - e * 0.6;
      S.ramp[i] = R.LEAFD; S.lvl[i] = clamp(Math.floor(l + BAY[i]), -4, 11);
      S.depth[i] = z; S.kind[i] = 3; touch(S, x, y);
    }
  }

  // --- the boughs
  const lit = cam.leafLight(sx, hy + (eye - (c.top + c.h0) / 2) / z);
  // detail by distance, in a few fixed steps so a bough is not re-cut as you walk
  const lod = z * PX < 3 ? 1 : z * PX < 6 ? 2 : 3;
  for (const b of c.boughs) {
    if (b.small && lod === 3) continue;
    const cp = Math.cos(b.phi), sp = Math.sin(b.phi);
    const ux = cp * cam.rx + sp * cam.rz, uz = cp * cam.fx + sp * cam.fz;    // its heading, seen from here
    // enough sprays to cover it, fewer as it shrinks with distance
    const nseg = lod === 3 ? 2 : clamp(Math.ceil(b.L / (lod === 1 ? 28 : 60)), 2, 8);
    const segL = (b.L / nseg) * 1.35;
    for (let k = 1; k <= nseg; k++) {
      const t = (k - 0.35) / nseg, sd = t * b.L;
      const yb = b.hb + b.L * (b.rise * t - b.droop * t * t);
      const Zs = Z + sd * uz;
      if (Zs < 40) continue;
      const zs = Zs / F;
      const tipSway = swp * t * t * (b.small ? 0.6 : 1);
      const bx = W / 2 + (X + sd * ux + lean * yb) / zs + tipSway, by = hy + (eye - yb) / zs;
      // a spray: long along the bough, wide across it, and seen from below its underside shows
      const sw = b.sw * (0.45 + 0.9 * t * (1.25 - t));
      const along = Math.abs(ux) * segL * 0.55 + Math.abs(uz) * sw * 0.5;
      const deep = Math.abs(uz) * segL * 0.55 + Math.abs(ux) * sw * 0.5;
      const glare = 1 - cam.glareAt(bx, by) * (0.55 + 0.4 * hash(b.seed, k, 3));
      if (glare < 0.1) continue;
      const rx = ((along + 3) / zs) * glare;
      const ry = ((b.th * (1.15 - 0.5 * t) * 0.5) / zs + (deep * Math.abs(yb - eye)) / (Zs * zs)) * glare;
      if (bx + rx < 0 || bx - rx >= W || by + ry * 2 < 0 || by - ry * 2 >= H) continue;
      // the slope it droops at, on screen
      const slope = b.rise - 2 * b.droop * t;
      // (eased toward flat as the bough turns end-on, so it never snaps)
      const shear = clamp((-slope * ux) / (ux * ux + 0.04), -1.4, 1.4);
      const seed = b.seed + k;
      // needle tufts are a few world units across: drawn no smaller than 2px, so
      // they move as clumps rather than churning, and faded out with distance
      // before they would be smaller than that; up close no bigger than 4px,
      // so they never turn into blocks
      const cw = clamp(5 / zs, 2.5, 4 * PX), ch = clamp(3.5 / zs, 2, 3 * PX), tex = band(5, zs);
      const base = 1.5 + t * 1.3 - (b.small ? 0.4 : 0);
      // the spray is a sheared ellipse: for each row, solve for the span it covers
      // far off a spray is at least a pixel thick, so it doesn't flicker between rows
      const ryc = Math.max(lod === 3 ? 1 : 0.6, ry), qa = 1 / (rx * rx) + (shear * shear) / (ryc * ryc);
      const hgt = Math.ceil(ryc + Math.abs(shear) * rx) + 1;
      const ya = Math.max(0, Math.floor(by) - hgt), yz = Math.min(H - 1, Math.ceil(by) + hgt);
      for (let y = ya; y <= yz; y++) {
        const v = y + 0.5 - by;
        const qb = (-2 * v * shear) / (ryc * ryc), qc = (v * v) / (ryc * ryc) - 1;
        const disc = qb * qb - 4 * qa * qc;
        if (disc <= 0) continue;
        const sq = Math.sqrt(disc);
        const xa = Math.max(0, Math.ceil(bx + (-qb - sq) / (2 * qa) - 0.5)), xb = Math.min(W - 1, Math.floor(bx + (-qb + sq) / (2 * qa) - 0.5));
        for (let x = xa; x <= xb; x++) {
          if (((x & (TILE - 1)) === 0 || x === xa) && !open(S, x, y, zs)) { x |= TILE - 1; continue; }
          const i = y * W + x;
          if (zs > S.depth[i]) continue;
          const u = x + 0.5 - bx;
          const nx = u / rx, ny = (v - shear * u) / ryc;
          const d2 = nx * nx + ny * ny;
          if (d2 > 1) continue;
          // needle tufts, ragged at the edge, anchored to the spray's true position
          // (the same one its outline uses) so the two never disagree
          const nd = hash(Math.floor(u / cw) + 64, Math.floor(v / ch) + 64, seed);
          const d = Math.sqrt(d2);
          if (d > 0.55 && d > 1 - nd * 0.4 * tex - 0.08) continue;
          let l = base - ny * 1.3 + (nd - 0.5) * 1.0 * tex;
          if (ny < -0.45) l += 0.7;                    // the top of the spray catches the sky
          if (ny > 0.25) l -= 2.2 * (ny - 0.25);       // and it is dark beneath
          const toward = nx * lit.lx + ny * lit.ly;
          if (d > 0.5 && toward > 0.2) l += lit.rim * 2.4 * (toward - 0.1);
          l += front * (0.45 + 0.5 * (-ny));
          S.ramp[i] = R.LEAFD; S.lvl[i] = clamp(Math.floor(l + BAY[i] * 0.6), -4, 11);
          S.depth[i] = zs; S.kind[i] = 3; touch(S, x, y);
        }
      }
    }
  }
}

function drawStump(S, s, cam) {
  const Z = s._Z, z = Z / F;
  drawColumn(S, s._X, Z, s.w, s.h, 0, SP.OAK, s.seed, cam);
  // the cut face, seen from above: rings of pale wood
  const sx = W / 2 + s._X / z, cy = cam.hy + (cam.eye - s.h) / z;
  const rx = (s.w * 0.5) / z * 1.05, ry = Math.max(0.6, rx * (cam.eye - s.h) / Z);
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (let x = Math.floor(sx - rx); x <= Math.ceil(sx + rx); x++) {
    const d = Math.hypot((x + 0.5 - sx) / rx, (y + 0.5 - cy) / ry);
    if (d > 1) continue;
    const ring = Math.floor(d * 4.5) % 2;
    const edge = d > 0.82;
    plot(S, x, y, edge ? R.BARK : R.GOLD, edge ? 3 : 2.2 + ring * 0.9 - d * 0.5 + cam.front, z - 0.01, 2, 0.6);
  }
}

const SUN_DX = -Math.sin(SUN_AZ), SUN_DZ = -Math.cos(SUN_AZ);   // shadows fall this way

// A fallen log is a cylinder lying on the ground, traced per pixel like the
// boulders: its outline, depth and normals are real, the bark grain runs along
// it, moss grows where it faces the sky, the sawn end shows its rings, and it
// casts a soft shadow away from the sun.
function drawLog(S, l, cam, toCamZ, toCamX) {
  const ex = l.x2 - l.x, ez = l.z2 - l.z, len = Math.hypot(ex, ez);
  const Z0 = toCamZ(l.x, l.z), Z1 = toCamZ(l.x2, l.z2);
  if ((Z0 < 30 && Z1 < 30) || Math.min(Z0, Z1) > PLANT_Z * 1.5) return;
  const X0 = toCamX(l.x, l.z), X1 = toCamX(l.x2, l.z2);
  const r0 = l.rad, eye = cam.eye, hy = cam.hy;
  // the radius swells and narrows a little along the trunk, thinning toward the top end
  if (!l.radT) {
    // tabulated once: the noise is slow along the log, and this is asked per pixel
    l.radT = Float32Array.from({ length: 65 }, (_, k) => { const s = (k / 64) * len; return r0 * (1.04 - 0.14 * (s / len) + 0.1 * (vnoise(s / 70, 0.5, l.seed) - 0.5)); });
  }
  const radT = l.radT;
  const radAt = (s) => { const f = clamp(s / len, 0, 1) * 64, k = Math.min(63, f | 0); return radT[k] + (radT[k + 1] - radT[k]) * (f - k); };
  // axis in camera space (x right, y up, z ahead); the log lies along it at height rad
  const ax = (X1 - X0) / len, az = (Z1 - Z0) / len;
  const gx = -(l.z2 - l.z) / len, gz = (l.x2 - l.x) / len;   // across the log on the ground (world)

  // screen boxes: one round the log and its shadow reaching away from the sun, one round the log alone
  const shLen = r0 * 2 * 2.2, pad = r0 * 1.3 + shLen;
  const box = (p, top) => {
    let bx0 = W, bx1 = -1, by0 = H, by1 = -1;
    for (const [cx, cz] of [[X0, Z0], [X1, Z1]]) for (const ox of [-p, p]) for (const oz of [-p, p]) for (const h of [0, top]) {
      const z = Math.max(cz + oz, 20) / F, x = W / 2 + (cx + ox) / z, y = hy + (eye - h) / z;
      bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y);
    }
    return [Math.max(0, Math.floor(bx0)), Math.min(W - 1, Math.ceil(bx1)), Math.max(0, Math.floor(by0)), Math.min(H - 1, Math.ceil(by1))];
  };
  const [x0, x1, y0, y1] = box(pad, 0);
  const [lx0, lx1, ly0, ly1] = box(r0 * 1.3, r0 * 2.6);
  if (lx0 > lx1 || ly0 > ly1) return;

  // far away it is a thread: trace it as a line so it never breaks up
  const zNear = Math.max(Math.min(Z0, Z1), 30) / F;
  if (r0 / zNear < 1) {
    const n = Math.ceil(len / 20);
    for (let k = 0; k <= n; k++) {
      const wx = l.x + (ex * k) / n, wz = l.z + (ez * k) / n, Z = toCamZ(wx, wz);
      if (Z < 30) continue;
      const z = Z / F;
      plot(S, W / 2 + toCamX(wx, wz) / z, hy + (eye - r0) / z, R.BARK, 2, z, 2, 0.3, wx, wz);
    }
    return;
  }

  // --- the shadow and contact shade on the floor, worked out in the world
  const sdx = SUN_DX, sdz = SUN_DZ;
  for (let y = Math.max(y0, Math.floor(hy) + 1); y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * W + x;
    if (S.kind[i] !== 1) continue;
    const px = S.u[i] - l.x, pz = S.v[i] - l.z;
    // ground distance from the log's axis
    const s = clamp((px * ex + pz * ez) / (len * len), 0, 1) * len;
    const qx = px - (ex * s) / len, qz = pz - (ez * s) / len, d0 = Math.hypot(qx, qz);
    if (d0 > pad) continue;
    const r = radAt(s);
    // the shadow: the log's footprint swept away from the sun, thinning as it goes
    let sh = 0;
    for (let k = 0; k <= 3; k++) {
      const off = (shLen * k) / 3, rx = qx - sdx * off, rz = qz - sdz * off;
      // only the part across the log matters for an (almost) infinite cylinder
      const across = Math.abs(rx * gx + rz * gz), along = (px * ex + pz * ez) / len - s;
      const rad = r * (1 - 0.35 * (k / 3));
      const v = (1 - smooth(rad * 0.6, rad * 1.15, Math.hypot(across, along))) * (1 - 0.15 * k);
      if (v > sh) sh = v;
    }
    if (sh > 0) S.sun[i] *= 1 - 0.85 * sh;
    const ao = 1 - smooth(r * 0.8, r * 1.5, d0);
    if (ao > 0) S.lvl[i] = Math.max(-4, S.lvl[i] - Math.floor(ao * 1.6 + BAY2[i]));
  }

  // --- the log itself
  const Ll = Math.hypot(cam.sa, 0.45, cam.ca), Lx = cam.sa / Ll, Ly = 0.45 / Ll, Lz = cam.ca / Ll;
  const zc = Math.max((Z0 + Z1) / 2, 30) / F;
  const b4 = band(4, zc), b12 = band(12, zc), b14 = band(14, zc);
  const showRings = r0 / zc > 5;
  const mossLine = 0.55;
  // ray origin relative to the near end A = (X0, rad, Z0)
  const wx0 = -X0, wy0 = eye - r0, wz0 = -Z0;
  const wa = wx0 * ax + wz0 * az;
  const wpx = wx0 - wa * ax, wpy = wy0, wpz = wz0 - wa * az;
  for (let y = ly0; y <= ly1; y++) {
    const dy = -(y + 0.5 - hy) / F;
    for (let x = lx0; x <= lx1; x++) {
      const dx = (x + 0.5 - W / 2) / F, dz = 1;
      const da = dx * ax + dz * az;
      const dpx = dx - da * ax, dpy = dy, dpz = dz - da * az;
      const A2 = dpx * dpx + dpy * dpy + dpz * dpz;
      const B2 = 2 * (wpx * dpx + wpy * dpy + wpz * dpz);
      const Cw = wpx * wpx + wpy * wpy + wpz * wpz;
      // the radius where the ray passes closest to the axis, then the hit
      const tc = -B2 / (2 * A2), sc = clamp(wa + tc * da, 0, len);
      let r = radAt(sc);
      let disc = B2 * B2 - 4 * A2 * (Cw - r * r);
      let t = Infinity, cap = 0, s = 0;
      if (disc > 0) {
        const tb = (-B2 - Math.sqrt(disc)) / (2 * A2);
        s = wa + tb * da;
        if (tb > 1 && s >= 0 && s <= len) { t = tb; r = radAt(s); }
      }
      // the sawn ends
      if (Math.abs(da) > 1e-6) for (let e = 0; e < 2; e++) {
        const se = e ? len : 0, tcap = (se - wa) / da;
        if (tcap <= 1 || tcap >= t) continue;
        const qx = wpx + tcap * dpx, qy = wpy + tcap * dpy, qz = wpz + tcap * dpz;
        const rc = radAt(se);
        if (qx * qx + qy * qy + qz * qz <= rc * rc) { t = tcap; cap = e ? 1 : -1; s = se; r = rc; }
      }
      if (t === Infinity) continue;
      // the point hit, relative to the axis
      const hxp = wpx + t * dpx, hyp = wpy + t * dpy, hzp = wpz + t * dpz;
      if (hyp + r0 < 0) continue;                 // below the ground
      const i = y * W + x, z = t / F;
      if (z > S.depth[i]) continue;
      const wx = l.x + (ex * s) / len, wz = l.z + (ez * s) / len;
      let ramp, lv, sun;
      if (cap) {
        // end grain: rings round the heart, a rim of bark
        const d = Math.hypot(hxp, hyp, hzp) / r;
        const diff = Math.max(0, cap * (ax * Lx + az * Lz));
        if (d > 0.86) { ramp = R.BARK; lv = 1.8 + diff * 0.6; }
        else {
          ramp = R.GOLD;
          lv = 1.3 + diff * 0.9 + cam.front * 0.6 - d * 0.5;
          if (showRings) lv += (Math.floor(d * 4.5) % 2) * 1.0;
          if (d < 0.12) lv -= 0.6;                // the dark heart
        }
        sun = diff * 0.3;
      } else {
        const nx = hxp / r, ny = hyp / r, nz = hzp / r;
        const diff = Math.max(0, nx * Lx + ny * Ly + nz * Lz);
        // round the log: the angle from the top, as an arc length, stays with the wood
        const side = nx * -az + nz * ax;
        const round = Math.atan2(side, ny) * r;
        lv = 2.1 + ny * 1.1 + diff * 0.7 + cam.front * 0.5;
        // bark: furrows that run along the log, softened before they would shimmer
        lv += (vnoise(s / 30, round / 4, l.seed + 1) - 0.5) * 1.8 * b4;
        lv += (vnoise(s / 90, round / 12, l.seed + 3) - 0.5) * 0.8 * b12;
        lv -= smooth(0.56, 0.7, vnoise(s / 45, round / 3, l.seed + 5)) * 1.4 * b4;   // deep cracks
        lv -= (1 - smooth(0, r0 * 0.7, hyp + r0)) * 1.1;   // dark where it rests on the ground
        // a dark edge where the surface turns away
        const ndv = -(nx * dx + ny * dy + nz * dz) / Math.hypot(dx, dy, dz);
        if (ndv < 0.22) lv -= 0.7;
        ramp = R.BARK;
        const m = ny + (vnoise(s / 40, round / 14, l.seed + 2) - 0.5) * 1.3 * b14;
        if (m > mossLine) {
          ramp = R.MOSS;
          lv += -0.5 + Math.min(0.5, (m - mossLine) * 0.8) + (vnoise(s / 9, round / 6, l.seed + 4) - 0.5) * 1.4 * band(6, zc);
        }
        sun = diff * 0.8;
      }
      S.ramp[i] = ramp; S.lvl[i] = clamp(Math.floor(lv + BAY[i]), -4, 11);
      S.depth[i] = z; S.kind[i] = 2; S.u[i] = wx; S.v[i] = wz; S.sun[i] = sun; touch(S, x, y);
    }
  }
}

// A boulder is a lumpy dome: each pixel's ray is traced against an ellipsoid
// whose radius wobbles with direction, so the outline, depth and normals are
// real. It is lit from the sun's bearing, mossed where it faces the sky, and
// it casts a soft shadow onto the floor away from the sun.
function drawRock(S, k, cam) {
  const Z = k._Z, X = k._X, rr = k.r, hh = k.r * (k.big ? 0.72 : 0.62), sq = hh / rr;
  const zc = Z / F, eye = cam.eye, hy = cam.hy;
  const sx = W / 2 + X / zc;
  if (rr / zc < 1.2) {
    // a pebble, a pixel or so across
    plot(S, sx, hy + eye / zc - 1, k.moss > 0.5 ? R.MOSS : R.STONE, 2.6 + cam.front * 0.6, zc, 2, 0.4, k.x, k.z);
    return;
  }
  // the screen box that the rock and its shadow can cover
  const len = hh * 2.2, reach = rr * 1.2 + len;
  const zn = Math.max(Z - reach, 20) / F, zf = (Z + reach) / F;
  const xs = [(X - reach) / zn, (X + reach) / zn, (X - reach) / zf, (X + reach) / zf];
  const x0 = Math.max(0, Math.floor(W / 2 + Math.min(...xs))), x1 = Math.min(W - 1, Math.ceil(W / 2 + Math.max(...xs)));
  if (x0 > x1) return;

  // --- the shadow on the floor, worked out in the world from each floor pixel
  const gy0 = Math.max(0, Math.floor(hy + eye / zf)), gy1 = Math.min(H - 1, Math.ceil(hy + eye / zn));
  for (let y = gy0; y <= gy1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * W + x;
    if (S.kind[i] !== 1) continue;
    const ex = S.u[i] - k.x, ez = S.v[i] - k.z;
    const d0 = Math.hypot(ex, ez);
    if (d0 > reach) continue;
    const a = ex * SUN_DX + ez * SUN_DZ, pe = ex * SUN_DZ - ez * SUN_DX;
    const ac = a < 0 ? 0 : a > len ? len : a;
    const rad = rr * (0.95 - 0.4 * (ac / len));
    const sh = 1 - smooth(rad * 0.6, rad * 1.15, Math.hypot(a - ac, pe));
    if (sh > 0) S.sun[i] *= 1 - 0.85 * sh;
    // contact shade where it beds into the ground
    const ao = 1 - smooth(rr * 0.85, rr * 1.45, d0);
    if (ao > 0) S.lvl[i] = Math.max(-4, S.lvl[i] - Math.floor(ao * 1.6 + BAY2[i]));
  }

  // --- the stone itself
  const zr = Math.max(Z - rr * 1.2, 20) / F;
  const ry0 = Math.max(0, Math.floor(hy + (eye - hh * 1.2) / (Z + rr) * F)), ry1 = Math.min(H - 1, Math.ceil(hy + eye / zr));
  const rx0 = Math.max(0, Math.floor(W / 2 + Math.min((X - rr * 1.2) / zr, (X - rr * 1.2) / ((Z + rr) / F))));
  const rx1 = Math.min(W - 1, Math.ceil(W / 2 + Math.max((X + rr * 1.2) / zr, (X + rr * 1.2) / ((Z + rr) / F))));
  // toward the sun, in camera space (x right, y up, z ahead), a little above the horizon
  const Ll = Math.hypot(cam.sa, 0.45, cam.ca), Lx = cam.sa / Ll, Ly = 0.45 / Ll, Lz = cam.ca / Ll;
  const oy = eye / sq;                          // the ray origin, with heights squashed so the rock is a sphere
  const b5 = band(5, zc), b14 = band(14, zc);
  const mossLine = 1 - k.moss * 0.95;
  for (let y = ry0; y <= ry1; y++) {
    const dy = -(y + 0.5 - hy) / F / sq;
    for (let x = rx0; x <= rx1; x++) {
      const dx = (x + 0.5 - W / 2) / F;
      // closest approach of the ray to the centre
      const ox = -X, oz = -Z, dd = dx * dx + dy * dy + 1;
      const tc = -(ox * dx + oy * dy + oz) / dd;
      const px = ox + tc * dx, py = oy + tc * dy, pz = oz + tc * 1;
      const pm = Math.hypot(px, py, pz) || 1e-6;
      // the lumps: the radius wobbles with direction in the world, so they stay put
      const ux = px / pm, uy = py / pm, uz = pz / pm;
      const wux = ux * cam.rx + uz * cam.fx, wuz = ux * cam.rz + uz * cam.fz;
      const Rr = rr * (0.9 + 0.22 * vnoise(wux * 1.6 + uy * 0.8 + 5, wuz * 1.6 - uy * 0.7 + 5, k.seed));
      if (pm >= Rr) continue;
      const t = tc - Math.sqrt((Rr * Rr - pm * pm) / dd);
      if (t < 1) continue;
      const hx = ox + t * dx, hyS = oy + t * dy, hz = oz + t;
      const wy = hyS * sq;
      if (wy < 0) continue;                     // below the ground: the floor shows there
      const i = y * W + x, z = t / F;
      if (z > S.depth[i]) continue;
      // the ellipsoid's normal
      const nx0 = hx, ny0 = hyS / sq, nz0 = hz, nl = Math.hypot(nx0, ny0, nz0);
      const nx = nx0 / nl, ny = ny0 / nl, nz = nz0 / nl;
      const wx = k.x + hx * cam.rx + hz * cam.fx, wz = k.z + hx * cam.rz + hz * cam.fz;
      const diff = Math.max(0, nx * Lx + ny * Ly + nz * Lz);
      let l = 1.5 + ny * 1.5 + diff * 0.6 + cam.front * 0.6;
      if (b5 > 0) l += (vnoise((wx + wy * 0.7) / 5, (wz - wy * 0.6) / 5, k.seed + 1) - 0.5) * 1.2 * b5;
      l -= (1 - smooth(0, hh * 0.35, wy)) * 1.1;         // dark where it meets the ground
      if (pm > Rr * 0.9) l -= 0.7;                      // a crisp edge against what is behind
      let ramp = R.STONE;
      const m = ny + (vnoise((wx + wy * 0.5) / 14, (wz - wy * 0.5) / 14, k.seed + 2) - 0.5) * 1.3 * b14;
      if (m > mossLine) { ramp = R.MOSS; l -= 0.3 - Math.min(0.6, (m - mossLine) * 0.8); }
      S.ramp[i] = ramp; S.lvl[i] = clamp(Math.floor(l + BAY[i]), -4, 11);
      S.depth[i] = z; S.kind[i] = 2; S.u[i] = wx; S.v[i] = wz; S.sun[i] = diff * 0.9; touch(S, x, y);
    }
  }
}

function drawBush(S, b, cam) {
  if (!b.lobes) b.lobes = makeLobes(rng(b.seed), b.s);
  const z = b._Z / F;
  const s = swayAt(cam.t, cam.wind, b.phase, 2.7) * Math.min(1.5 * PX, 2 / z);
  const sx = W / 2 + b._X / z + s, sy = cam.hy + (cam.eye - b.s * 0.6) / z;
  if (sx + b.s * 2 / z < 0 || sx - b.s * 2 / z >= W) return;
  drawLobes(S, b.lobes, sx, sy, z, R.LEAF, 1.5, b.seed, cam.leafLight(sx, sy));
}

function drawFern(S, f, cam) {
  const z = f._Z / F;
  const fx = W / 2 + f._X / z, fy = cam.hy + cam.eye / z, s = f.s / z;
  if (fx < -s * 1.5 || fx > W + s * 1.5 || fy - s > H) return;
  const sway = swayAt(cam.t, cam.wind, f.phase, 4) * (z * PX < 2 ? 1.6 : 1);
  for (const fr of f.fronds) {
    const L = fr.len * s;
    const dx = Math.sin(fr.a), dy = -Math.cos(fr.a) * 0.85;
    const steps = Math.max(3, Math.ceil(L * 1.3));
    let qx = fx, qy = fy;
    for (let j = 1; j <= steps; j++) {
      const t = j / steps;
      const x = fx + dx * L * t + sway * t * t * s * 0.12;
      const y = fy + dy * L * t + t * t * L * 0.55 * (0.5 + Math.abs(dx));
      const tx = x - qx, ty = y - qy, tl = Math.hypot(tx, ty) || 1;
      plot(S, x, y, R.FERN, 1.6 + t * 2.4, z, 4, t * (0.4 + 0.6 * Math.max(0, cam.ca)), f.x, f.z);
      const ll = (1 - t * 0.85) * s * 0.2;
      const side = j % 2 ? 1 : -1;
      for (let m = 1; m <= ll; m++) {
        plot(S, x - (ty / tl) * m * side, y + (tx / tl) * m * side + m * 0.35, R.FERN, 2.6 + t * 2 - m * 0.25, z, 4, t, f.x, f.z);
      }
      qx = x; qy = y;
    }
  }
}

const FLOWER = [0, R.WHITE, R.GOLD, R.MUSH];
function drawTuft(S, tf, cam) {
  const z = tf._Z / F;
  const x0 = W / 2 + tf._X / z, by = cam.hy + cam.eye / z;
  if (x0 < -20 * PX || x0 > W + 20 * PX) return;
  const sway = swayAt(cam.t, cam.wind, tf.phase + tf.x * 0.02, 2) * 3;
  const tone = tf.tone ? R.MOSS : R.GRASS;
  const tip = 0.4 + 0.6 * Math.max(0, cam.ca);
  tf.blades.forEach((b, bi) => {
    const h = b.h / z;
    if (by - h > H) return;
    let x = x0, y = by;
    for (let j = 0; j <= h; j++) {
      const t = j / h;
      x = x0 + b.dx / z + (b.lean * t + sway * 0.25 * t * t) * h;
      y = by - j;
      plot(S, x, y, tone, 1.2 + t * 4, z, 4, t * t * tip, tf.x, tf.z);
    }
    if (tf.flower && bi === 0) {
      const big = z * PX < 1.6;
      const lv = tf.flower === 1 ? 6 : tf.flower === 2 ? 5.5 : 4.5;
      dot(S, x, y - PX, FLOWER[tf.flower], lv, z - 0.01, 4, 0.5, tf.x, tf.z);
      if (big) { dot(S, x - PX, y, FLOWER[tf.flower], lv - 1, z - 0.01, 4, 0.5, tf.x, tf.z); dot(S, x + PX, y, FLOWER[tf.flower], lv - 1, z - 0.01, 4, 0.5, tf.x, tf.z); }
    }
  });
}

function drawMush(S, m, cam) {
  const z = m._Z / F;
  const x = Math.round(W / 2 + m._X / z), by = cam.hy + cam.eye / z;
  if (x < -10 * PX || x > W + 10 * PX) return;
  const stem = (7 * m.s) / z, cap = Math.max(1, (6.5 * m.s) / z);
  const capRamp = m.kind === MUSH.RED ? R.MUSH : m.kind === MUSH.GOLD ? R.GOLD : R.WHITE;
  for (let j = 0; j <= stem; j++) plot(S, x, by - j, R.WHITE, 3, z, 4, 0.3, m.x, m.z);
  const cy = by - stem;
  const ry = m.kind === MUSH.GOLD ? cap * 0.55 : cap * 0.8;
  for (let dy = -Math.ceil(ry); dy <= 0; dy++) for (let dx = -Math.ceil(cap) - 1; dx <= Math.ceil(cap) + 1; dx++) {
    const yy = m.kind === MUSH.GOLD ? -dy - ry : dy + 0.2;    // chanterelles are funnels
    if ((dx / (cap + 0.2)) ** 2 + (yy / (ry + 0.01)) ** 2 > 1) continue;
    const spot = m.kind === MUSH.RED && hash(dx, dy, x) > 0.84 && dy < 0;
    plot(S, x + dx, cy + dy, spot ? R.WHITE : capRamp, spot ? 5 : 2.8 + dx * 0.2 - dy * 0.3, z - 0.01, 4, 0.4, m.x, m.z);
  }
  // a glint now and then, so a sharp eye can find them
  const g = Math.sin(cam.t * 1.7 + m.phase * 3);
  if (g > 0.93 && z * PX < 14) {
    const gy = Math.round(cy - ry - 2 * PX);
    dot(S, x, gy, R.GOLD, 11, z - 0.02, 5);
    if (g > 0.97) { dot(S, x - PX, gy, R.GOLD, 9, z - 0.02, 5); dot(S, x + PX, gy, R.GOLD, 9, z - 0.02, 5); dot(S, x, gy - PX, R.GOLD, 9, z - 0.02, 5); dot(S, x, gy + PX, R.GOLD, 9, z - 0.02, 5); }
  }
}

// Berries and herbs: a low clump of leaves, and on it the fruit or flowers
// that give it away. Leaves are drawn like short fern fronds; the fruit sits a
// hair in front of them so it always shows.
const PLANT_LOOK = {
  //                 leaf ramp, leaf level, height, fruit ramp, fruit level, fruit size, fruit count
  [PLANT.BILBERRY]:  { leaf: R.LEAF, ll: 2.4, h: 30, fruit: R.BERRY, fl: 4.5, fs: 1.8, n: 9 },
  [PLANT.RASPBERRY]: { leaf: R.LEAF, ll: 1.8, h: 46, fruit: R.MUSH, fl: 5.5, fs: 2.3, n: 6 },
  [PLANT.GARLIC]:    { leaf: R.GRASS, ll: 3.2, h: 30, fruit: R.WHITE, fl: 7, fs: 1.6, n: 6, broad: 1 },
  [PLANT.SORREL]:    { leaf: R.MOSS, ll: 3.8, h: 18, fruit: R.WHITE, fl: 6.5, fs: 1.2, n: 4, broad: 1 },
  [PLANT.WORT]:      { leaf: R.GRASS, ll: 2.6, h: 40, fruit: R.GOLD, fl: 6.5, fs: 1.8, n: 7 },
};
function drawPlant(S, p, cam) {
  const look = PLANT_LOOK[p.kind];
  const z = p._Z / F;
  const x0 = W / 2 + p._X / z, by = cam.hy + cam.eye / z, s = (look.h * p.s) / z;
  if (x0 < -s * 1.5 || x0 > W + s * 1.5 || by - s > H) return;
  const sway = swayAt(cam.t, cam.wind, p.phase, 3) * (z * PX < 2 ? 1.6 : 1);
  const lit = 0.3 + 0.5 * Math.max(0, cam.ca);
  const tips = [];
  for (const lf of p.leaves) {
    const L = lf.len * s;
    const dx = Math.sin(lf.a) * (look.broad ? 1 : 0.6), dy = -Math.cos(lf.a);
    const steps = Math.max(2, Math.ceil(L * 1.2));
    let x = x0, y = by;
    for (let j = 1; j <= steps; j++) {
      const t = j / steps;
      x = x0 + dx * L * t + sway * t * t * s * 0.1;
      y = by + dy * L * t + t * t * L * 0.35 * Math.abs(dx);
      plot(S, x, y, look.leaf, look.ll + t * 2, z, 4, t * lit, p.x, p.z);
      // broad leaves are a few pixels wide in the middle
      const wide = (look.broad ? 0.22 : 0.12) * s * Math.sin(t * Math.PI);
      for (let m = 1; m <= wide; m++) {
        plot(S, x - m, y, look.leaf, look.ll + t * 2 - 0.6, z, 4, t * lit, p.x, p.z);
        plot(S, x + m, y, look.leaf, look.ll + t * 2 + 0.4, z, 4, t * lit, p.x, p.z);
      }
    }
    tips.push([x, y]);
  }
  // the fruit or flowers: some at leaf tips, some tucked in among them
  const r = Math.max(0, (look.fs * p.s) / z - 0.5);
  for (let k = 0; k < look.n; k++) {
    const h = hash(p.seed, k, 7);
    let fx, fy;
    if (k % 2 === 0 && tips.length) [fx, fy] = tips[(h * tips.length) | 0];
    else { fx = x0 + (h - 0.5) * s * 0.9; fy = by - s * (0.25 + hash(p.seed, k, 8) * 0.4); }
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
      if (dx * dx + dy * dy > r * r + 0.3) continue;
      plot(S, fx + dx, fy + dy, look.fruit, look.fl - dy * 0.4 + dx * 0.15 + (dx === -1 && dy === -1 ? 1.5 : 0), z - 0.01, 4, 0.5, p.x, p.z);
    }
    if (r < 1) dot(S, fx, fy, look.fruit, look.fl, z - 0.01, 4, 0.5, p.x, p.z);
  }
  // a glint now and then, like the mushrooms
  const g = Math.sin(cam.t * 1.5 + p.phase * 3);
  if (g > 0.94 && z * PX < 14) {
    const gy = Math.round(by - s - 2 * PX);
    dot(S, x0, gy, R.GOLD, 11, z - 0.02, 5);
    if (g > 0.975) { dot(S, x0 - PX, gy, R.GOLD, 9, z - 0.02, 5); dot(S, x0 + PX, gy, R.GOLD, 9, z - 0.02, 5); }
  }
}

function drawCloud(S, SX, SY, HY, t) {
  const cx = SX + cloudOff(t) * PX;
  if (cx < -100 * PX || cx > W + 100 * PX) return;
  const blobs = [[0, 0, 34, 11], [-26, 5, 22, 8], [28, 4, 26, 8], [8, -8, 20, 9], [-8, 8, 30, 6]].map((b) => b.map((v) => v * PX));
  for (let y = Math.max(0, Math.floor(SY - 30 * PX)); y < Math.min(HY, H, SY + 30 * PX); y++) for (let x = Math.max(0, Math.floor(cx - 70 * PX)); x < Math.min(W, cx + 70 * PX); x++) {
    const i = y * W + x;
    if (S.kind[i] !== 0) continue;
    let inside = 0, top = 0;
    for (const [bx, by, rx, ry] of blobs) {
      const d = ((x - cx - bx) / rx) ** 2 + ((y - SY + 4 * PX - by) / ry) ** 2;
      if (d < 1) { inside = 1; top = Math.max(top, -(y - SY + 4 * PX - by) / ry); }
    }
    if (!inside) continue;
    const near = Math.exp(-Math.hypot(x - SX, y - SY) / (30 * PX));
    S.lvl[i] = clamp(Math.floor(4.6 + top * 1.8 + near * 3.6 + BAY[i]), 0, 10);
  }
}

// --- sun shafts ---------------------------------------------------------------------------
// Rays are cast outward from the disc through the leaves and trunks near it; a
// ray that escapes through a hole carries a beam on down into the wood.

function castBeams(S, prof, tmp, SX, SY, amt) {
  if (amt <= 0) { prof.fill(0); return; }
  for (let b = 0; b < BINS; b++) {
    const a = (b / BINS) * TAU - Math.PI;
    const dx = Math.sin(a), dy = Math.cos(a);
    let T = 1;
    for (let r = 5 * PX; r < RING && T > 0.02; r += 0.75 * PX) {
      const x = Math.round(SX + dx * r), y = Math.round(SY + dy * r);
      if (x < 0 || y < 0 || x >= W || y >= H) break;
      const i = y * W + x;
      if (S.kind[i] === 0) continue;
      const z = S.depth[i] * PX;
      T *= z > 20 ? 0.985 : z > 12 ? 0.95 : z > 4 ? 0.5 : 0;
    }
    tmp[b] = T;
  }
  // a wide triangle filter: shafts with soft edges, not hard wedges
  const K = 6;
  for (let b = 0; b < BINS; b++) {
    let acc = 0, wsum = 0;
    for (let j = -K; j <= K; j++) { const w = K + 1 - Math.abs(j); acc += tmp[(b + j + BINS) % BINS] * w; wsum += w; }
    prof[b] = (acc / wsum) * amt;
  }
}

// --- small lives ------------------------------------------------------------------------
// Falling leaves and cabbage whites live in the world around the walker and
// are dealt again ahead of them when they drift out of reach.

const LEAF_FRAMES = [[[0, 0], [1, 0]], [[0, 0], [1, 1]], [[0, 0], [0, 1]], [[1, 0], [0, 1]]];

function makeLife() {
  const rand = rng(77);
  const leaves = Array.from({ length: 22 }, () => ({ x: 0, z: 0, h: -1, gold: rand() < 0.55, wob: rand() * TAU, spd: 30 + rand() * 25 }));
  const flies = Array.from({ length: 3 }, (_, k) => ({ hx: 0, hz: 0, live: false, p: k * 2.1 }));
  const motes = Array.from({ length: 160 }, () => ({
    x: rand() * (384 + 40), y: 50 + rand() * 150, z: 1.5 + rand() * 8,   // original pixels
    p1: 16 + rand() * 32, p2: 12 + rand() * 30, ph: rand() * TAU, tw: 5 + rand() * 12,
  }));
  let last = null;

  function draw(S, st, cam, toCamZ, toCamX) {
    const dt = last === null ? 0 : clamp(st.t - last, 0, 0.1);
    last = st.t;
    const fwd = Math.atan2(cam.fx, cam.fz);
    const deal = (o, minD, maxD, spread) => {
      const a = fwd + (Math.random() - 0.5) * spread, d = minD + Math.random() * (maxD - minD);
      o.x = st.x + Math.sin(a) * d; o.z = st.z + Math.cos(a) * d;
    };
    for (const f of leaves) {
      if (f.h < 0 || Math.hypot(f.x - st.x, f.z - st.z) > 1400) { deal(f, 120, 1100, 2.2); f.h = 160 + Math.random() * 380; }
      f.h -= f.spd * dt;
      f.x += cam.wind * 34 * dt * 0.7; f.z += cam.wind * 34 * dt * 0.7;
      f.wob += dt * 2.3;
      const Z = toCamZ(f.x, f.z) , X = toCamX(f.x, f.z) + Math.sin(f.wob) * 18;
      if (Z < 30) continue;
      const z = Z / F;
      const sx = W / 2 + X / z, sy = cam.hy + (cam.eye - f.h) / z;
      const fr = LEAF_FRAMES[Math.floor(f.wob * 5) & 3];
      for (const [a, b] of fr) dot(S, sx + a * PX, sy + b * PX, f.gold ? R.GOLD : R.LEAF, f.gold ? 4 : 5, z, 4, 1, f.x, f.z);
    }
    for (const b of flies) {
      if (!b.live || Math.hypot(b.hx - st.x, b.hz - st.z) > 1500) {
        const o = {}; deal(o, 300, 1000, 1.6); b.hx = o.x; b.hz = o.z; b.live = true;
      }
      const t = st.t;
      const wx = b.hx + 90 * Math.sin(t * 0.37 + b.p) + 22 * Math.sin(t * 1.9 + b.p * 2);
      const wz = b.hz + 70 * Math.sin(t * 0.29 + b.p * 1.3);
      const h = 34 + 14 * Math.sin(t * 0.8 + b.p) + 4 * Math.sin(t * 3.3 + b.p);
      const Z = toCamZ(wx, wz);
      if (Z < 30) continue;
      const z = Z / F, X = toCamX(wx, wz);
      const sx = W / 2 + X / z, sy = cam.hy + (cam.eye - h) / z;
      const open = Math.floor(t * 11 + b.p * 3) % 2 === 0;
      const px = open ? [[-1, -1], [1, -1], [-1, 0], [1, 0], [0, 0]] : [[0, -1], [0, 0]];
      for (const [a, c] of px) dot(S, sx + a * PX, sy + c * PX, R.WHITE, 5, z, 4, 1, wx, wz);
      dot(S, sx - PX, cam.hy + cam.eye / z + PX, R.DIRT, 1, z + 0.01, 4, 0, wx, wz);
    }
  }
  return { draw, motes };
}
