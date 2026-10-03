// The basket: drawn straight into the finished frame, in the same palette.

import { R, LUT } from '../pixel.js';
import { MUSH } from './world.js';

const col = (ramp, L) => { const e = (ramp * 16 + L + 4) * 3; return [LUT[e], LUT[e + 1], LUT[e + 2]]; };

// 3x5 digits
const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001',
  '111100111001111', '111100111101111', '111001010010010', '111101111101111', '111101111001111'];

// 7x6 icons: . clear, o outline, c cap, s spot, t stem
const ICONS = {
  [MUSH.RED]: ['.occco.', 'occscco', 'ocsccso', 'ooottoo', '...t...', '..ttt..'],
  [MUSH.GOLD]: ['occccco', '.occco.', '..oco..', '..oto..', '...t...', '..ttt..'],
  [MUSH.WHITE]: ['.occco.', 'occccco', 'occccco', 'ooottoo', '...t...', '..ttt..'],
};
const CAP = { [MUSH.RED]: [R.MUSH, 5], [MUSH.GOLD]: [R.GOLD, 5], [MUSH.WHITE]: [R.WHITE, 6] };

// (ox, oy): the top-left pixel that is actually on screen after cropping.
// px: frame pixels per HUD pixel, so the basket is the same size at any resolution.
export function drawHud(rgba, W, H, basket, flash, ox = 0, oy = 0, px = 1) {
  const put1 = (x, y, c, a) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4;
    rgba[o] += (c[0] - rgba[o]) * a; rgba[o + 1] += (c[1] - rgba[o + 1]) * a; rgba[o + 2] += (c[2] - rgba[o + 2]) * a;
  };
  // (x, y) in HUD pixels, measured from the visible corner
  const put = (x, y, c, a = 1) => {
    for (let j = 0; j < px; j++) for (let k = 0; k < px; k++) put1(ox + x * px + k, oy + y * px + j, c, a);
  };
  const ink = col(R.WHITE, 7), shade = col(R.LEAFD, -2);
  const stem = col(R.WHITE, 5), spot = col(R.WHITE, 7), outline = col(R.LEAFD, -3);
  let x = 6;
  for (const kind of [MUSH.RED, MUSH.GOLD, MUSH.WHITE]) {
    const n = basket[kind];
    if (!n && kind !== MUSH.RED) continue;
    const lit = flash[kind] > 0 ? 2 : 0;
    const cap = col(CAP[kind][0], CAP[kind][1] + lit);
    ICONS[kind].forEach((row, j) => [...row].forEach((ch, i) => {
      const c = ch === 'c' ? cap : ch === 's' ? spot : ch === 't' ? stem : ch === '.' ? null : outline;
      if (c) put(x + i, 6 + j, c);
    }));
    x += 9;
    for (const d of String(n)) {
      const g = DIGITS[+d];
      for (let k = 0; k < 15; k++) if (g[k] === '1') { put(x + (k % 3) + 1, 8 + ((k / 3) | 0), shade, 0.6); put(x + (k % 3), 7 + ((k / 3) | 0), ink); }
      x += 4;
    }
    x += 6;
  }
}
