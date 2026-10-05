'use strict';
// Luna ships every serialized object as a positional array. The build itself carries the decoder:
//   var Deserializers = { "<type>": function (e, data, existing) { i.name = data[0]; e.r(...); ... },
//                         fields: {...}, types: [...], unityVersion, productName, packagesInfo, ... }
// Running those functions against a recording context gives objects with the real (Unity) field names,
// whatever the Luna version — no field table of our own to keep in sync.
const vm = require('vm');

// ---------------------------------------------------------------- value classes the deserializers create
class Vec2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } }
class Vec3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } }
class Vec4 { constructor(x = 0, y = 0, z = 0, w = 0) { this.x = x; this.y = y; this.z = z; this.w = w; } }
class Quat { constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; } }
class Color { constructor(r = 0, g = 0, b = 0, a = 1) { this.r = r; this.g = g; this.b = b; this.a = a; } }
class Color32 { constructor(r = 0, g = 0, b = 0, a = 255) { this.r = r; this.g = g; this.b = b; this.a = a; } }
class Mat4 {
  constructor() { this.data = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
  setData(...v) { this.data = v; return this; }
  set(v) { this.data = Array.from(v); return this; }
}
class Rect { constructor(x, y, w, h) { this.x = x; this.y = y; this.width = w; this.height = h; } }
class LayerMask { constructor(v) { this.m_Bits = v >>> 0; } }
class Sh { constructor(coeffs) { this.coefficients = coeffs; } }
class List { constructor(elementType) { this.$list = elementType; this.items = []; } add(x) { this.items.push(x); } }
class Ref { constructor(type, id) { this.type = type; this.id = id; } }

/** Proxy that answers any property/call/new: unknown runtime APIs never make a deserializer throw. */
function anything(path) {
  const fn = function () { return { $unknown: path, args: Array.from(arguments) }; };
  return new Proxy(fn, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => path;
      if (typeof k === 'symbol' || k === 'prototype') return t[k];
      if (!Object.prototype.hasOwnProperty.call(t, k)) t[k] = anything(path + '.' + k);
      return t[k];
    },
    construct(t, args) { return { $unknown: path, args }; },
  });
}

function sandboxGlobals() {
  const pc = anything('pc');
  Object.assign(pc, {
    Vec2, Vec3, Vec4, Quat, Color, Mat4,
    SphericalHarmonicsL2: Sh,
    UnityMaterial: function UnityMaterial() { this.$type = 'Luna.Unity.DTO.UnityEngine.Assets.Material'; },
    UnityShaderPass: function UnityShaderPass() { this.$type = 'Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass'; },
  });
  const UnityEngine = anything('UnityEngine');
  Object.assign(UnityEngine, {
    Rect: Object.assign(function (x, y, w, h) { return new Rect(x, y, w, h); }, { MinMaxRect: (a, b, c, d) => new Rect(a, b, c - a, d - b) }),
    Color32: Object.assign(function (r, g, b, a) { return new Color32(r, g, b, a); }, { ConstructColor: (r, g, b, a) => new Color32(r, g, b, a) }),
    LayerMask: Object.assign(function (v) { return new LayerMask(v); }, { FromIntegerValue: (v) => new LayerMask(v), op_Implicit: (v) => new LayerMask(v) }),
    LightProbes: function LightProbes() { this.$type = 'UnityEngine.LightProbes'; },
  });
  const System = anything('System');
  System.Collections.Generic.List$1 = (elementType) => function ListOf() { return new List(elementType); };
  const Bridge = anything('Bridge');
  Bridge.ns = (name) => name;
  return { pc, UnityEngine, System, Bridge };
}

// ---------------------------------------------------------------- locate the Deserializers literal
/** Index of the brace/bracket closing the one at `start` (strings and escapes skipped). */
function closingIndex(src, start) {
  let depth = 0, str = null;
  for (let k = start; k < src.length; k++) {
    const c = src[k];
    if (str) { if (c === '\\') k++; else if (c === str) str = null; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') { if (--depth === 0) return k; }
  }
  return -1;
}

function loadDeserializers(code) {
  const m = code.match(/(?:var\s+|window\.)?Deserializers\s*=\s*\{/);
  if (!m) throw new Error('Không tìm thấy bảng Deserializers trong code Luna (định dạng Luna quá cũ?).');
  const open = m.index + m[0].length - 1;
  const close = closingIndex(code, open);
  if (close < 0) throw new Error('Bảng Deserializers bị cắt cụt.');
  const ctx = sandboxGlobals();
  vm.runInNewContext('__d = ' + code.slice(open, close + 1), ctx, { timeout: 20000 });
  const D = ctx.__d;
  if (!D || !Array.isArray(D.types)) throw new Error('Bảng Deserializers không có danh sách types.');
  return D;
}

// ---------------------------------------------------------------- schema
const REF_KINDS = { assign: 0, list: 1, array: 2 };

class Schema {
  constructor(code) {
    this.D = loadDeserializers(code);
    this.types = this.D.types;
    this.fields = this.D.fields || {};
    this.missing = new Set();   // DTO names without a deserializer (kept raw)
    const self = this;
    this.ctx = {
      c: (name) => ({ $type: name }),
      r(type, id, kind, target, field) {
        const ref = id === 0 || id == null || type == null ? null : new Ref(self.types[type] || type, id);
        if (kind === REF_KINDS.assign) target[field] = ref;
        else if (kind === REF_KINDS.list) { if (target instanceof List) target.add(ref); else target.push(ref); }
        else target.push(ref);
      },
      d: (name, data, existing) => self.deserialize(name, data, existing),
    };
  }

  info() {
    const D = this.D;
    return {
      unityVersion: D.unityVersion || '', productName: D.productName || '', lunaVersion: D.lunaVersion || '',
      creativeName: D.creativeName || '', packagesInfo: D.packagesInfo || '', companyName: D.companyName || '',
    };
  }

  has(name) { return typeof this.D[name] === 'function'; }

  deserialize(name, data, existing) {
    const fn = this.D[name];
    if (typeof fn !== 'function') { this.missing.add(name); return { $type: name, $raw: data }; }
    if (data == null) return existing || null;
    try {
      return fn(this.ctx, data, existing);
    } catch (e) {
      // the runtime reads some records (animation clips…) through field tables, not these functions, so
      // optional arrays can be null in the data: retry with empty arrays in their place
      if (!Array.isArray(data) || !data.some((x) => x === null)) throw e;
      return fn(this.ctx, data.map((x) => (x === null ? [] : x)), existing);
    }
  }

  /** Deserializer name for a component record { type, class, data }. */
  componentDto(comp) {
    const typeName = this.types[comp.type];
    // MonoBehaviours (user scripts, UI, TMP, Spine…) carry their concrete class separately; the type is a base
    // class (MonoBehaviour, UIBehaviour…)
    const className = comp.class != null ? this.types[comp.class] : typeName;
    if (this.has(className)) return { typeName, className, dto: className };
    const short = String(className).replace(/^UnityEngine\./, '');
    const dto = 'Luna.Unity.DTO.UnityEngine.Components.' + short;
    return { typeName, className, dto: this.has(dto) ? dto : null };
  }

  component(comp) {
    const t = this.componentDto(comp);
    let value = null;
    if (t.dto) value = this.deserialize(t.dto, comp.data);
    else if (comp.data && comp.data.length) this.missing.add(t.className);
    return { ...t, id: comp.id, enabled: comp.enabled === undefined ? null : !!comp.enabled, value: value || {} };
  }
}

/** Plain JSON view of a deserialized value (Lists → arrays, class instances → objects). */
function plain(v) {
  if (v == null || typeof v !== 'object') return v;
  if (v instanceof List) return v.items.map(plain);
  if (Array.isArray(v)) return v.map(plain);
  if (ArrayBuffer.isView(v)) return Array.from(v);
  const o = {};
  for (const k of Object.keys(v)) o[k] = plain(v[k]);
  return o;
}

module.exports = { Schema, loadDeserializers, plain, closingIndex, Vec2, Vec3, Vec4, Quat, Color, Color32, Mat4, Rect, LayerMask, List, Ref };
