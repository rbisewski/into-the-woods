// The sound of the wood, made up as it plays with Web Audio: no recordings.
//
// A bed of wind that rises and falls with the same gusts that sway the trees;
// the hiss of leaves over it, thicker where the trees stand close; birds that
// sing from somewhere in the wood and stay put while you turn; and footsteps
// that scuff on the trails and crunch through the litter between them.
//
// Browsers only let sound start from a key press or click, so nothing is made
// until start() is called from one.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (xs) => xs[(Math.random() * xs.length) | 0];

const STORE = 'into-the-woods:muted';
function loadMuted() { try { return localStorage.getItem(STORE) === '1'; } catch { return false; } }
function saveMuted(m) { try { localStorage.setItem(STORE, m ? '1' : '0'); } catch { /* fine without */ } }

export function createAudio() {
  let ctx = null, sc = null, muted = loadMuted();
  return {
    // call from a user gesture
    start() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ctx = new AC();
        sc = soundscape(ctx, ctx.destination);
        sc.setMuted(muted, 0.8);   // fade in
        document.addEventListener('visibilitychange', () => (document.hidden ? ctx.suspend() : ctx.resume()));
      }
      if (ctx.state === 'suspended' && !document.hidden) ctx.resume();
    },
    update(s) { sc?.update(s); },
    step(surface, pace) { sc?.step(surface, pace); },
    land(impact, surface) { sc?.land(impact, surface); },
    toggleMute() { muted = !muted; saveMuted(muted); sc?.setMuted(muted); return muted; },
    get muted() { return muted; },
  };
}

// Everything that makes sound, built on any context (an OfflineAudioContext too).
export function soundscape(ctx, dest) {
  const sr = ctx.sampleRate;

  // --- noise ---------------------------------------------------------------------

  const noiseBuf = (secs, brown) => {
    const b = ctx.createBuffer(1, Math.floor(sr * secs), sr), d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
    }
    // fade the seam so the loop does not click
    const f = Math.floor(sr * 0.05);
    for (let i = 0; i < f; i++) { const k = i / f; d[i] *= k; d[d.length - 1 - i] *= k; }
    return b;
  };
  const WHITE = noiseBuf(3, false), BROWN = noiseBuf(5, true);
  const loop = (buf, offset = 0) => {
    const s = ctx.createBufferSource();
    s.buffer = buf; s.loop = true; s.start(ctx.currentTime, offset % buf.duration);
    return s;
  };
  const filter = (type, f, Q = 0.7) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = Q; return n; };
  const gain = (v = 0) => { const g = ctx.createGain(); g.gain.value = v; return g; };
  const panner = (p) => { const n = ctx.createStereoPanner(); n.pan.value = clamp(p, -1, 1); return n; };
  const chain = (...ns) => { for (let k = 0; k < ns.length - 1; k++) ns[k].connect(ns[k + 1]); return ns[ns.length - 1]; };

  // --- the mix: everything through a gentle limiter, with a little open-air reverb

  const master = gain(0);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.01; comp.release.value = 0.25;
  chain(master, comp, dest);

  // a wood's reverb: short, dark and diffuse, from decaying noise
  const verb = ctx.createConvolver();
  {
    const len = Math.floor(sr * 1.8), ir = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        lp += 0.35 * ((Math.random() * 2 - 1) - lp);
        d[i] = lp * Math.pow(1 - i / len, 3.2) * (i < sr * 0.012 ? i / (sr * 0.012) : 1);
      }
    }
    verb.buffer = ir;
  }
  const verbIn = gain(0.9);
  chain(verbIn, verb, gain(0.55), master);

  // --- wind: brown noise through a lowpass that opens as it gusts ----------------

  const windL = filter('lowpass', 400, 0.5), windR = filter('lowpass', 400, 0.5);
  const windG = gain(0);
  chain(loop(BROWN, 0), windL, panner(-0.6), windG);
  chain(loop(BROWN, 2.3), windR, panner(0.6), windG);
  windG.connect(master);
  // a breathy whistle riding on top, only in the stronger gusts
  const breeze = filter('bandpass', 700, 1.6), breezeG = gain(0);
  chain(loop(WHITE, 0.7), breeze, breezeG, master);

  // --- leaves: high hiss with a fast, uneven flutter, left and right apart --------

  const leaves = [-0.7, 0.7].map((p, k) => {
    const g = gain(0);
    chain(loop(WHITE, 1.1 + k * 0.9), filter('highpass', 2200), filter('peaking', 5200, 0.8), panner(p), g, master);
    g.connect(verbIn);
    return g;
  });

  // --- birds --------------------------------------------------------------------------

  // one note: a sine sweeping f0 -> f1, optionally with a warble
  function note(out, t, dur, f0, f1, vol, vib = 0) {
    const o = ctx.createOscillator(), g = gain(0);
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
    if (vib) {
      const lfo = ctx.createOscillator(), lg = gain(vib);
      lfo.frequency.value = rand(28, 45);
      chain(lfo, lg, o.frequency);
      lfo.start(t); lfo.stop(t + dur + 0.02);
    }
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + Math.min(0.012, dur * 0.25));
    g.gain.setTargetAtTime(0, t + dur * 0.55, dur * 0.18);
    chain(o, g, out);
    o.start(t); o.stop(t + dur + 0.1);
  }

  // songs, written as calls to note(); each returns how long it lasts
  const SONGS = {
    // a great tit's "tee-cher tee-cher tee-cher"
    tit(out, t) {
      const n = 3 + ((Math.random() * 3) | 0), hi = rand(5000, 5800), lo = hi * rand(0.66, 0.74);
      for (let k = 0; k < n; k++) {
        const s = t + k * 0.32;
        note(out, s, 0.1, hi, hi * 0.94, 0.5);
        note(out, s + 0.14, 0.11, lo, lo * 0.96, 0.42);
      }
      return n * 0.32;
    },
    // a chaffinch's tumbling run, quickening and falling, with a flourish at the end
    finch(out, t) {
      let s = t, f = rand(5200, 6000), gap = 0.11;
      const n = 9 + ((Math.random() * 5) | 0);
      for (let k = 0; k < n; k++) {
        note(out, s, 0.05, f, f * 0.82, 0.38);
        s += gap; gap *= 0.93; f *= 0.975;
      }
      note(out, s + 0.03, 0.09, f * 1.3, f * 1.6, 0.45);
      note(out, s + 0.15, 0.16, f * 1.5, f * 0.8, 0.5);
      return s + 0.3 - t;
    },
    // a robin: a wandering, liquid phrase, never quite the same twice
    robin(out, t) {
      let s = t;
      const n = 5 + ((Math.random() * 6) | 0);
      for (let k = 0; k < n; k++) {
        const f = rand(2600, 6800), d = rand(0.06, 0.22);
        note(out, s, d, f, f * rand(0.8, 1.25), rand(0.25, 0.45), Math.random() < 0.4 ? rand(80, 220) : 0);
        s += d + rand(0.02, 0.09);
      }
      return s - t;
    },
    // a wood pigeon, far off and soft: "coo-COO-coo, coo-coo"
    pigeon(out, t) {
      const f = rand(430, 500);
      const beats = [[0, 0.32, 0.7], [0.4, 0.55, 1], [1.05, 0.3, 0.7], [1.55, 0.3, 0.75], [1.95, 0.42, 0.8]];
      for (const [d, dur, v] of beats) note(out, t + d, dur, f * 0.96, f * 1.04, 0.32 * v);
      return 2.5;
    },
    // a woodpecker drumming on a dead limb
    drum(out, t) {
      const n = 14 + ((Math.random() * 8) | 0);
      for (let k = 0; k < n; k++) {
        const s = t + k * 0.055, src = ctx.createBufferSource(), g = gain(0), bp = filter('bandpass', rand(900, 1100), 3);
        src.buffer = WHITE;
        const v = 0.9 * (1 - k / n * 0.6);
        g.gain.setValueAtTime(v, s); g.gain.exponentialRampToValueAtTime(0.001, s + 0.03);
        chain(src, bp, g, out);
        src.start(s, Math.random() * 2, 0.04);
      }
      return n * 0.055;
    },
  };
  // how often each sings, relative to the others
  const WEIGHT = { tit: 3, finch: 3, robin: 3, pigeon: 1, drum: 0.4 };
  const kinds = Object.keys(WEIGHT), total = kinds.reduce((a, k) => a + WEIGHT[k], 0);
  const anyKind = () => { let r = Math.random() * total; for (const k of kinds) if ((r -= WEIGHT[k]) < 0) return k; return kinds[0]; };

  // a few birds at once, each sitting somewhere in the world and singing
  // a phrase every so often, then after a while flying off
  const birds = [];
  let nextBird = 1;
  function placeBird(x, z) {
    const a = rand(0, Math.PI * 2), d = rand(250, 1800);
    return { kind: anyKind(), x: x + Math.sin(a) * d, z: z + Math.cos(a) * d, next: 0, left: 2 + ((Math.random() * 5) | 0) };
  }
  function sing(b, s) {
    // where it is from here: in front or behind, to the left or right
    const dx = b.x - s.x, dz = b.z - s.z, d = Math.hypot(dx, dz) || 1;
    const X = dx * Math.cos(s.heading) - dz * Math.sin(s.heading);
    const Z = dx * Math.sin(s.heading) + dz * Math.cos(s.heading);
    const near = 1 / (1 + d / 500);
    const lp = filter('lowpass', (Z < 0 ? 5000 : 9000) * (0.45 + 0.55 * near) + 1200);
    const g = gain((b.kind === 'pigeon' ? 0.6 : 0.3) * (0.25 + 0.75 * near));
    const out = filter('highpass', 300);
    chain(out, lp, panner((X / d) * 0.85), g, master);
    g.connect(verbIn);
    const t = ctx.currentTime + 0.05;
    const len = SONGS[b.kind](out, t);
    setTimeout(() => out.disconnect(), (len + 2) * 1000);
    return len;
  }

  // --- footsteps ---------------------------------------------------------------------------

  let side = 1;
  function grain(t, f, dur, vol, pan, Q = 1.2) {
    const src = ctx.createBufferSource(), g = gain(0), p = panner(pan);
    src.buffer = WHITE;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    chain(src, filter('bandpass', f, Q), g, p, master);
    src.start(t, Math.random() * 2.5, dur + 0.02);
  }
  function thump(t, f, vol) {
    const o = ctx.createOscillator(), g = gain(0);
    o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 0.5, t + 0.09);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    chain(o, g, master);
    o.start(t); o.stop(t + 0.12);
  }
  // surface: 'trail' (packed earth) or 'litter' (leaves, twigs and grass)
  function step(surface, pace = 1) {
    const t = ctx.currentTime + 0.005, v = 0.35 + 0.65 * clamp(pace, 0, 1.6) / 1.6;
    side = -side;
    const pan = side * 0.18;
    if (surface === 'trail') {
      thump(t, rand(70, 95), 0.35 * v);
      grain(t, rand(380, 620), 0.13, 0.5 * v, pan, 0.9);
      grain(t + rand(0.03, 0.06), rand(1400, 2200), 0.09, 0.14 * v, pan, 0.8);
    } else {
      thump(t, rand(60, 80), 0.25 * v);
      // a scatter of tiny cracks and crunches over the footfall
      const n = 6 + ((Math.random() * 6) | 0);
      for (let k = 0; k < n; k++) grain(t + rand(0, 0.16) * (k / n + 0.2), rand(1800, 5200), rand(0.01, 0.035), rand(0.15, 0.4) * v, pan + rand(-0.1, 0.1), rand(1, 3));
      grain(t, rand(700, 1100), 0.18, 0.28 * v, pan, 0.6);
    }
  }
  function land(impact, surface) {
    const k = clamp(impact, 0.3, 1.5);
    step(surface, 1.3 * k);
    thump(ctx.currentTime + 0.005, 55, 0.3 * k);
    side = -side;
    step(surface, k);
  }

  // --- each frame -------------------------------------------------------------------------

  let lastFlutter = 0;
  // s: { x, z, heading, t, density }
  function update(s) {
    const now = ctx.currentTime;
    const wind = clamp(s.wind, 0, 1.6);
    const gust = clamp((wind - 0.5) / 0.9, 0, 1);
    // wind follows the trees' sway, but a gust only swells it so far: past a
    // light breeze it grows slowly. Everything is eased so nothing zips.
    const swell = Math.min(wind, 0.6) + 0.35 * Math.max(0, wind - 0.6);
    windG.gain.setTargetAtTime(0.08 + 0.2 * swell, now, 0.9);
    windL.frequency.setTargetAtTime(220 + 420 * swell, now, 0.9);
    windR.frequency.setTargetAtTime(240 + 450 * swell, now, 1);
    breezeG.gain.setTargetAtTime(0.022 * gust * gust, now, 1);
    breeze.frequency.setTargetAtTime(560 + 520 * gust + 90 * Math.sin(s.t * 0.7), now, 0.8);
    // leaves: thicker under close trees, and always a little alive
    if (now - lastFlutter > 0.07) {
      lastFlutter = now;
      const base = (0.012 + 0.07 * wind) * (0.35 + 0.65 * clamp(s.density, 0, 1));
      for (const g of leaves) g.gain.setTargetAtTime(base * rand(0.35, 1.15), now, 0.05);
    }
    // birds come and go; they hush in a strong gust
    if (now > nextBird && birds.length < 3) { birds.push(placeBird(s.x, s.z)); nextBird = now + rand(4, 12); }
    for (let k = birds.length - 1; k >= 0; k--) {
      const b = birds[k];
      if (now < b.next) continue;
      if (b.left-- <= 0 || Math.hypot(b.x - s.x, b.z - s.z) > 2600) { birds.splice(k, 1); continue; }
      const len = gust > 0.6 && Math.random() < 0.6 ? 0 : sing(b, s);
      b.next = now + len + rand(2, 7) * (b.kind === 'drum' ? 3 : 1);
    }
  }

  function setMuted(m, fade = 0.25) {
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setTargetAtTime(m ? 0 : 0.9, ctx.currentTime, fade);
  }

  return { update, step, land, setMuted };
}
