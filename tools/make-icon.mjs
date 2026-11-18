/**
 * Generates the Nurofen app icon (assets/nurofen.ico + .png) with no external
 * dependencies: the glyph is drawn with distance fields and anti-aliased by
 * supersampling, then packed into a plain 32-bit ICO (BMP frames, so Windows
 * shells and System.Drawing.Icon both read it without surprises).
 *
 *   node tools/make-icon.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'assets');

const BG_TOP = [17, 23, 31];
const BG_BOTTOM = [11, 15, 20];
const MARK = [61, 220, 132];
const EDGE = [34, 44, 56];

// Glyph geometry in a 24x24 box, matching the UI header mark.
const NODES = [
  [5, 17.5, 2.35],
  [12, 5, 2.35],
  [19, 17.5, 2.35],
];
const EDGES = [
  [5, 17.5, 12, 5],
  [12, 5, 19, 17.5],
  [5, 17.5, 19, 17.5],
];
const STROKE = 1.85;

function roundedRect(x, y, size, radius) {
  const r = radius;
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const wx = px - x1;
  const wy = py - y1;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
  const dx = px - (x1 + t * vx);
  const dy = py - (y1 + t * vy);
  return Math.hypot(dx, dy);
}

function renderRGBA(size) {
  const SS = 4;
  const big = size * SS;
  const scale = size / 24;
  const pixels = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = (x * SS + sx + 0.5) / SS;
          const py = (y * SS + sy + 0.5) / SS;

          let color = [0, 0, 0];
          let alpha = 0;
          const inset = size * 0.02;
          if (roundedRect(px, py, size, size * 0.235) && px > inset && py > inset) {
            const t = py / size;
            color = [
              Math.round(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t),
              Math.round(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t),
              Math.round(BG_BOTTOM[2] + (BG_TOP[2] - BG_BOTTOM[2]) * (1 - t)),
            ];
            alpha = 255;
            // subtle 1px rim
            if (!roundedRect(px, py, size, size * 0.235) === false) {
              const edge =
                px < inset * 2 ||
                py < inset * 2 ||
                px > size - inset * 2 ||
                py > size - inset * 2;
              if (edge) color = EDGE;
            }
          }

          // glyph in 24x24 space
          const gx = px / scale;
          const gy = py / scale;
          let inGlyph = false;
          for (const [nx, ny, nr] of NODES) {
            if (Math.hypot(gx - nx, gy - ny) <= nr) inGlyph = true;
          }
          if (!inGlyph) {
            for (const [x1, y1, x2, y2] of EDGES) {
              if (distToSegment(gx, gy, x1, y1, x2, y2) <= STROKE / 2) inGlyph = true;
            }
          }

          const out = inGlyph ? MARK : color;
          if (inGlyph) alpha = 255;

          r += out[0];
          g += out[1];
          b += out[2];
          a += alpha;
        }
      }

      const count = SS * SS;
      const index = (y * size + x) * 4;
      pixels[index] = Math.round(r / count);
      pixels[index + 1] = Math.round(g / count);
      pixels[index + 2] = Math.round(b / count);
      pixels[index + 3] = Math.round(a / count);
    }
  }
  return pixels;
}

function bmpFrame(size) {
  const rgba = renderRGBA(size);
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(size * size * 4, 20);

  const rows = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const src = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x += 1) {
      const s = src + x * 4;
      const d = (y * size + x) * 4;
      rows[d] = rgba[s + 2];
      rows[d + 1] = rgba[s + 1];
      rows[d + 2] = rgba[s];
      rows[d + 3] = rgba[s + 3];
    }
  }

  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size);
  return Buffer.concat([header, rows, mask]);
}

function png(size) {
  const rgba = renderRGBA(size);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const chunk = (type, body) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length, 0);
    const typeAndBody = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32?.(typeAndBody) ?? crc32(typeAndBody), 0);
    return Buffer.concat([length, typeAndBody, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const sizes = [16, 24, 32, 48, 64, 128];
const frames = sizes.map((size) => ({ size, data: bmpFrame(size) }));

const header = Buffer.alloc(6 + frames.length * 16);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(frames.length, 4);

let offset = header.length;
frames.forEach((frame, index) => {
  const base = 6 + index * 16;
  header.writeUInt8(frame.size >= 256 ? 0 : frame.size, base);
  header.writeUInt8(frame.size >= 256 ? 0 : frame.size, base + 1);
  header.writeUInt8(0, base + 2);
  header.writeUInt8(0, base + 3);
  header.writeUInt16LE(1, base + 4);
  header.writeUInt16LE(32, base + 6);
  header.writeUInt32LE(frame.data.length, base + 8);
  header.writeUInt32LE(offset, base + 12);
  offset += frame.data.length;
});

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'nurofen.ico'), Buffer.concat([header, ...frames.map((f) => f.data)]));
fs.writeFileSync(path.join(OUT, 'nurofen.png'), png(256));
console.log(`icon written: ${path.join(OUT, 'nurofen.ico')}`);
