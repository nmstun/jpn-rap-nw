#!/usr/bin/env node
// SVGから favicon.ico を作る。
//
//   node scripts/make-favicon-ico.mjs <入力.svg> <出力.ico>
//
// なぜicoが要るか: SafariはSVGの rel="icon" を使わないため、SVGだけ置くとSafariの
// タブが空になる。icoならどのブラウザでも表示できる。
//
// 実装上の注意が2つある。
// 1. icoにはPNGをそのまま詰めている（BMPに変換していない）。Vista以降のWindowsと
//    現行ブラウザはico内のPNGを解釈できるため。
// 2. そのPNGはRGBAでなければならない。rsvg-convertは全ピクセルが不透明だとRGBで
//    書き出すが、Next.jsのICOデコーダーはRGBAを要求し、RGBのままだと
//    「The PNG is not in RGBA format!」でビルドが500になる。そのため下の
//    toRgba() でアルファチャンネルを足してからicoに詰める。
//
// 依存: rsvg-convert（macOSなら `brew install librsvg`）
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const SIZES = [16, 32, 48];
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function readChunks(buf) {
  const out = [];
  for (let off = 8; off < buf.length; ) {
    const len = buf.readUInt32BE(off);
    out.push({ type: buf.toString('ascii', off + 4, off + 8), data: buf.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
  }
  return out;
}

// PNGのフィルタを解いて生のピクセル列に戻す
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`未対応のフィルタ: ${filter}`);
      cur[x] = v & 0xff;
    }
  }
  return out;
}

function toRgba(png) {
  const chunks = readChunks(png);
  const ihdr = chunks.find((c) => c.type === 'IHDR').data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr.readUInt8(8);
  const colorType = ihdr.readUInt8(9);
  if (colorType === 6) return png;
  if (colorType !== 2 || bitDepth !== 8 || ihdr.readUInt8(12) !== 0) {
    throw new Error(`未対応の形式 colorType=${colorType} bitDepth=${bitDepth}`);
  }
  const rgb = unfilter(
    inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data))),
    width, height, 3,
  );
  const raw = Buffer.alloc(height * (1 + width * 4));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // フィルタなし
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw[o++] = rgb[i]; raw[o++] = rgb[i + 1]; raw[o++] = rgb[i + 2]; raw[o++] = 255;
    }
  }
  const newIhdr = Buffer.from(ihdr);
  newIhdr.writeUInt8(6, 9);
  return Buffer.concat([SIG, chunk('IHDR', newIhdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function packIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ data, size }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

const [svg, ico] = process.argv.slice(2);
if (!svg || !ico) {
  console.error('使い方: node scripts/make-favicon-ico.mjs <入力.svg> <出力.ico>');
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'favicon-'));
try {
  const images = SIZES.map((size) => {
    const out = join(work, `${size}.png`);
    execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), svg, '-o', out]);
    return { size, data: toRgba(readFileSync(out)) };
  });
  writeFileSync(ico, packIco(images));
  console.log(`${ico}: ${SIZES.map((s) => `${s}x${s}`).join(', ')} (${packIco(images).length} bytes)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
