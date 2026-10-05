'use strict';
// UUID helpers matching Cocos Creator's compressed uuid formats.
//  - asset uuids in builds: 22 chars (2 hex + 20 base64), optionally with "@subId"
//  - script class ids (cid): 23 chars (5 hex + 18 base64)
const crypto = require('crypto');

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_VALUE = new Map([...B64].map((c, i) => [c, i]));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

/** Decompress a 22/23-char compressed uuid (keeps any "@sub" suffix). Returns input unchanged if not compressed. */
function decompressUuid(str) {
  if (typeof str !== 'string') return str;
  const at = str.indexOf('@');
  const base = at >= 0 ? str.slice(0, at) : str;
  const suffix = at >= 0 ? str.slice(at) : '';
  if (base.length !== 22 && base.length !== 23) return str;
  const headLen = base.length === 22 ? 2 : 5;
  let hex = base.slice(0, headLen);
  if (!/^[0-9a-f]+$/i.test(hex)) return str;
  for (let i = headLen; i < base.length; i += 2) {
    const l = B64_VALUE.get(base[i]), r = B64_VALUE.get(base[i + 1]);
    if (l === undefined || r === undefined) return str;
    hex += (l >> 2).toString(16) + (((l & 3) << 2) | (r >> 4)).toString(16) + (r & 0xf).toString(16);
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}${suffix}`;
}

/** Compress a full uuid. reserved=2 -> 22 chars (asset/node ids), reserved=5 -> 23 chars (script class ids). */
function compressUuid(uuid, reserved = 5) {
  const hex = uuid.replace(/-/g, '');
  let out = hex.slice(0, reserved);
  for (let i = reserved; i < 32; i += 3) {
    const a = parseInt(hex[i], 16), b = parseInt(hex[i + 1], 16), c = parseInt(hex[i + 2], 16);
    out += B64[(a << 2) | (b >> 2)] + B64[((b & 3) << 4) | c];
  }
  return out;
}

/** Deterministic v4-shaped uuid from a seed string (so re-running the tool gives identical output). */
function stableUuid(seed) {
  const h = crypto.createHash('md5').update('cocos-build-recover:' + seed).digest('hex');
  const s = h.slice(0, 12) + '4' + h.slice(13, 16) + ((parseInt(h[16], 16) & 3) | 8).toString(16) + h.slice(17, 32);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/** 22-char id in the style the editor uses for node _id / prefab fileId. */
function stableId(seed) {
  return compressUuid(stableUuid(seed), 2);
}

module.exports = { B64, isUuid, decompressUuid, compressUuid, stableUuid, stableId };
