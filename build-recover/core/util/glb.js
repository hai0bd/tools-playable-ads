'use strict';
// Minimal glTF 2.0 binary (.glb) builder.
const COMPONENT = { f32: 5126, u32: 5125, u16: 5123, u8: 5121, i16: 5122, i8: 5120 };
const TYPE_SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const ARRAY = { f32: Float32Array, u32: Uint32Array, u16: Uint16Array, u8: Uint8Array, i16: Int16Array, i8: Int8Array };

class GlbBuilder {
  constructor() {
    this.json = { asset: { version: '2.0', generator: 'cocos-build-recover' }, buffers: [{ byteLength: 0 }], bufferViews: [], accessors: [] };
    this.chunks = [];
    this.length = 0;
  }

  /** Append raw bytes as a bufferView (4-byte aligned). Returns the view index. */
  addView(bytes, target) {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) { this.chunks.push(Buffer.alloc(pad)); this.length += pad; }
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const view = { buffer: 0, byteOffset: this.length, byteLength: buf.length };
    if (target) view.target = target;
    this.chunks.push(Buffer.from(buf));
    this.length += buf.length;
    this.json.bufferViews.push(view);
    return this.json.bufferViews.length - 1;
  }

  /**
   * Add a tightly packed accessor. data: typed array (or plain array) of `comp` components.
   * opts: { normalized, minMax, target }
   */
  addAccessor(data, comp, type, opts = {}) {
    const arr = data instanceof ARRAY[comp] ? data : ARRAY[comp].from(data);
    const n = TYPE_SIZE[type];
    const count = arr.length / n;
    const acc = { bufferView: this.addView(arr, opts.target), componentType: COMPONENT[comp], count, type };
    if (opts.normalized) acc.normalized = true;
    if (opts.minMax) {
      const min = new Array(n).fill(Infinity), max = new Array(n).fill(-Infinity);
      for (let i = 0; i < count; i++) for (let k = 0; k < n; k++) { const v = arr[i * n + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
      acc.min = count ? min.map(f32) : new Array(n).fill(0);
      acc.max = count ? max.map(f32) : new Array(n).fill(0);
    }
    this.json.accessors.push(acc);
    return this.json.accessors.length - 1;
  }

  add(kind, obj) {
    (this.json[kind] = this.json[kind] || []).push(obj);
    return this.json[kind].length - 1;
  }

  toBuffer() {
    const bin = Buffer.concat(this.chunks);
    const binPadded = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
    this.json.buffers[0].byteLength = bin.length;
    if (!bin.length) delete this.json.buffers;
    for (const k of Object.keys(this.json)) if (Array.isArray(this.json[k]) && !this.json[k].length) delete this.json[k];
    let jsonBuf = Buffer.from(JSON.stringify(this.json), 'utf8');
    jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
    const parts = [jsonBuf.length, 0x4e4f534a, jsonBuf];
    const header = Buffer.alloc(12);
    const total = 12 + 8 + jsonBuf.length + (bin.length ? 8 + binPadded.length : 0);
    header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8);
    const jsonHead = Buffer.alloc(8); jsonHead.writeUInt32LE(parts[0], 0); jsonHead.writeUInt32LE(parts[1], 4);
    const out = [header, jsonHead, jsonBuf];
    if (bin.length) { const binHead = Buffer.alloc(8); binHead.writeUInt32LE(binPadded.length, 0); binHead.writeUInt32LE(0x004e4942, 4); out.push(binHead, binPadded); }
    return Buffer.concat(out);
  }
}

const F32 = new Float32Array(1);
function f32(v) { F32[0] = v; return F32[0]; }

/** Read a .glb back: { json, bin } */
function readGlb(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a glb');
  let off = 12, json = null, bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    else if (type === 0x004e4942) bin = data;
    off += 8 + len;
  }
  return { json, bin };
}

module.exports = { GlbBuilder, readGlb, COMPONENT };
