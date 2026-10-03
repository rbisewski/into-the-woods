// ---------------------------------------------------------------------------
// The endless wood. Everything here is a pure function of (seed, position):
// trails, clearings and the mix of trees are slow noise fields, and the things
// standing in the wood are dealt out per square cell from a hashed RNG, so a
// cell regenerates identically however many times it is evicted.
//
// World units match the film: the eye is 112 up, trunks are 1100-1700 tall.
// x runs east, z runs north; heading 0 looks north.
// ---------------------------------------------------------------------------

import { TAU, hash, vnoise, vnoiseD, rng, clamp, smooth } from '../pixel.js';

export const CELL = 256;
export const TRAIL_HW = 58;            // trail half-width
export const SUN_AZ = 0.55;            // the sun's bearing, low over the trees

export const SP = { OAK: 0, BIRCH: 1, PINE: 2 };
export const MUSH = { RED: 0, GOLD: 1, WHITE: 2 };
// berries and herbs; their kinds follow on from the mushrooms' so one number names any find
export const PLANT = { BILBERRY: 3, RASPBERRY: 4, GARLIC: 5, SORREL: 6, WORT: 7 };

export function createWorld(seed = 1) {
  const S = (k) => (seed * 7919 + k) | 0;      // salt for each noise field
  const g = [0, 0, 0];

  // Trails are the n = 0.5 contour of a slow field, so they wind, fork and
  // close into loops. Dividing by the gradient turns the field into a
  // distance in world units, which keeps the width roughly even.
  const tf = [0, 0, 0];
  function trailField(x, z) {
    vnoiseD(x / 2600, z / 2600, S(1), g);
    let n = 0.7 * g[0], gx = 0.7 * g[1] / 2600, gz = 0.7 * g[2] / 2600;
    vnoiseD(x / 900, z / 900, S(2), g);
    tf[0] = n + 0.3 * g[0] - 0.5; tf[1] = gx + 0.3 * g[1] / 900; tf[2] = gz + 0.3 * g[2] / 900;
    return tf;
  }
  function trail(x, z) {
    trailField(x, z);
    return Math.abs(tf[0]) / (Math.hypot(tf[1], tf[2]) + 1e-7);
  }
  // the same, signed: smooth enough to interpolate between samples
  function trailSigned(x, z) {
    trailField(x, z);
    return tf[0] / (Math.hypot(tf[1], tf[2]) + 1e-7);
  }
  // how thickly the trees stand: low values open into sunny clearings
  // the coarse part alone: how much sky the floor sees
  const openness = (x, z) => 1 - 0.75 * smooth(0.26, 0.64, vnoise(x / 1700, z / 1700, S(3)) * 0.75 + 0.125);
  const density = (x, z) => smooth(0.26, 0.64, vnoise(x / 1700, z / 1700, S(3)) * 0.75 + vnoise(x / 600, z / 600, S(4)) * 0.25);
  // groves: birch where it is low, pine where it is high, oak between
  const grove = (x, z) => vnoise(x / 2300, z / 2300, S(5));

  // --- cells -------------------------------------------------------------------

  const cells = new Map();
  const picked = new Set();

  function genCell(cx, cz) {
    const r = rng(Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663) ^ S(6));
    const x0 = cx * CELL, z0 = cz * CELL;
    const c = { trees: [], bushes: [], ferns: [], tufts: [], rocks: [], logs: [], stumps: [], mush: [], plants: [] };
    const spot = () => [x0 + r() * CELL, z0 + r() * CELL];
    const clearOf = (x, z, d) => trail(x, z) > d;
    const dc = density(x0 + CELL / 2, z0 + CELL / 2);

    for (let k = 0; k < 3; k++) {
      const [x, z] = spot();
      const d = density(x, z);
      if (r() > d * 0.5) continue;
      const gv = grove(x, z) + (r() - 0.5) * 0.25;
      const sp = gv < 0.36 ? SP.BIRCH : gv > 0.64 ? SP.PINE : SP.OAK;
      const w = sp === SP.BIRCH ? 13 + r() * 9 : sp === SP.PINE ? 18 + r() * 12 : 20 + r() * 18;
      if (!clearOf(x, z, TRAIL_HW * 1.4 + w)) continue;
      if (c.trees.some((t) => Math.hypot(t.x - x, t.z - z) < 130)) continue;
      const la = r() * TAU, lm = r() * 0.035;
      c.trees.push({ x, z, w, sp, H: 1100 + r() * 600 * (sp === SP.PINE ? 0.8 : 1), lx: Math.cos(la) * lm, lz: Math.sin(la) * lm,
        seed: (r() * 1e6) | 0, crown: null });
    }
    const nb = r() < 0.2 + dc * 0.5 ? 1 + (r() < 0.4) : 0;
    for (let k = 0; k < nb; k++) {
      const [x, z] = spot(), s = 30 + r() * 45;
      if (clearOf(x, z, TRAIL_HW * 1.15 + s)) c.bushes.push({ x, z, s, seed: (r() * 1e6) | 0, phase: r() * TAU, lobes: null });
    }
    const nf = Math.floor(r() * 7 * (0.25 + dc));
    for (let k = 0; k < nf; k++) {
      const [x, z] = spot();
      if (!clearOf(x, z, TRAIL_HW * 1.05)) continue;
      const fr = 5 + Math.floor(r() * 4);
      c.ferns.push({ x, z, s: 26 + r() * 22, phase: r() * TAU, fronds: Array.from({ length: fr }, (_, j) => ({
        a: -1.35 + (2.7 * (j + 0.5)) / fr + (r() - 0.5) * 0.25, len: 0.75 + r() * 0.45 })) });
    }
    for (let k = 0; k < 34; k++) {
      const [x, z] = spot();
      if (!clearOf(x, z, TRAIL_HW * 0.8)) continue;
      const open = 1 - density(x, z);
      const n = 3 + Math.floor(r() * 4);
      const flower = r() < open * 0.35 ? 1 + Math.floor(r() * 3) : 0;   // 1 white, 2 gold, 3 red
      c.tufts.push({ x, z, phase: r() * TAU, tone: r() < 0.3 ? 1 : 0, flower, blades: Array.from({ length: n }, () => ({
        dx: (r() - 0.5) * 6, h: 7 + r() * 13, lean: (r() - 0.5) * 0.7 })) });
    }
    if (r() < 0.3) {
      const [x, z] = spot();
      c.rocks.push({ x, z, r: 6 + r() * 9, moss: r() * 0.4, seed: (r() * 1e6) | 0 });
    }
    if (r() < 0.07) {
      const [x, z] = spot(), rr = 34 + r() * 46;
      if (clearOf(x, z, TRAIL_HW + rr)) c.rocks.push({ x, z, r: rr, moss: 0.4 + r() * 0.5, seed: (r() * 1e6) | 0, big: true });
    }
    if (r() < 0.08) {
      const [x, z] = spot(), a = r() * TAU, len = 220 + r() * 240, rad = 15 + r() * 11;
      const x2 = x + Math.cos(a) * len, z2 = z + Math.sin(a) * len;
      if (clearOf(x, z, TRAIL_HW + 40) && clearOf(x2, z2, TRAIL_HW + 40) && clearOf((x + x2) / 2, (z + z2) / 2, TRAIL_HW + 40))
        c.logs.push({ x, z, x2, z2, rad, seed: (r() * 1e6) | 0 });
    }
    if (r() < 0.07) {
      const [x, z] = spot();
      if (clearOf(x, z, TRAIL_HW + 30)) c.stumps.push({ x, z, w: 26 + r() * 22, h: 26 + r() * 30, seed: (r() * 1e6) | 0 });
    }
    // mushrooms come up in little clusters, mostly at the foot of something
    if (r() < 0.16 + dc * 0.14) {
      const host = c.trees[0] || c.logs[0] || c.stumps[0];
      let [x, z] = spot();
      if (host && r() < 0.75) { const a = r() * TAU, d = (host.w || host.rad * 2 || 30) * 0.5 + 14 + r() * 26; x = host.x + Math.cos(a) * d; z = host.z + Math.sin(a) * d; }
      const kind = r() < 0.68 ? MUSH.RED : r() < 0.7 ? MUSH.GOLD : MUSH.WHITE;
      const n = 1 + Math.floor(r() * 3);
      for (let k = 0; k < n; k++) {
        const id = `${cx},${cz},${k}`;
        // draw it even if picked, so what follows in the cell comes out the same
        const m = { id, kind, x: x + (r() - 0.5) * 30, z: z + (r() - 0.5) * 30, s: 0.75 + r() * 0.5, phase: r() * TAU };
        if (!picked.has(id)) c.mush.push(m);
      }
    }
    // berries and herbs grow in patches, each where it likes the light: bilberry
    // under pine and birch, raspberry and St John's wort out in the clearings,
    // wild garlic in the deep shade of the oaks, wood sorrel anywhere under trees.
    // (Drawn after everything above, so the rest of a cell is the same as ever.)
    if (r() < 0.22) {
      const [x, z] = spot();
      const open = 1 - density(x, z), gv = grove(x, z);
      const kind = open > 0.55 ? (r() < 0.55 ? PLANT.RASPBERRY : PLANT.WORT)
        : gv > 0.6 || gv < 0.38 ? (r() < 0.7 ? PLANT.BILBERRY : PLANT.SORREL)
        : r() < 0.5 ? PLANT.GARLIC : PLANT.SORREL;
      const n = 1 + Math.floor(r() * 3);
      for (let k = 0; k < n; k++) {
        const id = `${cx},${cz},p${k}`;
        const px = x + (r() - 0.5) * 50, pz = z + (r() - 0.5) * 50;
        const leaves = 5 + Math.floor(r() * 4);
        const p = { id, kind, x: px, z: pz, s: 0.8 + r() * 0.4, phase: r() * TAU, seed: (r() * 1e6) | 0,
          leaves: Array.from({ length: leaves }, (_, j) => ({ a: -1.3 + (2.6 * (j + 0.5)) / leaves + (r() - 0.5) * 0.3, len: 0.6 + r() * 0.5 })) };
        if (!picked.has(id) && clearOf(px, pz, TRAIL_HW * 0.85)) c.plants.push(p);
      }
    }
    return c;
  }

  function cell(cx, cz) {
    const key = cx * 65536 + cz;
    let c = cells.get(key);
    if (!c) {
      c = genCell(cx, cz);
      c.cx = cx; c.cz = cz;
      cells.set(key, c);
    }
    return c;
  }

  // every cell whose square comes within reach of (x, z)
  function forCells(x, z, reach, fn) {
    if (cells.size > 12000) {
      // forget what is well out of sight; it comes back identical if revisited
      const keep = 9000 / CELL;
      for (const [k, c] of cells) if (Math.abs(c.cx + 0.5 - x / CELL) > keep || Math.abs(c.cz + 0.5 - z / CELL) > keep) cells.delete(k);
    }
    const a = Math.floor((x - reach) / CELL), b = Math.floor((x + reach) / CELL);
    const p = Math.floor((z - reach) / CELL), q = Math.floor((z + reach) / CELL);
    for (let cz = p; cz <= q; cz++) for (let cx = a; cx <= b; cx++) fn(cell(cx, cz), cx, cz);
  }

  // --- walking ---------------------------------------------------------------

  // push a walker of radius rad out of trunks, rocks, stumps and logs;
  // anything lower than their feet (when jumping) is cleared
  function collide(pos, rad, feet = 0) {
    forCells(pos.x, pos.z, 120, (c) => {
      const push = (cx, cz, rr) => {
        const dx = pos.x - cx, dz = pos.z - cz, d = Math.hypot(dx, dz);
        if (d < rr && d > 1e-6) { pos.x = cx + (dx / d) * rr; pos.z = cz + (dz / d) * rr; }
      };
      for (const t of c.trees) push(t.x, t.z, t.w * 0.5 + rad);
      for (const s of c.stumps) if (feet < s.h) push(s.x, s.z, s.w * 0.5 + rad);
      for (const k of c.rocks) if (k.big && feet < k.r * 0.72) push(k.x, k.z, k.r * 0.9 + rad);
      for (const l of c.logs) {
        if (feet >= l.rad * 2) continue;
        const ex = l.x2 - l.x, ez = l.z2 - l.z, L2 = ex * ex + ez * ez;
        const u = clamp(((pos.x - l.x) * ex + (pos.z - l.z) * ez) / L2, 0, 1);
        push(l.x + ex * u, l.z + ez * u, l.rad + rad);
      }
    });
  }

  // gather whatever is within reach and accepted (take(kind) says whether
  // there is room for it); anything refused stays where it grows
  function pickup(x, z, reach, take = () => true) {
    const got = [], left = [];
    const gather = (o) => {
      if (Math.hypot(o.x - x, o.z - z) > reach) return true;
      if (!take(o.kind)) { left.push(o); return true; }
      picked.add(o.id); got.push(o);
      return false;
    };
    forCells(x, z, reach + 10, (c) => {
      c.mush = c.mush.filter(gather);
      c.plants = c.plants.filter(gather);
    });
    return { got, left };
  }

  // start on a trail near the origin, looking along it. (Not at the origin
  // itself: value noise is flat on its lattice points.)
  function start() {
    let bx = 0, bz = 0, best = Infinity;
    for (let z = -3000; z <= 3000; z += 40) for (let x = -3000; x <= 3000; x += 40) {
      const d = trail(x + 517, z + 1213) + Math.hypot(x, z) * 0.01;
      if (d < best) { best = d; bx = x + 517; bz = z + 1213; }
    }
    let x = bx, z = bz;
    for (let k = 0; k < 8; k++) {
      const [d, gx, gz] = [...trailField(x, z)];
      const g2 = gx * gx + gz * gz + 1e-12;
      x -= (d * gx) / g2; z -= (d * gz) / g2;
    }
    const [, gx, gz] = [...trailField(x, z)];
    return { x, z, heading: Math.atan2(gz, -gx) };
  }

  return { trail, trailSigned, density, openness, cell, forCells, collide, pickup, start, picked, seed };
}
