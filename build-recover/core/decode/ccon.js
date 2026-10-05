'use strict';
// CCON binary container: "CCON" magic, version, total length, JSON (v1) or notepack/msgpack (v2) document, 8-aligned chunks.
// Mirrors engine/cocos/serialization/ccon.ts

function decodeMsgpack(buf) {
  // Small msgpack decoder (covers what notepack encodes: nil/bool/int/float/str/bin/array/map + ext types used by notepack)
  let p = 0;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  function str(len) { const s = Buffer.from(buf.buffer, buf.byteOffset + p, len).toString('utf8'); p += len; return s; }
  function bin(len) { const b = buf.subarray(p, p + len); p += len; return b; }
  function arrN(n) { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = read(); return a; }
  function mapN(n) { const o = {}; for (let i = 0; i < n; i++) { const k = read(); o[k] = read(); } return o; }
  function ext(len) {
    const type = dv.getInt8(p); p++;
    const data = bin(len);
    if (type === 0) return undefined; // notepack encodes `undefined` as fixext type 0
    return { __ext__: type, data };
  }
  function read() {
    const b = buf[p++];
    if (b < 0x80) return b;
    if (b < 0x90) return mapN(b & 0x0f);
    if (b < 0xa0) return arrN(b & 0x0f);
    if (b < 0xc0) return str(b & 0x1f);
    if (b >= 0xe0) return b - 0x100;
    switch (b) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: { const n = buf[p++]; return bin(n); }
      case 0xc5: { const n = dv.getUint16(p); p += 2; return bin(n); }
      case 0xc6: { const n = dv.getUint32(p); p += 4; return bin(n); }
      case 0xc7: { const n = buf[p++]; return ext(n); }
      case 0xc8: { const n = dv.getUint16(p); p += 2; return ext(n); }
      case 0xc9: { const n = dv.getUint32(p); p += 4; return ext(n); }
      case 0xca: { const v = dv.getFloat32(p); p += 4; return v; }
      case 0xcb: { const v = dv.getFloat64(p); p += 8; return v; }
      case 0xcc: return buf[p++];
      case 0xcd: { const v = dv.getUint16(p); p += 2; return v; }
      case 0xce: { const v = dv.getUint32(p); p += 4; return v; }
      case 0xcf: { const v = Number(dv.getBigUint64(p)); p += 8; return v; }
      case 0xd0: { const v = dv.getInt8(p); p += 1; return v; }
      case 0xd1: { const v = dv.getInt16(p); p += 2; return v; }
      case 0xd2: { const v = dv.getInt32(p); p += 4; return v; }
      case 0xd3: { const v = Number(dv.getBigInt64(p)); p += 8; return v; }
      case 0xd4: return ext(1);
      case 0xd5: return ext(2);
      case 0xd6: return ext(4);
      case 0xd7: return ext(8);
      case 0xd8: return ext(16);
      case 0xd9: { const n = buf[p++]; return str(n); }
      case 0xda: { const n = dv.getUint16(p); p += 2; return str(n); }
      case 0xdb: { const n = dv.getUint32(p); p += 4; return str(n); }
      case 0xdc: { const n = dv.getUint16(p); p += 2; return arrN(n); }
      case 0xdd: { const n = dv.getUint32(p); p += 4; return arrN(n); }
      case 0xde: { const n = dv.getUint16(p); p += 2; return mapN(n); }
      case 0xdf: { const n = dv.getUint32(p); p += 4; return mapN(n); }
      default: throw new Error('msgpack: unsupported byte 0x' + b.toString(16));
    }
  }
  return read();
}

function isCCON(buf) {
  return buf && buf.length >= 16 && buf.readUInt32LE(0) === 0x4e4f4343;
}

function decodeCCON(buf) {
  if (!isCCON(buf)) throw new Error('Not a CCON file');
  const version = buf.readUInt32LE(4);
  let p = 12;
  const jsonLen = buf.readUInt32LE(p); p += 4;
  const docBytes = buf.subarray(p, p + jsonLen); p += jsonLen;
  // v1 = JSON text, v2 = notepack; decide by content (some packers damage the version field)
  const looksJson = docBytes[0] === 0x5b || docBytes[0] === 0x7b;
  const doc = looksJson ? JSON.parse(docBytes.toString('utf8')) : decodeMsgpack(docBytes);
  const chunks = [];
  while (p < buf.length) {
    if (p % 8 !== 0) p += 8 - (p % 8);
    if (p + 4 > buf.length) break;
    const len = buf.readUInt32LE(p); p += 4;
    chunks.push(buf.subarray(p, p + len)); p += len;
  }
  return { version, doc, chunks };
}

module.exports = { isCCON, decodeCCON };
