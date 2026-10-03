// Thumbs instead of keys. The left half of the screen is a floating stick:
// put a thumb down anywhere there and push to walk (past the rim to hurry).
// The right half turns and looks as you drag across it. A few buttons do the
// rest: jump, the satchel, sound and fullscreen.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// Touch mode: ?touch=1 or ?touch=0 decides; otherwise a coarse pointer with
// no fine one (a phone or tablet, not a laptop with a touchscreen).
export function wantsTouch(params) {
  if (params.get('touch') === '1') return true;
  if (params.get('touch') === '0') return false;
  return matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
}

const ICONS = {
  jump: '<path d="M12 4l7 8h-4v7H9v-7H5z"/>',
  bag: '<path d="M9 7V5a3 3 0 016 0v2h3l1 13H5L6 7zm2 0h2V5a1 1 0 00-2 0z"/>',
  sound: '<path d="M4 9h4l5-4v14l-5-4H4zM16 8.5a5 5 0 010 7M18.5 6a8.5 8.5 0 010 12" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 9h4l5-4v14l-5-4H4z"/>',
  muted: '<path d="M4 9h4l5-4v14l-5-4H4zM16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2"/>',
  full: '<path d="M4 4h6v2H6v4H4zM14 4h6v6h-2V6h-4zM4 14h2v4h4v2H4zM18 14h2v6h-6v-2h4z"/>',
};
const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">${ICONS[name]}</svg>`;

export function createTouch({ onStart, onJump, onSatchel, onSound, muted }) {
  document.body.classList.add('touch');
  const root = document.createElement('div');
  root.id = 'touch';
  root.innerHTML = `
    <div class="zone move"></div>
    <div class="zone look"></div>
    <div class="stick"><div class="knob"></div></div>
    <div class="bar">
      <button class="sound" aria-label="Sound">${svg(muted ? 'muted' : 'sound')}</button>
      ${document.fullscreenEnabled ? `<button class="full" aria-label="Fullscreen">${svg('full')}</button>` : ''}
      <button class="bag" aria-label="Satchel">${svg('bag')}</button>
    </div>
    <button class="jump" aria-label="Jump">${svg('jump')}</button>`;
  document.body.appendChild(root);

  const $ = (s) => root.querySelector(s);
  const stick = $('.stick'), knob = $('.knob');
  const state = { x: 0, y: 0, run: false };   // x: right, y: ahead, both -1..1
  let turn = 0, look = 0;

  // anything touched at all starts the walk (and, being a gesture, the sound)
  root.addEventListener('pointerdown', () => onStart(), true);
  root.addEventListener('pointerup', () => onStart(), true);
  root.addEventListener('contextmenu', (e) => e.preventDefault());

  // --- the stick ------------------------------------------------------------------
  let movePtr = null, ox = 0, oy = 0;
  const R = () => clamp(Math.min(innerWidth, innerHeight) * 0.13, 44, 72);   // the stick's reach in px
  $('.move').addEventListener('pointerdown', (e) => {
    if (movePtr !== null) return;
    movePtr = e.pointerId; ox = e.clientX; oy = e.clientY;
    e.target.setPointerCapture(e.pointerId);
    stick.style.setProperty('--r', `${R()}px`);
    stick.style.transform = `translate(${ox}px, ${oy}px)`;
    knob.style.transform = '';
    stick.classList.add('on');
  });
  $('.move').addEventListener('pointermove', (e) => {
    if (e.pointerId !== movePtr) return;
    const r = R(), dx = e.clientX - ox, dy = e.clientY - oy, d = Math.hypot(dx, dy);
    const k = d > r ? r / d : 1;
    knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    // a small dead zone in the middle, then full strength at the rim
    const m = clamp((d / r - 0.12) / 0.88, 0, 1);
    state.x = d ? (dx / d) * m : 0;
    state.y = d ? (-dy / d) * m : 0;
    state.run = d > r * 1.35;
    stick.classList.toggle('run', state.run);
  });
  const endMove = (e) => {
    if (e.pointerId !== movePtr) return;
    movePtr = null; state.x = state.y = 0; state.run = false;
    stick.classList.remove('on', 'run');
  };
  $('.move').addEventListener('pointerup', endMove);
  $('.move').addEventListener('pointercancel', endMove);

  // --- looking ----------------------------------------------------------------------
  const lookPtrs = new Map();
  $('.look').addEventListener('pointerdown', (e) => {
    lookPtrs.set(e.pointerId, [e.clientX, e.clientY]);
    e.target.setPointerCapture(e.pointerId);
  });
  $('.look').addEventListener('pointermove', (e) => {
    const p = lookPtrs.get(e.pointerId);
    if (!p) return;
    // a drag across the width of a phone turns about a half circle
    const s = 3.2 / Math.max(innerWidth, innerHeight);
    turn += (e.clientX - p[0]) * s;
    look -= (e.clientY - p[1]) * s;
    p[0] = e.clientX; p[1] = e.clientY;
  });
  const endLook = (e) => lookPtrs.delete(e.pointerId);
  $('.look').addEventListener('pointerup', endLook);
  $('.look').addEventListener('pointercancel', endLook);

  // --- buttons ---------------------------------------------------------------------------
  const press = (sel, fn) => $(sel)?.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); onStart(); fn(); });
  press('.jump', onJump);
  press('.bag', onSatchel);
  press('.sound', () => { $('.sound').innerHTML = svg(onSound() ? 'muted' : 'sound'); });
  press('.full', () => {
    if (document.fullscreenElement) return document.exitFullscreen();
    document.documentElement.requestFullscreen?.().then(() => screen.orientation?.lock?.('landscape')).catch(() => {});
  });

  return {
    move: state,
    // turning and looking gathered since the last call
    takeLook() { const r = [turn, look]; turn = look = 0; return r; },
  };
}
