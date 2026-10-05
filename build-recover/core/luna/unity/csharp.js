'use strict';
// C# for the game's own MonoBehaviours / ScriptableObjects / [Serializable] classes.
// Luna compiled them with Bridge.NET; the build keeps, per class:
//   - the Deserializer (exact serialized field names, reference vs value, Vector3/Color/List<T>…)
//   - Bridge.define("Name", { inherits, fields, ctors: { init }, methods, statics })
// This first pass writes classes that compile and carry every serialized field with the right type, so the
// recovered scenes/prefabs keep their data; method bodies are attached as the compiled JavaScript for reference.
const { closingIndex } = require('../schema');
const { importers } = require('./project');
const { translateFunction } = require('./js2cs');
const ids = require('./ids');

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

/** Type name as C# source: "UnityEngine.UI.Image" → "UnityEngine.UI.Image" (fully qualified keeps usings trivial). */
function csTypeName(t) {
  if (!t) return 'UnityEngine.Object';
  return String(t).replace(/\+/g, '.').replace(/\$\d+$/, '');
}

/** Bridge.define source of a class, or null. */
function bridgeDefine(code, name) {
  const key = `Bridge.define("${name}",`;
  const at = code.indexOf(key);
  if (at < 0) return null;
  const open = code.indexOf('{', at + key.length);
  const close = closingIndex(code, open);
  return close < 0 ? null : code.slice(open, close + 1);
}

/** Top-level keys of an object literal source → { key: source text }. */
function objectEntries(src) {
  const out = {};
  if (!src || src[0] !== '{') return out;
  let depth = 0, str = null, keyStart = 1, key = null, valStart = -1;
  for (let i = 1; i < src.length - 1; i++) {
    const c = src[i];
    if (str) { if (c === '\\') i++; else if (c === str) str = null; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if ('{[('.includes(c)) depth++;
    else if ('}])'.includes(c)) depth--;
    else if (depth === 0 && c === ':' && key === null) { key = src.slice(keyStart, i).trim().replace(/^["']|["']$/g, ''); valStart = i + 1; }
    else if (depth === 0 && c === ',') { if (key !== null) out[key] = src.slice(valStart, i).trim(); key = null; keyStart = i + 1; }
  }
  if (key !== null) out[key] = src.slice(valStart, src.length - 1).trim();
  return out;
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
      const types = [...new Set(flat.map((v) => v.type))];
      f.refType = types.length === 1 ? types[0] : types.length ? commonBase(types) : null;
    }
    if (f.kind === 'plain' || f.kind === 'plainArray') {
      const flat = vals.flatMap((v) => (Array.isArray(v) ? v : [v]));
      if (flat.some((v) => typeof v === 'string')) f.plainType = 'string';
      else if (flat.length && flat.every((v) => typeof v === 'number' && Number.isInteger(v)) && p.intHint(className, f.name)) f.plainType = 'int';
      else f.plainType = flat.length && flat.every((v) => typeof v === 'boolean') ? 'bool' : 'float';
    }
  }
  return fields;
}

function commonBase(types) {
  if (types.every((t) => /Transform$/.test(t))) return 'UnityEngine.Transform';
  if (types.every((t) => /^UnityEngine\.UI\./.test(t) || /TextMeshProUGUI/.test(t))) return 'UnityEngine.UI.Graphic';
  if (types.every((t) => /Collider2D$/.test(t))) return 'UnityEngine.Collider2D';
  if (types.every((t) => /Collider$/.test(t))) return 'UnityEngine.Collider';
  if (types.every((t) => /Renderer$/.test(t))) return 'UnityEngine.Renderer';
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

function methodComments(defSrc) {
  const parts = objectEntries(defSrc);
  const methods = objectEntries(parts.methods || '{}');
  const statics = objectEntries(parts.statics || '{}');
  return {
    methods, staticMethods: objectEntries(statics.methods || '{}'), init: objectEntries(parts.ctors || '{}').init || '', inherits: parts.inherits || '',
    fields: objectEntries(parts.fields || '{}'), staticFields: objectEntries(statics.fields || '{}'),
  };
}

/** Type of a runtime-only field from its Bridge default and the ctor init assignment. */
function runtimeFields(p, className, info, serialized) {
  const out = [];
  const initSrc = info.init || '';
  const typeFrom = (name, def, isStatic) => {
    const init = (initSrc.match(new RegExp(`this\\.${name}\\s*=\\s*([^,}]+(?:\\([^)]*\\)[^,}]*)?)`)) || [])[1] || '';
    const list = init.match(/List\$1\(([\w.]+)\)/);
    if (list) return `System.Collections.Generic.List<${p.typeAvailable(list[1]) || /^System\./.test(list[1]) ? csTypeName(list[1]).replace(/^System\.(Int32|Single|String|Boolean)$/, (x, t) => ({ Int32: 'int', Single: 'float', String: 'string', Boolean: 'bool' })[t]) : 'UnityEngine.Object'}>`;
    const nw = init.match(/^new\s+(UnityEngine\.\w+)/);
    if (nw) return nw[1];
    const v = (def || '').trim();
    if (v === '!1' || v === '!0' || /^(true|false)$/.test(v)) return 'bool';
    if (/^-?[\d.]+(e[-+]?\d+)?$/i.test(v)) return p.intHint(className, name) ? 'int' : 'float';
    if (/^["']/.test(v)) return 'string';
    if (isStatic && /^[Ii]nstance$/.test(name)) return csTypeName(className);
    return 'object';
  };
  for (const [name, def] of Object.entries(info.fields || {})) if (!serialized.has(name) && /^[A-Za-z_]\w*$/.test(name)) out.push({ name, type: typeFrom(name, def, false) });
  for (const [name, def] of Object.entries(info.staticFields || {})) if (/^[A-Za-z_]\w*$/.test(name)) out.push({ name, type: typeFrom(name, def, true), isStatic: true });
  return out;
}

/** Lines of one class (no namespace/usings). Nested [Serializable] field types are collected into `nested`. */
function classLines(p, className, kind, nested, pad) {
  const code = p.m.x.code;
  const def = bridgeDefine(code, className);
  const info = def ? methodComments(def) : { methods: {}, staticMethods: {}, init: '', inherits: '' };
  const nestedName = (dto) => {
    const clean = csTypeName(dto);
    if (/^(UnityEngine|TMPro|Spine|DG|Cinemachine|System)\./.test(clean)) return clean;
    const local = clean.split('.').pop();
    if (!nested.has(dto)) nested.set(dto, local);
    return local;
  };
  const fields = serializedFields(p, className);
  const name = csTypeName(className).split('.').pop();
  const base = kind === 'scriptable' ? 'UnityEngine.ScriptableObject' : kind === 'serializable' ? null : 'UnityEngine.MonoBehaviour';
  const lines = [];
  if (kind === 'serializable') lines.push(`${pad}[System.Serializable]`);
  lines.push(`${pad}public class ${name}${base ? ' : ' + base : ''}`, `${pad}{`);
  const avail = (t) => p.typeAvailable(t);
  for (const f of fields) lines.push(`${pad}    public ${fieldType(f, nestedName, avail)} ${ident(f.name)};${typeNote(f, avail)}`);
  // fields the game keeps at runtime only (Bridge "fields"/"statics" minus the serialized ones)
  const extra = runtimeFields(p, className, info, new Set(fields.map((f) => f.name)));
  for (const f of extra) lines.push(`${pad}    ${f.isStatic ? 'public static' : '[System.NonSerialized] public'} ${f.type} ${ident(f.name)};`);
  if (fields.length || extra.length) lines.push('');
  const methodName = (m) => ident(m.replace(/\$(\d+)$/, '_$1'));
  const events = p.eventMethods.get(className) || new Map();
  const emitted = new Set();
  const emitMethod = (mName, body, isStatic) => {
    const unity = !isStatic && Object.prototype.hasOwnProperty.call(UNITY_MSG, mName);
    const isCoroutine = /GeneratorEnumerator/.test(body);
    const tr = translateFunction(body);
    const clean = methodName(mName);
    // UnityEvent targets (Button.onClick…) must keep the signature the scene binds to
    const evParam = events.get(mName.replace(/\$\d+$/, ''));
    const params = unity ? UNITY_MSG[mName] : evParam != null ? evParam : '';
    const ret = unity ? 'void' : isCoroutine ? 'public System.Collections.IEnumerator' : isStatic ? 'public static void' : 'public void';
    lines.push(`${pad}    ${ret} ${clean}(${params})`, `${pad}    {`);
    if (tr && tr.lines.length) {
      const jsParams = tr.params.length ? ` — tham số gốc: (${tr.params.join(', ')})` : '';
      lines.push(`${pad}        // Dịch tự động từ JavaScript${jsParams}; kiểm tra kiểu rồi bỏ comment:`);
      // multi-line lambdas come back as one string: comment every physical line, or the rest becomes code
      for (const l of tr.lines) for (const sub of commentSafe(l).split('\n')) lines.push(`${pad}        // ${sub}`);
    } else lines.push(...jsComment(body, pad + '        '));
    if (isCoroutine) lines.push(`${pad}        yield break;`);
    lines.push(`${pad}    }`, '');
    emitted.add(mName.replace(/\$\d+$/, ''));
  };
  for (const [mName, body] of Object.entries(info.methods)) emitMethod(mName, body, false);
  for (const [mName, body] of Object.entries(info.staticMethods)) emitMethod(mName, body, true);
  // event targets the build calls but whose body was stripped: keep the binding alive
  for (const [mName, param] of events) {
    if (emitted.has(mName)) continue;
    lines.push(`${pad}    public void ${ident(mName)}(${param})`, `${pad}    {`, `${pad}    }`, '');
  }
  if (info.init) lines.push(`${pad}    // giá trị khởi tạo gốc (ctors.init):`, ...jsComment(info.init, pad + '    '));
  lines.push(`${pad}}`);
  return lines;
}

function classSource(p, className, kind) {
  const full = csTypeName(className);
  const dot = full.lastIndexOf('.');
  const ns = dot > 0 ? full.slice(0, dot) : '';
  const pad = ns ? '    ' : '';
  const nested = new Map();
  const body = classLines(p, className, kind, nested, pad);
  // [Serializable] types used by fields go to one shared file (global namespace, written by writeScripts): two
  // scripts sharing a type must not both define it, and every namespace can see the global one
  if (!p.nestedTypes) p.nestedTypes = new Map();
  for (const [dto, local] of nested) if (!p.nestedTypes.has(local)) p.nestedTypes.set(local, dto);
  const lines = [
    '// Dựng lại bởi Build Recover từ bản build Luna (Unity → Bridge.NET → JavaScript). Tên class, field và kiểu serialize',
    '// là thật. Thân hàm được dịch tự động từ JavaScript về C# và để trong comment: kiểm tra kiểu rồi bỏ comment.',
    'using UnityEngine;', '',
  ];
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
  const pretty = commentSafe(src).replace(/;(?=[^;\n])/g, ';\n').split('\n').slice(0, 200);
  return pretty.map((l) => `${indent}// ${l.trim()}`);
}

function writeScripts(p) {
  const done = new Set();
  for (const [className, s] of p.scripts) {
    if (!s.user || done.has(className)) continue;
    done.add(className);
    const full = csTypeName(className);
    const parts = full.split('.');
    const rel = p.claim(`Assets/Scripts/${parts.slice(0, -1).join('/')}${parts.length > 1 ? '/' : ''}${parts[parts.length - 1]}.cs`);
    const kind = p.scriptKinds.get(className) || 'mono';
    let src;
    try { src = classSource(p, className, kind); } catch (e) { src = `// Không dựng được class ${className}: ${e.message}\nusing UnityEngine;\npublic class ${parts[parts.length - 1]} : MonoBehaviour { }\n`; }
    p.out.write(rel, src);
    const imp = importers.mono();
    const order = p.executionOrder && p.executionOrder.get(className);
    if (order) imp.MonoImporter.executionOrder = order;
    p.out.meta(rel, s.guid, imp);
    p.count('scripts');
  }
  // shared [Serializable] field types (and the types they use in turn)
  const types = p.nestedTypes || new Map();
  if (!types.size) return;
  const userNames = new Set([...p.scripts].filter(([, s]) => s.user).map(([c]) => csTypeName(c).split('.').pop()));
  const lines = [
    '// Kiểu [Serializable] mà field của các script dùng — Build Recover gom về một file để không định nghĩa trùng.',
    'using UnityEngine;', '',
  ];
  const done2 = new Set();
  for (let changed = true; changed;) {
    changed = false;
    for (const [local, dto] of [...types]) {
      if (done2.has(local)) continue;
      done2.add(local);
      changed = true;
      if (userNames.has(local)) continue;
      const nested = new Map();
      lines.push(...classLines(p, dto, 'serializable', nested, ''), '');
      for (const [d2, l2] of nested) if (!types.has(l2)) types.set(l2, d2);
    }
  }
  const rel = p.claim('Assets/Scripts/_RecoveredTypes.cs');
  p.out.write(rel, lines.join('\n') + '\n');
  p.out.meta(rel, ids.guidOf(rel), importers.mono());
}

module.exports = { writeScripts, bridgeDefine, objectEntries, serializedFields, csTypeName };
