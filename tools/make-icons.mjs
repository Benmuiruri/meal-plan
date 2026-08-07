// Hand-encoded PNG icons for Meal & Shop — plate on the board blue.
// Zero-dep: node zlib deflate + hand-rolled CRC32. Regenerate: node tools/make-icons.mjs icons
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2];
if (!outDir) throw new Error('usage: node make-icons.mjs <outdir>');
mkdirSync(outDir, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixelFn) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixelFn(x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Design tokens from index.html
const BLUE = [0x1b, 0x5b, 0x9e], CHALK = [0xfb, 0xf6, 0xea], MUSTARD = [0xf2, 0xb2, 0x1b],
      TOMATO = [0xe2, 0x3e, 0x2c], LEAF = [0x2e, 0x7d, 0x46];

// A plate of food, top-down: chalk plate, mustard centre, tomato + leaf bites.
// Everything sits inside r=0.35 of centre — within the maskable safe zone (0.4).
function colourAt(u, v) {
  if (Math.hypot(u - 0.42, v - 0.43) < 0.095) return TOMATO;
  if (Math.hypot(u - 0.585, v - 0.56) < 0.065) return LEAF;
  const d = Math.hypot(u - 0.5, v - 0.5);
  if (d < 0.26) return MUSTARD;
  if (d < 0.35) return CHALK;
  return BLUE;
}

const supersampled = (size) => (x, y) => {
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const c = colourAt((x + (i + 0.5) / 3) / size, (y + (j + 0.5) / 3) / size);
      r += c[0]; g += c[1]; b += c[2];
    }
  }
  return [Math.round(r / 9), Math.round(g / 9), Math.round(b / 9)];
};

for (const size of [180, 192, 512]) {
  const file = join(outDir, `icon-${size}.png`);
  writeFileSync(file, png(size, supersampled(size)));
  console.log('wrote', file);
}
