// Playback: a steady 30 fps beat, scaled up with nearest-neighbour to cover the window.
import { createScene, W, H, DURATION } from './scene.js';

const FPS = 30;
const params = new URLSearchParams(location.search);
const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const frame = new OffscreenCanvas(W, H);
const fctx = frame.getContext('2d');
const image = fctx.createImageData(W, H);
const scene = createScene();

function resize() {
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  ctx.imageSmoothingEnabled = false;
}
addEventListener('resize', resize);
resize();

function draw(t) {
  scene.render(t, image.data);
  fctx.putImageData(image, 0, 0);
  // cover the window, keeping the horizon a little above centre
  const s = Math.max(canvas.width / W, canvas.height / H);
  const dw = W * s, dh = H * s;
  ctx.drawImage(frame, (canvas.width - dw) / 2, (canvas.height - dh) * 0.45, dw, dh);
  canvas.classList.add('lit');
}

let playing = !params.has('still');
let offset = Number(params.get('t')) || 0;
let startWall = 0, last = -1;

function tick(wall) {
  requestAnimationFrame(tick);
  if (!playing) return;
  if (!startWall) startWall = wall;
  const idx = Math.floor(((wall - startWall) / 1000 + offset) * FPS);
  if (idx === last) return;
  last = idx;
  draw((idx / FPS) % DURATION);
}

draw(offset % DURATION);
requestAnimationFrame(tick);

let uiTimer = 0;
addEventListener('pointermove', () => {
  document.body.classList.add('ui');
  clearTimeout(uiTimer);
  uiTimer = setTimeout(() => document.body.classList.remove('ui'), 2000);
});
addEventListener('keydown', (e) => {
  if (e.key === ' ') {
    e.preventDefault();
    if (playing) offset = last / FPS; else startWall = 0;
    playing = !playing;
  } else if (e.key === 'f') {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  }
});
