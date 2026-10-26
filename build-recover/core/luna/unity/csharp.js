'use strict';
// C# for the game's own types. Luna compiled them with Bridge.NET; the build keeps, per class:
//   - the Deserializer (exact serialized field names, reference vs value, Vector3/Color/List<T>…)
//   - Bridge.define("Name", { $kind, inherits, fields, props, ctors: { init }, methods, statics })
// From these the writer emits the real type hierarchy (base classes and interfaces, so a subclass never repeats a
// field its base declares), every type the code defines — also those no scene uses (base classes, Configs, enums,
// interfaces, structs) — and typed signatures inferred from how the code uses each value (./types). Method bodies
// stay the translated JavaScript inside comments, so the project still compiles as soon as it opens.
const { closingIndex } = require('../schema');
const { importers } = require('./project');
const { translateFunction } = require('./js2cs');
const types = require('./types');
const ids = require('./ids');

const { objectEntries } = types;
const VALUE_TYPES = { Vec2: 'Vector2', Vec3: 'Vector3', Vec4: 'Vector4', Quat: 'Quaternion', Color: 'Color', Color32: 'Color32', Rect: 'Rect', LayerMask: 'LayerMask', Mat4: 'Matrix4x4' };
const UNITY_MSG = {
  Awake: '', Start: '', Update: '', LateUpdate: '', FixedUpdate: '', OnEnable: '', OnDisable: '', OnDestroy: '', OnValidate: '', Reset: '',
  OnGUI: '', OnApplicationPause: 'bool pauseStatus', OnApplicationFocus: 'bool hasFocus', OnApplicationQuit: '', OnBecameVisible: '', OnBecameInvisible: '',
  OnTriggerEnter: 'Collider other', OnTriggerExit: 'Collider other', OnTriggerStay: 'Collider other',
  OnTriggerEnter2D: 'Collider2D other', OnTriggerExit2D: 'Collider2D other', OnTriggerStay2D: 'Collider2D other',
  OnCollisionEnter: 'Collision collision', OnCollisionExit: 'Collision collision', OnCollisionStay: 'Collision collision',
  OnCollisionEnter2D: 'Collision2D collision', OnCollisionExit2D: 'Collision2D collision', OnCollisionStay2D: 'Collision2D collision',
  OnMouseDown: '', OnMouseUp: '', OnMouseDrag: '', OnMouseEnter: '', OnMouseExit: '', OnMouseOver: '', OnMouseUpAsButton: '',
};
const CS_KEYWORDS = new Set('abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while'.split(' '));
const ident = (s) => (CS_KEYWORDS.has(s) ? '@' + s : s);
// names that are ids, counters and indices: integral data in such a field is an int, not a float
const INT_NAME = /(^|_)(id|index|count|level|layer|step|num|amount|total|max|min)|(Id|ID|Index|Count|Level|Layer|Step|Num|Amount|Total)([A-Z_]|$)|^(id|Id|ID)[A-Z_]/;
const VALUE_TYPE = /^(int|float|double|bool|long|short|byte|char|uint|UnityEngine\.(Vector[234]|Vector[23]Int|Quaternion|Color|Color32|Rect|Bounds|LayerMask|Matrix4x4))$/;

/** Type name as C# source: "UnityEngine.UI.Image" → "UnityEngine.UI.Image" (fully qualified keeps usings trivial). */
function csTypeName(t) {
  if (!t) return 'UnityEngine.Object';
  return String(t).replace(/\+/g, '.').replace(/\$\d+$/, '');
}

/** Bridge.define source of a (non-generic) class, or null. */
function bridgeDefine(code, name) {
  const key = `Bridge.define("${name}",`;
  const at = code.indexOf(key);
  if (at < 0) return null;
  const open = code.indexOf('{', at + key.length);
  const close = closingIndex(code, open);
  return close < 0 ? null : code.slice(open, close + 1);
}

/** Serialized fields of a class from its deserializer + values seen in scenes/prefabs. */
function serializedFields(p, className) {
  const fn = p.m.schema.D[className];
  if (typeof fn !== 'function') return [];
  const src = fn.toString();
  const fields = [];
  const seen = new Set();
  const add = (name, kind, extra) => { if (!seen.has(name)) { seen.add(name); fields.push({ name, kind, ...extra }); } };
  // walk assignments in source order
  const re = /\.r\([^()]*?,\s*0\s*,\s*\w+\s*,\s*"(\w+)"\s*\)|\b\w+\.(\w+)\s*=\s*(!!)?(new\s*\(?\s*(?:pc|UnityEngine)\.(\w+)|new\s*\(\s*System\.Collections\.Generic\.List\$1\(\s*Bridge\.ns\("([^"]+)"\)\)\)|UnityEngine\.(\w+)\.\w+\(|e\.d\("([^"]+)"|\w+\[\d+\]|\w+)/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[1]) { add(m[1], 'ref'); continue; }
    const name = m[2];
    if (!name || name === 'prototype') continue;
    if (m[3]) add(name, 'bool');
    else if (m[5]) add(name, 'value', { valueType: VALUE_TYPES[m[5]] || m[5] });
    else if (m[6]) add(name, 'list', { element: m[6] });
    else if (m[7]) add(name, 'value', { valueType: VALUE_TYPES[m[7]] || m[7] });
    else if (m[8]) add(name, 'nested', { dto: m[8] });
    else add(name, 'plain');
  }
  // collections filled in a loop then assigned: "for(...)s.push(...)" / "g.add(...)" / "e.r(..,2,s,"")" … "i.name=s";
  // a variable created as new(List$1(Bridge.ns("T"))) makes the field a List<T>, otherwise an array
  const listVars = new Map();
  const lv = /(\w+)\s*=\s*new\s*\(\s*System\.Collections\.Generic\.List\$1\(\s*Bridge\.ns\("([^"]+)"\)\)\)/g;
  while ((m = lv.exec(src))) listVars.set(m[1], m[2]);
  const arr = /for\s*\((?:var\s+)?[^;]*;[^;]*;[^)]*\)\s*(?:(\w+)\.(?:push|add)\(([^;]*?)\)|e\.r\([^()]*?,\s*[12]\s*,\s*(\w+)\s*,\s*""\s*\))[^]*?\b\w+\.(\w+)\s*=\s*(\1|\3)\b/g;
  while ((m = arr.exec(src))) {
    const v = m[1] || m[3];
    const f = fields.find((x) => x.name === m[4]);
    let kind = m[3] ? 'refArray' : /pc\.(\w+)/.test(m[2] || '') ? 'valueArray' : /e\.d\("([^"]+)"/.test(m[2] || '') ? 'nestedArray' : /!!/.test(m[2] || '') ? 'boolArray' : 'plainArray';
    let extra = kind === 'valueArray' ? { valueType: VALUE_TYPES[(m[2].match(/pc\.(\w+)/) || [])[1]] } : kind === 'nestedArray' ? { dto: (m[2].match(/e\.d\("([^"]+)"/) || [])[1] } : {};
    if (listVars.has(v)) { extra = { element: listVars.get(v), inner: kind, ...extra }; kind = 'list'; }
    if (f) Object.assign(f, { kind, ...extra });
    else add(m[4], kind, extra);
  }
  // types of references / plain values from the actual data
  const samples = p.scriptSamples.get(className) || [];
  for (const f of fields) {
    const vals = samples.map((s) => s && s[f.name]).filter((v) => v != null);
    if (f.kind === 'ref' || f.kind === 'refArray' || (f.kind === 'list' && !f.element)) {
      const flat = vals.flatMap((v) => (Array.isArray(v) ? v : v && v.items ? v.items : [v])).filter((v) => v && v.type);
      const types2 = [...new Set(flat.map((v) => v.type))];
      f.refType = types2.length === 1 ? types2[0] : types2.length ? commonBase(types2) : null;
    }
    if (f.kind === 'plain' || f.kind === 'plainArray') {
      const flat = vals.flatMap((v) => (Array.isArray(v) ? v : [v]));
      f.samples = flat.length;
      if (flat.some((v) => typeof v === 'string')) f.plainType = 'string';
      else if (flat.every((v) => typeof v === 'number' && Number.isInteger(v)) && (p.intHint(className, f.name) || INT_NAME.test(f.name))) f.plainType = 'int';
      else f.plainType = flat.length && flat.every((v) => typeof v === 'boolean') ? 'bool' : 'float';
    }
  }
  return fields;
}

function commonBase(list) {
  if (list.every((t) => /Transform$/.test(t))) return 'UnityEngine.Transform';
  if (list.every((t) => /^UnityEngine\.UI\./.test(t) || /TextMeshProUGUI/.test(t))) return 'UnityEngine.UI.Graphic';
  if (list.every((t) => /Collider2D$/.test(t))) return 'UnityEngine.Collider2D';
  if (list.every((t) => /Collider$/.test(t))) return 'UnityEngine.Collider';
  if (list.every((t) => /Renderer$/.test(t))) return 'UnityEngine.Renderer';
  return 'UnityEngine.Object';
}

function fieldType(f, nestedName, avail) {
  // a reference to a type from a package the project cannot resolve by itself (Spine 3.x, DOTween, FinalIK…) is
  // declared with a Unity base type: the serialized reference still binds and the project compiles without it
  const refT = (t) => (avail(t) ? csTypeName(t) : 'UnityEngine.Object');
  switch (f.kind) {
    case 'bool': return 'bool';
    case 'boolArray': return 'bool[]';
    case 'ref': return refT(f.refType);
    case 'refArray': return refT(f.refType) + '[]';
    case 'value': return 'UnityEngine.' + (f.valueType || 'Vector3');
    case 'valueArray': return 'UnityEngine.' + (f.valueType || 'Vector3') + '[]';
    case 'list': {
      const prim = { 'System.Int32': 'int', 'System.Single': 'float', 'System.Double': 'double', 'System.String': 'string', 'System.Boolean': 'bool', 'System.Int64': 'long' }[f.element];
      const el = f.inner === 'nestedArray' ? nestedName(f.dto || f.element) : prim || (/^UnityEngine\.(Vector[234]|Quaternion|Color|Color32|Rect)$/.test(f.element || '') ? f.element : refT(f.element || f.refType));
      return `System.Collections.Generic.List<${el}>`;
    }
    case 'nested': return nestedName(f.dto);
    case 'nestedArray': return nestedName(f.dto) + '[]';
    case 'plainArray': return (f.plainType || 'float') + '[]';
    default: return f.plainType || 'float';
  }
}

// A reference field declared as UnityEngine.Object says why, so its type can be restored later.
function typeNote(f, avail) {
  const isList = f.kind === 'list' && f.inner !== 'nestedArray';
  if (f.kind !== 'ref' && f.kind !== 'refArray' && !isList) return '';
  const t = isList ? f.element || f.refType : f.refType;
  if (isList && t && /^System\.|^UnityEngine\.(Vector[234]|Quaternion|Color|Color32|Rect)$/.test(t)) return '';
  if (!t) return '   // kiểu gốc không rõ: field để trống trong bản build';
  return avail(t) ? '' : `   // kiểu gốc: ${csTypeName(t)} — package chưa có trong project; import package rồi đổi lại kiểu này`;
}

// ---------------------------------------------------------------- planning (once per project)
/** this.X = <node> assignments of a ctor init function → Map name → babel node */
function initAssignments(src) {
  const out = new Map();
  const fn = src && types.parseFn(src);
  if (!fn || !fn.body || !fn.body.body) return out;
  const visit = (e) => {
    if (!e) return;
    if (e.type === 'SequenceExpression') return e.expressions.forEach(visit);
    if (e.type === 'AssignmentExpression' && e.operator === '=' && e.left.type === 'MemberExpression' && !e.left.computed && e.left.object.type === 'ThisExpression') out.set(e.left.property.name, e.right);
  };
  for (const s of fn.body.body) if (s.type === 'ExpressionStatement') visit(s.expression);
  return out;
}

/** Enum (and other) types fields are assigned / compared with, from every method of the hierarchy. */
function fieldEvidence(model) {
  const enums = model.enumNames();
  const out = new Map();   // "Cls.field" → Votes-like counts
  const vote = (cls, f, t, w) => {
    if (!t) return;
    // the class that declares the field (it may be an ancestor)
    let owner = cls;
    for (const c of [cls, ...model.ancestors(cls)]) if (Object.prototype.hasOwnProperty.call(model.get(c).fields, f)) { owner = c; break; }
    const k = owner + '.' + f;
    if (!out.has(k)) out.set(k, new Map());
    out.get(k).set(t, (out.get(k).get(t) || 0) + w);
  };
  const enumOf = (n) => {
    const p = types.memberPath(n);
    if (!p) return null;
    const prefix = p.slice(0, p.lastIndexOf('.'));
    return enums.has(prefix) ? types.cleanName(prefix) : null;
  };
  const thisField = (n) => (n && n.type === 'MemberExpression' && !n.computed && n.object.type === 'ThisExpression' ? n.property.name : null);
  for (const t of model.types.values()) {
    const srcs = [...Object.values(t.methods), t.init, ...Object.values(t.props)].filter(Boolean);
    for (const src0 of srcs) {
      const srcList = src0.trim()[0] === '{' ? Object.values(objectEntries(src0)) : [src0];
      for (const src of srcList) {
        const fn = types.parseFn(src);
        if (!fn) continue;
        types.walk(fn.body, (n) => {
          if (n.type === 'AssignmentExpression' && n.operator === '=') { const f = thisField(n.left); if (f) vote(t.name, f, enumOf(n.right), 3); }
          if (n.type === 'BinaryExpression' && /^(===|!==|==|!=)$/.test(n.operator)) {
            const f = thisField(n.left) || thisField(n.right);
            if (f) vote(t.name, f, enumOf(thisField(n.left) ? n.right : n.left), 3);
          }
          if (n.type === 'SwitchStatement') { const f = thisField(n.discriminant); if (f) for (const cs of n.cases) vote(t.name, f, cs.test && enumOf(cs.test), 3); }
        });
      }
    }
  }
  const best = new Map();
  for (const [k, m] of out) best.set(k, [...m].sort((a, b) => b[1] - a[1])[0][0]);
  return best;
}

/** Type of a runtime-only field from its Bridge default and the ctor init assignment. */
function runtimeType(p, className, name, def, initNode, initSrc, isStatic, generic) {
  const model = p.typeModel;
  const init = (initSrc.match(new RegExp(`this\\.${name}\\s*=\\s*([^,}]+(?:\\([^)]*\\)[^,}]*)?)`)) || [])[1] || '';
  const list = init.match(/List\$1\(([\w.]+)\)/);
  if (list) {
    const el = list[1];
    const prim = { 'System.Int32': 'int', 'System.Single': 'float', 'System.String': 'string', 'System.Boolean': 'bool' }[el];
    return `System.Collections.Generic.List<${prim || (p.typeAvailable(el) || model.has(el) ? model.csType(el, generic) : /^System\./.test(el) ? csTypeName(el) : 'UnityEngine.Object')}>`;
  }
  const nw = init.match(/^new\s+(UnityEngine\.\w+)/);
  if (nw) return nw[1];
  const pc = init.match(/^new\s+pc\.(\w+)/);
  if (pc && VALUE_TYPES[pc[1]]) return 'UnityEngine.' + VALUE_TYPES[pc[1]];
  const gd = (def || '').match(/^Bridge\.getDefaultValue\(([^)]+)\)$/);
  if (gd) return model.csType(gd[1], generic);
  const lt = initNode && types.litType(initNode);
  if (lt === 'string' || lt === 'bool') return lt;
  const v = (def || '').trim();
  if (v === '!1' || v === '!0' || /^(true|false)$/.test(v)) return 'bool';
  if (/^-?[\d.]+(e[-+]?\d+)?$/i.test(v)) return p.intHint(className, name) || (lt === 'int' && INT_NAME.test(name)) ? 'int' : 'float';
  if (/^["']/.test(v)) return 'string';
  if (isStatic && /^[Ii]nstance$/.test(name)) return model.csType(className, generic);
  return 'object';
}

/** Every user type's fields, typed; then every method's signature. Stored on p for the writers. */
function plan(p) {
  if (p.typeModel) return;
  const model = new types.TypeModel(p.m.x.code);
  p.typeModel = model;
  const evidence = fieldEvidence(model);
  const enums = model.enumNames();
  const avail = (t) => p.typeAvailable(t) || model.has(t);
  const nestedName = (dto) => {
    if (model.has(dto)) return csTypeName(dto);
    const clean = csTypeName(dto);
    if (/^(UnityEngine|TMPro|Spine|DG|Cinemachine|System)\./.test(clean)) return clean;
    const local = clean.split('.').pop();
    if (!p.nestedTypes) p.nestedTypes = new Map();
    if (!p.nestedTypes.has(local)) p.nestedTypes.set(local, dto);
    return local;
  };
  p.csNestedName = nestedName;
  p.classFields = new Map();
  for (const t of model.types.values()) {
    if (t.kind === 'enum' || t.kind === 'interface') continue;
    const inherited = model.inheritedFieldNames(t.name);
    const own = new Set(Object.keys(t.fields));
    let ser;
    if (typeof p.m.schema.D[t.name] === 'function') ser = serializedFields(p, t.name).filter((f) => !inherited.has(f.name));
    else {
      // a base class no scene instantiates: its serialized fields are the ones its subclasses' data carry
      ser = [];
      for (const d of model.descendants(t.name)) {
        if (typeof p.m.schema.D[d] !== 'function') continue;
        for (const f of serializedFields(p, d)) if (own.has(f.name) && !ser.some((x) => x.name === f.name)) ser.push(f);
      }
    }
    const inits = initAssignments(t.init);
    const serialized = ser.map((f) => {
      let cs = fieldType(f, nestedName, avail);
      const ev = evidence.get(t.name + '.' + f.name);
      if ((f.kind === 'plain') && ev && enums.has(ev)) cs = csTypeName(ev);
      else if (f.kind === 'plain' && !f.samples && inits.has(f.name)) { const lt = types.litType(inits.get(f.name)); if (lt === 'string' || lt === 'bool') cs = lt; }
      return { name: f.name, type: cs, note: typeNote(f, avail), init: inits.get(f.name) };
    });
    const serNames = new Set([...ser.map((f) => f.name), ...inherited]);
    const runtime = [];
    for (const [name, def] of Object.entries(t.fields)) {
      if (serNames.has(name) || !/^[A-Za-z_]\w*$/.test(name)) continue;
      let ty = runtimeType(p, t.name, name, def, inits.get(name), t.init || '', false, t.generic);
      const ev = evidence.get(t.name + '.' + name);
      if (ev && (ty === 'object' || ty === 'float' || ty === 'int')) ty = csTypeName(ev);
      runtime.push({ name, type: ty, init: inits.get(name) });
    }
    const sInits = initAssignments(t.statics.init);
    const statics = [];
    for (const [name, def] of Object.entries(t.statics.fields)) {
      if (!/^[A-Za-z_]\w*$/.test(name)) continue;
      statics.push({ name, type: runtimeType(p, t.name, name, def, sInits.get(name), t.statics.init || '', true, t.generic), init: sInits.get(name) });
    }
    p.classFields.set(t.name, { serialized, runtime, statics });
  }
  const fieldTypeOf = (cls, f, isStatic) => {
    const cf = p.classFields.get(cls);
    if (!cf) return null;
    const list = isStatic ? cf.statics : [...cf.serialized, ...cf.runtime];
    const x = list.find((y) => y.name === f);
    return x && x.type !== 'object' ? x.type.replace(/^UnityEngine\.Object$/, '') || null : null;
  };
  p.signatures = types.inferSignatures(model, fieldTypeOf);
  planMethods(p);
}

/** C# name, parameters, return type and modifiers of every method — overloads restored, overrides matched. */
function planMethods(p) {
  const model = p.typeModel;
  p.methodPlans = new Map();
  for (const t of model.types.values()) {
    const sigs = p.signatures.get(t.name) || new Map();
    const events = (p.eventMethods && p.eventMethods.get(t.name)) || new Map();
    const iface = new Map();
    for (const i of t.interfaces) {
      const e = types.EVENT_INTERFACES[i.split('.').pop()];
      if (e) iface.set(e[0], 'UnityEngine.EventSystems.' + e[1] + ' eventData');
    }
    const list = [];
    for (const [isStatic, methods] of [[false, t.methods], [true, t.statics.methods]]) {
      for (const raw of Object.keys(methods)) {
        if (t.kind === 'struct' && types.BRIDGE_PLUMBING.test(raw)) continue;
        if (isStatic && /^getDefaultValue$/.test(raw)) continue;
        // explicit implementations of System interfaces (System$Collections$IEnumerable$GetEnumerator): those
        // interfaces are not declared on the C# class, so neither are their members
        if (/\$/.test(raw.replace(/\$\d+$/, ''))) continue;
        const s = sigs.get(raw) || { params: [], ret: 'void', coroutine: false };
        const base = raw.replace(/\$\d+$/, '');
        // a subclass's Awake comes out as Awake$1 (Bridge numbers it after the base's Awake)
        const unity = !isStatic && Object.prototype.hasOwnProperty.call(UNITY_MSG, base) && (raw === base || !Object.prototype.hasOwnProperty.call(methods, base));
        const ev = events.get(base);
        let params, ret, fixed = true;
        if (unity) { params = UNITY_MSG[base] ? [UNITY_MSG[base]] : []; ret = 'void'; }
        else if (iface.has(base)) { params = [iface.get(base)]; ret = 'void'; }
        else if (ev != null) { params = ev ? [ev] : []; ret = 'void'; }
        else {
          fixed = false;
          params = paramNames(s.params.map((x) => x.name)).map((n, i) => `${s.params[i].type} ${n}`);
          ret = s.coroutine ? 'System.Collections.IEnumerator' : s.ret;
        }
        list.push({ raw, base, isStatic, unity, fixed, params, defs: fixed ? [] : s.params.map((x) => x.def), ret, coroutine: s.coroutine, types: fixed ? params.map((x) => x.split(' ')[0]) : s.params.map((x) => x.type) });
      }
    }
    // overloads: Bridge renames them Name$1, Name$2… — back to one name when their parameter types tell them apart
    const groups = new Map();
    for (const m of list) { if (!groups.has(m.base)) groups.set(m.base, []); groups.get(m.base).push(m); }
    for (const [base, g] of groups) {
      // every parameter list a call can match: optional trailing parameters may be left out
      const callable = (m) => {
        let req = m.types.length;
        while (req > 0 && m.defs[req - 1] !== undefined) req--;
        const out = [];
        for (let n = req; n <= m.types.length; n++) out.push(m.types.slice(0, n).join(','));
        return out;
      };
      const all = g.flatMap(callable);
      const distinct = new Set(all).size === all.length;
      for (const m of g) m.name = ident(distinct ? base : m.raw.replace(/\$(\d+)$/, '_$1'));
    }
    // a static and an instance method Bridge keeps under the same name and parameter types (CS0111)
    const seen = new Set();
    for (const m of list) {
      let key = m.name + '(' + m.types.join(',') + ')';
      if (seen.has(key)) { m.name = ident(m.name.replace(/^@/, '') + (m.isStatic ? '_static' : '_instance')); key = m.name + '(' + m.types.join(',') + ')'; }
      seen.add(key);
    }
    // optional parameters: only a trailing run of literals C# accepts as defaults
    for (const m of list) {
      let ok = true;
      m.paramText = m.params.map((x, i) => x).slice();
      for (let i = m.params.length - 1; i >= 0; i--) {
        const d = m.defs[i];
        if (!ok || d === undefined || (m.types[i] === 'object' && d !== 'null')) { ok = false; continue; }
        m.paramText[i] = m.params[i] + ' = ' + d;
      }
    }
    p.methodPlans.set(t.name, list);
  }
  // overrides: same name and parameter types as an ancestor's method → virtual there, override here
  for (const t of model.types.values()) {
    for (const m of p.methodPlans.get(t.name)) {
      if (m.isStatic) continue;
      for (const a of model.ancestors(t.name)) {
        const am = (p.methodPlans.get(a) || []).find((x) => !x.isStatic && x.name === m.name && x.types.join(',') === m.types.join(','));
        if (!am) continue;
        am.virtual = true;
        m.override = true;
        m.ret = am.ret;   // C# requires the same return type
        break;
      }
    }
  }
}

/** Minified parameter names as C# identifiers: "$" → "_p0", duplicates numbered. */
function paramNames(names) {
  const used = new Set();
  return names.map((n, i) => {
    let s = /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : 'p' + i;
    while (used.has(s)) s += '_';
    used.add(s);
    return ident(s);
  });
}

// ---------------------------------------------------------------- writing
function literal(node, type, model) {
  if (!node || /^(object|System\.)/.test(type) && type !== 'string') return undefined;
  if (type === 'string' && node.type === 'StringLiteral') return JSON.stringify(node.value);
  const lt = types.litType(node);
  if ((type === 'int' && lt === 'int') || (type === 'float' && (lt === 'int' || lt === 'float')) || (type === 'bool' && lt === 'bool')) {
    if (lt === 'bool') return node.type === 'BooleanLiteral' ? String(node.value) : node.argument.value ? 'false' : 'true';
    const v = node.type === 'UnaryExpression' ? -node.argument.value : node.value;
    return type === 'float' ? (Number.isInteger(v) ? String(v) : v + 'f') : String(v);
  }
  const path = types.memberPath(node);
  if (path && model.enumNames().has(path.slice(0, path.lastIndexOf('.'))) && csTypeName(path.slice(0, path.lastIndexOf('.'))) === type) return csTypeName(path);
  return undefined;
}

/** Property: getter/setter bodies for the plain field-accessor and PlayerPrefs patterns, a typed stub otherwise. */
function propertyLines(p, t, name, src, isStatic, pad) {
  const e = objectEntries(src);
  const get = e.get || '', set = e.set || '';
  const field = (get.match(/^function\s*\(\)\s*\{\s*return\s+this\.(\w+)\s*;?\s*\}$/) || [])[1];
  const setField = (set.match(/^function\s*\((\w+)\)\s*\{\s*this\.(\w+)\s*=\s*\1\s*;?\s*\}$/) || [])[2];
  const pp = get.match(/^function\s*\(\)\s*\{\s*return\s+UnityEngine\.PlayerPrefs\.Get(Int|Float|String)\(([\w.]+|"[^"]*"),\s*([^)]*)\)\s*;?\s*\}$/);
  const ppSet = set.match(/^function\s*\((\w+)\)\s*\{\s*UnityEngine\.PlayerPrefs\.Set(Int|Float|String)\(([\w.]+|"[^"]*"),\s*\1\s*\)\s*;?\s*\}$/);
  const cf = p.classFields.get(t.name) || { serialized: [], runtime: [], statics: [] };
  const typeOfField = (f) => { const x = [...cf.serialized, ...cf.runtime, ...cf.statics].find((y) => y.name === f); return x ? x.type : null; };
  const keyIsString = (k) => /^"/.test(k) || (() => { const i = k.lastIndexOf('.'); const c = k.slice(0, i), f = k.slice(i + 1); const x = (p.classFields.get(c) || { statics: [] }).statics.find((y) => y.name === f); return x && x.type === 'string'; })();
  const mod = `public ${isStatic ? 'static ' : ''}`;
  if (field && !isStatic && typeOfField(field)) {
    const ty = typeOfField(field);
    const setter = setField === field ? ` set => this.${field} = value;` : '';
    return [`${pad}    ${mod}${ty} ${ident(name)} { get => this.${field};${setter} }`];
  }
  if (pp && keyIsString(pp[2]) && /^(-?[\d.]+|"[^"]*"|[\w.]+)$/.test(pp[3].trim())) {
    const ty = { Int: 'int', Float: 'float', String: 'string' }[pp[1]];
    const def = ty === 'float' && /^-?[\d.]+$/.test(pp[3].trim()) && !Number.isInteger(Number(pp[3])) ? pp[3].trim() + 'f' : pp[3].trim();
    const setter = ppSet && ppSet[2] === pp[1] && ppSet[3] === pp[2] ? ` set => UnityEngine.PlayerPrefs.Set${pp[1]}(${pp[2]}, value);` : '';
    return [`${pad}    ${mod}${ty} ${ident(name)} { get => UnityEngine.PlayerPrefs.Get${pp[1]}(${pp[2]}, ${def});${setter} }`];
  }
  // anything else: typed from what the getter returns, body kept for reference
  const model = p.typeModel;
  const returnType = (a) => {
    if (!a) return null;
    if (a.type === 'SequenceExpression') return returnType(a.expressions[a.expressions.length - 1]);
    // Bridge.rValue(x) is x
    if (a.type === 'CallExpression' && types.memberPath(a.callee) === 'Bridge.rValue' && a.arguments[0]) return returnType(a.arguments[0]);
    if (a.type === 'MemberExpression' && !a.computed) {
      const f = a.property.name;
      if (a.object.type === 'ThisExpression') return typeOfField(f);
      // Singleton$1(e).instance / UserData.instance: a static field of this class
      const o = a.object.type === 'CallExpression' ? types.memberPath(a.object.callee) : types.memberPath(a.object);
      const cls = o && (model.has(o) ? o : model.has(o + '$1') ? o + '$1' : null);
      const x = cls && (p.classFields.get(cls) || { statics: [] }).statics.find((y) => y.name === f);
      return x ? x.type : null;
    }
    if (a.type === 'CallExpression') {
      // Utils.IntToBool(…): a static method whose return type is known
      const cp = types.memberPath(a.callee) || '';
      const i = cp.lastIndexOf('.');
      const sig = i > 0 && p.signatures.get(cp.slice(0, i)) && p.signatures.get(cp.slice(0, i)).get(cp.slice(i + 1));
      if (sig && sig.ret && sig.ret !== 'void' && sig.ret !== 'object') return sig.ret;
      const pp2 = cp.match(/PlayerPrefs\.Get(Int|Float|String)$/);
      if (pp2) return { Int: 'int', Float: 'float', String: 'string' }[pp2[1]];
    }
    return types.litType(a);
  };
  let ty = 'object';
  const fn = types.parseFn(get);
  if (fn) types.walk(fn.body, (n) => {
    if (ty !== 'object' || n.type !== 'ReturnStatement' || !n.argument) return;
    ty = returnType(n.argument) || 'object';
  });
  const lines = [`${pad}    ${mod}${ty} ${ident(name)}`, `${pad}    {`];
  if (get) {
    lines.push(`${pad}        get`, `${pad}        {`);
    const tr = translateFunction(get);
    if (tr) for (const l of tr.lines) for (const sub of commentSafe(l).split('\n')) lines.push(`${pad}            // ${sub}`);
    lines.push(`${pad}            return default;`, `${pad}        }`);
  }
  if (set) {
    lines.push(`${pad}        set`, `${pad}        {`);
    const tr = translateFunction(set);
    if (tr) for (const l of tr.lines) for (const sub of commentSafe(l).split('\n')) lines.push(`${pad}            // ${sub}`);
    lines.push(`${pad}        }`);
  }
  lines.push(`${pad}    }`);
  return lines;
}

/** Lines of one type (no namespace/usings); nested user types go inside it. */
function classLines(p, className, kind, nested, pad) {
  plan(p);
  const model = p.typeModel;
  const t = model.get(className);
  if (!t) return legacyClassLines(p, className, kind, nested, pad);
  const name = model.localName(className);
  const generic = t.generic.length ? '<' + types.typeParamNames(t.generic.length).join(', ') + '>' : '';
  const lines = [];
  if (t.kind === 'enum') {
    lines.push(`${pad}public enum ${name}`, `${pad}{`);
    for (const [k, v] of model.enumValues(className)) lines.push(`${pad}    ${ident(k)} = ${v},`);
    lines.push(`${pad}}`);
    return lines;
  }
  if (t.kind === 'interface') return [`${pad}public interface ${name}${generic}`, `${pad}{`, `${pad}}`];
  // base class: a user class, or the Unity base its chain ends on; components keep a Unity base even when the
  // original one (UIBehaviour, Image…) would bring its own serialized fields along
  let base = null;
  if (t.baseRaw) {
    const head = t.baseRaw.replace(/\(.*$/, '').trim();
    if (model.has(head)) base = model.csType(t.baseRaw, t.generic);
    else if (/^UnityEngine\.(MonoBehaviour|ScriptableObject)$/.test(head)) base = head;
  }
  // kind: how scenes/assets use the class ('mono' / 'scriptable'), null for a type only the code knows
  if (!base && t.kind === 'class') {
    if (model.isComponent(className) || kind === 'mono') base = 'UnityEngine.MonoBehaviour';
    else if (model.isScriptable(className) || kind === 'scriptable') base = 'UnityEngine.ScriptableObject';
  }
  const plans = p.methodPlans.get(className) || [];
  const ifaces = t.interfaces.map((i) => model.csType(i, t.generic)).filter((i) => {
    const e = types.EVENT_INTERFACES[i.split('.').pop()];
    // a Unity event interface stays only when its method exists here or in a base (else CS0535)
    return !e || [className, ...model.ancestors(className)].some((c) => (p.methodPlans.get(c) || []).some((m) => m.name === e[0]));
  });
  const heads = [base, ...ifaces].filter(Boolean);
  const cf = p.classFields.get(className) || { serialized: [], runtime: [], statics: [] };
  const serializable = !base && (t.kind === 'struct' || cf.serialized.length || cf.runtime.length);
  if (serializable) lines.push(`${pad}[System.Serializable]`);
  lines.push(`${pad}public ${t.kind === 'struct' ? 'struct' : t.abstract ? 'abstract class' : 'class'} ${name}${generic}${heads.length ? ' : ' + heads.join(', ') : ''}`, `${pad}{`);
  const isStruct = t.kind === 'struct';
  const init = (f) => { if (isStruct) return ''; const v = literal(f.init, f.type, model); return v === undefined ? '' : ' = ' + v; };
  for (const f of cf.serialized) lines.push(`${pad}    public ${f.type} ${ident(f.name)}${init(f)};${f.note || ''}`);
  for (const f of cf.runtime) lines.push(`${pad}    ${isStruct ? '' : '[System.NonSerialized] '}public ${f.type} ${ident(f.name)}${init(f)};`);
  for (const f of cf.statics) lines.push(`${pad}    public static ${f.type} ${ident(f.name)}${literal(f.init, f.type, model) !== undefined ? ' = ' + literal(f.init, f.type, model) : ''};`);
  if (cf.serialized.length || cf.runtime.length || cf.statics.length) lines.push('');
  const memberNames = new Set([...cf.serialized, ...cf.runtime, ...cf.statics].map((f) => f.name));
  for (const [isStatic, props] of [[false, t.props], [true, t.statics.props]]) {
    for (const [pname, src] of Object.entries(props)) {
      if (memberNames.has(pname) || plans.some((m) => m.name === pname) || !/^[A-Za-z_]\w*$/.test(pname)) continue;
      memberNames.add(pname);
      lines.push(...propertyLines(p, t, pname, src, isStatic, pad), '');
    }
  }
  const emitted = new Set();
  for (const m of plans) {
    const body = (m.isStatic ? t.statics.methods : t.methods)[m.raw];
    const tr = translateFunction(body);
    const access = m.unity && !m.virtual && !m.override ? '' : m.unity ? 'protected ' : 'public ';
    const mods = m.isStatic ? 'static ' : m.override ? 'override ' : m.virtual ? 'virtual ' : '';
    const ret = m.coroutine ? 'System.Collections.IEnumerator' : m.ret;
    lines.push(`${pad}    ${access}${mods}${ret} ${m.name}(${m.paramText.join(', ')})`, `${pad}    {`);
    if (tr && tr.lines.length) {
      const jsParams = tr.params.length && !m.fixed ? ` — tham số gốc: (${tr.params.join(', ')})` : tr.params.length ? ` — tham số gốc: (${tr.params.join(', ')})` : '';
      lines.push(`${pad}        // Dịch tự động từ JavaScript${jsParams}; kiểm tra rồi bỏ comment:`);
      // multi-line lambdas come back as one string: comment every physical line, or the rest becomes code
      for (const l of tr.lines) for (const sub of commentSafe(l).split('\n')) lines.push(`${pad}        // ${sub}`);
    } else lines.push(...jsComment(body, pad + '        '));
    if (m.coroutine) lines.push(`${pad}        yield break;`);
    else if (ret !== 'void') lines.push(`${pad}        return default;`);
    lines.push(`${pad}    }`, '');
    emitted.add(m.base);
  }
  // UnityEvent targets the build calls but whose body was stripped: keep the binding alive
  const events = (p.eventMethods && p.eventMethods.get(className)) || new Map();
  for (const [mName, param] of events) {
    if (emitted.has(mName)) continue;
    lines.push(`${pad}    public void ${ident(mName)}(${param})`, `${pad}    {`, `${pad}    }`, '');
  }
  // nested types (enums, structs, helper classes declared inside this one)
  for (const n of model.nestedIn(className)) lines.push(...classLines(p, n.name, null, nested, pad + '    '), '');
  if (t.init) lines.push(`${pad}    // giá trị khởi tạo gốc (ctors.init):`, ...jsComment(t.init, pad + '    '));
  while (lines[lines.length - 1] === '') lines.pop();
  lines.push(`${pad}}`);
  return lines;
}

/** Types the build has a deserializer for but no Bridge.define (very old Luna): fields only, as before. */
function legacyClassLines(p, className, kind, nested, pad) {
  const fields = serializedFields(p, className);
  const name = csTypeName(className).split('.').pop();
  const base = kind === 'scriptable' ? 'UnityEngine.ScriptableObject' : kind === 'serializable' ? null : 'UnityEngine.MonoBehaviour';
  const lines = [];
  if (kind === 'serializable') lines.push(`${pad}[System.Serializable]`);
  lines.push(`${pad}public class ${name}${base ? ' : ' + base : ''}`, `${pad}{`);
  const avail = (t) => p.typeAvailable(t);
  for (const f of fields) lines.push(`${pad}    public ${fieldType(f, p.csNestedName, avail)} ${ident(f.name)};${typeNote(f, avail)}`);
  lines.push(`${pad}}`);
  return lines;
}

const HEADER = [
  '// Dựng lại bởi Build Recover từ bản build Luna (Unity → Bridge.NET → JavaScript). Tên type, lớp cơ sở, field và kiểu',
  '// serialize là thật; kiểu tham số / giá trị trả về suy ra từ cách code dùng. Thân hàm được dịch tự động từ JavaScript',
  '// về C# và để trong comment: kiểm tra rồi bỏ comment.',
];

function classSource(p, className, kind) {
  plan(p);
  const model = p.typeModel;
  const ns = model.has(className) ? model.namespaceOf(className) : (() => { const full = csTypeName(className); const dot = full.lastIndexOf('.'); return dot > 0 ? full.slice(0, dot) : ''; })();
  const pad = ns ? '    ' : '';
  const body = classLines(p, className, kind, null, pad);
  const lines = [...HEADER, 'using UnityEngine;', ''];
  if (ns) lines.push(`namespace ${ns}`, '{');
  lines.push(...body);
  if (ns) lines.push('}');
  return lines.join('\n') + '\n';
}

// C# ends a // comment at \r, \n, U+0085, U+2028 and U+2029 — keep only \n as the line break
const LINE_BREAKS = new RegExp('[' + String.fromCharCode(0x85, 0x2028, 0x2029) + ']', 'g');
const CRLF = new RegExp(String.fromCharCode(13) + String.fromCharCode(10) + '?', 'g');
const commentSafe = (s) => String(s).replace(CRLF, String.fromCharCode(10)).replace(LINE_BREAKS, ' ');

function jsComment(src, indent) {
  const pretty = commentSafe(src || '').replace(/;(?=[^;\n])/g, ';\n').split('\n').slice(0, 200);
  return pretty.map((l) => `${indent}// ${l.trim()}`);
}

function writeOne(p, className, kind, guid) {
  const model = p.typeModel;
  const ns = model.has(className) ? model.namespaceOf(className) : '';
  const local = model.has(className) ? model.localName(className) : csTypeName(className).split('.').pop();
  const rel = p.claim(`Assets/Scripts/${ns ? ns.split('.').join('/') + '/' : ''}${local}.cs`);
  let src;
  try { src = classSource(p, className, kind); } catch (e) { src = `// Không dựng được ${className}: ${e.message}\nusing UnityEngine;\npublic class ${local} : MonoBehaviour { }\n`; }
  p.out.write(rel, src);
  const imp = importers.mono();
  const order = p.executionOrder && p.executionOrder.get(className);
  if (order) imp.MonoImporter.executionOrder = order;
  p.out.meta(rel, guid, imp);
  p.count('scripts');
}

function writeScripts(p) {
  plan(p);
  const model = p.typeModel;
  const done = new Set();
  // 1. scripts scenes/prefabs/assets use — their GUIDs are already in the YAML
  for (const [className, s] of p.scripts) {
    if (!s.user || done.has(className)) continue;
    done.add(className);
    // a type nested in another class is written inside it (Unity cannot bind a nested MonoBehaviour anyway)
    if (model.has(className) && model.get(className).outer) continue;
    writeOne(p, className, p.scriptKinds.get(className) || 'mono', s.guid);
  }
  // 2. every other type the code defines: base classes, Configs, enums, interfaces, helpers…
  for (const t of model.types.values()) {
    if (done.has(t.name) || t.outer) continue;
    done.add(t.name);
    const guid = ids.guidOf('script:' + t.name);
    p.scripts.set(t.name, { guid, user: true, generated: true });
    writeOne(p, t.name, null, guid);
    p.count('typesFromCode');
  }
  // 3. [Serializable] field types the build has no Bridge.define for (old Luna): one shared file
  const pending = p.nestedTypes || new Map();
  if (!pending.size) return;
  const lines = ['// Kiểu [Serializable] mà field của các script dùng — Build Recover gom về một file để không định nghĩa trùng.', 'using UnityEngine;', ''];
  const done2 = new Set();
  for (let changed = true; changed;) {
    changed = false;
    for (const [local, dto] of [...pending]) {
      if (done2.has(local)) continue;
      done2.add(local);
      changed = true;
      lines.push(...legacyClassLines(p, dto, 'serializable', null, ''), '');
    }
  }
  const rel = p.claim('Assets/Scripts/_RecoveredTypes.cs');
  p.out.write(rel, lines.join('\n') + '\n');
  p.out.meta(rel, ids.guidOf(rel), importers.mono());
}

module.exports = { writeScripts, bridgeDefine, objectEntries, serializedFields, csTypeName, plan, classSource };
