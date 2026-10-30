// The 1200×630 share image (Open Graph / Twitter card), drawn with code at build time: a 5×7
// pixel font, a few rectangles and a minimal PNG encoder. No image is copied from anywhere.
import { deflateSync } from 'node:zlib';

export const WIDTH = 1200;
export const HEIGHT = 630;

/** 5 columns per glyph; 7 rows above the baseline, plus 2 for descenders (g, j, p, q, y, ","). */
const FONT = {
  A: '.###.|#...#|#...#|#####|#...#|#...#|#...#',
  B: '####.|#...#|#...#|####.|#...#|#...#|####.',
  C: '.###.|#...#|#....|#....|#....|#...#|.###.',
  D: '####.|#...#|#...#|#...#|#...#|#...#|####.',
  E: '#####|#....|#....|####.|#....|#....|#####',
  F: '#####|#....|#....|####.|#....|#....|#....',
  G: '.###.|#...#|#....|#.###|#...#|#...#|.####',
  H: '#...#|#...#|#...#|#####|#...#|#...#|#...#',
  I: '.###.|..#..|..#..|..#..|..#..|..#..|.###.',
  J: '..###|...#.|...#.|...#.|...#.|#..#.|.##..',
  K: '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#',
  L: '#....|#....|#....|#....|#....|#....|#####',
  M: '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#',
  N: '#...#|#...#|##..#|#.#.#|#..##|#...#|#...#',
  O: '.###.|#...#|#...#|#...#|#...#|#...#|.###.',
  P: '####.|#...#|#...#|####.|#....|#....|#....',
  Q: '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#',
  R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
  S: '.####|#....|#....|.###.|....#|....#|####.',
  T: '#####|..#..|..#..|..#..|..#..|..#..|..#..',
  U: '#...#|#...#|#...#|#...#|#...#|#...#|.###.',
  V: '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..',
  W: '#...#|#...#|#...#|#.#.#|#.#.#|#.#.#|.#.#.',
  X: '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
  Y: '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..',
  Z: '#####|....#|...#.|..#..|.#...|#....|#####',
  a: '.....|.....|.###.|....#|.####|#...#|.####',
  b: '#....|#....|#.##.|##..#|#...#|#...#|####.',
  c: '.....|.....|.###.|#....|#....|#...#|.###.',
  d: '....#|....#|.##.#|#..##|#...#|#...#|.####',
  e: '.....|.....|.###.|#...#|#####|#....|.###.',
  f: '..##.|.#..#|.#...|###..|.#...|.#...|.#...',
  g: '.....|.....|.####|#...#|#...#|#..##|.##.#|....#|.###.',
  h: '#....|#....|#.##.|##..#|#...#|#...#|#...#',
  i: '..#..|.....|.##..|..#..|..#..|..#..|.###.',
  j: '...#.|.....|..##.|...#.|...#.|...#.|...#.|#..#.|.##..',
  k: '#....|#....|#..#.|#.#..|##...|#.#..|#..#.',
  l: '.##..|..#..|..#..|..#..|..#..|..#..|.###.',
  m: '.....|.....|##.#.|#.#.#|#.#.#|#.#.#|#.#.#',
  n: '.....|.....|#.##.|##..#|#...#|#...#|#...#',
  o: '.....|.....|.###.|#...#|#...#|#...#|.###.',
  p: '.....|.....|####.|#...#|#...#|#...#|####.|#....|#....',
  q: '.....|.....|.####|#...#|#...#|#...#|.####|....#|....#',
  r: '.....|.....|#.##.|##..#|#....|#....|#....',
  s: '.....|.....|.###.|#....|.###.|....#|####.',
  t: '.#...|.#...|###..|.#...|.#...|.#..#|..##.',
  u: '.....|.....|#...#|#...#|#...#|#..##|.##.#',
  v: '.....|.....|#...#|#...#|#...#|.#.#.|..#..',
  w: '.....|.....|#...#|#...#|#.#.#|#.#.#|.#.#.',
  x: '.....|.....|#...#|.#.#.|..#..|.#.#.|#...#',
  y: '.....|.....|#...#|#...#|#...#|#...#|.####|....#|.###.',
  z: '.....|.....|#####|...#.|..#..|.#...|#####',
  0: '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.',
  1: '..#..|.##..|..#..|..#..|..#..|..#..|.###.',
  2: '.###.|#...#|....#|...#.|..#..|.#...|#####',
  3: '#####|...#.|..#..|...#.|....#|#...#|.###.',
  4: '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.',
  5: '#####|#....|####.|....#|....#|#...#|.###.',
  6: '..##.|.#...|#....|####.|#...#|#...#|.###.',
  7: '#####|....#|...#.|..#..|.#...|.#...|.#...',
  8: '.###.|#...#|#...#|.###.|#...#|#...#|.###.',
  9: '.###.|#...#|#...#|.####|....#|...#.|.##..',
  ' ': '.....|.....|.....|.....|.....|.....|.....',
  '-': '.....|.....|.....|.###.|.....|.....|.....',
  '.': '.....|.....|.....|.....|.....|.##..|.##..',
  ',': '.....|.....|.....|.....|.....|.##..|.##..|..#..|.#...',
  ':': '.....|.##..|.##..|.....|.##..|.##..|.....',
  '/': '....#|...#.|...#.|..#..|.#...|.#...|#....',
  '+': '.....|..#..|..#..|#####|..#..|..#..|.....',
  '#': '.#.#.|.#.#.|#####|.#.#.|#####|.#.#.|.#.#.',
  $: '..#..|.####|#.#..|.###.|..#.#|####.|..#..',
  '·': '.....|.....|..#..|.###.|..#..|.....|.....',
  '✓': '.....|....#|...##|#.##.|###..|.#...|.....',
};
const GLYPHS = new Map(Object.entries(FONT).map(([char, rows]) => [char, rows.split('|')]));
const GLYPH_WIDTH = 5;
const ADVANCE = GLYPH_WIDTH + 1;

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** An RGB canvas with the two operations the card needs: rectangles and pixel-font text. */
export function createCanvas(width, height, background) {
  const pixels = Buffer.alloc(width * height * 3);
  const fill = (x, y, w, h, color) => {
    const [r, g, b] = rgb(color);
    for (let row = Math.max(0, y); row < Math.min(height, y + h); row++) {
      for (let col = Math.max(0, x); col < Math.min(width, x + w); col++) {
        const at = (row * width + col) * 3;
        pixels[at] = r;
        pixels[at + 1] = g;
        pixels[at + 2] = b;
      }
    }
  };
  /** Draws `text` with its top-left corner at (x, y), each font pixel `scale`² pixels. Returns the x after it. */
  const text = (value, x, y, scale, color) => {
    let cursor = x;
    for (const char of value) {
      const glyph = GLYPHS.get(char);
      if (!glyph) throw new Error(`share image: no glyph for ${JSON.stringify(char)}`);
      glyph.forEach((row, r) => {
        for (let c = 0; c < GLYPH_WIDTH; c++) if (row[c] === '#') fill(cursor + c * scale, y + r * scale, scale, scale, color);
      });
      cursor += ADVANCE * scale;
    }
    return cursor;
  };
  fill(0, 0, width, height, background);
  return { width, height, pixels, fill, text };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(typed.length + 8);
  out.writeUInt32BE(data.length, 0);
  typed.copy(out, 4);
  out.writeUInt32BE(crc32(typed), typed.length + 4);
  return out;
}

/** An 8-bit RGB PNG of the canvas (no interlacing, filter 0 on every row). */
export function encodePng({ width, height, pixels }) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const COLORS = {
  background: '#0d1117',
  panel: '#161b22',
  border: '#30363d',
  text: '#e6edf3',
  muted: '#8b949e',
  green: '#3fb950',
  brand: '#7ee787',
};
/** The stack on the right, top to bottom: the layer pr-split opened last sits on top. */
const STACK = [
  { label: '#131 docs', color: '#3fb950' },
  { label: '#130 ui', color: '#f0883e' },
  { label: '#129 api', color: '#bc8cff' },
  { label: '#128 database', color: '#58a6ff' },
];

/** pr-split's share card: name, promise, and a stack of four validated PRs on main. */
export function drawShareImage() {
  const card = createCanvas(WIDTH, HEIGHT, COLORS.background);
  card.fill(0, 0, WIDTH, 10, COLORS.green);

  const after = card.text('$ ', 72, 64, 12, COLORS.muted);
  card.text('pr-split', after, 64, 12, COLORS.brand);
  ['Split one giant branch', 'into small PRs that', 'each build green.'].forEach((line, i) =>
    card.text(line, 72, 230 + i * 64, 5, COLORS.text),
  );

  const x = 760;
  const width = 368;
  const height = 58;
  STACK.forEach(({ label, color }, i) => {
    const y = 214 + i * 72;
    card.fill(x, y, width, height, COLORS.border);
    card.fill(x + 2, y + 2, width - 4, height - 4, COLORS.panel);
    card.fill(x + 2, y + 2, 10, height - 4, color);
    card.text(label, x + 30, y + 19, 3, COLORS.text);
    card.text('✓', x + width - 44, y + 19, 3, COLORS.green);
  });
  card.fill(x - 16, 512, width + 32, 4, COLORS.muted);
  card.text('main', x, 528, 3, COLORS.muted);

  card.text('$9 once · runs on your machine · opens PRs with gh', 72, 572, 3, COLORS.muted);
  return encodePng(card);
}
