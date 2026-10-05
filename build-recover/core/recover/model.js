'use strict';
// Rebuild 3D model files (.glb) from what a build keeps of an FBX/glTF model: its sub-assets
// cc.Mesh, cc.Skeleton, cc.Material, cc.Texture2D, cc.ImageAsset, cc.AnimationClip and the model prefab.
//  - sub-asset names are chosen so the Cocos importer derives the ORIGINAL sub-asset ids (util/subid.js),
//    so scenes/prefabs/materials keep working without touching any reference;
//  - embedded materials are written to meta userData.materials (the importer's "edited material" store),
//    so they stay exactly as in the build (effect, defines, states, props);
//  - animation clips also keep their id through animationImportSettings.splits[].previousId.
const path = require('path');
const { GlbBuilder } = require('../util/glb');
const { solveName, nameToId } = require('../util/subid');
const { decompressUuid } = require('../util/uuid');
const { isPNG, decodePNG, encodePNG } = require('../util/png');
const { meta, subMeta } = require('../project/metas');
const { toEditorJSON, normalizeMaterialJSON } = require('./editorjson');

const MODEL_TYPES = new Set(['cc.Mesh', 'cc.Skeleton', 'cc.Material', 'cc.Texture2D', 'cc.ImageAsset', 'cc.AnimationClip', 'cc.Prefab']);
const EXT = { mesh: '.mesh', material: '.material', skeleton: '.skeleton', texture: '.texture', image: '.image', clip: '.animation', prefab: '.prefab' };

// gfx.Format -> component layout
const FMT = {};
const defFmt = (ids, comp, norm) => ids.forEach((id, i) => { FMT[id] = { comp, n: i + 1, norm }; });
defFmt([4, 14, 24, 35], 'u8', true);      // R8 RG8 RGB8 RGBA8 (unorm)
defFmt([5, 15, 26, 38], 'i8', true);      // *8SN
defFmt([6, 16, 27, 39], 'u8', false);     // *8UI
defFmt([7, 17, 28, 40], 'i8', false);     // *8I
defFmt([8, 18, 29, 41], 'f16', false);    // *16F
defFmt([9, 19, 30, 42], 'u16', false);    // *16UI
defFmt([10, 20, 31, 43], 'i16', false);   // *16I
defFmt([11, 21, 32, 44], 'f32', false);   // *32F
defFmt([12, 22, 33, 45], 'u32', false);   // *32UI
defFmt([13, 23, 34, 46], 'i32', false);   // *32I
FMT[25] = { comp: 'u8', n: 3, norm: true };        // SRGB8
FMT[36] = { comp: 'u8', n: 4, norm: true };        // BGRA8
FMT[37] = { comp: 'u8', n: 4, norm: true };        // SRGB8_A8
const COMP_SIZE = { u8: 1, i8: 1, u16: 2, i16: 2, f16: 2, u32: 4, i32: 4, f32: 4 };

const SEMANTIC = {
  a_position: 'POSITION', a_normal: 'NORMAL', a_tangent: 'TANGENT', a_color: 'COLOR_0', a_color1: 'COLOR_1',
  a_texCoord: 'TEXCOORD_0', a_texCoord1: 'TEXCOORD_1', a_texCoord2: 'TEXCOORD_2', a_texCoord3: 'TEXCOORD_3',
  a_joints: 'JOINTS_0', a_weights: 'WEIGHTS_0', a_joints1: 'JOINTS_1', a_weights1: 'WEIGHTS_1',
};
const GLTF_MODE = { 0: 0, 1: 1, 2: 3, 3: 2, 7: 4, 8: 5, 9: 6 };   // gfx.PrimitiveMode -> glTF mode
const GL_FILTER = { nearest: 9728, linear: 9729 };
const GL_MIN_FILTER = { 'nearest:none': 9728, 'linear:none': 9729, 'nearest:nearest': 9984, 'linear:nearest': 9985, 'nearest:linear': 9986, 'linear:linear': 9987 };
const GL_WRAP = { repeat: 10497, 'mirrored-repeat': 33648, 'clamp-to-edge': 33071, 'clamp-to-border': 33071 };
const FILTER = { 0: 'none', 1: 'nearest', 2: 'linear' };
const WRAP = { 0: 'repeat', 1: 'mirrored-repeat', 2: 'clamp-to-edge', 3: 'clamp-to-border' };

const refUuid = (v) => (v && v.__uuid__ ? v.__uuid__ : null);
const PLACEHOLDER_PNG = () => encodePNG(1, 1, Buffer.from([255, 255, 255, 255]));
/** Cocos attribute name -> glTF semantic (a_texCoord3 -> TEXCOORD_3, a_color1 -> COLOR_1 ...) */
function semanticOf(name) {
  if (SEMANTIC[name]) return SEMANTIC[name];
  const m = name.match(/^a_(texCoord|color|joints|weights)(\d+)$/);
  if (!m) return null;
  return { texCoord: 'TEXCOORD_', color: 'COLOR_', joints: 'JOINTS_', weights: 'WEIGHTS_' }[m[1]] + m[2];
}
const RENDERERS = new Set(['cc.MeshRenderer', 'cc.SkinnedMeshRenderer']);
const ANIM_COMPS = new Set(['cc.SkeletalAnimation', 'cc.Animation']);

function halfToFloat(h) {
  const s = (h & 0x8000) ? -1 : 1, e = (h & 0x7c00) >> 10, f = h & 0x03ff;
  if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

/** Decode the interleaved vertex attributes of one Cocos vertex bundle. */
function readBundle(bin, bundle) {
  const { view, attributes } = bundle;
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const out = [];
  let offset = 0;
  for (const a of attributes) {
    const f = FMT[a.format];
    if (!f) throw new Error(`định dạng thuộc tính ${a.name} (${a.format}) chưa hỗ trợ`);
    const comp = f.comp === 'f16' || f.comp === 'i32' ? 'f32' : f.comp;
    const Arr = { u8: Uint8Array, i8: Int8Array, u16: Uint16Array, i16: Int16Array, u32: Uint32Array, f32: Float32Array }[comp];
    const data = new Arr(view.count * f.n);
    const cs = COMP_SIZE[f.comp];
    for (let v = 0; v < view.count; v++) {
      const base = view.offset + v * view.stride + offset;
      for (let k = 0; k < f.n; k++) {
        const p = base + k * cs;
        let x;
        switch (f.comp) {
          case 'u8': x = dv.getUint8(p); break;
          case 'i8': x = dv.getInt8(p); break;
          case 'u16': x = dv.getUint16(p, true); break;
          case 'i16': x = dv.getInt16(p, true); break;
          case 'f16': x = halfToFloat(dv.getUint16(p, true)); break;
          case 'u32': x = dv.getUint32(p, true); break;
          case 'i32': x = dv.getInt32(p, true); break;
          default: x = dv.getFloat32(p, true);
        }
        data[v * f.n + k] = x;
      }
    }
    out.push({ name: a.name, comp, n: f.n, norm: !!(a.isNormalized || f.norm), data });
    offset += cs * f.n;
  }
  return out;
}

function readIndices(bin, iv) {
  const Arr = iv.stride === 4 ? Uint32Array : iv.stride === 1 ? Uint8Array : Uint16Array;
  const copy = new Uint8Array(bin.subarray(iv.offset, iv.offset + iv.count * iv.stride));
  return new Arr(copy.buffer, 0, iv.count);
}

const TYPE_OF_N = { 1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4', 16: 'MAT4' };
const MAT_KEYS = ['m00', 'm01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08', 'm09', 'm10', 'm11', 'm12', 'm13', 'm14', 'm15'];
const mat4Array = (m) => (Array.isArray(m) ? m : m && typeof m === 'object' ? MAT_KEYS.map((k) => m[k] || 0) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

// ---------------------------------------------------------------- column-major 4x4 helpers
function invert4(m) {
  const a = m, inv = new Array(16);
  inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
  inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
  inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
  inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
  inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
  inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
  inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
  inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
  inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
  inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
  inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
  inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
  inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
  inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
  inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
  inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
  const det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
  if (!det) return null;
  return inv.map((x) => x / det);
}
function mul4(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
/** Decompose a column-major affine matrix into translation / rotation quaternion (x,y,z,w) / scale. */
function decompose(m) {
  const t = [m[12], m[13], m[14]];
  let sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]);
  const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
  if (det < 0) sx = -sx;
  const r00 = m[0] / sx, r10 = m[1] / sx, r20 = m[2] / sx, r01 = m[4] / sy, r11 = m[5] / sy, r21 = m[6] / sy, r02 = m[8] / sz, r12 = m[9] / sz, r22 = m[10] / sz;
  let q;
  const tr = r00 + r11 + r22;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(r21 - r12) / s, (r02 - r20) / s, (r10 - r01) / s, 0.25 * s]; }
  else if (r00 > r11 && r00 > r22) { const s = Math.sqrt(1 + r00 - r11 - r22) * 2; q = [0.25 * s, (r01 + r10) / s, (r02 + r20) / s, (r21 - r12) / s]; }
  else if (r11 > r22) { const s = Math.sqrt(1 + r11 - r00 - r22) * 2; q = [(r01 + r10) / s, 0.25 * s, (r12 + r21) / s, (r02 - r20) / s]; }
  else { const s = Math.sqrt(1 + r22 - r00 - r11) * 2; q = [(r02 + r20) / s, (r12 + r21) / s, 0.25 * s, (r10 - r01) / s]; }
  return { t, r: q, s: [sx, sy, sz] };
}

const nearly = (a, b) => Math.abs(a - b) < 1e-6;
function trsOf(node) {
  const p = node._lpos, q = node._lrot, s = node._lscale;
  const out = {};
  if (p && (p.x || p.y || p.z)) out.translation = [p.x || 0, p.y || 0, p.z || 0];
  if (q && !(nearly(q.x || 0, 0) && nearly(q.y || 0, 0) && nearly(q.z || 0, 0) && nearly(q.w ?? 1, 1))) out.rotation = [q.x || 0, q.y || 0, q.z || 0, q.w ?? 1];
  if (s && !(nearly(s.x ?? 1, 1) && nearly(s.y ?? 1, 1) && nearly(s.z ?? 1, 1))) out.scale = [s.x ?? 1, s.y ?? 1, s.z ?? 1];
  return out;
}

/** Dynamic (CCON) documents: resolve {__id__} and TypedArrayRef into plain JS. */
function dynamicResolver(dyn) {
  const arr = Array.isArray(dyn.doc) ? dyn.doc : [dyn.doc];
  const chunk = dyn.chunks && dyn.chunks[0];
  const typed = (ref) => {
    const Ctor = { Float32Array, Float64Array, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array }[ref.ctor] || Float32Array;
    const bytes = new Uint8Array(chunk.subarray(ref.offset, ref.offset + ref.length * Ctor.BYTES_PER_ELEMENT));
    return new Ctor(bytes.buffer, 0, ref.length);
  };
  const get = (v) => {
    if (v && typeof v === 'object' && v.__id__ !== undefined) return arr[v.__id__];
    if (v && v.__type__ === 'TypedArrayRef') return typed(v);
    return v;
  };
  return { root: arr[0], get };
}

/**
 * Keys outside [0, duration] (split clips whose times were not rebased, negative times): resample the track
 * inside the clip range so it evaluates to the same values (linear, clamped at both ends; quats normalized).
 */
function resampleTrack(tr, n, duration) {
  const { times, values } = tr;
  const last = times.length - 1;
  const evalAt = (t) => {
    if (t <= times[0]) return Array.from(values.subarray(0, n));
    if (t >= times[last]) return Array.from(values.subarray(last * n, last * n + n));
    let i = 0;
    while (i < last && times[i + 1] <= t) i++;
    const f = (t - times[i]) / (times[i + 1] - times[i]);
    const out = [];
    let dot = 0;
    if (n === 4) for (let c = 0; c < 4; c++) dot += values[i * n + c] * values[(i + 1) * n + c];
    const sign = n === 4 && dot < 0 ? -1 : 1;
    for (let c = 0; c < n; c++) out.push(values[i * n + c] + (sign * values[(i + 1) * n + c] - values[i * n + c]) * f);
    if (n === 4) { const l = Math.hypot(...out) || 1; for (let c = 0; c < 4; c++) out[c] /= l; }
    return out;
  };
  const keyTimes = [0];
  for (const t of times) if (t > 1e-6 && t < duration - 1e-6) keyTimes.push(t);
  if (duration > 1e-6) keyTimes.push(duration);
  const vals = keyTimes.flatMap(evalAt);
  return { times: Float32Array.from(keyTimes), values: Float32Array.from(vals) };
}

function extractExotic(rec) {
  if (!rec.dynamic) return null;
  const { root, get } = dynamicResolver(rec.dynamic);
  const exo = get(root._exoticAnimation);
  if (!exo) return { clip: root, nodes: [] };
  const nodes = [];
  for (const nref of exo._nodeAnimations || []) {
    const na = get(nref);
    if (!na) continue;
    const tracks = {};
    for (const [key, gl] of [['_position', 'translation'], ['_rotation', 'rotation'], ['_scale', 'scale']]) {
      const tr = get(na[key]);
      if (!tr) continue;
      const vals = get(tr.values);
      if (vals && vals._isQuantized) throw new Error('track lượng tử hoá (quantized) chưa hỗ trợ');
      const times = get(tr.times), values = vals && get(vals._values);
      if (times && values && times.length) tracks[gl] = { times: Float32Array.from(times), values: Float32Array.from(values) };
    }
    nodes.push({ path: na._path || '', tracks });
  }
  return { clip: root, nodes };
}

class ModelExporter {
  constructor(exporter) {
    this.ex = exporter;
    this.db = exporter.db;
    this.writer = exporter.writer;
    this.planner = exporter.planner;
    this.report = exporter.report;
    this.stats = { models: 0, recoveredNames: 0, searchedNames: 0 };
  }

  // ------------------------------------------------------------ grouping
  collectGroups() {
    const groups = new Map();
    for (const r of this.db.records.values()) {
      if (!r.subId || !MODEL_TYPES.has(r.type) || this.db.isInternal(r.uuid)) continue;
      if (r.type === 'cc.Texture2D' && r.subId === '6c48a') continue;
      const baseRec = this.db.get(r.baseUuid);
      if (baseRec && baseRec.type === 'cc.ImageAsset') continue;
      let g = groups.get(r.baseUuid);
      if (!g) groups.set(r.baseUuid, g = { base: r.baseUuid, meshes: [], skeletons: [], materials: [], textures: [], images: [], clips: [], prefabs: [], all: [] });
      g.all.push(r);
      ({ 'cc.Mesh': g.meshes, 'cc.Skeleton': g.skeletons, 'cc.Material': g.materials, 'cc.Texture2D': g.textures, 'cc.ImageAsset': g.images, 'cc.AnimationClip': g.clips, 'cc.Prefab': g.prefabs })[r.type].push(r);
    }
    const sortById = (a, b) => (a.subId < b.subId ? -1 : 1);
    const out = [];
    for (const g of groups.values()) {
      if (!(g.meshes.length || g.skeletons.length || g.prefabs.length || g.clips.length || g.materials.length)) continue;
      for (const k of ['meshes', 'skeletons', 'materials', 'textures', 'images', 'clips', 'prefabs']) g[k].sort(sortById);
      out.push(g);
    }
    return out;
  }

  /** Every component in scenes/prefabs (outside the model itself) that references a uuid. */
  buildUsageIndex() {
    this.usage = new Map();          // uuid -> [{ comp, node }]
    this.instances = new Map();      // model prefab uuid -> instance root node (from scenes / user prefabs)
    const graphs = [];
    for (const s of this.db.ofType('cc.SceneAsset')) if (s.root && s.root.scene) graphs.push(s.root.scene);
    for (const p of this.db.ofType('cc.Prefab')) if (p.root && p.root.data) graphs.push(p.root.data);
    const seen = new Set();
    for (const g of graphs) {
      (function walk(n, self) {
        if (!n || seen.has(n)) return;
        seen.add(n);
        for (const c of n._components || []) {
          for (const key of ['_mesh', '_skeleton']) { const u = refUuid(c[key]); if (u) self.addUsage(u, c, n); }
          for (const m of c._materials || []) { const u = refUuid(m); if (u) self.addUsage(u, c, n); }
          for (const m of c._clips || []) { const u = refUuid(m); if (u) self.addUsage(u, c, n); }
        }
        const info = n._prefab;
        const asset = info && refUuid(info.asset);
        if (asset && asset.includes('@') && !self.instances.has(asset) && (!info.root || info.root === n)) self.instances.set(asset, n);
        for (const ch of n._children || []) walk(ch, self);
      })(g, this);
    }
  }
  addUsage(uuid, comp, node) { (this.usage.get(uuid) || this.usage.set(uuid, []).get(uuid)).push({ comp, node }); }

  // ------------------------------------------------------------ run
  run() {
    const groups = this.collectGroups();
    if (!groups.length) return this.stats;
    this.buildUsageIndex();
    for (const g of groups) {
      try { this.exportModel(g); }
      catch (e) { this.report.warn(`Model ${g.base}: không dựng lại được file .glb (${e.message}) — dữ liệu thô lưu ở _recovered/raw/.`); }
    }
    if (this.stats.models) {
      this.report.note(`Dựng lại ${this.stats.models} file model 3D (.glb) giữ nguyên id của mesh/material/skeleton/animation/prefab; ${this.stats.recoveredNames} tên sub-asset khôi phục đúng tên gốc, ${this.stats.searchedNames} tên được sinh tự động để khớp id.`);
    }
    return this.stats;
  }

  // ------------------------------------------------------------ one model
  exportModel(g) {
    const gltf = new GlbBuilder();
    const B = g.base;
    const warnings = new Set();

    // ---- hierarchy source: model prefab in the build > an instance in a scene > synthesized
    let prefabRec = g.prefabs[0] || null;
    let rootNode = prefabRec && prefabRec.root && prefabRec.root.data;
    let prefabUuid = prefabRec ? prefabRec.uuid : null;
    if (!rootNode) {
      for (const [asset, inst] of this.instances) if (asset.startsWith(B + '@')) { rootNode = inst; prefabUuid = asset; break; }
    }
    const fromInstance = rootNode && !prefabRec;

    // ---- file name / location
    const pathHint = g.all.map((r) => r.pathInfo && r.pathInfo.path).find((p) => p && !p.startsWith('db:/'));
    let fileBase = pathHint ? path.posix.basename(path.posix.dirname(pathHint)) : null;
    const clipName = g.clips.map((c) => (c.dynamic ? dynamicResolver(c.dynamic).root._name : c.root && c.root._name)).find(Boolean);
    const usedBy = g.meshes.map((m) => (this.usage.get(m.uuid) || [])[0]).find(Boolean);
    if (!fileBase) fileBase = (rootNode && rootNode._name) || clipName || (usedBy && usedBy.node._name) || `Model_${B.slice(0, 8)}`;
    let rel;
    if (pathHint) {
      const rec = g.all.find((r) => r.pathInfo && r.pathInfo.path === pathHint);
      rel = this.writer.claimExact(`${this.planner.bundleRoot(rec)}/${path.posix.dirname(pathHint)}.glb`);
    } else {
      rel = this.planner.place(g.all[0], fileBase, '.glb', 'Models', { useOwner: true });
    }
    fileBase = path.posix.basename(rel, '.glb');

    // ---- nodes
    const nodes = [];                 // { name, trs, children: [], src (build node), mesh, skin }
    const nodeByPath = new Map();     // path from the prefab root -> node index
    const addNode = (name, trs, src) => { nodes.push({ name, trs: trs || {}, children: [], src }); return nodes.length - 1; };
    const sceneRoots = [];
    let promote = false;
    const rootRenderers = rootNode ? (rootNode._components || []).filter((c) => RENDERERS.has(c.__type__)) : [];
    if (rootNode) {
      // an instance root carries the placement of the instance, not the model's own transform
      const rootTrs = fromInstance ? {} : trsOf(rootNode);
      promote = rootRenderers.length > 0 || Object.keys(rootTrs).length > 0;
      const belongs = (n) => !fromInstance || !n._prefab || !n._prefab.root || n._prefab.root === rootNode;
      const walk = (n, parentIdx, parentPath) => {
        const idx = addNode(n._name || 'Node', n === rootNode ? rootTrs : trsOf(n), n);
        const p = parentPath === null ? '' : parentPath ? `${parentPath}/${n._name}` : n._name;
        if (parentPath !== null) nodeByPath.set(p, idx);
        if (parentIdx >= 0) nodes[parentIdx].children.push(idx);
        for (const ch of n._children || []) if (belongs(ch)) walk(ch, idx, p);
        return idx;
      };
      if (promote) {
        sceneRoots.push(walk(rootNode, -1, null));
        nodeByPath.set('', sceneRoots[0]);
      } else {
        for (const ch of rootNode._children || []) if (belongs(ch)) sceneRoots.push(walk(ch, -1, ''));
      }
    }
    // SkeletalAnimation sockets: the importer moved non-joint children of a joint into a root node "<joint> Socket".
    // Put those children back under their joint so the importer rebuilds the socket exactly as before.
    const socketNodes = new Set();
    const socketPaths = new Set();
    const rootAnimComp = rootNode && (rootNode._components || []).find((c) => ANIM_COMPS.has(c.__type__));
    for (const sock of (rootAnimComp && rootAnimComp._sockets) || []) {
      const target = sock && sock.target;
      const sIdx = nodes.findIndex((n) => n.src === target);
      const jIdx = sock && nodeByPath.get(sock.path);
      if (sIdx < 0 || jIdx === undefined) continue;
      nodes[jIdx].children.push(...nodes[sIdx].children);
      nodes[sIdx].children = [];
      socketNodes.add(sIdx);
      for (const [p, i] of nodeByPath) if (i === sIdx) socketPaths.add(p);
      const ri = sceneRoots.indexOf(sIdx);
      if (ri >= 0) sceneRoots.splice(ri, 1);
      for (const n of nodes) { const ci = n.children.indexOf(sIdx); if (ci >= 0) n.children.splice(ci, 1); }
    }
    const ensurePath = (p) => {
      if (nodeByPath.has(p)) return nodeByPath.get(p);
      const parts = p.split('/');
      let cur = '', parent = -1;
      for (const part of parts) {
        cur = cur ? `${cur}/${part}` : part;
        let idx = nodeByPath.get(cur);
        if (idx === undefined) {
          idx = addNode(part, {}, null);
          nodeByPath.set(cur, idx);
          if (parent >= 0) nodes[parent].children.push(idx); else sceneRoots.push(idx);
        }
        parent = idx;
      }
      return parent;
    };

    // ---- names (original when we can find them, otherwise searched so the id still matches)
    const names = this.solveNames(g, rootNode, fileBase);

    // ---- images & textures
    const imageIndex = new Map();     // image uuid -> glTF image index
    const imageMetas = [];
    const imageSubs = [];             // { index, id, name, rec, hasAlpha }
    const addImage = (rec, name, bytes, mime, remap) => {
      const iv = gltf.addView(bytes);
      const idx = gltf.add('images', { name, mimeType: mime, bufferView: iv });
      const id = nameToId(name + EXT.image);
      imageMetas.push(Object.assign({ name, uri: `${B}@${id}` }, remap ? { remap } : {}));
      let hasAlpha = mime === 'image/png';
      if (isPNG(bytes)) { try { hasAlpha = decodePNG(bytes).hasAlpha; } catch { /* keep */ } }
      imageSubs.push({ index: idx, id, name, rec, hasAlpha });
      return idx;
    };
    const embeddedImage = (rec) => {
      if (imageIndex.has(rec.uuid)) return imageIndex.get(rec.uuid);
      const nat = this.ex.nativeOf(rec, ['.png', '.jpg', '.jpeg', '.webp']);
      const buf = nat && this.ex.anyBundleFile(nat.key);
      let bytes = buf, mime = nat && (nat.ext === '.png' ? 'image/png' : nat.ext === '.webp' ? 'image/webp' : 'image/jpeg');
      if (!buf || (mime === 'image/webp')) {
        this.report.warn(`Model ${fileBase}: ảnh nhúng ${rec.uuid} không có file PNG/JPG trong build — thay bằng ảnh trống 1x1.`);
        bytes = PLACEHOLDER_PNG(); mime = 'image/png';
      }
      const idx = addImage(rec, names.get(rec.uuid), bytes, mime, null);
      imageIndex.set(rec.uuid, idx);
      return idx;
    };
    const samplerIndex = new Map();
    const textureIndex = new Map();   // texture uuid -> glTF texture index
    const textureSubs = [];
    for (const t of g.textures) {
      const c = (t.root && t.root.__custom__) || {};
      const tb = String(c.base || '2,2,0,0,0,0').split(',').map(Number);
      const sampler = { minfilter: FILTER[tb[0]] || 'linear', magfilter: FILTER[tb[1]] || 'linear', wrapModeS: WRAP[tb[2]] || 'repeat', wrapModeT: WRAP[tb[3]] || 'repeat', mipfilter: FILTER[tb[4]] || 'none', anisotropy: tb[5] || 0 };
      let imgUuid = (c.mipmaps || [])[0];
      if (imgUuid && !imgUuid.includes('-')) imgUuid = decompressUuid(imgUuid);
      let source, imageUuidOrDatabaseUri;
      const imgRec = imgUuid && this.db.get(imgUuid);
      if (imgRec && imgRec.baseUuid === B) {
        source = embeddedImage(imgRec);
        imageUuidOrDatabaseUri = `${B}@${imageSubs.find((s) => s.index === source).id}`;
      } else if (imgUuid && imgUuid.startsWith(B + '@')) {
        // embedded image missing from the build: keep its id with an empty image
        const iname = names.get(imgUuid) || solveName(imgUuid.split('@')[1], EXT.image, [], names.get(t.uuid) + '_image').name;
        source = addImage(null, iname, PLACEHOLDER_PNG(), 'image/png', null);
        imageUuidOrDatabaseUri = imgUuid;
        this.report.warn(`Model ${fileBase}: ảnh nhúng ${imgUuid} không có trong build — thay bằng ảnh trống 1x1.`);
      } else {
        // the original project remapped this texture to an image asset of the project
        const pname = names.get(t.uuid) + '_image';
        source = addImage(null, pname, PLACEHOLDER_PNG(), 'image/png', imgUuid || undefined);
        imageUuidOrDatabaseUri = imgUuid || `${B}@${imageSubs.find((s) => s.index === source).id}`;
      }
      const skey = JSON.stringify(sampler);
      if (!samplerIndex.has(skey)) {
        const s = { magFilter: GL_FILTER[sampler.magfilter] || 9729, minFilter: GL_MIN_FILTER[`${sampler.minfilter === 'nearest' ? 'nearest' : 'linear'}:${sampler.mipfilter}`] || 9729, wrapS: GL_WRAP[sampler.wrapModeS], wrapT: GL_WRAP[sampler.wrapModeT] };
        samplerIndex.set(skey, gltf.add('samplers', s));
      }
      const idx = gltf.add('textures', { name: names.get(t.uuid), sampler: samplerIndex.get(skey), source });
      textureIndex.set(t.uuid, idx);
      textureSubs.push({ index: idx, rec: t, userData: { ...sampler, premultiplyAlpha: false, isUuid: true, imageUuidOrDatabaseUri } });
    }
    for (const im of g.images) embeddedImage(im);    // embedded images no texture of the build refers to

    // ---- materials (real data goes to userData.materials)
    const materialIndex = new Map();
    const materialsUD = {};
    for (const m of g.materials) {
      const json = m.dynamic ? require('./editorjson').convertDynamicDoc(m.dynamic.doc, m.dynamic.chunks, { typeOf: this.ex.typeOf }).json : toEditorJSON(m.root, { kind: 'asset', typeOf: this.ex.typeOf });
      const mj = normalizeMaterialJSON(Array.isArray(json) ? json[0] : json);
      if (Array.isArray(json) && json.length > 1) warnings.add(`material ${m.uuid} tham chiếu object lồng — có thể thiếu dữ liệu`);
      materialsUD[m.uuid] = mj;
      const props = (m.root && m.root._props && m.root._props[0]) || {};
      const mat = { name: names.get(m.uuid), pbrMetallicRoughness: { metallicFactor: 0 } };
      const col = props.mainColor || props.albedo;
      if (col && typeof col === 'object') mat.pbrMetallicRoughness.baseColorFactor = [(col.r ?? 255) / 255, (col.g ?? 255) / 255, (col.b ?? 255) / 255, (col.a ?? 255) / 255];
      const tex = refUuid(props.mainTexture || props.albedoMap);
      if (tex && textureIndex.has(tex)) mat.pbrMetallicRoughness.baseColorTexture = { index: textureIndex.get(tex) };
      materialIndex.set(m.uuid, gltf.add('materials', mat));
    }

    // ---- meshes
    const meshIndex = new Map();
    const meshSubs = [];
    const skinOfMesh = new Map();     // mesh uuid -> skeleton uuid (from renderers)
    const materialsOfMesh = new Map();
    const rendererNodes = new Map();  // mesh uuid -> [node idx]
    for (let i = 0; i < nodes.length; i++) {
      const src = nodes[i].src;
      if (!src) continue;
      for (const c of src._components || []) {
        if (!RENDERERS.has(c.__type__)) continue;
        const mu = refUuid(c._mesh);
        if (!mu || !mu.startsWith(B + '@')) continue;
        (rendererNodes.get(mu) || rendererNodes.set(mu, []).get(mu)).push(i);
        if (c._skeleton && refUuid(c._skeleton)) skinOfMesh.set(mu, refUuid(c._skeleton));
        if (!materialsOfMesh.has(mu)) materialsOfMesh.set(mu, (c._materials || []).map(refUuid));
      }
    }
    for (const m of g.meshes) {
      if (!skinOfMesh.has(m.uuid) || !materialsOfMesh.has(m.uuid)) {
        for (const u of this.usage.get(m.uuid) || []) {
          if (!skinOfMesh.has(m.uuid) && refUuid(u.comp._skeleton)) skinOfMesh.set(m.uuid, refUuid(u.comp._skeleton));
          if (!materialsOfMesh.has(m.uuid) && u.comp._materials) materialsOfMesh.set(m.uuid, u.comp._materials.map(refUuid));
        }
      }
    }
    for (const m of g.meshes) {
      const nat = this.ex.nativeOf(m, ['.bin']);
      const bin = nat && this.ex.anyBundleFile(nat.key);
      const st = m.root && m.root._struct;
      if (!bin || !st) { this.report.warn(`Model ${fileBase}: mesh ${m.uuid} không có dữ liệu đỉnh (.bin).`); continue; }
      if (st.morph) warnings.add('morph target (blend shape) chưa được xuất');
      const skelUuid = skinOfMesh.get(m.uuid) || (g.skeletons.length === 1 ? g.skeletons[0].uuid : null);
      const bundles = (st.vertexBundles || []).map((b) => readBundle(bin, b));
      const mats = materialsOfMesh.get(m.uuid) || [];
      const prims = [];
      const cache = new Map();
      let triangles = 0;
      (st.primitives || []).forEach((p, pi) => {
        const jm = p.jointMapIndex !== undefined && st.jointMaps ? st.jointMaps[p.jointMapIndex] : null;
        const key = (p.vertexBundelIndices || []).join(',') + '|' + (jm ? p.jointMapIndex : '');
        let attributes = cache.get(key);
        if (!attributes) {
          attributes = {};
          for (const bi of p.vertexBundelIndices || []) {
            for (const a of bundles[bi] || []) {
              const sem = semanticOf(a.name);
              if (!sem) { warnings.add(`thuộc tính đỉnh ${a.name} không có trong glTF — bỏ qua`); continue; }
              if ((sem.startsWith('JOINTS') || sem.startsWith('WEIGHTS')) && !skelUuid) { warnings.add('mesh có dữ liệu skin nhưng build không còn skeleton — bỏ joints/weights'); continue; }
              let data = a.data, comp = a.comp, norm = a.norm;
              if (sem.startsWith('JOINTS')) {
                const g16 = new Uint16Array(data.length);
                for (let k = 0; k < data.length; k++) g16[k] = jm ? jm[data[k]] ?? 0 : data[k];
                data = g16; comp = 'u16'; norm = false;
              } else if (sem === 'POSITION' || sem === 'NORMAL' || sem === 'TANGENT' || (comp !== 'f32' && !(norm && (comp === 'u8' || comp === 'u16')))) {
                if (comp !== 'f32') {
                  const f = new Float32Array(data.length);
                  const div = norm ? { u8: 255, i8: 127, u16: 65535, i16: 32767 }[comp] || 1 : 1;
                  for (let k = 0; k < data.length; k++) f[k] = norm ? Math.max(data[k] / div, -1) : data[k];
                  data = f; comp = 'f32'; norm = false;
                }
              }
              attributes[sem] = gltf.addAccessor(data, comp, TYPE_OF_N[a.n], { normalized: norm, minMax: sem === 'POSITION', target: 34962 });
            }
          }
          cache.set(key, attributes);
        }
        const prim = { attributes, mode: GLTF_MODE[p.primitiveMode] ?? 4 };
        if (p.indexView) {
          const idx = readIndices(bin, p.indexView);
          prim.indices = gltf.addAccessor(idx, idx instanceof Uint32Array ? 'u32' : idx instanceof Uint8Array ? 'u8' : 'u16', 'SCALAR', { target: 34963 });
          triangles += Math.floor(idx.length / 3);
        } else {
          const pos = attributes.POSITION !== undefined ? gltf.json.accessors[attributes.POSITION].count : 0;
          triangles += Math.floor(pos / 3);
        }
        const matUuid = mats[pi] !== undefined ? mats[pi] : mats[mats.length - 1];
        if (matUuid && materialIndex.has(matUuid)) prim.material = materialIndex.get(matUuid);
        prims.push(prim);
      });
      if (!prims.length) continue;
      const idx = gltf.add('meshes', { name: names.get(m.uuid), primitives: prims });
      meshIndex.set(m.uuid, idx);
      meshSubs.push({ index: idx, rec: m, triangleCount: triangles, skeleton: skelUuid });
    }

    // ---- skins
    const skinIndex = new Map();
    const skinSubs = [];
    for (const s of g.skeletons) {
      const sk = s.root || {};
      const jointPaths = sk._joints || [];
      const binds = (sk._bindposes || []).map(mat4Array);
      let synthesized = false;
      const joints = jointPaths.map((p) => { if (!nodeByPath.has(p)) synthesized = true; return ensurePath(p); });
      if (synthesized && binds.length === joints.length) {
        // joints missing from the hierarchy: place them at their bind pose
        const world = binds.map((b) => invert4(b) || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        jointPaths.forEach((p, i) => {
          const node = nodes[joints[i]];
          if (node.src) return;
          const parentPath = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : null;
          const pi = parentPath !== null ? jointPaths.indexOf(parentPath) : -1;
          const local = pi >= 0 ? mul4(invert4(world[pi]) || world[pi], world[i]) : world[i];
          const d = decompose(local);
          node.trs = { translation: d.t, rotation: d.r, scale: d.s };
        });
      }
      const skin = { name: names.get(s.uuid), joints };
      if (binds.length === joints.length && binds.length) skin.inverseBindMatrices = gltf.addAccessor(Float32Array.from(binds.flat()), 'f32', 'MAT4');
      const idx = gltf.add('skins', skin);
      skinIndex.set(s.uuid, idx);
      skinSubs.push({ index: idx, rec: s, jointsLength: joints.length });
    }

    // ---- attach meshes / skins to nodes
    for (const ms of meshSubs) {
      let targets = rendererNodes.get(ms.rec.uuid);
      if (!targets || !targets.length) {
        const n = addNode(names.get(ms.rec.uuid), {}, null);
        sceneRoots.push(n);
        targets = [n];
      }
      for (const n of targets) {
        nodes[n].mesh = ms.index;
        const hasJoints = gltf.json.meshes[ms.index].primitives.some((p) => p.attributes.JOINTS_0 !== undefined);
        if (hasJoints && ms.skeleton && skinIndex.has(ms.skeleton)) nodes[n].skin = skinIndex.get(ms.skeleton);
      }
    }

    // ---- animations (exotic node animations -> glTF channels)
    const animSubs = [];
    const animSettings = [];
    const rootAnim = rootNode && (rootNode._components || []).find((c) => ANIM_COMPS.has(c.__type__));
    const rootClips = rootAnim ? (rootAnim._clips || []).map(refUuid).filter(Boolean) : [];
    const clipOrder = [...g.clips].sort((a, b) => {
      const ia = rootClips.indexOf(a.uuid), ib = rootClips.indexOf(b.uuid);
      return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || (a.subId < b.subId ? -1 : 1);
    });
    for (const c of clipOrder) {
      let exo;
      try { exo = extractExotic(c); } catch (e) { this.report.warn(`Model ${fileBase}: animation ${c.uuid} — ${e.message}.`); continue; }
      if (!exo) { this.report.warn(`Model ${fileBase}: animation ${c.uuid} không phải dạng animation của model — bỏ qua.`); continue; }
      const clip = exo.clip;
      if (clip._tracks && clip._tracks.length) warnings.add(`animation "${clip._name}" có ${clip._tracks.length} track thêm ngoài model — chưa xuất`);
      const duration = clip._duration || 0;
      const channels = [], samplers = [];
      let maxT = 0;
      const addChannel = (nodeIdx, gl, times, values) => {
        const input = gltf.addAccessor(times, 'f32', 'SCALAR', { minMax: true });
        const output = gltf.addAccessor(values, 'f32', gl === 'rotation' ? 'VEC4' : 'VEC3');
        samplers.push({ input, output, interpolation: 'LINEAR' });
        channels.push({ sampler: samplers.length - 1, target: { node: nodeIdx, path: gl } });
      };
      const pending = [];
      for (const na of exo.nodes) {
        if ([...socketPaths].some((sp) => na.path === sp || na.path.startsWith(sp + '/'))) continue;   // socket nodes are rebuilt by the importer
        const nodeIdx = na.path === '' && !promote ? -1 : nodeByPath.has(na.path) ? nodeByPath.get(na.path) : ensurePath(na.path);
        if (nodeIdx < 0) { warnings.add('animation của node gốc không biểu diễn được trong glTF — bỏ qua'); continue; }
        for (const [gl, tr0] of Object.entries(na.tracks)) {
          const outside = tr0.times[0] < -1e-6 || tr0.times[tr0.times.length - 1] > duration + 1e-4;
          const tr = outside ? resampleTrack(tr0, gl === 'rotation' ? 4 : 3, duration) : tr0;
          pending.push({ nodeIdx, gl, tr });
          maxT = Math.max(maxT, tr.times[tr.times.length - 1]);
        }
      }
      // keep the clip length: glTF animations end at their last key
      if (pending.length && duration > maxT + 1e-4) {
        const p = pending[0], n = p.gl === 'rotation' ? 4 : 3;
        const t2 = new Float32Array(p.tr.times.length + 1); t2.set(p.tr.times); t2[t2.length - 1] = duration;
        const v2 = new Float32Array(p.tr.values.length + n); v2.set(p.tr.values); v2.set(p.tr.values.subarray(p.tr.values.length - n), p.tr.values.length);
        p.tr = { times: t2, values: v2 };
      }
      for (const p of pending) addChannel(p.nodeIdx, p.gl, p.tr.times, p.tr.values);
      if (!channels.length) { this.report.warn(`Model ${fileBase}: animation "${clip._name}" không có track nào dựng lại được.`); continue; }
      const name = names.get(c.uuid);
      const idx = gltf.add('animations', { name, channels, samplers });
      const events = (clip._events || []).map((e) => ({ frame: e.frame, func: e.func, params: e.params || [] }));
      const split = { name, from: 0, to: duration, wrapMode: clip.wrapMode ?? 2, previousId: c.subId };
      if (clip.speed !== undefined && clip.speed !== 1) split.speed = clip.speed;
      if (clip.sample) split.fps = clip.sample;
      animSettings.push({ name, duration, fps: clip.sample || 30, splits: [split] });
      animSubs.push({ index: idx, rec: c, userData: { gltfIndex: idx, wrapMode: split.wrapMode, sample: clip.sample || 30, span: { from: 0, to: duration }, events, ...(split.speed ? { speed: split.speed } : {}) } });
    }

    // ---- scene (socket nodes dropped: node indices are remapped)
    const remap = new Map();
    nodes.forEach((n, i) => { if (!socketNodes.has(i)) remap.set(i, remap.size); });
    const gNodes = nodes.filter((n, i) => !socketNodes.has(i)).map((n) => {
      const o = { name: n.name, ...n.trs };
      if (n.children.length) o.children = n.children.map((c) => remap.get(c));
      if (n.mesh !== undefined) o.mesh = n.mesh;
      if (n.skin !== undefined) o.skin = n.skin;
      return o;
    });
    for (const s of gltf.json.skins || []) s.joints = s.joints.map((j) => remap.get(j));
    for (const a of gltf.json.animations || []) for (const c of a.channels) c.target.node = remap.get(c.target.node);
    gltf.json.nodes = gNodes;
    gltf.json.scenes = [{ name: fileBase, nodes: sceneRoots.map((i) => remap.get(i)) }];
    gltf.json.scene = 0;
    if (!gNodes.length) gltf.json.nodes = [];
    this.writer.write(rel, gltf.toBuffer());

    // ---- meta: sub-metas with the ids the importer will derive + the data it cannot read from glTF
    const subMetas = {};
    const addSub = (importer, id, name, userData, files) => { subMetas[id] = subMeta(importer, `${B}@${id}`, id, name, '', userData, files); };
    for (const ms of meshSubs) addSub('gltf-mesh', ms.rec.subId, names.get(ms.rec.uuid) + EXT.mesh, { gltfIndex: ms.index, triangleCount: ms.triangleCount }, ['.bin', '.json']);
    for (const im of imageSubs) addSub('gltf-embeded-image', im.id, im.name + EXT.image, { gltfIndex: im.index, fixAlphaTransparencyArtifacts: false, hasAlpha: im.hasAlpha, type: 'texture' }, ['.json', '.png']);
    for (const ts of textureSubs) addSub('texture', ts.rec.subId, names.get(ts.rec.uuid) + EXT.texture, ts.userData);
    g.materials.forEach((m) => addSub('gltf-material', m.subId, names.get(m.uuid) + EXT.material, { gltfIndex: materialIndex.get(m.uuid) }));
    for (const ss of skinSubs) addSub('gltf-skeleton', ss.rec.subId, names.get(ss.rec.uuid) + EXT.skeleton, { gltfIndex: ss.index, jointsLength: ss.jointsLength });
    for (const as of animSubs) addSub('gltf-animation', as.rec.subId, names.get(as.rec.uuid) + EXT.clip, as.userData);
    const prefabId = prefabUuid ? prefabUuid.split('@')[1] : nameToId(fileBase + EXT.prefab);
    addSub('gltf-scene', prefabId, fileBase + EXT.prefab, { gltfIndex: 0 });

    const byIndex = (list, n) => { const a = new Array(n); for (const x of list) a[x.index] = `${B}@${x.rec.subId}`; return [...a].filter(Boolean); };
    const userData = {
      imageMetas,
      // 2 = "require": keeps the normals/tangents stored in the glb (verified byte-identical after import)
      normals: 2, tangents: 2,
      promoteSingleRootNode: promote,
      mountAllAnimationsOnPrefab: rootClips.length > 1,
      meshOptimize: { enable: false },
      lods: { enable: false, hasBuiltinLOD: false, options: [{ screenRatio: 0.25, faceCount: 1 }, { screenRatio: 0.125, faceCount: 0.25 }, { screenRatio: 0.01, faceCount: 0.1 }] },
      assetFinder: {
        meshes: byIndex(meshSubs, (gltf.json.meshes || []).length), skeletons: byIndex(skinSubs, (gltf.json.skins || []).length),
        textures: byIndex(textureSubs, (gltf.json.textures || []).length), materials: g.materials.map((m) => m.uuid), scenes: [`${B}@${prefabId}`],
      },
    };
    if (animSettings.length) userData.animationImportSettings = animSettings;
    if (Object.keys(materialsUD).length) userData.materials = materialsUD;
    this.writer.writeMeta(rel, meta('gltf', B, { files: [], subMetas, userData }));

    for (const r of g.all) this.ex.done.add(r.uuid);
    if (prefabUuid) this.ex.done.add(prefabUuid);
    for (const w of warnings) this.report.warn(`Model ${fileBase}: ${w}.`);
    if (fromInstance) this.report.note(`Model ${fileBase}: cây node dựng lại từ instance trong scene (prefab của model không có trong build).`);
    else if (!rootNode) this.report.note(`Model ${fileBase}: build không có prefab của model — mỗi mesh thành một node riêng.`);
    this.stats.models++;
    this.ex.count('models');
    return rel;
  }

  // ------------------------------------------------------------ naming
  solveNames(g, rootNode, fileBase) {
    const names = new Map();
    const usedPerType = {};
    const solve = (rec, ext, candidates, hint) => {
      const taken = usedPerType[ext] || (usedPerType[ext] = new Set());
      const pathName = rec.pathInfo && rec.pathInfo.path && !rec.pathInfo.path.startsWith('db:/') ? path.posix.basename(rec.pathInfo.path) : null;
      const res = solveName(rec.subId, ext, [pathName, ...candidates], hint || fileBase, taken);
      if (!res.name) throw new Error(`không tìm được tên cho sub-asset ${rec.uuid}`);
      taken.add(res.name);
      names.set(rec.uuid, res.name);
      if (res.recovered) this.stats.recoveredNames++; else this.stats.searchedNames++;
      return res;
    };
    const variants = (list, n) => {
      const out = [];
      for (const x of list) {
        if (!x) continue;
        out.push(x);
        for (let i = 0; i < Math.max(n, 4); i++) out.push(`${x}-${i}`);
      }
      return out;
    };
    // node names that render a mesh (model prefab + scenes)
    const nodeNamesOf = (uuid) => {
      const set = [];
      if (rootNode) {
        const seen = new Set();
        (function walk(n) {
          if (!n || seen.has(n)) return; seen.add(n);
          for (const c of n._components || []) if (refUuid(c._mesh) === uuid) set.push(n._name);
          (n._children || []).forEach(walk);
        })(rootNode);
      }
      for (const u of this.usage.get(uuid) || []) set.push(u.node._name);
      return [...new Set(set)];
    };
    for (const m of g.meshes) {
      const nn = nodeNamesOf(m.uuid);
      solve(m, EXT.mesh, variants([...nn, ...nn.map((x) => `${x}_Material0`), fileBase, 'UnnamedMesh'], g.meshes.length), nn[0] || fileBase);
    }
    for (const m of g.materials) {
      const n = m.root && m.root._name;
      solve(m, EXT.material, variants([n, 'UnnamedMaterial', 'lambert1', 'Material', 'Material.001', 'DefaultMaterial'], g.materials.length), n || 'Material');
    }
    for (const s of g.skeletons) {
      const n = (s.root && s.root._name) || '';
      const k = (n.match(/^Skin-(\d+)$/) || [])[1];
      solve(s, EXT.skeleton, [k !== undefined ? `UnnamedSkeleton-${k}` : null, 'UnnamedSkeleton', ...variants([n, 'UnnamedSkeleton'], 32)], 'Skeleton');
    }
    for (const c of g.clips) {
      const clip = c.dynamic ? dynamicResolver(c.dynamic).root : c.root;
      const n = clip && clip._name;
      solve(c, EXT.clip, variants([n], g.clips.length), n || 'Animation');
    }
    // images and textures usually share their name ("Palette.png" image + texture)
    const texOfImage = new Map();
    for (const t of g.textures) {
      let im = ((t.root && t.root.__custom__) || {}).mipmaps;
      im = im && im[0] && (im[0].includes('-') ? im[0] : decompressUuid(im[0]));
      if (im) texOfImage.set(im, t);
    }
    const imgCands = ['UnnamedImage', 'image', 'texture', 'base_color_texture', 'Palette.png', fileBase];
    for (const im of g.images) {
      const t = texOfImage.get(im.uuid);
      const tPath = t && t.pathInfo && t.pathInfo.path ? path.posix.basename(t.pathInfo.path) : null;
      solve(im, EXT.image, variants([tPath, ...imgCands], g.images.length), fileBase + '_tex');
    }
    for (const t of g.textures) {
      let im = ((t.root && t.root.__custom__) || {}).mipmaps;
      im = im && im[0] && (im[0].includes('-') ? im[0] : decompressUuid(im[0]));
      solve(t, EXT.texture, variants([names.get(im), 'UnnamedTexture', ...imgCands], g.textures.length), names.get(im) || fileBase + '_tex');
    }
    return names;
  }
}

module.exports = { ModelExporter, readBundle, extractExotic, dynamicResolver, nameToId };
