'use strict';
// WebP → RGBA8: lossy (VP8 key frame), lossless (VP8L) and alpha (ALPH). Synchronous and dependency-free so the
// Luna recovery gets identical pixels in Node and in the browser worker: Luna re-encodes project textures as WebP
// and Unity cannot import .webp. Mirrors libwebp's decoder — loop filter, "fancy" chroma upsampling, fixed-point
// YUV → RGB — i.e. the pixels the browser showed in the playable.
const { COEFFS, COEFF_UPDATES, BMODES, DC_TABLE, AC_TABLE, PLANE } = require('./webp-tables');

const u32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;

function isWebP(b) {
  return !!b && b.length >= 20 && u32(b, 0) === 0x46464952 && u32(b, 8) === 0x50424557;   // 'RIFF' … 'WEBP'
}

function chunksOf(b) {
  const out = {};
  const end = Math.min(b.length, 8 + u32(b, 4));
  for (let p = 12; p + 8 <= end;) {
    const tag = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]), size = u32(b, p + 4);
    if (!(tag in out)) out[tag] = b.subarray(p + 8, Math.min(end, p + 8 + size));
    p += 8 + size + (size & 1);
  }
  return out;
}

/** Decode a still WebP → { width, height, data: Buffer RGBA8 (straight alpha) }. */
function decodeWebP(b) {
  const c = chunksOf(b);
  if (c.VP8L) return argbToRGBA(decodeLossless(c.VP8L));
  if (!c['VP8 ']) throw new Error(c.ANIM ? 'WebP động (animation) chưa hỗ trợ' : 'WebP không có dữ liệu ảnh');
  const frame = decodeLossy(c['VP8 ']);
  return toRGBA(frame, c.ALPH ? decodeAlpha(c.ALPH, frame.width, frame.height) : null);
}

// ============================================================================ VP8L (lossless)

class LsbReader {
  constructor(d) { this.d = d; this.pos = 0; }
  peek(n) {   // n <= 24
    const d = this.d, p = this.pos >> 3;
    return ((d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)) >>> (this.pos & 7)) & ((1 << n) - 1);
  }
  read(n) { const v = this.peek(n); this.pos += n; return v; }
}

const ROOT_BITS = 8;
// Canonical Huffman code (deflate convention). Codes up to ROOT_BITS long come from a table indexed by the next
// ROOT_BITS input bits; longer ones are walked bit by bit. A one-symbol code reads no bits at all.
class Huffman {
  constructor(lengths, size) {
    const count = new Uint16Array(16);
    let used = 0, last = 0;
    for (let s = 0; s < size; s++) if (lengths[s]) { count[lengths[s]]++; used++; last = s; }
    if (!used) throw new Error('VP8L: mã Huffman rỗng');
    this.single = used === 1 ? last : -1;
    if (used === 1) return;
    const offs = new Uint16Array(17), next = new Uint16Array(16);
    for (let l = 1; l < 16; l++) offs[l + 1] = offs[l] + count[l];
    this.sorted = new Uint16Array(used);
    for (let s = 0; s < size; s++) if (lengths[s]) this.sorted[offs[lengths[s]]++] = s;
    this.count = count;
    for (let l = 1, code = 0; l < 16; l++) { code = (code + count[l - 1]) << 1; next[l] = code; }
    this.table = new Int32Array(1 << ROOT_BITS).fill(-1);
    for (let s = 0; s < size; s++) {
      const l = lengths[s];
      if (!l) continue;
      const code = next[l]++;
      if (l > ROOT_BITS) continue;
      let rev = 0;
      for (let i = 0; i < l; i++) rev |= ((code >> i) & 1) << (l - 1 - i);   // first bit read = code MSB
      for (let k = rev; k < 1 << ROOT_BITS; k += 1 << l) this.table[k] = (s << 4) | l;
    }
  }
  read(br) {
    if (this.single >= 0) return this.single;
    const e = this.table[br.peek(ROOT_BITS)];
    if (e >= 0) { br.pos += e & 15; return e >> 4; }
    let code = 0, first = 0, index = 0;
    for (let l = 1; l < 16; l++) {
      code |= br.read(1);
      const n = this.count[l];
      if (code - first < n) return this.sorted[index + code - first];
      index += n; first = (first + n) << 1; code <<= 1;
    }
    throw new Error('VP8L: mã Huffman hỏng');
  }
}

const CODE_LENGTH_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

function readCode(br, size) {
  const lengths = new Uint8Array(Math.max(size, 256));
  if (br.read(1)) {                                    // "simple" code: one or two symbols
    const two = br.read(1);
    lengths[br.read(br.read(1) ? 8 : 1)] = 1;
    if (two) lengths[br.read(8)] = 1;
    return new Huffman(lengths, size);
  }
  const cl = new Uint8Array(19);
  const n = br.read(4) + 4;
  for (let i = 0; i < n; i++) cl[CODE_LENGTH_ORDER[i]] = br.read(3);
  const clCode = new Huffman(cl, 19);
  let max = size;
  if (br.read(1)) {
    max = 2 + br.read(2 + 2 * br.read(3));
    if (max > size) throw new Error('VP8L: số độ dài mã sai');
  }
  let prev = 8;
  for (let s = 0; s < size;) {
    if (max-- === 0) break;
    const len = clCode.read(br);
    if (len < 16) { lengths[s++] = len; if (len) prev = len; continue; }
    const rep = br.read([2, 3, 7][len - 16]) + [3, 3, 11][len - 16];
    if (s + rep > size) throw new Error('VP8L: độ dài mã tràn');
    const v = len === 16 ? prev : 0;
    for (let k = 0; k < rep; k++) lengths[s++] = v;
  }
  return new Huffman(lengths, size);
}

const subSize = (size, bits) => (size + (1 << bits) - 1) >> bits;
// green (+ 24 length prefixes + colour cache), red, blue, alpha, distance
const ALPHABETS = [256 + 24, 256, 256, 256, 40];

function readGroups(br, w, h, cacheBits, level0) {
  const hg = { groups: [], meta: null, bits: 0, metaW: 0 };
  let numGroups = 1;
  if (level0 && br.read(1)) {                          // entropy image: one Huffman group per tile
    hg.bits = br.read(3) + 2;
    hg.metaW = subSize(w, hg.bits);
    hg.meta = decodeStream(br, hg.metaW, subSize(h, hg.bits), false);
    for (let i = 0; i < hg.meta.length; i++) {
      const g = (hg.meta[i] >> 8) & 0xffff;
      hg.meta[i] = g;
      if (g >= numGroups) numGroups = g + 1;
    }
  }
  for (let i = 0; i < numGroups; i++) {
    hg.groups.push(ALPHABETS.map((size, j) => readCode(br, size + (j === 0 && cacheBits ? 1 << cacheBits : 0))));
  }
  return hg;
}

// Lengths and distances: prefix symbol + extra bits.
function prefixValue(sym, br) {
  if (sym < 4) return sym + 1;
  const extra = (sym - 2) >> 1;
  return ((2 + (sym & 1)) << extra) + br.read(extra) + 1;
}

function planeDistance(w, code) {
  if (code > 120) return code - 120;
  const c = PLANE[code - 1];
  const d = (c >> 4) * w + 8 - (c & 15);
  return d >= 1 ? d : 1;
}

function decodePixels(br, w, h, cacheBits, hg) {
  const out = new Uint32Array(w * h), total = w * h;
  const cache = cacheBits ? new Uint32Array(1 << cacheBits) : null, shift = 32 - cacheBits;
  let pos = 0, x = 0, y = 0, cached = 0;
  while (pos < total) {
    const g = hg.meta ? hg.groups[hg.meta[(y >> hg.bits) * hg.metaW + (x >> hg.bits)]] : hg.groups[0];
    const code = g[0].read(br);
    if (code < 256) {                                  // literal
      const r = g[1].read(br), b = g[2].read(br), a = g[3].read(br);
      out[pos++] = ((a << 24) | (r << 16) | (code << 8) | b) >>> 0;
      if (++x === w) { x = 0; y++; }
    } else if (code < 280) {                           // backward reference (may overlap)
      const len = prefixValue(code - 256, br);
      const dist = planeDistance(w, prefixValue(g[4].read(br), br));
      if (dist > pos || pos + len > total) throw new Error('VP8L: tham chiếu lùi sai');
      for (let k = 0; k < len; k++, pos++) out[pos] = out[pos - dist];
      x += len;
      while (x >= w) { x -= w; y++; }
    } else {                                           // colour cache: every earlier pixel goes in, in order
      if (!cache) throw new Error('VP8L: mã cache khi không có cache');
      while (cached < pos) { const v = out[cached++]; cache[Math.imul(v, 0x1e35a7bd) >>> shift] = v; }
      out[pos++] = cache[code - 280];
      if (++x === w) { x = 0; y++; }
    }
  }
  return out;
}

// Per-channel helpers on packed ARGB.
const addPx = (a, b) => ((((a & 0xff00ff00) + (b & 0xff00ff00)) & 0xff00ff00) | (((a & 0xff00ff) + (b & 0xff00ff)) & 0xff00ff)) >>> 0;
const avg2 = (a, b) => ((((a ^ b) & 0xfefefefe) >>> 1) + ((a & b) >>> 0)) >>> 0;
const clip255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
function clampFull(a, b, c) {
  let out = 0;
  for (let s = 0; s < 32; s += 8) out |= clip255(((a >>> s) & 255) + ((b >>> s) & 255) - ((c >>> s) & 255)) << s;
  return out >>> 0;
}
function clampHalf(a, b) {
  let out = 0;
  for (let s = 0; s < 32; s += 8) { const x = (a >>> s) & 255; out |= clip255(x + (((x - ((b >>> s) & 255)) / 2) | 0)) << s; }
  return out >>> 0;
}
function select(t, l, tl) {                            // T or L, whichever is closer to T + L - TL
  let d = 0;
  for (let s = 0; s < 32; s += 8) { const c = (tl >>> s) & 255; d += Math.abs(((l >>> s) & 255) - c) - Math.abs(((t >>> s) & 255) - c); }
  return d <= 0 ? t : l;
}
function predict(mode, p, i, w) {
  switch (mode) {
    case 1: return p[i - 1];
    case 2: return p[i - w];
    case 3: return p[i - w + 1];
    case 4: return p[i - w - 1];
    case 5: return avg2(avg2(p[i - 1], p[i - w + 1]), p[i - w]);
    case 6: return avg2(p[i - 1], p[i - w - 1]);
    case 7: return avg2(p[i - 1], p[i - w]);
    case 8: return avg2(p[i - w - 1], p[i - w]);
    case 9: return avg2(p[i - w], p[i - w + 1]);
    case 10: return avg2(avg2(p[i - 1], p[i - w - 1]), avg2(p[i - w], p[i - w + 1]));
    case 11: return select(p[i - w], p[i - 1], p[i - w - 1]);
    case 12: return clampFull(p[i - 1], p[i - w], p[i - w - 1]);
    case 13: return clampHalf(avg2(p[i - 1], p[i - w]), p[i - w - 1]);
    default: return 0xff000000;                        // 0, and 14/15 like libwebp
  }
}

function inverseTransform(t, px) {
  const w = t.w, h = t.h;
  if (t.type === 2) {                                  // subtract green
    for (let i = 0; i < px.length; i++) {
      const v = px[i], g = (v >> 8) & 255;
      px[i] = ((v & 0xff00ff00) | (((v & 0xff00ff) + ((g << 16) | g)) & 0xff00ff)) >>> 0;
    }
    return px;
  }
  if (t.type === 0) {                                  // predictor: row 0 uses L, column 0 uses T
    const tw = subSize(w, t.bits);
    px[0] = addPx(px[0], 0xff000000);
    for (let x = 1; x < w; x++) px[x] = addPx(px[x], px[x - 1]);
    for (let y = 1; y < h; y++) {
      const row = y * w, modes = (y >> t.bits) * tw;
      px[row] = addPx(px[row], px[row - w]);
      for (let x = 1; x < w; x++) px[row + x] = addPx(px[row + x], predict((t.data[modes + (x >> t.bits)] >> 8) & 15, px, row + x, w));
    }
    return px;
  }
  if (t.type === 1) {                                  // cross colour
    const tw = subSize(w, t.bits);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const m = t.data[(y >> t.bits) * tw + (x >> t.bits)], i = y * w + x, v = px[i];
        const g = (v << 16) >> 24;
        const r = (((v >> 16) & 255) + ((((m << 24) >> 24) * g) >> 5)) & 255;
        let b = ((v & 255) + ((((m << 16) >> 24) * g) >> 5)) & 255;
        b = (b + ((((m << 8) >> 24) * ((r << 24) >> 24)) >> 5)) & 255;
        px[i] = ((v & 0xff00ff00) | (r << 16) | b) >>> 0;
      }
    }
    return px;
  }
  // colour indexing: indices in green, several packed per pixel when the palette is small
  const out = new Uint32Array(w * h), pw = subSize(w, t.bits);
  const bpp = 8 >> t.bits, per = (1 << t.bits) - 1, mask = (1 << bpp) - 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const packed = (px[y * pw + (x >> t.bits)] >> 8) & 255;
      out[y * w + x] = t.data[(packed >> ((x & per) * bpp)) & mask];
    }
  }
  return out;
}

function decodeStream(br, w, h, level0) {
  const transforms = [];
  let tw = w;
  if (level0) {
    while (br.read(1)) {
      const type = br.read(2);
      if (transforms.some((t) => t.type === type)) throw new Error('VP8L: transform lặp lại');
      const t = { type, w: tw, h, bits: 0, data: null };
      if (type === 0 || type === 1) {
        t.bits = br.read(3) + 2;
        t.data = decodeStream(br, subSize(tw, t.bits), subSize(h, t.bits), false);
      } else if (type === 3) {
        const n = br.read(8) + 1;
        t.bits = n > 16 ? 0 : n > 4 ? 1 : n > 2 ? 2 : 3;
        const pal = decodeStream(br, n, 1, false);
        t.data = new Uint32Array(1 << (8 >> t.bits));  // unused entries: transparent black
        t.data[0] = pal[0];
        for (let i = 1; i < n; i++) t.data[i] = addPx(pal[i], t.data[i - 1]);
        tw = subSize(tw, t.bits);
      }
      transforms.push(t);
    }
  }
  let cacheBits = 0;
  if (br.read(1)) {
    cacheBits = br.read(4);
    if (cacheBits < 1 || cacheBits > 11) throw new Error('VP8L: colour cache sai');
  }
  const hg = readGroups(br, tw, h, cacheBits, level0);
  let px = decodePixels(br, tw, h, cacheBits, hg);
  for (let i = transforms.length - 1; i >= 0; i--) px = inverseTransform(transforms[i], px);
  return px;
}

function decodeLossless(d) {
  const br = new LsbReader(d);
  if (br.read(8) !== 0x2f) throw new Error('VP8L: sai chữ ký');
  const width = br.read(14) + 1, height = br.read(14) + 1;
  br.read(1);                                          // alpha hint
  if (br.read(3) !== 0) throw new Error('VP8L: phiên bản lạ');
  return { width, height, argb: decodeStream(br, width, height, true) };
}

function argbToRGBA({ width, height, argb }) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0, o = 0; i < argb.length; i++, o += 4) {
    const v = argb[i];
    data[o] = (v >> 16) & 255; data[o + 1] = (v >> 8) & 255; data[o + 2] = v & 255; data[o + 3] = v >>> 24;
  }
  return { width, height, data };
}

// ============================================================================ ALPH

function decodeAlpha(d, w, h) {
  const method = d[0] & 3, filter = (d[0] >> 2) & 3;
  const a = new Uint8Array(w * h);
  if (method === 0) a.set(d.subarray(1, 1 + w * h));
  else if (method === 1) {                             // VP8L stream without header; alpha lives in green
    const argb = decodeStream(new LsbReader(d.subarray(1)), w, h, true);
    for (let i = 0; i < a.length; i++) a[i] = (argb[i] >> 8) & 255;
  } else throw new Error('ALPH: kiểu nén lạ');
  for (let y = 0; filter && y < h; y++) {
    const row = y * w, up = row - w;
    if (y === 0 || filter === 1) {                     // horizontal (also row 0 of every filter)
      let pred = y === 0 ? 0 : a[up];
      for (let x = 0; x < w; x++) pred = a[row + x] = (a[row + x] + pred) & 255;
    } else if (filter === 2) {                         // vertical
      for (let x = 0; x < w; x++) a[row + x] = (a[row + x] + a[up + x]) & 255;
    } else {                                           // gradient
      let left = a[up], topLeft = a[up];
      for (let x = 0; x < w; x++) {
        const top = a[up + x];
        left = a[row + x] = (a[row + x] + clip255(left + top - topLeft)) & 255;
        topLeft = top;
      }
    }
  }
  return a;
}

// ============================================================================ VP8 (lossy key frame)

// Boolean entropy decoder of RFC 6386 §7, renormalising several bits at a time.
class BoolDecoder {
  constructor(d, start, end) {
    this.d = d; this.p = start; this.end = end;
    this.value = (this.next() << 8) | this.next();
    this.range = 255; this.count = 0;
  }
  next() { return this.p < this.end ? this.d[this.p++] : 0; }
  bit(prob) {
    const split = 1 + (((this.range - 1) * prob) >> 8), big = split << 8;
    let v = 0;
    if (this.value >= big) { v = 1; this.range -= split; this.value -= big; } else this.range = split;
    const s = Math.clz32(this.range) - 24;
    if (s > 0) {
      this.range <<= s; this.value <<= s; this.count += s;
      if (this.count >= 8) { this.count -= 8; this.value |= this.next() << this.count; }
    }
    return v;
  }
  literal(n) { let v = 0; while (n--) v = (v << 1) | this.bit(128); return v; }
  signed(n) { const v = this.literal(n); return this.bit(128) ? -v : v; }
}

// Mode numbers follow libwebp (and its BMODES table): 16x16 / chroma DC_PRED 0, TM 1, V 2, H 3; 4x4 modes
// DC 0, TM 1, VE 2, HE 3, RD 4, VR 5, LD 6, VL 7, HD 8, HU 9.
const DC_PRED = 0, TM_PRED = 1, V_PRED = 2, H_PRED = 3;
const BANDS = [0, 1, 2, 3, 6, 4, 5, 6, 6, 6, 6, 6, 6, 6, 6, 7, 0];
const ZIGZAG = [0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15];
const CATS = [[173, 148, 140], [176, 155, 140, 135], [180, 157, 141, 134, 130], [254, 254, 243, 230, 196, 177, 153, 140, 133, 130, 129]];
const clip = (v, max) => (v < 0 ? 0 : v > max ? max : v);
const clip8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

function readBMode(br, o) {
  if (!br.bit(BMODES[o])) return 0;
  if (!br.bit(BMODES[o + 1])) return 1;
  if (!br.bit(BMODES[o + 2])) return 2;
  if (!br.bit(BMODES[o + 3])) return !br.bit(BMODES[o + 4]) ? 3 : !br.bit(BMODES[o + 5]) ? 4 : 5;
  return !br.bit(BMODES[o + 6]) ? 6 : !br.bit(BMODES[o + 7]) ? 7 : !br.bit(BMODES[o + 8]) ? 8 : 9;
}

function largeValue(br, P, p) {
  if (!br.bit(P[p + 3])) return !br.bit(P[p + 4]) ? 2 : 3 + br.bit(P[p + 5]);
  if (!br.bit(P[p + 6])) {
    if (!br.bit(P[p + 7])) return 5 + br.bit(159);
    const hi = br.bit(165);
    return 7 + 2 * hi + br.bit(145);
  }
  const b1 = br.bit(P[p + 8]), cat = 2 * b1 + br.bit(P[p + 9 + b1]);
  let v = 0;
  for (const pr of CATS[cat]) v += v + br.bit(pr);
  return v + 3 + (8 << cat);
}

// Tokens of one 4x4 block → dequantized coefficients (raster order) at out[off…]. Returns the position after
// the last decoded token (libwebp's GetCoeffs), which drives the neighbours' contexts.
function getCoeffs(br, P, type, ctx, dq, n, out, off) {
  let p = ((type * 8 + BANDS[n]) * 3 + ctx) * 11;
  for (; n < 16; ++n) {
    if (!br.bit(P[p])) return n;                       // end of block
    while (!br.bit(P[p + 1])) {                        // zero run
      if (++n === 16) return 16;
      p = (type * 8 + BANDS[n]) * 33;
    }
    let v, next;
    if (!br.bit(P[p + 2])) { v = 1; next = 1; } else { v = largeValue(br, P, p); next = 2; }
    out[off + ZIGZAG[n]] = (br.bit(128) ? -v : v) * dq[n > 0 ? 1 : 0];
    p = ((type * 8 + BANDS[n + 1]) * 3 + next) * 11;
  }
  return 16;
}

const WHT = new Int32Array(16);
function inverseWHT(inp, out) {
  const t = WHT;
  for (let i = 0; i < 4; i++) {
    const a0 = inp[i] + inp[12 + i], a1 = inp[4 + i] + inp[8 + i], a2 = inp[4 + i] - inp[8 + i], a3 = inp[i] - inp[12 + i];
    t[i] = a0 + a1; t[8 + i] = a0 - a1; t[4 + i] = a3 + a2; t[12 + i] = a3 - a2;
  }
  for (let i = 0; i < 4; i++) {
    const dc = t[i * 4] + 3;
    const a0 = dc + t[i * 4 + 3], a1 = t[i * 4 + 1] + t[i * 4 + 2], a2 = t[i * 4 + 1] - t[i * 4 + 2], a3 = dc - t[i * 4 + 3];
    out[64 * i] = (a0 + a1) >> 3; out[64 * i + 16] = (a3 + a2) >> 3; out[64 * i + 32] = (a0 - a1) >> 3; out[64 * i + 48] = (a3 - a2) >> 3;
  }
}

const mul1 = (a) => ((a * 20091) >> 16) + a;
const mul2 = (a) => (a * 35468) >> 16;
const IDCT = new Int32Array(16);
// Inverse DCT of coefficients c[off…off+15], added to the 4x4 pixels at P[pos] (row stride `stride`).
function idctAdd(c, off, P, stride, pos) {
  let any = 0;
  for (let i = 0; i < 16; i++) any |= c[off + i];
  if (!any) return;
  const t = IDCT;
  for (let i = 0; i < 4; i++) {                        // columns
    const i0 = c[off + i], i4 = c[off + 4 + i], i8 = c[off + 8 + i], i12 = c[off + 12 + i];
    const a = i0 + i8, b = i0 - i8, cc = mul2(i4) - mul1(i12), d = mul1(i4) + mul2(i12);
    t[i * 4] = a + d; t[i * 4 + 1] = b + cc; t[i * 4 + 2] = b - cc; t[i * 4 + 3] = a - d;
  }
  for (let i = 0; i < 4; i++) {                        // rows
    const dc = t[i] + 4, a = dc + t[8 + i], b = dc - t[8 + i];
    const cc = mul2(t[4 + i]) - mul1(t[12 + i]), d = mul1(t[4 + i]) + mul2(t[12 + i]);
    const r = pos + i * stride;
    P[r] = clip8(P[r] + ((a + d) >> 3)); P[r + 1] = clip8(P[r + 1] + ((b + cc) >> 3));
    P[r + 2] = clip8(P[r + 2] + ((b - cc) >> 3)); P[r + 3] = clip8(P[r + 3] + ((a - d) >> 3));
  }
}

// 16x16 luma / 8x8 chroma prediction. Outside the frame the row above reads 127 and the column to the left 129
// (the corner: 127 on the top row, 129 below it), as in libvpx/libwebp.
function predictBlock(P, stride, pos, n, mode, hasTop, hasLeft) {
  const shift = n === 16 ? 4 : 3;
  if (mode === DC_PRED) {
    let v = 128;
    if (hasTop || hasLeft) {
      let s = 0;
      for (let i = 0; i < n; i++) s += (hasTop ? P[pos - stride + i] : 0) + (hasLeft ? P[pos - 1 + i * stride] : 0);
      v = hasTop && hasLeft ? (s + n) >> (shift + 1) : (s + (n >> 1)) >> shift;
    }
    for (let y = 0; y < n; y++) P.fill(v, pos + y * stride, pos + y * stride + n);
    return;
  }
  const top = (i) => (hasTop ? P[pos - stride + i] : 127), left = (i) => (hasLeft ? P[pos - 1 + i * stride] : 129);
  if (mode === V_PRED) { for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) P[pos + y * stride + x] = top(x); return; }
  if (mode === H_PRED) { for (let y = 0; y < n; y++) P.fill(left(y), pos + y * stride, pos + y * stride + n); return; }
  const tl = !hasTop ? 127 : !hasLeft ? 129 : P[pos - stride - 1];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) P[pos + y * stride + x] = clip8(left(y) + top(x) - tl);
}

const avg3 = (a, b, c) => (a + 2 * b + c + 2) >> 2;
const avg2b = (a, b) => (a + b + 1) >> 1;
// 4x4 prediction: e = [X, A..H, I..L] (top-left, 8 above incl. above-right, 4 left).
function predict4(P, stride, pos, mode, e) {
  const X = e[0], A = e[1], B = e[2], C = e[3], D = e[4], E = e[5], F = e[6], G = e[7], H = e[8];
  const I = e[9], J = e[10], K = e[11], L = e[12];
  const put = (x, y, v) => { P[pos + y * stride + x] = v; };
  switch (mode) {
    case 0: { const v = (A + B + C + D + I + J + K + L + 4) >> 3; for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) put(x, y, v); break; }
    case 1: { const top = [A, B, C, D], left = [I, J, K, L]; for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) put(x, y, clip8(left[y] + top[x] - X)); break; }
    case 2: { const v = [avg3(X, A, B), avg3(A, B, C), avg3(B, C, D), avg3(C, D, E)]; for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) put(x, y, v[x]); break; }
    case 3: { const v = [avg3(X, I, J), avg3(I, J, K), avg3(J, K, L), avg3(K, L, L)]; for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) put(x, y, v[y]); break; }
    case 4:                                            // RD (down-right)
      put(0, 3, avg3(J, K, L));
      put(1, 3, avg3(I, J, K)); put(0, 2, avg3(I, J, K));
      put(2, 3, avg3(X, I, J)); put(1, 2, avg3(X, I, J)); put(0, 1, avg3(X, I, J));
      put(3, 3, avg3(A, X, I)); put(2, 2, avg3(A, X, I)); put(1, 1, avg3(A, X, I)); put(0, 0, avg3(A, X, I));
      put(3, 2, avg3(B, A, X)); put(2, 1, avg3(B, A, X)); put(1, 0, avg3(B, A, X));
      put(3, 1, avg3(C, B, A)); put(2, 0, avg3(C, B, A));
      put(3, 0, avg3(D, C, B));
      break;
    case 5:                                            // VR (vertical-right)
      put(0, 0, avg2b(X, A)); put(1, 2, avg2b(X, A));
      put(1, 0, avg2b(A, B)); put(2, 2, avg2b(A, B));
      put(2, 0, avg2b(B, C)); put(3, 2, avg2b(B, C));
      put(3, 0, avg2b(C, D));
      put(0, 3, avg3(K, J, I));
      put(0, 2, avg3(J, I, X));
      put(0, 1, avg3(I, X, A)); put(1, 3, avg3(I, X, A));
      put(1, 1, avg3(X, A, B)); put(2, 3, avg3(X, A, B));
      put(2, 1, avg3(A, B, C)); put(3, 3, avg3(A, B, C));
      put(3, 1, avg3(B, C, D));
      break;
    case 6:                                            // LD (down-left)
      put(0, 0, avg3(A, B, C));
      put(1, 0, avg3(B, C, D)); put(0, 1, avg3(B, C, D));
      put(2, 0, avg3(C, D, E)); put(1, 1, avg3(C, D, E)); put(0, 2, avg3(C, D, E));
      put(3, 0, avg3(D, E, F)); put(2, 1, avg3(D, E, F)); put(1, 2, avg3(D, E, F)); put(0, 3, avg3(D, E, F));
      put(3, 1, avg3(E, F, G)); put(2, 2, avg3(E, F, G)); put(1, 3, avg3(E, F, G));
      put(3, 2, avg3(F, G, H)); put(2, 3, avg3(F, G, H));
      put(3, 3, avg3(G, H, H));
      break;
    case 7:                                            // VL (vertical-left)
      put(0, 0, avg2b(A, B));
      put(1, 0, avg2b(B, C)); put(0, 2, avg2b(B, C));
      put(2, 0, avg2b(C, D)); put(1, 2, avg2b(C, D));
      put(3, 0, avg2b(D, E)); put(2, 2, avg2b(D, E));
      put(0, 1, avg3(A, B, C));
      put(1, 1, avg3(B, C, D)); put(0, 3, avg3(B, C, D));
      put(2, 1, avg3(C, D, E)); put(1, 3, avg3(C, D, E));
      put(3, 1, avg3(D, E, F)); put(2, 3, avg3(D, E, F));
      put(3, 2, avg3(E, F, G));
      put(3, 3, avg3(F, G, H));
      break;
    case 8:                                            // HD (horizontal-down)
      put(0, 0, avg2b(I, X)); put(2, 1, avg2b(I, X));
      put(0, 1, avg2b(J, I)); put(2, 2, avg2b(J, I));
      put(0, 2, avg2b(K, J)); put(2, 3, avg2b(K, J));
      put(0, 3, avg2b(L, K));
      put(3, 0, avg3(A, B, C));
      put(2, 0, avg3(X, A, B));
      put(1, 0, avg3(I, X, A)); put(3, 1, avg3(I, X, A));
      put(1, 1, avg3(J, I, X)); put(3, 2, avg3(J, I, X));
      put(1, 2, avg3(K, J, I)); put(3, 3, avg3(K, J, I));
      put(1, 3, avg3(L, K, J));
      break;
    default:                                           // 9: HU (horizontal-up)
      put(0, 0, avg2b(I, J));
      put(2, 0, avg2b(J, K)); put(0, 1, avg2b(J, K));
      put(2, 1, avg2b(K, L)); put(0, 2, avg2b(K, L));
      put(1, 0, avg3(I, J, K));
      put(3, 0, avg3(J, K, L)); put(1, 1, avg3(J, K, L));
      put(3, 1, avg3(K, L, L)); put(1, 2, avg3(K, L, L));
      put(3, 2, L); put(2, 2, L); put(0, 3, L); put(1, 3, L); put(2, 3, L); put(3, 3, L);
  }
}

// ---- loop filter (RFC 6386 §15, libwebp formulation)
function needsFilter2(P, p, hs, t, it) {
  const p3 = P[p - 4 * hs], p2 = P[p - 3 * hs], p1 = P[p - 2 * hs], p0 = P[p - hs];
  const q0 = P[p], q1 = P[p + hs], q2 = P[p + 2 * hs], q3 = P[p + 3 * hs];
  if (4 * Math.abs(p0 - q0) + Math.abs(p1 - q1) > t) return false;
  return Math.abs(p3 - p2) <= it && Math.abs(p2 - p1) <= it && Math.abs(p1 - p0) <= it
    && Math.abs(q3 - q2) <= it && Math.abs(q2 - q1) <= it && Math.abs(q1 - q0) <= it;
}
const sclip1 = (v) => (v < -128 ? -128 : v > 127 ? 127 : v);   // [-1020, 1020] → [-128, 127]
const sclip2 = (v) => (v < -16 ? -16 : v > 15 ? 15 : v);       // [-112, 112] → [-16, 15]
function filter2(P, p, hs) {                           // 4 in, 2 out
  const p1 = P[p - 2 * hs], p0 = P[p - hs], q0 = P[p], q1 = P[p + hs];
  const a = 3 * (q0 - p0) + sclip1(p1 - q1);
  const a1 = sclip2((a + 4) >> 3), a2 = sclip2((a + 3) >> 3);
  P[p - hs] = clip8(p0 + a2); P[p] = clip8(q0 - a1);
}
function filter4(P, p, hs) {                           // 4 in, 4 out
  const p1 = P[p - 2 * hs], p0 = P[p - hs], q0 = P[p], q1 = P[p + hs];
  const a = 3 * (q0 - p0), a1 = sclip2((a + 4) >> 3), a2 = sclip2((a + 3) >> 3), a3 = (a1 + 1) >> 1;
  P[p - 2 * hs] = clip8(p1 + a3); P[p - hs] = clip8(p0 + a2); P[p] = clip8(q0 - a1); P[p + hs] = clip8(q1 - a3);
}
function filter6(P, p, hs) {                           // 6 in, 6 out
  const p2 = P[p - 3 * hs], p1 = P[p - 2 * hs], p0 = P[p - hs], q0 = P[p], q1 = P[p + hs], q2 = P[p + 2 * hs];
  const a = sclip1(3 * (q0 - p0) + sclip1(p1 - q1));
  const a1 = (27 * a + 63) >> 7, a2 = (18 * a + 63) >> 7, a3 = (9 * a + 63) >> 7;
  P[p - 3 * hs] = clip8(p2 + a3); P[p - 2 * hs] = clip8(p1 + a2); P[p - hs] = clip8(p0 + a1);
  P[p] = clip8(q0 - a1); P[p + hs] = clip8(q1 - a2); P[p + 2 * hs] = clip8(q2 - a3);
}
const hev = (P, p, hs, t) => Math.abs(P[p - 2 * hs] - P[p - hs]) > t || Math.abs(P[p + hs] - P[p]) > t;
// hs: step across the edge, vs: step along it
function filterLoop(P, p, hs, vs, size, thresh, ithresh, hevT, mbEdge) {
  const t2 = 2 * thresh + 1;
  for (let i = 0; i < size; i++, p += vs) {
    if (!needsFilter2(P, p, hs, t2, ithresh)) continue;
    if (hev(P, p, hs, hevT)) filter2(P, p, hs);
    else if (mbEdge) filter6(P, p, hs);
    else filter4(P, p, hs);
  }
}
function simpleFilter(P, p, hs, vs, thresh) {
  const t2 = 2 * thresh + 1;
  for (let i = 0; i < 16; i++, p += vs) {
    if (4 * Math.abs(P[p - hs] - P[p]) + Math.abs(P[p - 2 * hs] - P[p + hs]) <= t2) filter2(P, p, hs);
  }
}

function decodeLossy(d) {
  if (d.length < 10) throw new Error('VP8: dữ liệu quá ngắn');
  const tag = d[0] | (d[1] << 8) | (d[2] << 16);
  if (tag & 1) throw new Error('VP8: không phải key frame');
  if (d[3] !== 0x9d || d[4] !== 0x01 || d[5] !== 0x2a) throw new Error('VP8: sai mã bắt đầu');
  const width = (d[6] | (d[7] << 8)) & 0x3fff, height = (d[8] | (d[9] << 8)) & 0x3fff;
  const firstEnd = Math.min(d.length, 10 + (tag >>> 5));
  const br = new BoolDecoder(d, 10, firstEnd);
  br.bit(128); br.bit(128);                            // colour space, clamping type

  const seg = { use: br.bit(128), map: 0, absolute: 1, quant: [0, 0, 0, 0], filter: [0, 0, 0, 0], probs: [255, 255, 255] };
  if (seg.use) {
    seg.map = br.bit(128);
    if (br.bit(128)) {
      seg.absolute = br.bit(128);
      for (let s = 0; s < 4; s++) seg.quant[s] = br.bit(128) ? br.signed(7) : 0;
      for (let s = 0; s < 4; s++) seg.filter[s] = br.bit(128) ? br.signed(6) : 0;
    }
    if (seg.map) for (let s = 0; s < 3; s++) seg.probs[s] = br.bit(128) ? br.literal(8) : 255;
  }

  const simple = br.bit(128), level = br.literal(6), sharpness = br.literal(3);
  const refDelta = [0, 0, 0, 0], modeDelta = [0, 0, 0, 0];
  const useDelta = br.bit(128);
  if (useDelta && br.bit(128)) {
    for (let i = 0; i < 4; i++) if (br.bit(128)) refDelta[i] = br.signed(6);
    for (let i = 0; i < 4; i++) if (br.bit(128)) modeDelta[i] = br.signed(6);
  }
  const filterType = level === 0 ? 0 : simple ? 1 : 2;

  const numParts = 1 << br.literal(2);
  const parts = [];
  let p = firstEnd + 3 * (numParts - 1);
  for (let i = 0; i < numParts; i++) {
    const sz = firstEnd + 3 * i;
    let size = i < numParts - 1 ? d[sz] | (d[sz + 1] << 8) | (d[sz + 2] << 16) : d.length - p;
    size = Math.max(0, Math.min(size, d.length - p));
    parts.push(new BoolDecoder(d, p, p + size));
    p += size;
  }

  const q0 = br.literal(7);
  const delta = () => (br.bit(128) ? br.signed(4) : 0);
  const y1dc = delta(), y2dc = delta(), y2ac = delta(), uvdc = delta(), uvac = delta();
  const quant = [0, 1, 2, 3].map((s) => {
    const q = seg.use ? seg.quant[s] + (seg.absolute ? 0 : q0) : q0;
    return {
      y1: [DC_TABLE[clip(q + y1dc, 127)], AC_TABLE[clip(q, 127)]],
      y2: [DC_TABLE[clip(q + y2dc, 127)] * 2, Math.max(8, (AC_TABLE[clip(q + y2ac, 127)] * 101581) >> 16)],
      uv: [DC_TABLE[clip(q + uvdc, 117)], AC_TABLE[clip(q + uvac, 127)]],
    };
  });

  br.bit(128);                                         // refresh entropy probs: single frame, ignored
  const P = Uint8Array.from(COEFFS);
  for (let i = 0; i < P.length; i++) if (br.bit(COEFF_UPDATES[i])) P[i] = br.literal(8);
  const useSkip = br.bit(128), skipProb = useSkip ? br.literal(8) : 0;

  // filter strength per segment × (i16, i4)
  const strengths = [0, 1, 2, 3].map((s) => [0, 1].map((i4) => {
    let lv = seg.use ? seg.filter[s] + (seg.absolute ? 0 : level) : level;
    if (useDelta) { lv += refDelta[0]; if (i4) lv += modeDelta[0]; }
    lv = clip(lv, 63);
    if (!lv) return { limit: 0 };
    let il = lv;
    if (sharpness > 0) { il >>= sharpness > 4 ? 2 : 1; if (il > 9 - sharpness) il = 9 - sharpness; }
    if (il < 1) il = 1;
    return { limit: 2 * lv + il, ilevel: il, hev: lv >= 40 ? 2 : lv >= 15 ? 1 : 0 };
  }));

  const mbw = (width + 15) >> 4, mbh = (height + 15) >> 4, yw = mbw * 16, uvw = mbw * 8;
  const Y = new Uint8Array(yw * mbh * 16), U = new Uint8Array(uvw * mbh * 8), V = new Uint8Array(uvw * mbh * 8);
  const intraT = new Uint8Array(mbw * 4), intraL = new Uint8Array(4);
  const nzT = new Uint8Array(mbw * 9), nzL = new Uint8Array(9);   // 4 Y, 2 U, 2 V, Y2
  const coeffs = new Int16Array(384), dc = new Int16Array(16), e = new Int32Array(13);
  const filters = filterType ? new Array(mbw * mbh) : null;

  for (let mby = 0; mby < mbh; mby++) {
    intraL.fill(0); nzL.fill(0);
    // modes of the whole row (first partition)
    const modes = [];
    for (let mbx = 0; mbx < mbw; mbx++) {
      const m = { segment: 0, skip: 0, i4: 0, ymode: 0, bmodes: null, uv: 0 };
      if (seg.map) m.segment = !br.bit(seg.probs[0]) ? br.bit(seg.probs[1]) : 2 + br.bit(seg.probs[2]);
      if (useSkip) m.skip = br.bit(skipProb);
      m.i4 = br.bit(145) ? 0 : 1;
      if (!m.i4) {
        m.ymode = br.bit(156) ? (br.bit(128) ? TM_PRED : H_PRED) : (br.bit(163) ? V_PRED : DC_PRED);
        intraT.fill(m.ymode, mbx * 4, mbx * 4 + 4); intraL.fill(m.ymode);
      } else {
        m.bmodes = new Uint8Array(16);
        for (let y = 0; y < 4; y++) {
          let left = intraL[y];
          for (let x = 0; x < 4; x++) {
            left = readBMode(br, (intraT[mbx * 4 + x] * 10 + left) * 9);
            intraT[mbx * 4 + x] = left;
            m.bmodes[y * 4 + x] = left;
          }
          intraL[y] = left;
        }
      }
      m.uv = !br.bit(142) ? DC_PRED : !br.bit(114) ? V_PRED : br.bit(183) ? TM_PRED : H_PRED;
      modes.push(m);
    }

    const tb = parts[mby & (numParts - 1)];
    for (let mbx = 0; mbx < mbw; mbx++) {
      const m = modes[mbx], q = quant[m.segment], t = mbx * 9;
      coeffs.fill(0);
      let nonZero = 0;
      if (!m.skip) {
        let first = 0, type = 3;
        if (!m.i4) {                                   // Y2: DC of the 16 luma blocks, Walsh-Hadamard coded
          dc.fill(0);
          const nz = getCoeffs(tb, P, 1, nzT[t + 8] + nzL[8], q.y2, 0, dc, 0);
          nzT[t + 8] = nzL[8] = nz > 0 ? 1 : 0;
          if (nz > 1) inverseWHT(dc, coeffs);
          else { const v = (dc[0] + 3) >> 3; for (let i = 0; i < 256; i += 16) coeffs[i] = v; }
          first = 1; type = 0;
        }
        for (let y = 0; y < 4; y++) {
          let l = nzL[y];
          for (let x = 0; x < 4; x++) {
            const off = (y * 4 + x) * 16;
            const nz = getCoeffs(tb, P, type, l + nzT[t + x], q.y1, first, coeffs, off);
            l = nzT[t + x] = nz > first ? 1 : 0;
            if (nz > 1 || coeffs[off]) nonZero = 1;
          }
          nzL[y] = l;
        }
        for (let ch = 0; ch < 2; ch++) {
          for (let y = 0; y < 2; y++) {
            let l = nzL[4 + ch * 2 + y];
            for (let x = 0; x < 2; x++) {
              const off = 256 + ch * 64 + (y * 2 + x) * 16;
              const nz = getCoeffs(tb, P, 2, l + nzT[t + 4 + ch * 2 + x], q.uv, 0, coeffs, off);
              l = nzT[t + 4 + ch * 2 + x] = nz > 0 ? 1 : 0;
              if (nz > 1 || coeffs[off]) nonZero = 1;
            }
            nzL[4 + ch * 2 + y] = l;
          }
        }
      } else {
        for (let k = 0; k < 8; k++) nzT[t + k] = nzL[k] = 0;
        if (!m.i4) nzT[t + 8] = nzL[8] = 0;
      }
      if (filters) filters[mby * mbw + mbx] = { ...strengths[m.segment][m.i4], inner: m.i4 || nonZero };

      // reconstruction (the loop filter runs afterwards on the whole frame: intra prediction sees unfiltered pixels)
      const yPos = mby * 16 * yw + mbx * 16;
      if (m.i4) {
        // pixels right of the MB's top row: next MB's bottom row above, or the last pixel repeated at the right edge
        const tr = [127, 127, 127, 127];
        if (mby > 0) for (let k = 0; k < 4; k++) tr[k] = Y[yPos - yw + (mbx < mbw - 1 ? 16 + k : 15)];
        for (let n = 0; n < 16; n++) {
          const sx = n & 3, sy = n >> 2, pos = yPos + sy * 4 * yw + sx * 4;
          const topRow = mby > 0 || sy > 0, leftCol = mbx > 0 || sx > 0;
          e[0] = !topRow ? 127 : !leftCol ? 129 : Y[pos - yw - 1];
          for (let k = 0; k < 4; k++) e[1 + k] = topRow ? Y[pos - yw + k] : 127;
          for (let k = 0; k < 4; k++) e[5 + k] = sx === 3 ? tr[k] : topRow ? Y[pos - yw + 4 + k] : 127;
          for (let k = 0; k < 4; k++) e[9 + k] = leftCol ? Y[pos - 1 + k * yw] : 129;
          predict4(Y, yw, pos, m.bmodes[n], e);
          idctAdd(coeffs, n * 16, Y, yw, pos);
        }
      } else {
        predictBlock(Y, yw, yPos, 16, m.ymode, mby > 0, mbx > 0);
        for (let n = 0; n < 16; n++) idctAdd(coeffs, n * 16, Y, yw, yPos + (n >> 2) * 4 * yw + (n & 3) * 4);
      }
      const uvPos = mby * 8 * uvw + mbx * 8;
      predictBlock(U, uvw, uvPos, 8, m.uv, mby > 0, mbx > 0);
      predictBlock(V, uvw, uvPos, 8, m.uv, mby > 0, mbx > 0);
      for (let n = 0; n < 4; n++) {
        const o = uvPos + (n >> 1) * 4 * uvw + (n & 1) * 4;
        idctAdd(coeffs, 256 + n * 16, U, uvw, o);
        idctAdd(coeffs, 320 + n * 16, V, uvw, o);
      }
    }
  }

  // loop filter, macroblocks in raster order
  for (let i = 0; filters && i < filters.length; i++) {
    const f = filters[i];
    if (!f.limit) continue;
    const mbx = i % mbw, mby = (i / mbw) | 0, yp = mby * 16 * yw + mbx * 16;
    if (filterType === 1) {
      if (mbx > 0) simpleFilter(Y, yp, 1, yw, f.limit + 4);
      if (f.inner) for (let k = 4; k < 16; k += 4) simpleFilter(Y, yp + k, 1, yw, f.limit);
      if (mby > 0) simpleFilter(Y, yp, yw, 1, f.limit + 4);
      if (f.inner) for (let k = 4; k < 16; k += 4) simpleFilter(Y, yp + k * yw, yw, 1, f.limit);
      continue;
    }
    const up = mby * 8 * uvw + mbx * 8;
    if (mbx > 0) {
      filterLoop(Y, yp, 1, yw, 16, f.limit + 4, f.ilevel, f.hev, true);
      filterLoop(U, up, 1, uvw, 8, f.limit + 4, f.ilevel, f.hev, true);
      filterLoop(V, up, 1, uvw, 8, f.limit + 4, f.ilevel, f.hev, true);
    }
    if (f.inner) {
      for (let k = 4; k < 16; k += 4) filterLoop(Y, yp + k, 1, yw, 16, f.limit, f.ilevel, f.hev, false);
      filterLoop(U, up + 4, 1, uvw, 8, f.limit, f.ilevel, f.hev, false);
      filterLoop(V, up + 4, 1, uvw, 8, f.limit, f.ilevel, f.hev, false);
    }
    if (mby > 0) {
      filterLoop(Y, yp, yw, 1, 16, f.limit + 4, f.ilevel, f.hev, true);
      filterLoop(U, up, uvw, 1, 8, f.limit + 4, f.ilevel, f.hev, true);
      filterLoop(V, up, uvw, 1, 8, f.limit + 4, f.ilevel, f.hev, true);
    }
    if (f.inner) {
      for (let k = 4; k < 16; k += 4) filterLoop(Y, yp + k * yw, yw, 1, 16, f.limit, f.ilevel, f.hev, false);
      filterLoop(U, up + 4 * uvw, uvw, 1, 8, f.limit, f.ilevel, f.hev, false);
      filterLoop(V, up + 4 * uvw, uvw, 1, 8, f.limit, f.ilevel, f.hev, false);
    }
  }
  return { width, height, Y, U, V, yw, uvw };
}

// ---- YUV 4:2:0 → RGBA: libwebp's "fancy" upsampler (9-3-3-1 chroma weights) and 14-bit fixed-point conversion
const mulHi = (v, c) => (v * c) >> 8;
const toByte = (v) => ((v & ~16383) === 0 ? v >> 6 : v < 0 ? 0 : 255);

function toRGBA(f, alpha) {
  const { width: w, height: h, Y, U, V, yw, uvw } = f;
  const data = Buffer.alloc(w * h * 4);
  const put = (x, y, yy, u, v) => {
    const o = (y * w + x) * 4, l = mulHi(yy, 19077);
    data[o] = toByte(l + mulHi(v, 26149) - 14234);
    data[o + 1] = toByte(l - mulHi(u, 6419) - mulHi(v, 13320) + 8708);
    data[o + 2] = toByte(l + mulHi(u, 33050) - 17685);
    data[o + 3] = alpha ? alpha[y * w + x] : 255;
  };
  // one pair of output rows: `ty` (and `by`, -1 for none) between chroma rows `tr` (above) and `cr` (below)
  const pair = (ty, by, tr, cr) => {
    const tY = ty * yw, bY = by * yw, tU = tr * uvw, cU = cr * uvw;
    let tlu = U[tU], tlv = V[tU], lu = U[cU], lv = V[cU];
    put(0, ty, Y[tY], (3 * tlu + lu + 2) >> 2, (3 * tlv + lv + 2) >> 2);
    if (by >= 0) put(0, by, Y[bY], (3 * lu + tlu + 2) >> 2, (3 * lv + tlv + 2) >> 2);
    for (let x = 1; x <= (w - 1) >> 1; x++) {
      const tu = U[tU + x], tv = V[tU + x], u = U[cU + x], v = V[cU + x];
      const u12 = (tlu + 3 * tu + 3 * lu + u + 8) >> 3, u03 = (3 * tlu + tu + lu + 3 * u + 8) >> 3;
      const v12 = (tlv + 3 * tv + 3 * lv + v + 8) >> 3, v03 = (3 * tlv + tv + lv + 3 * v + 8) >> 3;
      put(2 * x - 1, ty, Y[tY + 2 * x - 1], (u12 + tlu) >> 1, (v12 + tlv) >> 1);
      put(2 * x, ty, Y[tY + 2 * x], (u03 + tu) >> 1, (v03 + tv) >> 1);
      if (by >= 0) {
        put(2 * x - 1, by, Y[bY + 2 * x - 1], (u03 + lu) >> 1, (v03 + lv) >> 1);
        put(2 * x, by, Y[bY + 2 * x], (u12 + u) >> 1, (v12 + v) >> 1);
      }
      tlu = tu; tlv = tv; lu = u; lv = v;
    }
    if (!(w & 1)) {
      put(w - 1, ty, Y[tY + w - 1], (3 * tlu + lu + 2) >> 2, (3 * tlv + lv + 2) >> 2);
      if (by >= 0) put(w - 1, by, Y[bY + w - 1], (3 * lu + tlu + 2) >> 2, (3 * lv + tlv + 2) >> 2);
    }
  };
  pair(0, -1, 0, 0);
  let y = 0;
  for (; y + 2 < h; y += 2) pair(y + 1, y + 2, y >> 1, (y >> 1) + 1);
  if (!(h & 1)) pair(h - 1, -1, y >> 1, y >> 1);
  return { width: w, height: h, data };
}

module.exports = { isWebP, decodeWebP };
