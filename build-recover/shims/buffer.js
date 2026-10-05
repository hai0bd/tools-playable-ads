'use strict';
/* Buffer cho trình duyệt — đúng phần lõi khôi phục (và jsesc của Babel) dùng.
 *
 * Không kéo gói `buffer` của npm vào: lõi chỉ cần from/alloc/concat, đọc-ghi số nguyên và
 * vài bảng mã. Hai chỗ dễ sai nếu viết lại hời hợt, giữ đúng như Node:
 *   - slice() trả VIEW chung bộ nhớ (Uint8Array.slice thì chép) — lõi cắt buffer liên tục.
 *   - toString('latin1') ánh xạ byte → đúng code point đó. TextDecoder('latin1') thật ra là
 *     windows-1252 (0x80 → '€'), dùng nó là hỏng mọi payload nhị phân đi qua chuỗi.
 */

const encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { ignoreBOM: true });   // Node không bỏ BOM
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_REV = new Int16Array(256).fill(-1);
for (let i = 0; i < 64; i++) B64_REV[B64.charCodeAt(i)] = i;
B64_REV[45] = 62;   // '-' (base64url)
B64_REV[95] = 63;   // '_'
const HEX = [];
for (let i = 0; i < 256; i++) HEX.push((i < 16 ? '0' : '') + i.toString(16));

function normEnc(enc) {
  const e = String(enc || 'utf8').toLowerCase();
  if (e === 'utf-8') return 'utf8';
  if (e === 'binary') return 'latin1';
  if (e === 'ucs2' || e === 'ucs-2' || e === 'utf-16le') return 'utf16le';
  return e;
}

function base64ToBytes(str) {
  const out = new Uint8Array((str.length * 3) >> 2);
  let n = 0, acc = 0, bits = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    const v = c < 256 ? B64_REV[c] : -1;
    if (v < 0) { if (c === 61) break; continue; }   // '=' kết thúc, ký tự lạ thì bỏ qua như Node
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) { bits -= 8; out[n++] = (acc >> bits) & 255; }
  }
  return out.subarray(0, n);
}

function bytesToBase64(b, url) {
  let s = '';
  const n = b.length - (b.length % 3);
  const parts = [];
  for (let i = 0; i < n; i += 3) {
    const v = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    s += B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
    if (s.length > 32768) { parts.push(s); s = ''; }
  }
  if (b.length - n === 1) { const v = b[n] << 16; s += B64[v >> 18] + B64[(v >> 12) & 63] + '=='; }
  else if (b.length - n === 2) { const v = (b[n] << 16) | (b[n + 1] << 8); s += B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + '='; }
  parts.push(s);
  let out = parts.join('');
  if (url) out = out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return out;
}

function latin1(b, mask) {
  const parts = [];
  for (let i = 0; i < b.length; i += 0x8000) {
    let chunk = b.subarray(i, Math.min(b.length, i + 0x8000));
    if (mask) chunk = Uint8Array.from(chunk, (x) => x & mask);
    parts.push(String.fromCharCode.apply(null, chunk));
  }
  return parts.join('');
}

function fromString(str, enc) {
  switch (normEnc(enc)) {
    case 'utf8': return encoder.encode(str);
    case 'latin1': case 'ascii': {
      const out = new Uint8Array(str.length);
      for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i);
      return out;
    }
    case 'base64': case 'base64url': return base64ToBytes(str);
    case 'hex': {
      const out = new Uint8Array(str.length >> 1);
      let n = 0;
      for (; n < out.length; n++) {
        const v = parseInt(str.substr(n * 2, 2), 16);
        if (Number.isNaN(v)) break;
        out[n] = v;
      }
      return out.subarray(0, n);
    }
    case 'utf16le': {
      const out = new Uint8Array(str.length * 2);
      for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); out[i * 2] = c & 255; out[i * 2 + 1] = c >> 8; }
      return out;
    }
    default: throw new TypeError('Unknown encoding: ' + enc);
  }
}

function toBytes(val, enc) {
  if (typeof val === 'string') return fromString(val, enc);
  if (typeof val === 'number') return new Uint8Array([val & 255]);
  if (val instanceof Uint8Array) return val;
  throw new TypeError('Buffer: giá trị tìm kiếm không hợp lệ');
}

class Buffer extends Uint8Array {
  static from(value, encOrOffset, length) {
    if (typeof value === 'string') return Buffer.view(fromString(value, encOrOffset));
    if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)) {
      const off = encOrOffset >>> 0;
      return new Buffer(value, off, length === undefined ? value.byteLength - off : length >>> 0);
    }
    if (ArrayBuffer.isView(value)) {
      const out = new Buffer(value.length);
      if (value instanceof Uint8Array || value instanceof Uint8ClampedArray || value instanceof Int8Array) out.set(value);
      else for (let i = 0; i < value.length; i++) out[i] = value[i];   // Node: chép giá trị từng phần tử
      return out;
    }
    if (Array.isArray(value)) { const out = new Buffer(value.length); for (let i = 0; i < value.length; i++) out[i] = value[i]; return out; }
    if (value && value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data);
    if (value && typeof value.length === 'number') return Buffer.from(Array.from(value));
    throw new TypeError('Buffer.from: kiểu dữ liệu không hỗ trợ');
  }
  /** Bọc Uint8Array thành Buffer, không chép. */
  static view(u8) { return u8 instanceof Buffer ? u8 : new Buffer(u8.buffer, u8.byteOffset, u8.byteLength); }
  static alloc(n, fill, enc) { const b = new Buffer(n); if (fill !== undefined && fill !== 0) b.fill(fill, 0, n, enc); return b; }
  static allocUnsafe(n) { return new Buffer(n); }
  static allocUnsafeSlow(n) { return new Buffer(n); }
  static isBuffer(x) { return x instanceof Buffer; }
  static isEncoding(e) { return ['utf8', 'latin1', 'ascii', 'base64', 'base64url', 'hex', 'utf16le'].includes(normEnc(e)); }
  static byteLength(v, enc) {
    if (typeof v !== 'string') return v.byteLength;
    const e = normEnc(enc);
    if (e === 'latin1' || e === 'ascii') return v.length;
    if (e === 'utf16le') return v.length * 2;
    if (e === 'hex') return v.length >>> 1;
    return fromString(v, e).length;
  }
  static concat(list, total) {
    if (total === undefined) { total = 0; for (const b of list) total += b.length; }
    const out = new Buffer(total);
    let o = 0;
    for (const b of list) {
      if (o >= total) break;
      const part = b.length > total - o ? b.subarray(0, total - o) : b;
      out.set(part, o);
      o += part.length;
    }
    return out;
  }
  static compare(a, b) { return Buffer.prototype.compare.call(a, b); }

  toString(enc, start, end) {
    start = start === undefined ? 0 : Math.max(0, start | 0);
    end = end === undefined ? this.length : Math.min(this.length, end | 0);
    if (end <= start) return '';
    const v = start === 0 && end === this.length ? this : this.subarray(start, end);
    switch (normEnc(enc)) {
      case 'utf8': return utf8Decoder.decode(v);
      case 'latin1': return latin1(v);
      case 'ascii': return latin1(v, 127);
      case 'base64': return bytesToBase64(v, false);
      case 'base64url': return bytesToBase64(v, true);
      case 'hex': { let s = ''; for (let i = 0; i < v.length; i++) s += HEX[v[i]]; return s; }
      case 'utf16le': { let s = ''; for (let i = 0; i + 1 < v.length; i += 2) s += String.fromCharCode(v[i] | (v[i + 1] << 8)); return s; }
      default: throw new TypeError('Unknown encoding: ' + enc);
    }
  }
  toJSON() { return { type: 'Buffer', data: Array.from(this) }; }
  equals(o) {
    if (this.length !== o.length) return false;
    for (let i = 0; i < this.length; i++) if (this[i] !== o[i]) return false;
    return true;
  }
  compare(o) {
    const n = Math.min(this.length, o.length);
    for (let i = 0; i < n; i++) if (this[i] !== o[i]) return this[i] < o[i] ? -1 : 1;
    return this.length === o.length ? 0 : this.length < o.length ? -1 : 1;
  }
  slice(start, end) { return this.subarray(start, end); }
  indexOf(val, from, enc) {
    if (typeof from === 'string') { enc = from; from = 0; }
    const needle = toBytes(val, enc);
    let i = from === undefined ? 0 : from < 0 ? Math.max(0, this.length + from) : from;
    if (!needle.length) return i <= this.length ? i : this.length;
    const first = needle[0], last = this.length - needle.length;
    for (; i <= last; i++) {
      if (this[i] !== first) continue;
      let k = 1;
      while (k < needle.length && this[i + k] === needle[k]) k++;
      if (k === needle.length) return i;
    }
    return -1;
  }
  lastIndexOf(val, from, enc) {
    if (typeof from === 'string') { enc = from; from = undefined; }
    const needle = toBytes(val, enc);
    let i = from === undefined ? this.length - needle.length : Math.min(from < 0 ? this.length + from : from, this.length - needle.length);
    for (; i >= 0; i--) {
      let k = 0;
      while (k < needle.length && this[i + k] === needle[k]) k++;
      if (k === needle.length) return i;
    }
    return -1;
  }
  includes(val, from, enc) { return this.indexOf(val, from, enc) !== -1; }
  copy(target, ts = 0, ss = 0, se = this.length) {
    if (se > this.length) se = this.length;
    if (ts >= target.length || ss >= se) return 0;
    const n = Math.min(se - ss, target.length - ts);
    target.set(this.subarray(ss, ss + n), ts);
    return n;
  }
  fill(val, off, end, enc) {
    if (typeof off === 'string') { enc = off; off = 0; end = this.length; }
    else if (typeof end === 'string') { enc = end; end = this.length; }
    off = off === undefined ? 0 : off;
    end = end === undefined ? this.length : end;
    if (typeof val === 'number') return Uint8Array.prototype.fill.call(this, val & 255, off, end), this;
    const bytes = toBytes(val, enc);
    if (!bytes.length) return Uint8Array.prototype.fill.call(this, 0, off, end), this;
    for (let i = off, k = 0; i < end; i++, k = (k + 1) % bytes.length) this[i] = bytes[k];
    return this;
  }
  write(str, off, len, enc) {
    if (typeof off === 'string') { enc = off; off = 0; len = undefined; }
    else if (typeof len === 'string') { enc = len; len = undefined; }
    off = off || 0;
    const bytes = fromString(str, enc);
    const n = Math.min(bytes.length, len === undefined ? this.length - off : len, this.length - off);
    this.set(bytes.subarray(0, n), off);
    return n;
  }
  dv() { return new DataView(this.buffer, this.byteOffset, this.byteLength); }

  readUInt8(o = 0) { return this[o]; }
  readInt8(o = 0) { const v = this[o]; return v & 0x80 ? v - 256 : v; }
  readUInt16LE(o = 0) { return this[o] | (this[o + 1] << 8); }
  readUInt16BE(o = 0) { return (this[o] << 8) | this[o + 1]; }
  readInt16LE(o = 0) { const v = this.readUInt16LE(o); return v & 0x8000 ? v - 0x10000 : v; }
  readInt16BE(o = 0) { const v = this.readUInt16BE(o); return v & 0x8000 ? v - 0x10000 : v; }
  readUInt32LE(o = 0) { return (this[o] | (this[o + 1] << 8) | (this[o + 2] << 16)) + this[o + 3] * 0x1000000; }
  readUInt32BE(o = 0) { return this[o] * 0x1000000 + ((this[o + 1] << 16) | (this[o + 2] << 8) | this[o + 3]); }
  readInt32LE(o = 0) { return this[o] | (this[o + 1] << 8) | (this[o + 2] << 16) | (this[o + 3] << 24); }
  readInt32BE(o = 0) { return (this[o] << 24) | (this[o + 1] << 16) | (this[o + 2] << 8) | this[o + 3]; }
  readFloatLE(o = 0) { return this.dv().getFloat32(o, true); }
  readFloatBE(o = 0) { return this.dv().getFloat32(o, false); }
  readDoubleLE(o = 0) { return this.dv().getFloat64(o, true); }
  readDoubleBE(o = 0) { return this.dv().getFloat64(o, false); }
  readBigUInt64LE(o = 0) { return BigInt(this.readUInt32LE(o)) + (BigInt(this.readUInt32LE(o + 4)) << 32n); }
  readBigInt64LE(o = 0) { return BigInt.asIntN(64, this.readBigUInt64LE(o)); }

  writeUInt8(v, o = 0) { this[o] = v; return o + 1; }
  writeUInt16LE(v, o = 0) { this[o] = v; this[o + 1] = v >>> 8; return o + 2; }
  writeUInt16BE(v, o = 0) { this[o] = v >>> 8; this[o + 1] = v; return o + 2; }
  writeUInt32LE(v, o = 0) { this[o] = v; this[o + 1] = v >>> 8; this[o + 2] = v >>> 16; this[o + 3] = v >>> 24; return o + 4; }
  writeUInt32BE(v, o = 0) { this[o] = v >>> 24; this[o + 1] = v >>> 16; this[o + 2] = v >>> 8; this[o + 3] = v; return o + 4; }
  writeFloatLE(v, o = 0) { this.dv().setFloat32(o, v, true); return o + 4; }
  writeFloatBE(v, o = 0) { this.dv().setFloat32(o, v, false); return o + 4; }
  writeDoubleLE(v, o = 0) { this.dv().setFloat64(o, v, true); return o + 8; }
  writeDoubleBE(v, o = 0) { this.dv().setFloat64(o, v, false); return o + 8; }
}
// số có dấu ghi như không dấu (Uint8Array tự lấy mod 256)
const P = Buffer.prototype;
P.writeInt8 = P.writeUInt8; P.writeInt16LE = P.writeUInt16LE; P.writeInt16BE = P.writeUInt16BE;
P.writeInt32LE = P.writeUInt32LE; P.writeInt32BE = P.writeUInt32BE;
// Node có cả tên viết thường "Uint" từ v14
for (const k of Object.getOwnPropertyNames(P)) if (/UInt/.test(k)) P[k.replace('UInt', 'Uint')] = P[k];

module.exports = { Buffer, kMaxLength: 0x7fffffff };
