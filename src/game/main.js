// The walker: keys and mouse in, a 30 fps pixel frame out, scaled up with
// nearest-neighbour to cover the window.
import { createWorld, MUSH } from './world.js';
import { createRenderer, setScale, W, H, PX, PITCH_MAX } from './render.js';
import { drawHud } from './hud.js';

const params = new URLSearchParams(location.search);
let seed = Number(params.get('seed'));
if (!Number.isInteger(seed) || seed <= 0) {
  seed = 1 + Math.floor(Math.random() * 99999);
  params.set('seed', seed);
  history.replaceState(null, '', `${location.pathname}?${params}`);
}
const FPS = Number(params.get('fps')) || 30;
// frame size: 2 is 768x432, 1 the original 384x216 for slower machines
setScale(Number(params.get('scale')) === 1 ? 1 : 2);

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const frame = new OffscreenCanvas(W, H);
const fctx = frame.getContext('2d');
const image = fctx.createImageData(W, H);
const world = createWorld(seed);
const renderer = createRenderer(world);
document.getElementById('hint').textContent = `seed ${seed} · f fullscreen · esc frees the mouse`;

const EYE = 112;
const WALK = 170, RUN = 340, TURN = 1.9, RADIUS = 16, REACH = 40;
const LOOK = 1.2, GRAVITY = 1500, JUMP = 460;   // a hop of about 70: enough to clear a log
const st = { ...world.start(), t: 0, eye: EYE, pitch: 0, vx: 0, vz: 0, bob: 0, jump: 0, vy: 0, dip: 0 };
const basket = { [MUSH.RED]: 0, [MUSH.GOLD]: 0, [MUSH.WHITE]: 0 };
const flash = { [MUSH.RED]: 0, [MUSH.GOLD]: 0, [MUSH.WHITE]: 0 };

function resize() {
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  ctx.imageSmoothingEnabled = false;
}
addEventListener('resize', resize);
resize();

// --- input ------------------------------------------------------------------------

const keys = new Set();
let playing = false, mouseTurn = 0, mouseLook = 0, jumpQueued = false;
const held = (...codes) => codes.some((c) => keys.has(c)) ? 1 : 0;
const GAME_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyR', 'KeyV', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'PageUp', 'PageDown']);

addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (!playing) { playing = true; document.body.classList.add('playing'); }
  if (GAME_KEYS.has(e.code)) e.preventDefault();
  if (e.code === 'Space' && !e.repeat) jumpQueued = true;
  if (e.code === 'KeyF' && !e.repeat) {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  }
  keys.add(e.code);
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

canvas.addEventListener('click', () => {
  if (!playing) { playing = true; document.body.classList.add('playing'); }
  if (document.pointerLockElement !== canvas) canvas.requestPointerLock?.();
});
document.addEventListener('pointerlockchange', () => document.body.classList.toggle('locked', document.pointerLockElement === canvas));
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === canvas) { mouseTurn += e.movementX * 0.0028; mouseLook -= e.movementY * 0.0028; }
});

let uiTimer = 0;
addEventListener('pointermove', () => {
  document.body.classList.add('ui');
  clearTimeout(uiTimer);
  uiTimer = setTimeout(() => document.body.classList.remove('ui'), 2000);
});

// --- walking ------------------------------------------------------------------------

function step(dt) {
  st.t += dt;
  for (const k in flash) flash[k] = Math.max(0, flash[k] - dt);
  if (!playing) { st.heading += dt * 0.04; return; }   // idle drift behind the title

  st.heading += (held('KeyD', 'ArrowRight') - held('KeyA', 'ArrowLeft')) * TURN * dt + mouseTurn;
  st.pitch += (held('KeyR', 'PageUp') - held('KeyV', 'PageDown')) * LOOK * dt + mouseLook;
  st.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, st.pitch));
  mouseTurn = mouseLook = 0;

  // jumping: up off the ground, and a little dip in the knees on landing
  const grounded = st.jump <= 0;
  if (jumpQueued && grounded) st.vy = JUMP;
  jumpQueued = false;
  if (st.vy !== 0 || st.jump > 0) {
    st.vy -= GRAVITY * dt;
    st.jump += st.vy * dt;
    if (st.jump <= 0) { st.dip = Math.min(14, -st.vy * 0.02); st.jump = 0; st.vy = 0; }
  }
  st.dip *= Math.exp(-dt * 10);
  const fwd = held('KeyW', 'ArrowUp') - held('KeyS', 'ArrowDown');
  const side = held('KeyE') - held('KeyQ');
  const fx = Math.sin(st.heading), fz = Math.cos(st.heading);
  let dx = fx * fwd + fz * side, dz = fz * fwd - fx * side;
  const m = Math.hypot(dx, dz);
  const speed = held('ShiftLeft', 'ShiftRight') ? RUN : WALK;
  if (m > 0) { dx *= speed / m; dz *= speed / m; }
  // ease in and out of a stride; in the air there is little to push against
  const k = 1 - Math.exp(-dt * (st.jump > 0 ? 1.5 : 9));
  st.vx += (dx - st.vx) * k; st.vz += (dz - st.vz) * k;
  const ox = st.x, oz = st.z;
  st.x += st.vx * dt; st.z += st.vz * dt;
  world.collide(st, RADIUS, st.jump);
  const moved = Math.hypot(st.x - ox, st.z - oz);
  if (st.jump <= 0) st.bob += moved / 62;
  const pace = st.jump > 0 ? 0 : Math.min(1, Math.hypot(st.vx, st.vz) / WALK);
  st.eye = EYE + st.jump - st.dip + Math.abs(Math.sin(st.bob)) * 2.2 * pace - 1.1 * pace;

  for (const m of world.pickup(st.x, st.z, REACH)) { basket[m.kind]++; flash[m.kind] = 0.5; }
}

// --- the loop ---------------------------------------------------------------------------

const stats = params.has('stats') ? { n: 0, render: 0, blit: 0 } : null;
if (stats) window.walker = st;   // for poking at from the console
const hint = document.getElementById('hint');

function draw() {
  // cover the window, keeping the horizon a little above centre
  const s = Math.max(canvas.width / W, canvas.height / H);
  const dw = W * s, dh = H * s, dx = (canvas.width - dw) / 2, dy = (canvas.height - dh) * 0.45;
  const t0 = performance.now();
  renderer.render(st, image.data);
  const t1 = performance.now();
  drawHud(image.data, W, H, basket, flash, Math.ceil(-dx / s), Math.ceil(-dy / s), PX);
  fctx.putImageData(image, 0, 0);
  ctx.drawImage(frame, dx, dy, dw, dh);
  canvas.classList.add('lit');
  if (stats) {
    stats.render += t1 - t0; stats.blit += performance.now() - t1;
    if (++stats.n === 30) {
      hint.textContent = `render ${(stats.render / 30).toFixed(1)}ms · blit ${(stats.blit / 30).toFixed(1)}ms`;
      document.body.classList.add('ui');
      stats.n = stats.render = stats.blit = 0;
    }
  }
}

let last = performance.now(), lastDraw = -1e9;
function tick(now) {
  requestAnimationFrame(tick);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  step(dt);
  if (now - lastDraw >= 1000 / FPS - 4) { lastDraw = now; draw(); }
}
draw();
requestAnimationFrame(tick);
