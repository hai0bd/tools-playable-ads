'use strict';
// Sub-asset ids of imported models (gltf/fbx) are derived from the sub-asset name:
//   id = md5(name) hex digits [0, 6, 16, 25, 31]      e.g. "diamond.mesh" -> "27868"
// (verified on thousands of real metas; only gltf-scene keeps the id stored in the meta).
// To make the importer regenerate an asset with its ORIGINAL id we either recover the original
// name (candidates) or search a readable name whose hash gives that id.
const crypto = require('crypto');

function nameToId(name) {
  const h = crypto.createHash('md5').update(name, 'utf8').digest('hex');
  return h[0] + h[6] + h[16] + h[25] + h[31];
}

// ---------------------------------------------------------------- single-block md5 (messages <= 55 bytes)
const K = new Int32Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

/** Returns the target id as 5 nibbles computed from md5 words A, C, D (little-endian digest bytes). */
function md5Nibbles(M) {
  let a = 0x67452301, b = 0xefcdab89 | 0, c = 0x98badcfe | 0, d = 0x10325476;
  for (let i = 0; i < 64; i++) {
    let f, g;
    if (i < 16) { f = (b & c) | (~b & d); g = i; }
    else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
    else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
    else { f = c ^ (b | ~d); g = (7 * i) & 15; }
    const x = (a + f + K[i] + M[g]) | 0;
    const s = S[((i >> 4) << 2) + (i & 3)];
    a = d; d = c; c = b;
    b = (b + ((x << s) | (x >>> (32 - s)))) | 0;
  }
  a = (a + 0x67452301) | 0; c = (c + (0x98badcfe | 0)) | 0; d = (d + 0x10325476) | 0;
  // hex digit k of the digest: byte k>>1, high nibble when k is even
  return ((a >>> 4) & 15) << 16 | ((a >>> 28) & 15) << 12 | ((c >>> 4) & 15) << 8 | (d & 15) << 4 | ((d >>> 24) & 15);
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Find `${prefix}${suffix}` (suffix from ALPHABET) such that nameToId(name + ext) === targetId.
 * Returns the name without ext, or null.
 */
function searchName(prefix, ext, targetId, maxLen = 6) {
  const target = parseInt(targetId, 16);
  if (!/^[0-9a-f]{5}$/.test(targetId)) return null;
  const pre = Buffer.from(prefix, 'utf8'), post = Buffer.from(ext, 'utf8');
  for (let len = 1; len <= maxLen; len++) {
    const total = pre.length + len + post.length;
    if (total > 55) return null;
    const block = new Uint8Array(64);
    block.set(pre, 0); block.set(post, pre.length + len);
    block[total] = 0x80;
    const bits = total * 8;
    block[56] = bits & 255; block[57] = (bits >>> 8) & 255;
    const M = new Int32Array(block.buffer);
    const digits = new Array(len).fill(0);
    const codes = [...ALPHABET].map((ch) => ch.charCodeAt(0));
    const setByte = (pos, v) => { block[pos] = v; };
    for (let k = 0; k < len; k++) setByte(pre.length + k, codes[0]);
    const combos = Math.pow(ALPHABET.length, len);
    for (let n = 0; n < combos; n++) {
      if (md5Nibbles(M) === target) {
        const name = prefix + digits.map((x) => ALPHABET[x]).join('');
        if (nameToId(name + ext) === targetId) return name;   // double check with the real md5
      }
      // increment the suffix (little-endian counter over the alphabet)
      for (let k = len - 1; k >= 0; k--) {
        if (++digits[k] < ALPHABET.length) { setByte(pre.length + k, codes[digits[k]]); break; }
        digits[k] = 0; setByte(pre.length + k, codes[0]);
      }
    }
  }
  return null;
}

/**
 * Pick a name for a sub-asset so that the importer derives `targetId` from it.
 * candidates: likely original names (tried as-is); hint: readable base for the searched name.
 * Returns { name, recovered } — recovered = true when a candidate matched (original name found).
 */
function solveName(targetId, ext, candidates, hint, taken) {
  const seen = new Set();
  for (const c of candidates) {
    if (c == null || c === '' || seen.has(c)) continue;
    seen.add(c);
    if (taken && taken.has(c)) continue;
    if (nameToId(c + ext) === targetId) return { name: c, recovered: true };
  }
  let base = String(hint || 'Asset').replace(/[\x00-\x1f]/g, '').slice(0, 30) || 'Asset';
  while (Buffer.byteLength(base + '_' + ext, 'utf8') + 6 > 55) base = base.slice(0, -1);
  const name = searchName(base + '_', ext, targetId) || searchName('a', ext, targetId, 7);
  return { name, recovered: false };
}

module.exports = { nameToId, searchName, solveName };
