'use strict';
/* zlib cho trình duyệt — bản đồng bộ, vì lõi khôi phục gọi inflateSync/deflateSync giữa chừng.
 *
 * inflate: giải mã Huffman bằng bảng tra (mỗi ký hiệu một lần tra), đủ nhanh cho zip vài MB
 *          và PNG atlas 2048².
 * deflate: LZ77 (hash chain) + Huffman động; mỗi block chọn cách nhỏ nhất trong động / cố định /
 *          stored. Phải đồng bộ vì lõi mã hoá PNG giữa chừng (sprite cắt từ auto-atlas, ảnh nhúng
 *          trong .glb, panorama ghép). Nén kém zlib -9 vài phần trăm, không đáng kể.
 * brotli:  giải nén bằng brotli-core.js (bản của playable-converter) — cho file Luna.
 */
const { Buffer } = require('./buffer');
const BrotliCore = require('../vendor/brotli-core.js');

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Bảng tra: index = maxLen bit tiếp theo (đảo bit), giá trị = (ký hiệu << 4) | độ dài mã; 0 = mã sai. */
function buildTable(lengths, n) {
  let maxLen = 0;
  for (let i = 0; i < n; i++) if (lengths[i] > maxLen) maxLen = lengths[i];
  if (!maxLen) return { table: new Uint32Array(2), maxLen: 1 };
  const count = new Uint16Array(16);
  for (let i = 0; i < n; i++) count[lengths[i]]++;
  count[0] = 0;
  const next = new Uint16Array(16);
  let code = 0;
  for (let len = 1; len <= 15; len++) { code = (code + count[len - 1]) << 1; next[len] = code; }
  const size = 1 << maxLen, table = new Uint32Array(size);
  for (let sym = 0; sym < n; sym++) {
    const len = lengths[sym];
    if (!len) continue;
    const c = next[len]++;
    let r = 0;
    for (let i = 0; i < len; i++) r |= ((c >> i) & 1) << (len - 1 - i);
    for (let j = r; j < size; j += 1 << len) table[j] = (sym << 4) | len;
  }
  return { table, maxLen };
}

const FIXED_L = (() => { const l = new Uint8Array(288); l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288); return buildTable(l, 288); })();
const FIXED_D = (() => buildTable(new Uint8Array(32).fill(5), 32))();

function inflateRawBytes(src, expected) {
  let out = new Uint8Array(expected > 0 ? expected : Math.max(1 << 16, src.length * 4));
  let op = 0, ip = 0, bitbuf = 0, bitcnt = 0;
  const srcLen = src.length;
  const fail = (m) => { throw new Error('inflate: ' + m); };
  // đọc quá cuối vài byte 0 là bình thường (bảng tra cần đủ maxLen bit); quá nhiều = dữ liệu cụt
  const fill = (n) => {
    while (bitcnt < n) {
      if (ip >= srcLen + 4) fail('dữ liệu bị cắt cụt');
      bitbuf |= (ip < srcLen ? src[ip] : 0) << bitcnt;
      ip++;
      bitcnt += 8;
    }
  };
  const bits = (n) => {
    if (!n) return 0;
    fill(n);
    const v = bitbuf & ((1 << n) - 1);
    bitbuf >>>= n; bitcnt -= n;
    return v;
  };
  const sym = (t) => {
    fill(t.maxLen);
    const e = t.table[bitbuf & ((1 << t.maxLen) - 1)], len = e & 15;
    if (!len) fail('mã Huffman sai');
    bitbuf >>>= len; bitcnt -= len;
    return e >>> 4;
  };
  const ensure = (n) => {
    if (op + n <= out.length) return;
    let size = out.length * 2;
    while (size < op + n) size *= 2;
    const o = new Uint8Array(size);
    o.set(out.subarray(0, op));
    out = o;
  };

  let final;
  do {
    final = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitbuf >>>= bitcnt & 7; bitcnt -= bitcnt & 7;
      const len = bits(16), nlen = bits(16);
      if ((len ^ 0xffff) !== nlen) fail('block stored hỏng');
      ensure(len);
      let k = len;
      while (k > 0 && bitcnt > 0) { out[op++] = bitbuf & 255; bitbuf >>>= 8; bitcnt -= 8; k--; }
      if (ip + k > srcLen) fail('dữ liệu bị cắt cụt');
      out.set(src.subarray(ip, ip + k), op);
      op += k; ip += k;
    } else if (type === 1 || type === 2) {
      let lt = FIXED_L, dt = FIXED_D;
      if (type === 2) {
        const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
        const cl = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) cl[CLORDER[i]] = bits(3);
        const ct = buildTable(cl, 19);
        const lens = new Uint8Array(hlit + hdist);
        for (let i = 0; i < hlit + hdist;) {
          const s = sym(ct);
          if (s < 16) { lens[i++] = s; continue; }
          let rep, val = 0;
          if (s === 16) { if (!i) fail('mã lặp không có giá trị trước'); val = lens[i - 1]; rep = 3 + bits(2); }
          else if (s === 17) rep = 3 + bits(3);
          else rep = 11 + bits(7);
          if (i + rep > hlit + hdist) fail('bảng độ dài mã sai');
          while (rep--) lens[i++] = val;
        }
        lt = buildTable(lens.subarray(0, hlit), hlit);
        dt = buildTable(lens.subarray(hlit), hdist);
      }
      for (;;) {
        const s = sym(lt);
        if (s < 256) { if (op >= out.length) ensure(1); out[op++] = s; continue; }
        if (s === 256) break;
        const li = s - 257;
        if (li >= 29) fail('mã độ dài sai');
        const len = LBASE[li] + bits(LEXT[li]);
        const ds = sym(dt);
        if (ds >= 30) fail('mã khoảng cách sai');
        const dist = DBASE[ds] + bits(DEXT[ds]);
        if (dist > op) fail('khoảng cách vượt quá dữ liệu');
        ensure(len);
        let from = op - dist;
        if (dist >= len) { out.copyWithin(op, from, from + len); op += len; }
        else for (let k = 0; k < len; k++) out[op++] = out[from++];
      }
    } else fail('block type 3');
  } while (!final);
  if (ip - (bitcnt >> 3) > srcLen) fail('dữ liệu bị cắt cụt');
  return out.subarray(0, op);
}

function adler32(b) {
  let a = 1, s = 0;
  for (let i = 0; i < b.length;) {
    const end = Math.min(b.length, i + 3800);
    for (; i < end; i++) { a += b[i]; s += a; }
    a %= 65521; s %= 65521;
  }
  return ((s << 16) | a) >>> 0;
}

function asBytes(data) {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('zlib: dữ liệu vào không hợp lệ');
}

function inflateRawSync(data) { return Buffer.view(inflateRawBytes(asBytes(data), 0)); }

function inflateSync(data) {
  const b = asBytes(data);
  if (b.length < 2 || (b[0] & 15) !== 8 || ((b[0] << 8) | b[1]) % 31) throw new Error('inflate: header zlib sai');
  if (b[1] & 32) throw new Error('inflate: không hỗ trợ preset dictionary');
  return Buffer.view(inflateRawBytes(b.subarray(2), 0));
}

// ---------------------------------------------------------------- deflate
class BitWriter {
  constructor(size) { this.buf = new Uint8Array(Math.max(1024, size)); this.pos = 0; this.bits = 0; this.cnt = 0; }
  grow(n) {
    if (this.pos + n <= this.buf.length) return;
    let s = this.buf.length * 2;
    while (s < this.pos + n) s *= 2;
    const b = new Uint8Array(s);
    b.set(this.buf.subarray(0, this.pos));
    this.buf = b;
  }
  /** Ghi n bit (≤ 16) của value, bit thấp trước — thứ tự của deflate. */
  put(value, n) {
    this.bits |= value << this.cnt;
    this.cnt += n;
    while (this.cnt >= 8) {
      if (this.pos >= this.buf.length) this.grow(1);
      this.buf[this.pos++] = this.bits & 255;
      this.bits >>>= 8;
      this.cnt -= 8;
    }
  }
  align() { if (this.cnt > 0) { this.grow(1); this.buf[this.pos++] = this.bits & 255; } this.bits = 0; this.cnt = 0; }
  bytes(src) { this.grow(src.length); this.buf.set(src, this.pos); this.pos += src.length; }
  result() { this.align(); return this.buf.subarray(0, this.pos); }
}

const LCODE = new Uint8Array(259);   // độ dài match → chỉ số mã 257+i
for (let li = 0; li < 29; li++) for (let k = 0; k < 1 << LEXT[li]; k++) if (LBASE[li] + k <= 258) LCODE[LBASE[li] + k] = li;
LCODE[258] = 28;                     // 258 là mã 285, không phải 284 + 31
const DCODE = new Uint8Array(32769); // khoảng cách → mã
for (let di = 0; di < 30; di++) for (let k = 0; k < 1 << DEXT[di]; k++) if (DBASE[di] + k <= 32768) DCODE[DBASE[di] + k] = di;

const reverseBits = (c, l) => { let r = 0; for (let i = 0; i < l; i++) { r = (r << 1) | (c & 1); c >>= 1; } return r; };

/** Độ dài mã Huffman tối ưu, giới hạn `limit` bit: vượt thì làm phẳng tần suất rồi dựng lại. */
function codeLengths(freq, limit) {
  const len = new Uint8Array(freq.length), used = [];
  for (let i = 0; i < freq.length; i++) if (freq[i]) used.push(i);
  if (!used.length) return len;
  if (used.length === 1) { len[used[0]] = 1; return len; }
  const w = Float64Array.from(freq), m = used.length;
  for (;;) {
    const leaves = used.slice().sort((a, b) => w[a] - w[b] || a - b);
    const weight = new Float64Array(2 * m), parent = new Int32Array(2 * m);
    for (let i = 0; i < m; i++) weight[i] = w[leaves[i]];
    // hai hàng đợi: lá đã sắp xếp + nút trong (sinh ra theo trọng số không giảm)
    let li = 0, ii = m;
    for (let next = m; next < 2 * m - 1; next++) {
      const a = li < m && (ii >= next || weight[li] <= weight[ii]) ? li++ : ii++;
      const b = li < m && (ii >= next || weight[li] <= weight[ii]) ? li++ : ii++;
      weight[next] = weight[a] + weight[b];
      parent[a] = next; parent[b] = next;
    }
    const depth = new Uint16Array(2 * m);
    for (let k = 2 * m - 3; k >= 0; k--) depth[k] = depth[parent[k]] + 1;
    let max = 0;
    for (let i = 0; i < m; i++) { len[leaves[i]] = depth[i]; if (depth[i] > max) max = depth[i]; }
    if (max <= limit) return len;
    for (const s of used) w[s] = Math.floor(w[s] / 2) + 1;
  }
}

function canonicalCodes(len) {
  const count = new Uint16Array(16), next = new Uint16Array(16), codes = new Uint16Array(len.length);
  for (let i = 0; i < len.length; i++) count[len[i]]++;
  count[0] = 0;
  for (let b = 1, code = 0; b <= 15; b++) { code = (code + count[b - 1]) << 1; next[b] = code; }
  for (let i = 0; i < len.length; i++) if (len[i]) codes[i] = reverseBits(next[len[i]]++, len[i]);
  return codes;
}

const FIXED_LLEN = (() => { const l = new Uint8Array(288); l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288); return l; })();
const FIXED_LCODES = canonicalCodes(FIXED_LLEN);
const FIXED_DLEN = new Uint8Array(30).fill(5);
const FIXED_DCODES = canonicalCodes(FIXED_DLEN);

/** Ký hiệu: literal = byte; match = (dist << 9) | len. Chọn block nhỏ nhất: động, cố định hay stored. */
function writeBlock(w, syms, count, raw, rawStart, rawEnd, final) {
  const lf = new Uint32Array(286), df = new Uint32Array(30);
  let extra = 0;
  for (let k = 0; k < count; k++) {
    const v = syms[k], d = v >>> 9;
    if (!d) { lf[v]++; continue; }
    const li = LCODE[v & 511], di = DCODE[d];
    lf[257 + li]++; df[di]++;
    extra += LEXT[li] + DEXT[di];
  }
  lf[256] = 1;
  let dUsed = 0;
  for (let i = 0; i < 30; i++) if (df[i]) dUsed++;
  const dfx = Uint32Array.from(df);                 // cây khoảng cách cần ≥ 2 mã
  if (dUsed === 0) { dfx[0] = 1; dfx[1] = 1; } else if (dUsed === 1) dfx[df[0] ? 1 : 0] = 1;
  const ll = codeLengths(lf, 15), dl = codeLengths(dfx, 15);
  let nlit = 286; while (nlit > 257 && !ll[nlit - 1]) nlit--;
  let ndist = 30; while (ndist > 1 && !dl[ndist - 1]) ndist--;
  const all = new Uint8Array(nlit + ndist);
  all.set(ll.subarray(0, nlit)); all.set(dl.subarray(0, ndist), nlit);
  const rle = [];                                    // [ký hiệu, số bit thêm, giá trị thêm]
  for (let i = 0; i < all.length;) {
    const v = all[i];
    let run = 1;
    while (i + run < all.length && all[i + run] === v) run++;
    i += run;
    if (v === 0 && run >= 3) {
      while (run >= 3) {
        if (run >= 11) { const k = Math.min(138, run); rle.push(18, 7, k - 11); run -= k; }
        else { rle.push(17, 3, run - 3); run = 0; }
      }
      for (; run > 0; run--) rle.push(0, 0, 0);
    } else if (v !== 0 && run >= 4) {
      rle.push(v, 0, 0); run--;
      while (run >= 3) { const k = Math.min(6, run); rle.push(16, 2, k - 3); run -= k; }
      for (; run > 0; run--) rle.push(v, 0, 0);
    } else for (; run > 0; run--) rle.push(v, 0, 0);
  }
  const cf = new Uint32Array(19);
  for (let k = 0; k < rle.length; k += 3) cf[rle[k]]++;
  const cl = codeLengths(cf, 7);
  let nclen = 19; while (nclen > 4 && !cl[CLORDER[nclen - 1]]) nclen--;

  let dynBits = 17 + 3 * nclen + extra, fixBits = 3 + extra;
  for (let k = 0; k < rle.length; k += 3) dynBits += cl[rle[k]] + rle[k + 1];
  for (let s = 0; s < 286; s++) if (lf[s]) { dynBits += lf[s] * ll[s]; fixBits += lf[s] * FIXED_LLEN[s]; }
  for (let s = 0; s < 30; s++) if (df[s]) { dynBits += df[s] * dl[s]; fixBits += df[s] * 5; }
  const rawLen = rawEnd - rawStart;
  const storedBits = 8 * (rawLen + 5 * Math.max(1, Math.ceil(rawLen / 65535))) + 8;

  if (storedBits < dynBits && storedBits < fixBits) {
    let i = rawStart;
    do {
      const len = Math.min(65535, rawEnd - i);
      w.put(final && i + len >= rawEnd ? 1 : 0, 1); w.put(0, 2); w.align();
      w.bytes([len & 255, len >> 8, ~len & 255, (~len >> 8) & 255]);
      w.bytes(raw.subarray(i, i + len));
      i += len;
    } while (i < rawEnd);
    return;
  }
  let lcodes = FIXED_LCODES, llen = FIXED_LLEN, dcodes = FIXED_DCODES, dlen = FIXED_DLEN;
  w.put(final ? 1 : 0, 1);
  if (fixBits <= dynBits) w.put(1, 2);
  else {
    w.put(2, 2);
    w.put(nlit - 257, 5); w.put(ndist - 1, 5); w.put(nclen - 4, 4);
    for (let i = 0; i < nclen; i++) w.put(cl[CLORDER[i]], 3);
    const ccodes = canonicalCodes(cl);
    for (let k = 0; k < rle.length; k += 3) { w.put(ccodes[rle[k]], cl[rle[k]]); if (rle[k + 1]) w.put(rle[k + 2], rle[k + 1]); }
    lcodes = canonicalCodes(ll); llen = ll; dcodes = canonicalCodes(dl); dlen = dl;
  }
  for (let k = 0; k < count; k++) {
    const v = syms[k], d = v >>> 9;
    if (!d) { w.put(lcodes[v], llen[v]); continue; }
    const len = v & 511, li = LCODE[len], di = DCODE[d];
    w.put(lcodes[257 + li], llen[257 + li]);
    if (LEXT[li]) w.put(len - LBASE[li], LEXT[li]);
    w.put(dcodes[di], dlen[di]);
    if (DEXT[di]) w.put(d - DBASE[di], DEXT[di]);
  }
  w.put(lcodes[256], llen[256]);
}

function deflateRawBytes(data, level) {
  const n = data.length, w = new BitWriter((n >> 1) + 1024);
  if (!n) { w.put(1, 1); w.put(1, 2); w.put(0, 7); return w.result(); }
  const maxChain = level >= 9 ? 128 : level >= 6 ? 32 : 8, nice = level >= 9 ? 258 : 64;
  const HMASK = (1 << 15) - 1, WMASK = 32767;
  const head = new Int32Array(1 << 15).fill(-1), prev = new Int32Array(32768);
  const BLOCK = 1 << 16, syms = new Uint32Array(BLOCK);
  let count = 0, blockStart = 0, i = 0;
  while (i < n) {
    let best = 0, dist = 0;
    if (i + 2 < n) {
      const h = ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & HMASK;
      const maxLen = Math.min(258, n - i), lo = i - 32768;
      let c = head[h], chain = maxChain;
      while (c >= 0 && c > lo && chain-- > 0) {
        if (data[c + best] === data[i + best]) {
          let l = 0;
          while (l < maxLen && data[c + l] === data[i + l]) l++;
          if (l > best) { best = l; dist = i - c; if (l >= nice) break; }
        }
        c = prev[c & WMASK];
      }
      prev[i & WMASK] = head[h]; head[h] = i;
    }
    if (best >= 3) {
      syms[count++] = (dist << 9) | best;
      const end = i + best;
      for (let k = i + 1; k < end && k + 2 < n; k++) {
        const h = ((data[k] << 10) ^ (data[k + 1] << 5) ^ data[k + 2]) & HMASK;
        prev[k & WMASK] = head[h]; head[h] = k;
      }
      i = end;
    } else syms[count++] = data[i++];
    if (count >= BLOCK) { writeBlock(w, syms, count, data, blockStart, i, false); count = 0; blockStart = i; }
  }
  writeBlock(w, syms, count, data, blockStart, n, true);
  return w.result();
}

const levelOf = (opts) => (opts && opts.level != null && opts.level >= 0 ? opts.level : 6);

function deflateRawSync(data, opts) { return Buffer.from(deflateRawBytes(asBytes(data), levelOf(opts))); }

function deflateSync(data, opts) {
  const raw = asBytes(data), level = levelOf(opts), body = deflateRawBytes(raw, level);
  const out = Buffer.alloc(body.length + 6);
  out[0] = 0x78; out[1] = level >= 7 ? 0xda : level >= 6 ? 0x9c : level >= 2 ? 0x5e : 0x01;
  out.set(body, 2);
  const a = adler32(raw), at = body.length + 2;
  out[at] = a >>> 24; out[at + 1] = (a >>> 16) & 255; out[at + 2] = (a >>> 8) & 255; out[at + 3] = a & 255;
  return out;
}

function brotliDecompressSync(data) { return Buffer.view(BrotliCore.decompress(asBytes(data))); }

module.exports = { inflateSync, inflateRawSync, deflateSync, deflateRawSync, brotliDecompressSync, adler32, inflateRawBytes };
