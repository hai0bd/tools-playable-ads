'use strict';
// Minimal PNG decoder/encoder (RGBA8). Decoder supports color types 0,2,3,4,6, bit depths 1..16, non-interlaced
// and Adam7-interlaced images.
const zlib = require('zlib');

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function isPNG(buf) {
  return buf && buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47;
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function unfilter(raw, width, height, bitDepth, channels, offset) {
  const bpp = Math.max(1, (channels * bitDepth) >> 3);
  const stride = Math.ceil((width * channels * bitDepth) / 8);
  const rows = [];
  let prev = Buffer.alloc(stride);
  let p = offset;
  for (let y = 0; y < height; y++) {
    const ft = raw[p++];
    const cur = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      switch (ft) {
        case 1: cur[i] = (cur[i] + a) & 0xff; break;
        case 2: cur[i] = (cur[i] + b) & 0xff; break;
        case 3: cur[i] = (cur[i] + ((a + b) >> 1)) & 0xff; break;
        case 4: cur[i] = (cur[i] + paeth(a, b, c)) & 0xff; break;
      }
    }
    rows.push(cur);
    prev = cur;
  }
  return { rows, next: p };
}

function decodePNG(buf) {
  if (!isPNG(buf)) throw new Error('not a png');
  let p = 8, width, height, bitDepth, colorType, interlace, palette = null, trns = null;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12]; }
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const channels = CHANNELS[colorType];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(width * height * 4);
  const maxV = (1 << bitDepth) - 1;

  const sampleAt = (row, idx) => {
    if (bitDepth === 8) return row[idx];
    if (bitDepth === 16) return row[idx * 2];               // keep high byte
    const bit = idx * bitDepth;
    return (row[bit >> 3] >> (8 - bitDepth - (bit & 7))) & maxV;
  };
  const writePixel = (row, x, dx, dy) => {
    let r, g, b, a = 255;
    const base = x * channels;
    const to8 = (v) => (bitDepth >= 8 ? v : Math.round((v * 255) / maxV));
    if (colorType === 6) { r = sampleAt(row, base); g = sampleAt(row, base + 1); b = sampleAt(row, base + 2); a = sampleAt(row, base + 3); }
    else if (colorType === 2) {
      r = sampleAt(row, base); g = sampleAt(row, base + 1); b = sampleAt(row, base + 2);
      if (trns && trns.length >= 6 && trns.readUInt16BE(0) >> (bitDepth === 16 ? 8 : 0) === r && trns.readUInt16BE(2) >> (bitDepth === 16 ? 8 : 0) === g && trns.readUInt16BE(4) >> (bitDepth === 16 ? 8 : 0) === b) a = 0;
    } else if (colorType === 3) {
      const i = sampleAt(row, x);
      r = palette[i * 3]; g = palette[i * 3 + 1]; b = palette[i * 3 + 2];
      a = trns && i < trns.length ? trns[i] : 255;
    } else if (colorType === 0) {
      const v = sampleAt(row, x); r = g = b = to8(v);
      if (trns && trns.length >= 2 && (trns.readUInt16BE(0) >> (bitDepth === 16 ? 8 : 0)) === v) a = 0;
    } else if (colorType === 4) { r = g = b = sampleAt(row, base); a = sampleAt(row, base + 1); }
    const o = (dy * width + dx) * 4;
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
  };

  if (!interlace) {
    const { rows } = unfilter(raw, width, height, bitDepth, channels, 0);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) writePixel(rows[y], x, x, y);
  } else {
    // Adam7
    const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
    let off = 0;
    for (const [x0, y0, dx, dy] of passes) {
      const pw = Math.ceil((width - x0) / dx), ph = Math.ceil((height - y0) / dy);
      if (pw <= 0 || ph <= 0) continue;
      const { rows, next } = unfilter(raw, pw, ph, bitDepth, channels, off);
      off = next;
      for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) writePixel(rows[y], x, x0 + x * dx, y0 + y * dy);
    }
  }
  return { width, height, data: out, colorType, hasAlpha: colorType === 4 || colorType === 6 || !!trns };
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Encode RGBA8 pixels into a PNG buffer. */
function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Bounding box of pixels with alpha >= threshold (Cocos "auto" trim). */
function alphaBBox(img, threshold = 1) {
  const { width: w, height: h, data } = img;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] >= threshold) {
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, width: w, height: h };
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Cut a sprite out of an atlas image and place it into a canvas of the original (untrimmed) size.
 * rect is in atlas pixel space (unrotated size); rotated=true means the region is stored rotated 90deg clockwise.
 */
function extractSprite(atlas, rect, rotated, originalSize, offset) {
  const W = originalSize.width, H = originalSize.height;
  const out = Buffer.alloc(W * H * 4);
  const trimX = Math.round((W - rect.width) / 2 + offset.x);
  const trimY = Math.round((H - rect.height) / 2 - offset.y);
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      // source pixel in atlas
      let sx, sy;
      if (!rotated) { sx = rect.x + x; sy = rect.y + y; }
      else { sx = rect.x + (rect.height - 1 - y); sy = rect.y + x; }
      if (sx < 0 || sy < 0 || sx >= atlas.width || sy >= atlas.height) continue;
      const dx = trimX + x, dy = trimY + y;
      if (dx < 0 || dy < 0 || dx >= W || dy >= H) continue;
      atlas.data.copy(out, (dy * W + dx) * 4, (sy * atlas.width + sx) * 4, (sy * atlas.width + sx) * 4 + 4);
    }
  }
  return { width: W, height: H, data: out };
}

module.exports = { isPNG, decodePNG, encodePNG, alphaBBox, extractSprite };
