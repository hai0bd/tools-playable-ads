'use strict';
// Minimal ZIP reader (stored + deflate), enough for build archives. No external dependencies.
const zlib = require('zlib');

function findEocd(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('Không tìm thấy End-Of-Central-Directory (không phải file zip hợp lệ)');
}

/** Returns [{ name, method, compressedSize, size, localOffset, isDir }] */
function listZip(buf) {
  const eocd = findEocd(buf);
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  // ZIP64 locator (rare for builds, but handle offsets)
  if (cdOffset === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (loc >= 0 && buf.readUInt32LE(loc) === 0x07064b50) {
      const z64 = Number(buf.readBigUInt64LE(loc + 8));
      count = Number(buf.readBigUInt64LE(z64 + 32));
      cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
    }
  }
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Central directory hỏng tại ' + p);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    let compressedSize = buf.readUInt32LE(p + 20);
    let size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    let localOffset = buf.readUInt32LE(p + 42);
    const nameBuf = buf.subarray(p + 46, p + 46 + nameLen);
    const name = (flags & 0x800) ? nameBuf.toString('utf8') : decodeCp437OrUtf8(nameBuf);
    // zip64 extra field
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = buf.readUInt16LE(e), len = buf.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) { size = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (localOffset === 0xffffffff) { localOffset = Number(buf.readBigUInt64LE(q)); q += 8; }
      }
      e += 4 + len;
    }
    entries.push({ name: name.replace(/\\/g, '/'), method, compressedSize, size, localOffset, isDir: name.endsWith('/') });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function decodeCp437OrUtf8(b) {
  // Most tools write utf8 without setting the flag; try utf8 first.
  const s = b.toString('utf8');
  return s.includes('�') ? b.toString('latin1') : s;
}

function readEntry(buf, entry) {
  const p = entry.localOffset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error('Local header hỏng: ' + entry.name);
  const nameLen = buf.readUInt16LE(p + 26), extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`Phương thức nén zip ${entry.method} chưa hỗ trợ (${entry.name})`);
}

/** Read the whole archive into a Map<name, Buffer> (directories skipped). */
function readZip(buf) {
  const files = new Map();
  for (const e of listZip(buf)) {
    if (!e.isDir) files.set(e.name, readEntry(buf, e));
  }
  return files;
}

module.exports = { listZip, readEntry, readZip };
