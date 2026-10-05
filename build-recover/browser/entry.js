'use strict';
/* Điểm vào của bản trình duyệt (dist/recover-core.js).
 *
 * Lõi trong core/ là CommonJS viết cho Node; scripts/bundle.js thay fs/zlib/crypto/vm/path bằng
 * shims/ rồi gói lại. Ở đây chỉ thêm những gì worker cần mà Node không cần:
 *   - nạp snapshot của Cocos Creator (phiên bản importer, uuid asset builtin) — trình duyệt không
 *     đọc được thư mục cài editor như bản Node;
 *   - đóng gói kết quả thành .zip.
 */
const fs = require('fs');
const metas = require('../core/project/metas');
const snapshot = require('virtual:editor-snapshot');
const core = require('../core/index.js');

Object.assign(metas.VERSIONS, snapshot.versions);
for (const u of snapshot.builtinUuids) metas.BUILTIN_UUIDS.add(u);
for (const [u, t] of snapshot.builtinTypes) metas.BUILTIN_TYPES.set(u, t);

// ---------------------------------------------------------------- crc32 / stream
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b, crc = 0) {
  crc = ~crc;
  for (let i = 0; i < b.length; i++) crc = CRC_TABLE[(crc ^ b[i]) & 255] ^ (crc >>> 8);
  return ~crc >>> 0;
}
async function through(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---------------------------------------------------------------- ZIP
const STORE_EXT = /\.(png|jpe?g|webp|gif|mp3|ogg|m4a|wav|mp4|webm|zip|gz|br|ttf|otf|woff2?)$/i;

/** [[đường dẫn, bytes]] → file .zip (deflate cho file chữ, giữ nguyên ảnh/âm thanh). */
async function buildZip(entries, rootName) {
  const te = new TextEncoder(), parts = [], central = [];
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  let offset = 0;
  for (const [rel, data] of entries) {
    const name = te.encode(rootName ? rootName + '/' + rel : rel);
    const crc = crc32(data);
    let method = 0, body = data;
    if (data.length > 128 && !STORE_EXT.test(rel)) {
      const packed = await through(data, new CompressionStream('deflate-raw'));
      if (packed.length < data.length) { method = 8; body = packed; }
    }
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true);
    head.setUint16(8, method, true); head.setUint16(10, time, true); head.setUint16(12, date, true);
    head.setUint32(14, crc, true); head.setUint32(18, body.length, true); head.setUint32(22, data.length, true);
    head.setUint16(26, name.length, true); head.setUint16(28, 0, true);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, method, true); cen.setUint16(12, time, true); cen.setUint16(14, date, true);
    cen.setUint32(16, crc, true); cen.setUint32(20, body.length, true); cen.setUint32(24, data.length, true);
    cen.setUint16(28, name.length, true); cen.setUint32(42, offset, true);
    parts.push(new Uint8Array(head.buffer), name, body);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const cenSize = central.reduce((s, b) => s + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
  return Buffer.concat([...parts, ...central, new Uint8Array(end.buffer)]);
}

/** Như core.recover; editor "cài trên máy" là editor đã chụp snapshot (Node thì tự tìm trên đĩa). */
function recover(input, opts = {}) {
  return core.recover(input, { editors: [{ version: snapshot.editor, engine: null }], ...opts });
}

module.exports = {
  recover,
  UnsupportedBuildError: core.UnsupportedBuildError,
  vfs: fs.__vfs,
  editor: snapshot.editor,
  buildZip,
  crc32,
};
