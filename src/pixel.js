// ---------------------------------------------------------------------------
// The shared pixel kit: material ramps, the shade LUT, ordered dither and
// cheap hashed noise. Used by the looping film (scene.js) and the game.
// ---------------------------------------------------------------------------

export const TAU = Math.PI * 2;

// --- palette ----------------------------------------------------------------

export const R = { SKY: 1, LEAFD: 2, LEAF: 3, BARK: 4, DIRT: 5, GRASS: 6, MOSS: 7, STONE: 8, FERN: 9, WHITE: 10, GOLD: 11, MUSH: 12 };

export const RAMPS = {
  [R.SKY]:   ['#3d5d7a', '#4f7591', '#6b8fa6', '#8eabb6', '#b3c6c1', '#d4d8bd', '#ecdfae', '#f8ecc8'],
  [R.LEAFD]: ['#0b1715', '#11211d', '#182c24', '#20382a', '#2b4630', '#395735', '#4b6a3a', '#627f42'],
  [R.LEAF]:  ['#18291a', '#223a1e', '#2f4d22', '#3f6226', '#52772b', '#6a8c31', '#86a23c', '#a6b950'],
  [R.BARK]:  ['#171213', '#231a19', '#30241f', '#3f3026', '#503d2e', '#644d37', '#7c6144', '#977a56'],
  [R.DIRT]:  ['#271d19', '#382a20', '#4b3829', '#604932', '#775c3e', '#8f704c', '#a8885f', '#c2a276'],
  [R.GRASS]: ['#122017', '#1a2d1b', '#243d20', '#325026', '#42632b', '#567831', '#6f8e3a', '#8fa748'],
  [R.MOSS]:  ['#1b2816', '#27381a', '#35481e', '#455b23', '#576f29', '#6d8430', '#879a3a', '#a5b048'],
  [R.STONE]: ['#222328', '#2e3036', '#3c3f46', '#4d5058', '#606369', '#77797b', '#918f87', '#aeaa9b'],
  [R.FERN]:  ['#0e2019', '#152e20', '#1d3e27', '#28502e', '#356336', '#46773d', '#5c8c46', '#79a352'],
  [R.WHITE]: ['#46485a', '#62667a', '#868b98', '#aaaeb3', '#c7c9c3', '#dcdbcf', '#ede9da', '#fffbee'],
  [R.GOLD]:  ['#46341a', '#654b20', '#876526', '#ab842c', '#cba037', '#e3bb4b', '#f1d46a', '#fdec98'],
  [R.MUSH]:  ['#381412', '#501b16', '#6b231a', '#892d1e', '#a73a24', '#c14d2e', '#d66942', '#e98b60'],
};

export const SHADOW = hex('#080d18');   // below a ramp's floor
export const SUNLIT = hex('#fff2c6');   // above a ramp's ceiling
export const GLOW = hex('#ffecb8');     // the colour of lit air

export function hex(h) { const v = parseInt(h.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; }
export const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// 16 entries per ramp: levels -4..11. Below 0 falls toward shadow, above 7
// climbs toward sunlight, so strong light changes the hue, not just value.
export function makeLUT(shadow = SHADOW, sunlit = SUNLIT) {
  const lut = new Uint8Array(16 * 16 * 3);
  for (const id in RAMPS) {
    const ramp = RAMPS[id].map(hex);
    for (let L = -4; L <= 11; L++) {
      const c = L < 0 ? mix(ramp[0], shadow, -L / 5) : L > 7 ? mix(ramp[7], sunlit, (L - 7) / 5) : ramp[L];
      const e = (id * 16 + L + 4) * 3;
      lut[e] = c[0]; lut[e + 1] = c[1]; lut[e + 2] = c[2];
    }
  }
  return lut;
}
export const LUT = makeLUT();

// --- dither and noise -------------------------------------------------------

function bayer(n) {
  if (n === 1) return [[0]];
  const m = bayer(n / 2), h = n / 2, q = [[0, 2], [3, 1]];
  return Array.from({ length: n }, (_, y) => Array.from({ length: n }, (_, x) =>
    m[y % h][x % h] * 4 + q[y < h ? 0 : 1][x < h ? 0 : 1]));
}
export const B8 = bayer(8);
export const bay = (x, y) => (B8[y & 7][x & 7] + 0.5) / 64;

// two screen-sized threshold maps, the second offset so fog and glow don't
// dither in lockstep with the shading
export function bayerMaps(W, H) {
  const a = new Float32Array(W * H), b = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    a[y * W + x] = (B8[y & 7][x & 7] + 0.5) / 64;
    b[y * W + x] = (B8[(y + 3) & 7][(x + 5) & 7] + 0.5) / 64;
  }
  return [a, b];
}

export function hash(x, y, s = 0) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 982451653)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function vnoise(x, y, s = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let fx = x - xi, fy = y - yi;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

// value noise with its gradient, written into out = [n, dn/dx, dn/dy]
export function vnoiseD(x, y, s, out) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const dsx = 6 * fx * (1 - fx), dsy = 6 * fy * (1 - fy);
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  const k = a - b - c + d;
  out[0] = a + (b - a) * sx + (c - a) * sy + k * sx * sy;
  out[1] = ((b - a) + k * sy) * dsx;
  out[2] = ((c - a) + k * sx) * dsy;
  return out;
}

export function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
