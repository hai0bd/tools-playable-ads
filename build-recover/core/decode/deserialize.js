'use strict';
// Decoder for the Cocos Creator 3.x "compiled" serialization format (what builds contain).
// Mirrors engine/cocos/serialization/deserialize.ts but produces plain objects:
//   CCClass instance -> { __type__: 'cc.Node', ...props }
//   customized class -> { __type__, __custom__: content }   (classes with _deserialize)
//   value types      -> { __type__: 'cc.Vec3', x, y, z }
//   asset reference  -> { __uuid__: 'full-uuid@sub' }
//   object reference -> the referenced JS object itself (a graph)
const { decompressUuid } = require('../util/uuid');

function valueType(v) {
  switch (v[0]) {
    case 0: return { __type__: 'cc.Vec2', x: v[1], y: v[2] };
    case 1: return { __type__: 'cc.Vec3', x: v[1], y: v[2], z: v[3] };
    case 2: return { __type__: 'cc.Vec4', x: v[1], y: v[2], z: v[3], w: v[4] };
    case 3: return { __type__: 'cc.Quat', x: v[1], y: v[2], z: v[3], w: v[4] };
    case 4: { const u = v[1] >>> 0; return { __type__: 'cc.Color', r: u & 0xff, g: (u >>> 8) & 0xff, b: (u >>> 16) & 0xff, a: (u >>> 24) & 0xff }; }
    case 5: return { __type__: 'cc.Size', width: v[1], height: v[2] };
    case 6: return { __type__: 'cc.Rect', x: v[1], y: v[2], width: v[3], height: v[4] };
    case 7: { const o = { __type__: 'cc.Mat4' }; for (let i = 0; i < 16; i++) o['m' + String(i).padStart(2, '0')] = v[1 + i]; return o; }
    default: throw new Error('Unknown builtin value type ' + v[0]);
  }
}
const VALUE_TYPES = new Set(['cc.Vec2', 'cc.Vec3', 'cc.Vec4', 'cc.Quat', 'cc.Color', 'cc.Size', 'cc.Rect', 'cc.Mat4']);

function isCompiled(json) {
  return Array.isArray(json) && typeof json[0] === 'number';
}

/** data: IFileData (11 slots). Returns { root, instances, deps, hasNativeDep } */
function decodeCompiled(dataIn) {
  const data = JSON.parse(JSON.stringify(dataIn));
  const [, sharedUuids, sharedStrings, sharedClasses, sharedMasks, instances, instanceTypes, refsIn, dependObjs, dependKeys, dependUuidIndices] = data;
  const refs = refsIn || null;
  const clsName = (c) => (typeof c === 'string' ? c : c[0]);

  const ASSIGN = [];
  function deserializeCCObject(objectData) {
    const mask = sharedMasks[objectData[0]];
    const clazz = sharedClasses[mask[0]];
    const obj = { __type__: clsName(clazz) };
    const keys = clazz[1];
    const classTypeOffset = clazz[2];
    const maskTypeOffset = mask[mask.length - 1];
    let i = 1;
    for (; i < maskTypeOffset; ++i) obj[keys[mask[i]]] = objectData[i];
    for (; i < objectData.length; ++i) {
      const key = keys[mask[i]];
      const type = clazz[mask[i] + classTypeOffset];
      ASSIGN[type](obj, key, objectData[i]);
    }
    return obj;
  }
  const custom = (cls, content) => ({ __type__: cls, __custom__: content });
  const arr = (fn) => (o, k, v) => { for (let i = 0; i < v.length; ++i) fn(v, i, v[i]); o[k] = v; };
  ASSIGN[0] = (o, k, v) => { o[k] = v; };
  ASSIGN[1] = (o, k, v) => { if (v >= 0) o[k] = instances[v]; else refs[~v * 3] = o; };
  ASSIGN[2] = arr(ASSIGN[1]);
  ASSIGN[6] = (o, k, v) => { o[k] = null; dependObjs[v] = o; };
  ASSIGN[3] = arr(ASSIGN[6]);
  ASSIGN[4] = (o, k, v) => { o[k] = deserializeCCObject(v); };
  ASSIGN[5] = (o, k, v) => { o[k] = valueType(v); };
  ASSIGN[7] = (o, k, v) => { o[k] = { __trs__: v }; };
  ASSIGN[8] = (o, k, v) => { o[k] = valueType(v); };
  ASSIGN[9] = arr(ASSIGN[4]);
  ASSIGN[10] = (o, k, v) => { o[k] = custom(clsName(sharedClasses[v[0]]), v[1]); };
  ASSIGN[11] = (o, k, v) => { const dict = v[0]; o[k] = dict; for (let i = 1; i < v.length; i += 3) ASSIGN[v[i + 1]](dict, v[i], v[i + 2]); };
  ASSIGN[12] = (o, k, v) => { const a = v[0]; for (let i = 0; i < a.length; ++i) { const t = v[i + 1]; if (t !== 0) ASSIGN[t](a, i, a[i]); } o[k] = a; };

  const itLen = !instanceTypes ? 0 : instanceTypes.length;
  let rootIndex = instances[instances.length - 1];
  let normalCount = instances.length - itLen;
  let hasNativeDep = false, hasRootInfo = false;
  if (typeof rootIndex !== 'number') rootIndex = 0;
  else { hasRootInfo = true; if (rootIndex < 0) { rootIndex = ~rootIndex; hasNativeDep = true; } --normalCount; }
  let ins = 0;
  for (; ins < normalCount; ++ins) instances[ins] = deserializeCCObject(instances[ins]);
  for (let ti = 0; ti < itLen; ++ti, ++ins) {
    let type = instanceTypes[ti];
    const each = instances[ins];
    if (type >= 0) instances[ins] = custom(clsName(sharedClasses[type]), each);
    else { type = ~type; ASSIGN[type](instances, ins, each); }
  }
  if (hasRootInfo) instances.pop();

  if (refs) {
    const dataLength = refs.length - 1;
    const instanceOffset = refs[dataLength] * 3;
    let i = 0;
    for (; i < instanceOffset; i += 3) {
      const owner = refs[i], target = instances[refs[i + 2]], ki = refs[i + 1];
      if (ki >= 0) owner[sharedStrings[ki]] = target; else owner[~ki] = target;
    }
    for (; i < dataLength; i += 3) {
      const owner = instances[refs[i]], target = instances[refs[i + 2]], ki = refs[i + 1];
      if (ki >= 0) owner[sharedStrings[ki]] = target; else owner[~ki] = target;
    }
  }

  const deps = [];
  for (let i = 0; i < dependObjs.length; ++i) {
    let obj = dependObjs[i];
    if (typeof obj === 'number') obj = instances[obj];
    let key = dependKeys[i];
    if (typeof key === 'number') key = key >= 0 ? sharedStrings[key] : ~key;
    let uuid = dependUuidIndices[i];
    if (typeof uuid === 'number') uuid = sharedUuids[uuid];
    uuid = decompressUuid(uuid);
    deps.push({ owner: obj, key, uuid });
    if (obj) obj[key] = { __uuid__: uuid };
  }
  return { root: instances[rootIndex], instances, deps, hasNativeDep };
}

/** Packed (merged) json: [version, sharedUuids, sharedStrings, sharedClasses, sharedMasks, sections[]] */
function unpackJSONs(data) {
  const [version, sharedUuids, sharedStrings, sharedClasses, sharedMasks, sections] = data;
  return sections.map((sec) => [version, sharedUuids, sharedStrings, sharedClasses, sharedMasks, ...sec]);
}

module.exports = { decodeCompiled, unpackJSONs, valueType, isCompiled, VALUE_TYPES };
