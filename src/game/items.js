// Everything that can be foraged: what it is called, how many share a slot in
// the satchel, and a 12x12 icon drawn in the same palette as the wood.
//
// Icons are rows of characters; each character is looked up in the item's own
// colours as [ramp, level], and '.' is clear. 'o' is always the dark outline.

import { R, LUT } from '../pixel.js';
import { MUSH, PLANT } from './world.js';

export const KIND = { MUSHROOM: 'Mushroom', BERRY: 'Berry', HERB: 'Herb' };

const OUTLINE = [R.LEAFD, -3];

export const ITEMS = {
  [MUSH.RED]: {
    name: 'Fly Agaric', latin: 'Amanita muscaria', kind: KIND.MUSHROOM, stack: 10, poison: true,
    note: 'Handsome, and poisonous. Admire it; do not eat it.',
    pal: { c: [R.MUSH, 5], h: [R.MUSH, 7], s: [R.WHITE, 7], t: [R.WHITE, 6], d: [R.WHITE, 3] },
    icon: [
      '............',
      '....oooo....',
      '..oohhscoo..',
      '.ohsshcccco.',
      'ohhhccccscco',
      'occsccccccco',
      'oooooooooooo',
      '....otto....',
      '....ottdo...',
      '....ottdo...',
      '...ottttdo..',
      '...oooooo...',
    ],
  },
  [MUSH.GOLD]: {
    name: 'Chanterelle', latin: 'Cantharellus cibarius', kind: KIND.MUSHROOM, stack: 10,
    note: 'Smells faintly of apricots. A forager\'s prize.',
    pal: { c: [R.GOLD, 5], h: [R.GOLD, 7], d: [R.GOLD, 3] },
    icon: [
      '............',
      '............',
      '.oooooooooo.',
      'ohhhcchcccco',
      '.occccccddo.',
      '..occcccdo..',
      '...occcdo...',
      '....occo....',
      '....occo....',
      '....ocdo....',
      '...occcdo...',
      '...oooooo...',
    ],
  },
  [MUSH.WHITE]: {
    name: 'Wood Mushroom', latin: 'Agaricus silvicola', kind: KIND.MUSHROOM, stack: 10,
    note: 'A pale cap that bruises yellow. Always check the gills.',
    pal: { c: [R.WHITE, 6], h: [R.WHITE, 8], d: [R.WHITE, 3], g: [R.BARK, 5], t: [R.WHITE, 5] },
    icon: [
      '............',
      '............',
      '....oooo....',
      '..oohhhhoo..',
      '.ohhhhcccco.',
      '.ohccccccdo.',
      'occccccccddo',
      'oggggggggggo',
      '.oooottoooo.',
      '....ottdo...',
      '...ottttdo..',
      '...oooooo...',
    ],
  },
  [PLANT.BILBERRY]: {
    name: 'Bilberry', latin: 'Vaccinium myrtillus', kind: KIND.BERRY, stack: 20,
    note: 'Sweet, and stains your fingers blue for days.',
    pal: { g: [R.LEAF, 4], G: [R.LEAF, 6], t: [R.BARK, 5], b: [R.BERRY, 5], h: [R.BERRY, 8], d: [R.BERRY, 3] },
    icon: [
      '.......ggg..',
      '......gGGGg.',
      '..gg..tgGg..',
      '.gGGg.t.....',
      '..ggtt......',
      '.oo..t.oo...',
      'ohbo.tohbo..',
      'obdo.oobdo..',
      '.oooohbo....',
      '...oobdo....',
      '....ooo.....',
      '............',
    ],
  },
  [PLANT.RASPBERRY]: {
    name: 'Wild Raspberry', latin: 'Rubus idaeus', kind: KIND.BERRY, stack: 20,
    note: 'Wild ones are small, and all the better for it.',
    pal: { g: [R.LEAF, 4], G: [R.LEAF, 6], c: [R.MUSH, 5], h: [R.MUSH, 7], d: [R.MUSH, 3] },
    icon: [
      '............',
      '...g.gg.g...',
      '..gGgGGgGg..',
      '...ggooggg..',
      '...ohchco...',
      '..ohchcdco..',
      '..ochcdcdo..',
      '..ohcdcdco..',
      '..occdcdco..',
      '...odcddo...',
      '....oddo....',
      '.....oo.....',
    ],
  },
  [PLANT.GARLIC]: {
    name: 'Wild Garlic', latin: 'Allium ursinum', kind: KIND.HERB, stack: 15,
    note: 'You smell a patch long before you see it.',
    pal: { g: [R.GRASS, 4], G: [R.GRASS, 6], w: [R.WHITE, 7], y: [R.GOLD, 6], t: [R.GRASS, 3] },
    icon: [
      '...w.w.w....',
      '..wywwwyw...',
      '...wwywww...',
      '....wtw.....',
      '.....t......',
      '.g...t...g..',
      '.gG..t..Gg..',
      '.gGg.t.gGg..',
      '..gGgtgGg...',
      '..gGgtgGg...',
      '...ggtgg....',
      '....ttt.....',
    ],
  },
  [PLANT.SORREL]: {
    name: 'Wood Sorrel', latin: 'Oxalis acetosella', kind: KIND.HERB, stack: 15,
    note: 'Clover-shaped leaves with a sharp, lemony bite.',
    pal: { g: [R.MOSS, 5], G: [R.MOSS, 7], d: [R.MOSS, 3], t: [R.MUSH, 4] },
    icon: [
      '............',
      '...gg..gg...',
      '..gGGggGGg..',
      '..gGGGGGGg..',
      '...gGGGGg...',
      '.gg.gGGg.gg.',
      'gGGg.dd.gGGg',
      'gGGGgddgGGGg',
      '.gGGGddGGGg.',
      '..gggttggg..',
      '.....tt.....',
      '.....tt.....',
    ],
  },
  [PLANT.WORT]: {
    name: 'St John\'s Wort', latin: 'Hypericum perforatum', kind: KIND.HERB, stack: 15,
    note: 'Hold a leaf to the light and see its tiny windows.',
    pal: { y: [R.GOLD, 6], Y: [R.GOLD, 8], c: [R.GOLD, 3], g: [R.GRASS, 4], G: [R.GRASS, 6], t: [R.GRASS, 3] },
    icon: [
      '..y.y.......',
      '.yYcYy..y.y.',
      '..yyy..yYcYy',
      '...t....yyy.',
      '...t.....t..',
      '...t....t...',
      '.gGt...t....',
      '..gGt.tGg...',
      '....ttgGGg..',
      '.ggGt.......',
      '..ggt.......',
      '....t.......',
    ],
  },
};

const col = ([ramp, L]) => { const e = (ramp * 16 + L + 4) * 3; return [LUT[e], LUT[e + 1], LUT[e + 2]]; };

// the icon as 12x12 RGBA, ready for an ImageData
export function iconPixels(id) {
  const it = ITEMS[id], out = new Uint8ClampedArray(12 * 12 * 4);
  it.icon.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === '.') return;
    const c = col(ch === 'o' ? OUTLINE : it.pal[ch]), o = (y * 12 + x) * 4;
    out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
  }));
  return out;
}
