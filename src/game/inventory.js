// The satchel: a grid of slots in the manner of the old action RPGs. Each slot
// holds a stack of one kind. Click a stack to lift it onto the cursor (shift
// lifts half), click a slot to set it down, swapping or merging with what is
// there; click anywhere outside the satchel to leave it on the forest floor.

import { ITEMS, KIND, iconPixels } from './items.js';

export const COLS = 10, ROWS = 4;

const icons = {};
function iconURL(id) {
  if (!icons[id]) {
    const c = document.createElement('canvas');
    c.width = c.height = 12;
    c.getContext('2d').putImageData(new ImageData(iconPixels(id), 12, 12), 0, 0);
    icons[id] = c.toDataURL();
  }
  return icons[id];
}

const el = (tag, cls, parent) => { const e = document.createElement(tag); if (cls) e.className = cls; parent?.appendChild(e); return e; };
const nameClass = (it) => it.poison ? 'poison' : it.kind === KIND.BERRY ? 'berry' : it.kind === KIND.HERB ? 'herb' : 'mushroom';

export function createInventory() {
  const slots = new Array(COLS * ROWS).fill(null);    // { id, n } or null
  const found = {};                                   // id -> how many ever gathered
  let held = null, open = false;

  // --- the DOM -------------------------------------------------------------------

  const root = el('div', 'satchel', document.body);
  root.id = 'satchel';
  const panel = el('div', 'panel', root);
  el('div', 'title', panel).textContent = 'Satchel';

  el('div', 'label', panel).textContent = 'Field guide';
  const guide = el('div', 'guide', panel);
  const guideCells = Object.keys(ITEMS).map((id) => {
    const c = el('div', 'cell', guide);
    c.dataset.guide = id;
    const img = el('img', '', c);
    img.src = iconURL(id); img.alt = ''; img.draggable = false;
    return c;
  });

  el('div', 'label', panel).textContent = 'Pack';
  const grid = el('div', 'grid', panel);
  grid.style.setProperty('--cols', COLS);
  const cells = slots.map((_, i) => {
    const c = el('div', 'cell', grid);
    c.dataset.slot = i;
    return c;
  });

  const foot = el('div', 'foot', panel);
  el('div', 'help', panel).innerHTML = '<b>click</b> lift / place · <b>shift</b> lift half · click outside to drop · <b>I</b> / <b>esc</b> close';

  const cursor = el('div', 'held', document.body);
  const tip = el('div', 'tip', document.body);
  const toasts = el('div', 'toasts', document.body);

  function paint() {
    cells.forEach((c, i) => {
      const s = slots[i];
      c.replaceChildren();
      c.classList.toggle('full', !!s);
      if (!s) return;
      const img = el('img', '', c);
      img.src = iconURL(s.id); img.alt = ITEMS[s.id].name; img.draggable = false;
      if (s.n > 1) el('span', 'n', c).textContent = s.n;
    });
    guideCells.forEach((c) => c.classList.toggle('unknown', !found[c.dataset.guide]));
    const by = { [KIND.MUSHROOM]: 0, [KIND.BERRY]: 0, [KIND.HERB]: 0 };
    let used = 0;
    for (const s of slots) if (s) { by[ITEMS[s.id].kind] += s.n; used++; }
    if (held) by[ITEMS[held.id].kind] += held.n;
    foot.innerHTML = `<span>Mushrooms <b>${by[KIND.MUSHROOM]}</b></span><span>Berries <b>${by[KIND.BERRY]}</b></span>` +
      `<span>Herbs <b>${by[KIND.HERB]}</b></span><span class="slots">${used} / ${slots.length} slots</span>`;
    cursor.replaceChildren();
    cursor.classList.toggle('on', !!held);
    if (held) {
      const img = el('img', '', cursor);
      img.src = iconURL(held.id); img.alt = ''; img.draggable = false;
      if (held.n > 1) el('span', 'n', cursor).textContent = held.n;
    }
  }

  // --- tooltips ----------------------------------------------------------------------

  function showTip(id, n, e) {
    const it = ITEMS[id];
    tip.replaceChildren();
    if (!found[id]) {
      el('div', 'name', tip).textContent = '? ? ?';
      el('div', 'kind', tip).textContent = 'Not yet found';
    } else {
      el('div', `name ${nameClass(it)}`, tip).textContent = it.name;
      el('div', 'latin', tip).textContent = it.latin;
      el('div', 'kind', tip).textContent = it.poison ? `${it.kind} · Poisonous` : it.kind;
      if (n) el('div', 'qty', tip).textContent = `Quantity: ${n} / ${it.stack}`;
      el('div', 'note', tip).textContent = it.note;
      el('div', 'qty', tip).textContent = `Gathered in all: ${found[id]}`;
    }
    tip.classList.add('on');
    moveTip(e);
  }
  function moveTip(e) {
    const r = tip.getBoundingClientRect(), pad = 14;
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
    if (y + r.height > innerHeight - 8) y = innerHeight - r.height - 8;
    tip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
  }
  const hideTip = () => tip.classList.remove('on');

  root.addEventListener('pointermove', (e) => {
    const c = e.target.closest('.cell');
    const id = c?.dataset.guide ?? slots[c?.dataset.slot]?.id;
    if (held || id === undefined) return hideTip();
    showTip(id, c.dataset.slot !== undefined ? slots[c.dataset.slot].n : 0, e);
  });
  root.addEventListener('pointerleave', hideTip);
  addEventListener('pointermove', (e) => {
    cursor.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
  });

  // --- lifting and setting down ------------------------------------------------------

  function clickSlot(i, shift) {
    const s = slots[i];
    if (!held) {
      if (!s) return;
      const take = shift && s.n > 1 ? Math.floor(s.n / 2) : s.n;
      held = { id: s.id, n: take };
      s.n -= take;
      if (!s.n) slots[i] = null;
    } else if (!s) {
      slots[i] = held; held = null;
    } else if (s.id === held.id) {
      const room = ITEMS[s.id].stack - s.n, put = Math.min(room, held.n);
      s.n += put; held.n -= put;
      if (!held.n) held = null;
      else if (!put) { slots[i] = held; held = s; }    // a full stack: just swap
    } else {
      slots[i] = held; held = s;
    }
    hideTip();
    paint();
  }

  panel.addEventListener('click', (e) => {
    const c = e.target.closest('[data-slot]');
    if (c) clickSlot(+c.dataset.slot, e.shiftKey);
  });
  // a click anywhere outside the panel lets go of what is held
  root.addEventListener('click', (e) => {
    if (held && !panel.contains(e.target)) drop();
  });

  function drop() {
    if (!held) return;
    toast(held.id, `Left ${held.n} ${ITEMS[held.id].name} on the ground`);
    held = null;
    paint();
  }

  // put the held stack back wherever it fits
  function stow() {
    if (!held) return;
    const { id, n } = held;
    held = null;
    for (let k = 0; k < n; k++) add(id, false);
  }

  // --- the outside world ---------------------------------------------------------

  // returns false if there is no room for it
  function add(id, gathered = true) {
    let s = slots.find((s) => s && s.id === id && s.n < ITEMS[id].stack);
    if (!s) {
      const i = slots.indexOf(null);
      if (i < 0) return false;
      s = slots[i] = { id, n: 0 };
    }
    s.n++;
    if (gathered) { found[id] = (found[id] || 0) + 1; toast(id, `+1 ${ITEMS[id].name}`); }
    if (open || gathered) paint();
    return true;
  }

  // brief notes at the foot of the screen; repeats of the same note stack up
  let lastFull = -Infinity;
  function toast(id, text) {
    const last = toasts.lastElementChild;
    if (last && last.dataset.text === text && !last.classList.contains('out')) {
      last.dataset.count = (+last.dataset.count || 1) + 1;
      last.querySelector('span').textContent = text.startsWith('+1 ') ? `+${last.dataset.count} ${ITEMS[id].name}` : text;
      clearTimeout(last._t);
      last._t = setTimeout(() => fade(last), 2400);
      return;
    }
    const t = el('div', 'toast', toasts);
    t.dataset.text = text;
    if (id !== null) { const img = el('img', '', t); img.src = iconURL(id); img.alt = ''; }
    el('span', '', t).textContent = text;
    while (toasts.children.length > 5) toasts.firstElementChild.remove();
    t._t = setTimeout(() => fade(t), 2400);
  }
  const fade = (t) => { t.classList.add('out'); setTimeout(() => t.remove(), 500); };
  function full() {
    const now = performance.now();
    if (now - lastFull > 4000) { lastFull = now; toast(null, 'Your satchel is full'); }
  }

  function setOpen(v) {
    if (open === v) return;
    open = v;
    if (!open) { stow(); hideTip(); }
    document.body.classList.toggle('satchel-open', open);
    paint();
  }

  paint();
  return {
    add, full,
    isOpen: () => open,
    toggle: () => setOpen(!open),
    close: () => setOpen(false),
  };
}
