'use strict';
// Convert decoded build data into the editor's JSON format ([{__type__, ...}, ...] with {__id__} refs).
const { VALUE_TYPES } = require('../decode/deserialize');
const { decompressUuid, stableId } = require('../util/uuid');

const NODE_KEYS = ['_name', '_objFlags', '__editorExtras__', '_parent', '_children', '_active', '_components', '_prefab',
  '_lpos', '_lrot', '_lscale', '_mobility', '_layer', '_euler'];
const nodeDefaults = () => ({
  _name: '', _objFlags: 0, __editorExtras__: {}, _parent: null, _children: [], _active: true, _components: [], _prefab: null,
  _lpos: { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 }, _lrot: { __type__: 'cc.Quat', x: 0, y: 0, z: 0, w: 1 },
  _lscale: { __type__: 'cc.Vec3', x: 1, y: 1, z: 1 }, _mobility: 0, _layer: 1073741824,
  _euler: { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 },
});
const isNode = (o) => o && (o.__type__ === 'cc.Node' || o.__type__ === 'cc.Scene');
const isComponent = (o) => o && o.node && isNode(o.node) && !isNode(o);

function nodePath(n) {
  const parts = [];
  let guard = 0;
  while (n && n.__type__ !== 'cc.Scene' && guard++ < 1000) {
    const siblings = n._parent && n._parent._children ? n._parent._children : [];
    const idx = siblings.indexOf(n);
    parts.unshift(`${n._name}#${idx}`);
    n = n._parent;
  }
  return parts.join('/');
}

function walkNodes(root, fn) {
  const seen = new Set();
  (function rec(n) {
    if (!n || seen.has(n)) return;
    seen.add(n);
    fn(n);
    for (const c of n._children || []) rec(c);
  })(root);
}

/**
 * Prepare a decoded prefab graph so every node has a PrefabInfo and every component a CompPrefabInfo,
 * with the prefab root/asset links the editor expects.
 */
function preparePrefab(prefabAsset, prefabUuid) {
  const rootNode = prefabAsset.data;
  if (!rootNode) return;
  walkNodes(rootNode, (node) => {
    const path = nodePath(node);
    let info = node._prefab;
    if (!info || info.__type__ !== 'cc.PrefabInfo') {
      info = { __type__: 'cc.PrefabInfo' };
      node._prefab = info;
    }
    // nodes inside a nested prefab instance keep their own root; plain nodes belong to this prefab
    const nested = info.asset && info.asset.__uuid__ && info.asset.__uuid__ !== prefabUuid;
    if (!nested) {
      info.root = rootNode;
      info.asset = prefabAsset;
    }
    if (!info.fileId) info.fileId = stableId(`${prefabUuid}:node:${path}`);
    if (!('instance' in info)) info.instance = null;
    if (!('targetOverrides' in info)) info.targetOverrides = null;
    (node._components || []).forEach((c, i) => {
      if (!c.__prefab || c.__prefab.__type__ !== 'cc.CompPrefabInfo') c.__prefab = { __type__: 'cc.CompPrefabInfo', fileId: stableId(`${prefabUuid}:comp:${path}:${c.__type__}:${i}`) };
      else if (!c.__prefab.fileId) c.__prefab.fileId = stableId(`${prefabUuid}:comp:${path}:${c.__type__}:${i}`);
    });
  });
}

/**
 * Builds drop default values; the 3.8 material importer/upgrader needs a numeric _techIdx
 * (it reads effect.techniques[_techIdx].passes), and old editors sometimes saved it as a string.
 */
function normalizeMaterialJSON(o) {
  if (!o || o.__type__ !== 'cc.Material') return o;
  const n = Number(o._techIdx);
  o._techIdx = Number.isFinite(n) ? n : 0;
  return o;
}

/**
 * Scenes in builds keep no usable link to prefab assets, so baked prefab instances become plain nodes.
 * Returns the number of links removed.
 */
function unlinkScenePrefabs(scene) {
  let n = 0;
  walkNodes(scene, (node) => {
    if (node === scene) return;
    if (node._prefab) { node._prefab = null; n++; }
    for (const c of node._components || []) if (c.__prefab) c.__prefab = null;
  });
  return n;
}

/**
 * Serialize a decoded object graph to editor JSON.
 * opts.kind: 'scene' | 'prefab' | 'asset'; opts.typeOf(uuid) -> expected type; opts.sceneUuid for scene _id
 */
function toEditorJSON(root, opts) {
  const out = [];
  const ids = new Map();
  const usedIds = new Set();
  const kind = opts.kind || 'asset';
  const uniqueId = (seed) => {
    let id = stableId(seed), k = 0;
    while (usedIds.has(id)) id = stableId(seed + '#' + ++k);
    usedIds.add(id);
    return id;
  };
  const conv = (v) => {
    if (v === null || v === undefined || typeof v !== 'object') return v === undefined ? null : v;
    if (Array.isArray(v)) return v.map(conv);
    if (v.__uuid__) return { __uuid__: v.__uuid__, __expectedType__: opts.typeOf(v.__uuid__) };
    if (v.__trs__) return v.__trs__;
    if (v.__type__ && VALUE_TYPES.has(v.__type__)) return { ...v };
    if (v.__type__ && '__custom__' in v) return visitCustom(v);
    if (v.__type__) return visit(v);
    const o = {};
    for (const k of Object.keys(v)) o[k] = conv(v[k]);
    return o;
  };
  function visitCustom(v) {
    if (ids.has(v)) return { __id__: ids.get(v) };
    const idx = out.length; ids.set(v, idx); out.push(null);
    out[idx] = { __type__: v.__type__, content: v.__custom__ };
    return { __id__: idx };
  }
  function visit(obj) {
    if (ids.has(obj)) return { __id__: ids.get(obj) };
    const idx = out.length;
    ids.set(obj, idx);
    out.push(null);
    let res = { __type__: obj.__type__ };
    if (isNode(obj)) {
      const d = nodeDefaults();
      for (const k of NODE_KEYS) res[k] = k in obj ? conv(obj[k]) : conv(d[k]);
      if (obj.__type__ === 'cc.Scene') {
        res.autoReleaseAssets = !!obj.autoReleaseAssets;
        res._globals = conv(obj._globals);
        res._id = opts.sceneUuid || obj._id || '';
      } else {
        res._id = kind === 'prefab' ? '' : obj._id || uniqueId('node:' + nodePath(obj));
      }
      for (const k of Object.keys(obj)) if (!(k in res)) res[k] = conv(obj[k]);
    } else if (isComponent(obj)) {
      res._name = obj._name || '';
      res._objFlags = obj._objFlags || 0;
      res.__editorExtras__ = {};
      res.node = conv(obj.node);
      res._enabled = '_enabled' in obj ? obj._enabled : true;
      res.__prefab = obj.__prefab ? conv(obj.__prefab) : null;
      for (const k of Object.keys(obj)) if (!(k in res) && k !== '_id') res[k] = conv(obj[k]);
      const i = (obj.node._components || []).indexOf(obj);
      res._id = kind === 'prefab' ? '' : obj._id || uniqueId(`comp:${nodePath(obj.node)}:${obj.__type__}:${i}`);
    } else if (obj.__type__ === 'cc.SceneAsset' || obj.__type__ === 'cc.Prefab') {
      res._name = obj._name || '';
      res._objFlags = obj._objFlags || 0;
      res.__editorExtras__ = {};
      res._native = '';
      out[idx] = res;
      for (const k of Object.keys(obj)) if (!(k in res) && k !== '__type__') res[k] = conv(obj[k]);
      if (obj.__type__ === 'cc.Prefab') {
        if (!('optimizationPolicy' in res)) res.optimizationPolicy = 0;
        if (!('persistent' in res)) res.persistent = false;
      }
      return { __id__: idx };
    } else {
      for (const k of Object.keys(obj)) if (k !== '__type__') res[k] = conv(obj[k]);
    }
    out[idx] = res;
    return { __id__: idx };
  }
  visit(root);
  return out;
}

// ---------------------------------------------------------------- dynamic / CCON documents
function f32short(x) {
  if (typeof x !== 'number' || !isFinite(x)) return x;
  const f = Math.fround(x);
  for (let d = 1; d <= 9; d++) { const v = +f.toPrecision(d); if (Math.fround(v) === f) return v; }
  return f;
}
function snapTime(t, sample) {
  if (!sample) return f32short(t);
  const r = Math.round(t * sample);
  return Math.fround(r / sample) === Math.fround(t) ? r / sample : f32short(t);
}

const TYPED = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array };

function typedFromRef(ref, chunk) {
  const C = TYPED[ref.ctor];
  if (!C || !chunk) return null;
  const bytes = chunk.subarray(ref.offset, ref.offset + ref.length * C.BYTES_PER_ELEMENT);
  const copy = new Uint8Array(bytes); // aligned copy
  return new C(copy.buffer, 0, ref.length);
}

function decodeRealCurve(bytes, extras, sample) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  const pre = dv.getUint8(p++), post = dv.getUint8(p++);
  const n = dv.getUint32(p, true); p += 4;
  const times = [];
  for (let k = 0; k < n; k++) { times.push(snapTime(dv.getFloat32(p, true), sample)); p += 4; }
  const values = [];
  for (let k = 0; k < n; k++) {
    const flags = dv.getUint32(p, true); p += 4;
    const kv = { __type__: 'cc.RealKeyframeValue', interpolationMode: 0, tangentWeightMode: 0, value: 0, rightTangent: 0, rightTangentWeight: 0, leftTangent: 0, leftTangentWeight: 0, easingMethod: 0 };
    kv.value = f32short(dv.getFloat32(p, true)); p += 4;
    if (flags & 2) { kv.interpolationMode = dv.getUint8(p); p += 1; }
    if (flags & 4) { kv.tangentWeightMode = dv.getUint8(p); p += 1; }
    if (flags & 8) { kv.leftTangent = f32short(dv.getFloat32(p, true)); p += 4; }
    if (flags & 16) { kv.leftTangentWeight = f32short(dv.getFloat32(p, true)); p += 4; }
    if (flags & 32) { kv.rightTangent = f32short(dv.getFloat32(p, true)); p += 4; }
    if (flags & 64) { kv.rightTangentWeight = f32short(dv.getFloat32(p, true)); p += 4; }
    kv.easingMethod = (flags >> 8) & 0xff;
    if (extras) kv.__editorExtras__ = extras[k];
    values.push(kv);
  }
  if (p !== bytes.byteLength) throw new Error('RealCurve: kích thước dữ liệu không khớp');
  return { __type__: 'cc.RealCurve', _times: times, _values: values, preExtrapolation: pre, postExtrapolation: post };
}

function decodeQuatCurve(bytes, sample) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let P = 0;
  const flags = dv.getUint32(P, true); P += 1;          // engine writes 4 bytes but advances 1 (see quat-curve.ts)
  const repeated = flags & 1;
  const n = dv.getUint32(P, true); P += 4;
  const times = [];
  for (let i = 0; i < n; i++) times.push(snapTime(dv.getFloat32(P + 4 * i, true), sample));
  P += 4 * n;
  const PV = P; P += 16 * n;
  const values = [];
  for (let i = 0; i < n; i++) {
    const q = PV + 16 * i;
    const value = { __type__: 'cc.Quat', x: f32short(dv.getFloat32(q, true)), y: f32short(dv.getFloat32(q + 4, true)), z: f32short(dv.getFloat32(q + 8, true)), w: f32short(dv.getFloat32(q + 12, true)) };
    let easingMethod = dv.getUint8(P); P++;
    if (easingMethod === 255) { easingMethod = [0, 4, 8, 12].map((o) => f32short(dv.getFloat32(P + o, true))); P += 16; }
    values.push({ __type__: 'cc.QuatKeyframeValue', interpolationMode: 0, value, easingMethod });
  }
  if (repeated) { const m = dv.getUint8(P); P++; values.forEach((v) => { v.interpolationMode = m; }); }
  else { values.forEach((v, i) => { v.interpolationMode = dv.getUint8(P + i); }); P += n; }
  return { __type__: 'cc.QuatCurve', _times: times, _values: values };
}

/**
 * Convert a dynamic (editor-like) document from a build (CCON or plain) into editor JSON:
 * decompress uuids, fix expected types, expand binary curves / typed arrays.
 */
function convertDynamicDoc(doc, chunks, opts) {
  const chunk = chunks && chunks[0];
  const root = Array.isArray(doc) ? doc : [doc];
  const first = root[0] || {};
  const sample = first.__type__ === 'cc.AnimationClip' ? first.sample || 60 : 0;
  const problems = [];
  const fix = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(fix);
    if (v.__uuid__) {
      const u = decompressUuid(v.__uuid__);
      const t = v.__expectedType__ && v.__expectedType__ !== 'cc.Asset' ? v.__expectedType__ : opts.typeOf(u);
      return { __uuid__: u, __expectedType__: t };
    }
    if (v.__type__ === 'cc.RealCurve' && v.bytes && v.bytes.__type__ === 'TypedArrayRef') {
      const bytes = typedFromRef(v.bytes, chunk);
      return decodeRealCurve(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), v.keyframeValueEditorExtras, sample);
    }
    if (v.__type__ === 'cc.QuatCurve' && v.bytes && v.bytes.__type__ === 'TypedArrayRef') {
      const bytes = typedFromRef(v.bytes, chunk);
      return decodeQuatCurve(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), sample);
    }
    if (v.__type__ === 'TypedArrayRef') {
      const arr = typedFromRef(v, chunk);
      if (!arr) { problems.push('TypedArrayRef không đọc được'); return null; }
      return { __type__: 'TypedArray', ctor: v.ctor, array: Array.from(arr) };
    }
    const o = {};
    for (const k of Object.keys(v)) o[k] = fix(v[k]);
    return o;
  };
  const out = root.map(fix);
  return { json: Array.isArray(doc) ? out : out[0], problems };
}

module.exports = { toEditorJSON, preparePrefab, unlinkScenePrefabs, convertDynamicDoc, walkNodes, nodePath, isNode, isComponent, f32short, normalizeMaterialJSON };
