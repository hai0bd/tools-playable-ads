'use strict';
/* crypto cho trình duyệt: lõi chỉ cần md5 (id sub-asset của model, uuid ổn định) và byte ngẫu nhiên.
 * WebCrypto không có md5 và subtle.digest lại là async, nên md5 viết tay, đồng bộ. */
const { Buffer } = require('./buffer');

const K = new Int32Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) | 0;
const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];

function md5(bytes) {
  const n = bytes.length, total = ((n + 8) >> 6) + 1 << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[n] = 0x80;
  const bitLen = n * 8;
  for (let i = 0; i < 4; i++) buf[total - 8 + i] = (bitLen >>> (8 * i)) & 255;
  const hi = Math.floor(n / 0x20000000);
  for (let i = 0; i < 4; i++) buf[total - 4 + i] = (hi >>> (8 * i)) & 255;
  let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
  const M = new Int32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let j = 0; j < 16; j++) { const p = off + j * 4; M[j] = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24); }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
      else { F = C ^ (B | ~D); g = (7 * i) & 15; }
      const t = D; D = C; C = B;
      const x = (A + F + K[i] + M[g]) | 0;
      B = (B + ((x << S[i]) | (x >>> (32 - S[i])))) | 0;
      A = t;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const out = new Uint8Array(16);
  [a0, b0, c0, d0].forEach((v, k) => { for (let i = 0; i < 4; i++) out[k * 4 + i] = (v >>> (8 * i)) & 255; });
  return out;
}

function createHash(alg) {
  if (String(alg).toLowerCase() !== 'md5') throw new Error('crypto (trình duyệt): chỉ hỗ trợ md5, không có ' + alg);
  const parts = [];
  return {
    update(data, enc) { parts.push(typeof data === 'string' ? Buffer.from(data, enc || 'utf8') : data); return this; },
    digest(enc) {
      const d = Buffer.view(md5(Buffer.concat(parts)));
      return enc ? d.toString(enc) : d;
    },
  };
}

function randomBytes(n) { const b = Buffer.alloc(n); globalThis.crypto.getRandomValues(b); return b; }
function randomUUID() { return globalThis.crypto.randomUUID(); }

module.exports = { createHash, randomBytes, randomUUID, md5 };
