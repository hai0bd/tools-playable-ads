'use strict';
// The game's own types as Bridge.NET left them in a Luna build, and the C# types their code implies.
//
// Every user class survives as Bridge.define("Name", { $kind, inherits, fields, props, methods, statics, ctors }):
//   $kind      3 interface, 4 struct, 6 enum (+1000 when nested in another class); absent for a class
//   inherits   [Base, IFace…] or function(){return[Singleton$1(UserData)]} — the C# base class and interfaces
//   generic    Bridge.define("Singleton$1", function(e){return{…}}) — e is the type parameter
// so the C# can keep the real hierarchy, emit classes no scene uses (base classes, Configs, enums…), and type what
// JavaScript left untyped (parameters, returns, enum fields) from how the code uses each value.
const parser = require('@babel/parser');
const { closingIndex } = require('../schema');

const EXTERNAL = /^(Luna|UnityEngine|UnityEditor|Unity|System|Bridge|pc|DG|Spine|TMPro|Cinemachine|Newtonsoft|Microsoft|Sirenix|RootMotion|Mono|JetBrains)(\.|\$|$)/;
const SKIP_NAMES = /^IAmAnEmptyScriptJustToMakeCodelessProjectsCompileProperty$|\$AnonymousType|[<>]/;
const PRIMITIVES = { 'System.Int32': 'int', 'System.Single': 'float', 'System.Double': 'double', 'System.String': 'string', 'System.Boolean': 'bool', 'System.Int64': 'long', 'System.Object': 'object', 'System.Byte': 'byte', 'System.Char': 'char', 'System.Int16': 'short', 'System.UInt32': 'uint' };
const VALUE_OF_PC = { Vec2: 'UnityEngine.Vector2', Vec3: 'UnityEngine.Vector3', Vec4: 'UnityEngine.Vector4', Quat: 'UnityEngine.Quaternion', Color: 'UnityEngine.Color' };
const MEMBER_TYPES = {
  transform: 'UnityEngine.Transform', gameObject: 'UnityEngine.GameObject', position: 'UnityEngine.Vector3', localPosition: 'UnityEngine.Vector3',
  localScale: 'UnityEngine.Vector3', eulerAngles: 'UnityEngine.Vector3', localEulerAngles: 'UnityEngine.Vector3', rotation: 'UnityEngine.Quaternion',
  localRotation: 'UnityEngine.Quaternion', name: 'string', tag: 'string', text: 'string', length: 'int', Count: 'int', childCount: 'int',
  x: 'float', y: 'float', z: 'float', w: 'float', a: 'float', r: 'float', g: 'float', b: 'float', sprite: 'UnityEngine.Sprite', color: 'UnityEngine.Color',
};
const GENERIC_RETURN = /^(GetComponent|GetComponentInChildren|GetComponentInParent|AddComponent|FindObjectOfType|FindFirstObjectByType|Load)(\$\d+)?$/;
// Unity's UI event interfaces: the method name and parameter its implementation must have
const EVENT_INTERFACES = {
  IPointerClickHandler: ['OnPointerClick', 'PointerEventData'], IPointerDownHandler: ['OnPointerDown', 'PointerEventData'], IPointerUpHandler: ['OnPointerUp', 'PointerEventData'],
  IPointerEnterHandler: ['OnPointerEnter', 'PointerEventData'], IPointerExitHandler: ['OnPointerExit', 'PointerEventData'], IBeginDragHandler: ['OnBeginDrag', 'PointerEventData'],
  IDragHandler: ['OnDrag', 'PointerEventData'], IEndDragHandler: ['OnEndDrag', 'PointerEventData'], IDropHandler: ['OnDrop', 'PointerEventData'],
  IScrollHandler: ['OnScroll', 'PointerEventData'], IInitializePotentialDragHandler: ['OnInitializePotentialDrag', 'PointerEventData'],
  ISelectHandler: ['OnSelect', 'BaseEventData'], IDeselectHandler: ['OnDeselect', 'BaseEventData'], ISubmitHandler: ['OnSubmit', 'BaseEventData'],
  ICancelHandler: ['OnCancel', 'BaseEventData'], IUpdateSelectedHandler: ['OnUpdateSelected', 'BaseEventData'], IMoveHandler: ['OnMove', 'AxisEventData'],
};
const COMPONENT_BASES = /^UnityEngine\.(MonoBehaviour|Behaviour|Component)$/;
const BRIDGE_PLUMBING = /^(getHashCode|equals|\$clone|\$getType|toJSON|getDefaultValue|ctor|\$ctor\d*|\$initialize)$/;

/** Top-level "key: value" pairs of an object literal source (strings and nesting respected). */
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

/** "a, f(b, c), d" → ["a", "f(b, c)", "d"] */
function splitTop(src) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { out.push(src.slice(start, i).trim()); start = i + 1; }
  }
  if (src.slice(start).trim()) out.push(src.slice(start).trim());
  return out;
}

/** Source of Bridge.define("name", …) → { obj: object literal source, generic: [param names] } */
function readDefine(code, at, headLen) {
  let i = at + headLen;
  while (/\s/.test(code[i])) i++;
  if (code[i] === '{') {
    const close = closingIndex(code, i);
    return close < 0 ? null : { obj: code.slice(i, close + 1), generic: [] };
  }
  // generic: (function(e, t){ return { … } })
  const fn = code.slice(i, i + 200).match(/^\(?\s*function\s*\(([^)]*)\)\s*\{\s*return\s*/);
  if (!fn) return null;
  const open = code.indexOf('{', i + fn[0].length - 1);
  const close = closingIndex(code, open);
  if (close < 0) return null;
  return { obj: code.slice(open, close + 1), generic: fn[1].split(',').map((s) => s.trim()).filter(Boolean) };
}

const typeParamNames = (n) => (n === 1 ? ['T'] : Array.from({ length: n }, (_, k) => 'T' + (k + 1)));
/** "Singleton$1" → "Singleton"; "A+B" → "A.B" */
const cleanName = (t) => String(t).replace(/\+/g, '.').replace(/\$\d+$/, '');

class TypeModel {
  constructor(code) {
    this.code = code || '';
    this.types = new Map();
    this.sigs = null;
    const re = /Bridge\.define\("([^"]+)",/g;
    let m;
    while ((m = re.exec(this.code))) {
      const name = m[1];
      if (EXTERNAL.test(name) || SKIP_NAMES.test(name) || this.types.has(name)) continue;
      const d = readDefine(this.code, m.index, m[0].length);
      if (!d) continue;
      const e = objectEntries(d.obj);
      const k = Number(e.$kind) || 0;
      const kind = { 3: 'interface', 4: 'struct', 6: 'enum' }[k % 1000] || 'class';
      const statics = objectEntries(e.statics || '{}');
      this.types.set(name, {
        name, kind, entries: e, generic: d.generic, abstract: /^!0$/.test(e.$abstract || ''),
        fields: objectEntries(e.fields || '{}'), props: objectEntries(e.props || '{}'), methods: objectEntries(e.methods || '{}'),
        init: objectEntries(e.ctors || '{}').init || '',
        statics: { fields: objectEntries(statics.fields || '{}'), props: objectEntries(statics.props || '{}'), methods: objectEntries(statics.methods || '{}'), init: objectEntries(statics.ctors || '{}').init || '' },
        inheritsSrc: e.inherits || '',
      });
    }
    for (const t of this.types.values()) {
      t.outer = this.outerOf(t.name);
      const parents = this.inheritList(t);
      t.baseRaw = null;
      t.interfaces = [];
      for (const p of parents) {
        const head = p.replace(/\(.*$/, '').trim();
        const user = this.types.get(head);
        if (user && user.kind === 'interface') t.interfaces.push(p);
        else if (/^UnityEngine\.EventSystems\.I\w+Handler$/.test(head)) t.interfaces.push(p);
        else if (!t.baseRaw && (user || /^UnityEngine\./.test(head))) t.baseRaw = p;
      }
    }
  }

  /** Raw inherits entries: ["UnityEngine.MonoBehaviour", "IMakeup"] / ["Singleton$1(UserData)"] */
  inheritList(t) {
    let src = t.inheritsSrc.trim();
    if (!src) return [];
    const fn = src.match(/^function\s*\(\)\s*\{\s*return\s*(\[[^]*\])\s*;?\s*\}$/);
    if (fn) src = fn[1];
    if (src[0] !== '[') return [];
    return splitTop(src.slice(1, -1)).map((s) => s.replace(/Bridge\.ns\("([^"]+)"\)/g, '$1'));
  }

  has(name) { return this.types.has(name); }
  get(name) { return this.types.get(name); }

  /** "Outer.Inner" with Outer a user type → Outer; "Ns.Class" → null */
  outerOf(name) {
    const parts = String(name).split('.');
    for (let k = parts.length - 1; k > 0; k--) {
      const prefix = parts.slice(0, k).join('.');
      if (this.types.has(prefix)) return prefix;
    }
    return null;
  }
  /** Namespace of a top-level type ("DollBase.ItemSO" → "DollBase"). */
  namespaceOf(name) {
    const t = this.types.get(name);
    if (t && t.outer) return this.namespaceOf(t.outer);
    const i = cleanName(name).lastIndexOf('.');
    return i > 0 ? cleanName(name).slice(0, i) : '';
  }
  localName(name) { return cleanName(name).split('.').pop(); }
  nestedIn(outer) { return [...this.types.values()].filter((t) => t.outer === outer); }

  /** Bridge type expression → C# type ("Singleton$1(UserData)" → "Singleton<UserData>", "e" → "T"). */
  csType(expr, generic = []) {
    expr = String(expr || '').trim().replace(/Bridge\.ns\("([^"]+)"\)/g, '$1');
    if (!expr) return 'object';
    const gi = generic.indexOf(expr);
    if (gi >= 0) return typeParamNames(generic.length)[gi];
    if (PRIMITIVES[expr]) return PRIMITIVES[expr];
    const call = expr.match(/^([\w.$]+?)\$(\d+)\(([^]*)\)$/);
    if (call) return cleanName(call[1]) + '<' + splitTop(call[3]).map((a) => this.csType(a, generic)).join(', ') + '>';
    if (/^pc\.(\w+)$/.test(expr)) return VALUE_OF_PC[expr.slice(3)] || 'object';
    return cleanName(expr);
  }

  /** User ancestors, nearest first. */
  ancestors(name) {
    const out = [];
    const seen = new Set([name]);
    let t = this.types.get(name);
    while (t && t.baseRaw) {
      const head = t.baseRaw.replace(/\(.*$/, '').trim();
      if (!this.types.has(head) || seen.has(head)) break;
      seen.add(head);
      out.push(head);
      t = this.types.get(head);
    }
    return out;
  }
  descendants(name) { return [...this.types.keys()].filter((n) => this.ancestors(n).includes(name)); }
  /** The non-user type the hierarchy ends on ("UnityEngine.MonoBehaviour"), or null. */
  externalBase(name) {
    const chain = [name, ...this.ancestors(name)];
    const top = this.types.get(chain[chain.length - 1]);
    if (!top || !top.baseRaw) return null;
    const head = top.baseRaw.replace(/\(.*$/, '').trim();
    return this.types.has(head) ? null : head;
  }
  isComponent(name) { return COMPONENT_BASES.test(this.externalBase(name) || ''); }
  isScriptable(name) { return this.externalBase(name) === 'UnityEngine.ScriptableObject'; }
  /** Every field name a user ancestor declares (C# must not declare them again in the subclass). */
  inheritedFieldNames(name) {
    const out = new Set();
    for (const a of this.ancestors(name)) for (const f of Object.keys(this.types.get(a).fields)) out.add(f);
    return out;
  }
  enumNames() { return new Set([...this.types.values()].filter((t) => t.kind === 'enum').map((t) => t.name)); }
  enumValues(name) {
    const t = this.types.get(name);
    if (!t) return [];
    return Object.entries(t.statics.fields).filter(([, v]) => /^-?\d+$/.test(v.trim())).map(([k, v]) => [k, Number(v)]);
  }
}

// ---------------------------------------------------------------- type inference
const memberPath = (n) => {
  if (!n) return null;
  if (n.type === 'Identifier') return n.name;
  if (n.type === 'ThisExpression') return 'this';
  if (n.type === 'MemberExpression' && !n.computed) { const o = memberPath(n.object); return o ? o + '.' + n.property.name : null; }
  return null;
};
const isThisField = (n) => n && n.type === 'MemberExpression' && !n.computed && n.object.type === 'ThisExpression' ? n.property.name : null;
const isVoid0 = (n) => n && n.type === 'UnaryExpression' && n.operator === 'void';

function litType(n) {
  if (!n) return null;
  if (n.type === 'NumericLiteral') return Number.isInteger(n.value) && !/[.e]/i.test((n.extra && n.extra.raw) || '') ? 'int' : 'float';
  if (n.type === 'StringLiteral' || n.type === 'TemplateLiteral') return 'string';
  if (n.type === 'BooleanLiteral') return 'bool';
  if (n.type === 'UnaryExpression' && n.operator === '!' && n.argument.type === 'NumericLiteral') return 'bool';
  if (n.type === 'UnaryExpression' && n.operator === '-' && n.argument.type === 'NumericLiteral') return litType(n.argument);
  return null;
}

/** C# literal for a default parameter value, or undefined when it has none. */
function literalValue(n, type, model) {
  if (!n) return undefined;
  if (n.type === 'NullLiteral' || isVoid0(n)) return /^(int|float|double|bool|long|UnityEngine\.(Vector[234]|Quaternion|Color))$/.test(type) || model.enumNames().has(type) ? undefined : 'null';
  if (n.type === 'UnaryExpression' && n.operator === '!' && n.argument.type === 'NumericLiteral') return n.argument.value ? 'false' : 'true';
  if (n.type === 'BooleanLiteral') return String(n.value);
  if (n.type === 'StringLiteral') return JSON.stringify(n.value);
  if (n.type === 'NumericLiteral' || (n.type === 'UnaryExpression' && n.operator === '-' && n.argument.type === 'NumericLiteral')) {
    const v = n.type === 'NumericLiteral' ? n.value : -n.argument.value;
    if (type === 'float') return v + 'f';
    if (type === 'int' || type === 'double' || type === 'long') return Number.isInteger(v) || type === 'double' ? String(v) : undefined;
    return model.enumNames().has(type) ? undefined : undefined;
  }
  const p = memberPath(n);
  if (p && model.enumNames().has(p.slice(0, p.lastIndexOf('.')))) return cleanName(p);
  return undefined;
}

class Votes {
  constructor() { this.m = new Map(); }
  add(type, w) { if (!type || type === 'void') return; this.m.set(type, (this.m.get(type) || 0) + w); }
  best() {
    if (!this.m.size) return null;
    const s = [...this.m].sort((a, b) => b[1] - a[1]);
    // an int that also shows up as float (1 and 0.5 passed to the same parameter) is a float
    if (s[0][0] === 'int' && this.m.has('float')) return 'float';
    return s[0][0];
  }
}

function walk(node, fn, parent) {
  if (!node || typeof node.type !== 'string') return;
  fn(node, parent);
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra' || k === 'leadingComments' || k === 'trailingComments') continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((x) => x && typeof x.type === 'string' && walk(x, fn, node));
    else if (v && typeof v.type === 'string') walk(v, fn, node);
  }
}

function parseFn(src) {
  try {
    const ast = parser.parse('(' + src + ')', { sourceType: 'script', errorRecovery: true });
    const fn = ast.program.body[0] && ast.program.body[0].expression;
    return fn && (fn.type === 'FunctionExpression' || fn.type === 'ArrowFunctionExpression') ? fn : null;
  } catch { return null; }
}

/**
 * Signatures of every user method: class → raw method name → { params: [{name, type, def}], ret, coroutine }.
 * fieldTypeOf(cls, field) gives the C# type of a field the writer already settled (serialized data, init values).
 */
function inferSignatures(model, fieldTypeOf) {
  const enums = model.enumNames();
  const methods = [];   // { cls, name, isStatic, fn, params }
  for (const t of model.types.values()) {
    for (const [isStatic, list] of [[false, t.methods], [true, t.statics.methods]]) {
      for (const [name, src] of Object.entries(list)) {
        const fn = parseFn(src);
        if (!fn) continue;
        methods.push({ cls: t.name, name, isStatic, fn, src, params: fn.params.map((p) => (p.type === 'Identifier' ? p.name : '_')) });
      }
    }
  }
  const byClass = new Map();
  for (const m of methods) { if (!byClass.has(m.cls)) byClass.set(m.cls, new Map()); byClass.get(m.cls).set(m.name, m); }
  const byName = new Map();   // raw method name → [methods]
  for (const m of methods) { if (!byName.has(m.name)) byName.set(m.name, []); byName.get(m.name).push(m); }
  const lookup = (cls, name) => {
    for (const c of [cls, ...model.ancestors(cls)]) { const m = byClass.get(c) && byClass.get(c).get(name); if (m) return m; }
    return null;
  };
  const sig = new Map(methods.map((m) => [m, { params: m.params.map(() => null), defs: m.params.map(() => undefined), ret: null }]));
  const generic = (cls) => (model.get(cls) || {}).generic || [];
  const fieldOf = (cls, f) => {
    for (const c of [cls, ...model.ancestors(cls)]) { const ty = fieldTypeOf(c, f); if (ty) return ty; }
    return null;
  };
  // static member type: "GamesManager.Instance" → GamesManager
  const staticOf = (path) => {
    const i = path.lastIndexOf('.');
    const cls = path.slice(0, i), f = path.slice(i + 1);
    if (!model.has(cls)) return null;
    return fieldTypeOf(cls, f, true);
  };

  function exprType(n, m, paramTypes) {
    if (!n) return null;
    const lt = litType(n);
    if (lt) return lt;
    switch (n.type) {
      case 'ParenthesizedExpression': return exprType(n.expression, m, paramTypes);
      case 'SequenceExpression': return exprType(n.expressions[n.expressions.length - 1], m, paramTypes);
      case 'Identifier': { const i = m.params.indexOf(n.name); return i >= 0 ? paramTypes[i] : null; }
      case 'MemberExpression': {
        const tf = isThisField(n);
        if (tf) return fieldOf(m.cls, tf);
        const p = memberPath(n);
        if (p) {
          const prefix = p.slice(0, p.lastIndexOf('.'));
          if (enums.has(prefix)) return cleanName(prefix);
          const st = staticOf(p);
          if (st) return st;
        }
        if (!n.computed && MEMBER_TYPES[n.property.name]) return MEMBER_TYPES[n.property.name];
        return null;
      }
      case 'NewExpression': {
        const c = n.callee;
        const p = memberPath(c) || '';
        if (/^pc\.\w+$/.test(p)) return VALUE_OF_PC[p.slice(3)] || null;
        if (/^UnityEngine\.\w+$/.test(p)) return p;
        if (c.type === 'MemberExpression' && /^(ctor|\$ctor\d+)$/.test(c.property.name)) return model.csType(memberPath(c.object) || '', generic(m.cls));
        if (model.has(p)) return cleanName(p);
        return null;
      }
      case 'CallExpression': {
        const c = n.callee;
        const p = memberPath(c) || '';
        const last = c.type === 'MemberExpression' && !c.computed ? c.property.name : '';
        if ((p === 'Bridge.as' || p === 'Bridge.cast') && n.arguments[1]) return model.csType(memberPath(n.arguments[1]) || '', generic(m.cls));
        if (GENERIC_RETURN.test(last) && n.arguments[0] && /^(UnityEngine|TMPro|Spine)\.|^[A-Z]/.test(memberPath(n.arguments[0]) || '')) {
          const tp = memberPath(n.arguments[0]);
          if (model.has(tp) || /^(UnityEngine|TMPro|Spine)\./.test(tp)) return cleanName(tp);
        }
        if (last === '$clone' && c.type === 'MemberExpression') return exprType(c.object, m, paramTypes);
        if (last === 'toString' || p === 'System.String.format' || p === 'System.String.concat') return 'string';
        if (/^(UnityEngine\.)?Mathf\.\w+$|^Math\.\w+$/.test(p)) return /RoundToInt|FloorToInt|CeilToInt/.test(p) ? 'int' : 'float';
        if (/^UnityEngine\.(Vector[234]|Quaternion)\.(op_\w+|Lerp|MoveTowards|Slerp|Euler)$/.test(p)) return 'UnityEngine.' + p.split('.')[1];
        if (c.type === 'MemberExpression' && c.object.type === 'ThisExpression') { const t = lookup(m.cls, last); return t ? sig.get(t).ret : null; }
        return null;
      }
      case 'BinaryExpression': {
        if (n.operator === '|' && n.right.type === 'NumericLiteral' && n.right.value === 0) return 'int';
        if (/^(===|!==|==|!=|<|>|<=|>=|instanceof|in)$/.test(n.operator)) return 'bool';
        const a = exprType(n.left, m, paramTypes), b = exprType(n.right, m, paramTypes);
        if (n.operator === '+' && (a === 'string' || b === 'string')) return 'string';
        if (/^[-+*/%]$/.test(n.operator)) {
          if (a === 'int' && b === 'int') return n.operator === '/' ? null : 'int';
          if ((a === 'float' || a === 'int') && (b === 'float' || b === 'int')) return 'float';
        }
        return null;
      }
      case 'LogicalExpression': { const a = exprType(n.left, m, paramTypes), b = exprType(n.right, m, paramTypes); return a === 'bool' && b === 'bool' ? 'bool' : null; }
      case 'UnaryExpression': return n.operator === '!' ? 'bool' : n.operator === '-' ? exprType(n.argument, m, paramTypes) : null;
      case 'ConditionalExpression': { const a = exprType(n.consequent, m, paramTypes), b = exprType(n.alternate, m, paramTypes); return a && a === b ? a : a === 'int' && b === 'float' ? 'float' : null; }
      default: return null;
    }
  }

  // receiver class of a call: this.M(), this.field.M(), Cls.Instance.M(), Cls.M()
  function receiverClass(callee, m) {
    if (callee.type !== 'MemberExpression') return null;
    const o = callee.object;
    if (o.type === 'ThisExpression') return m.cls;
    const tf = isThisField(o);
    let ty = tf ? fieldOf(m.cls, tf) : null;
    const p = memberPath(o);
    if (!ty && p && model.has(p)) return p;
    if (!ty && p) ty = staticOf(p);
    return ty && model.has(ty) ? ty : null;
  }

  for (let pass = 0; pass < 4; pass++) {
    const votes = new Map(methods.map((m) => [m, { params: m.params.map(() => new Votes()), ret: new Votes() }]));
    for (const m of methods) {
      const cur = sig.get(m);
      const v = votes.get(m);
      const pi = (n) => (n && n.type === 'Identifier' ? m.params.indexOf(n.name) : -1);
      walk(m.fn.body, (n, parent) => {
        // nested functions: their own parameters shadow, but uses of ours still count
        if (n.type === 'AssignmentExpression' && n.operator === '=') {
          const i = pi(n.right), tf = isThisField(n.left);
          if (i >= 0 && tf) v.params[i].add(fieldOf(m.cls, tf), 3);
          // Bridge optional parameter: void 0 === e && (e = 5)
          const j = pi(n.left);
          if (j >= 0 && parent && parent.type === 'LogicalExpression' && parent.left.type === 'BinaryExpression' && (isVoid0(parent.left.left) || isVoid0(parent.left.right) || parent.left.left.type === 'NullLiteral')) {
            const lt = exprType(n.right, m, cur.params);
            if (lt) v.params[j].add(lt, 3);
            cur.defs[j] = n.right;
          }
        }
        if (n.type === 'BinaryExpression' && /^(===|!==|==|!=)$/.test(n.operator)) {
          for (const [a, b] of [[n.left, n.right], [n.right, n.left]]) {
            const i = pi(a);
            if (i < 0 || b.type === 'NullLiteral' || isVoid0(b)) continue;
            const t = exprType(b, m, cur.params);
            if (t) v.params[i].add(t, t && enums.has(t) ? 3 : 1);
          }
        }
        if (n.type === 'BinaryExpression' && n.operator === '|' && n.right.type === 'NumericLiteral' && n.right.value === 0) {
          walk(n.left, (x) => { const i = pi(x); if (i >= 0) v.params[i].add('int', 2); });
        }
        if (n.type === 'MemberExpression' && n.computed) { const i = pi(n.property); if (i >= 0) v.params[i].add('int', 2); }
        if (n.type === 'SwitchStatement') {
          const i = pi(n.discriminant);
          if (i >= 0) for (const cs of n.cases) { const t = cs.test && exprType(cs.test, m, cur.params); if (t) v.params[i].add(t, enums.has(t) ? 3 : 1); }
        }
        if ((n.type === 'IfStatement' || n.type === 'ConditionalExpression') && pi(n.test) >= 0) v.params[pi(n.test)].add('bool', 1);
        if (n.type === 'UnaryExpression' && n.operator === '!' && pi(n.argument) >= 0) v.params[pi(n.argument)].add('bool', 1);
        if (n.type === 'CallExpression' && pi(n.callee) >= 0 && !n.arguments.length) v.params[pi(n.callee)].add('System.Action', 3);
        if (n.type === 'CallExpression') {
          const c = n.callee;
          const last = c.type === 'MemberExpression' && !c.computed ? c.property.name : '';
          // our parameter passed on to an API whose parameter type is known
          n.arguments.forEach((a, k) => {
            const i = pi(a);
            if (i < 0) return;
            if (last === 'SetActive' || last === 'SetBool' || last === 'enabled') v.params[i].add('bool', 2);
            if (/^UnityEngine\.WaitForSeconds$/.test(memberPath(c) || '')) v.params[i].add('float', 2);
            const rc = receiverClass(c, m);
            const target = rc ? lookup(rc, last) : (byName.get(last) || []).length === 1 ? byName.get(last)[0] : null;
            if (target && sig.get(target).params[k]) v.params[i].add(sig.get(target).params[k], 2);
          });
          // call-site evidence for the callee's parameters
          const rc = receiverClass(c, m);
          const cands = rc ? [lookup(rc, last)].filter(Boolean) : (byName.get(last) || []).length === 1 ? byName.get(last) : [];
          for (const target of cands) {
            const tv = votes.get(target);
            n.arguments.forEach((a, k) => { if (k < tv.params.length) tv.params[k].add(exprType(a, m, cur.params), 2); });
          }
        }
        if (n.type === 'NewExpression' && /^pc\.Vec\d$/.test(memberPath(n.callee) || '')) n.arguments.forEach((a) => { const i = pi(a); if (i >= 0) v.params[i].add('float', 1); });
        if (n.type === 'MemberExpression' && !n.computed) {
          const i = pi(n.object);
          if (i >= 0 && n.property.name === 'z') v.params[i].add('UnityEngine.Vector3', 1);
          if (i >= 0 && /^(transform|gameObject|GetComponent|GetComponentInChildren)$/.test(n.property.name)) v.params[i].add('UnityEngine.Component', 1);
        }
        if (n.type === 'ReturnStatement' && n.argument && !isInsideNested(m.fn, n)) v.ret.add(exprType(n.argument, m, cur.params) || 'object', 1);
      });
    }
    for (const m of methods) {
      const s = sig.get(m), v = votes.get(m);
      s.params = v.params.map((x) => x.best());
      s.ret = /GeneratorEnumerator/.test(m.src) ? 'System.Collections.IEnumerator' : v.ret.best();
    }
  }
  const out = new Map();
  for (const m of methods) {
    const s = sig.get(m);
    const isCoroutine = /GeneratorEnumerator/.test(m.src);
    if (!out.has(m.cls)) out.set(m.cls, new Map());
    out.get(m.cls).set(m.name, {
      params: m.params.map((name, i) => {
        const type = s.params[i] || 'object';
        const def = s.defs[i] === undefined ? undefined : literalValue(s.defs[i], type, model);
        return { name, type, def };
      }),
      ret: s.ret || 'void', isStatic: m.isStatic, coroutine: isCoroutine,
    });
  }
  return out;
}

/** Is `node` inside a function nested in `fn` (a lambda), not in fn's own body? */
function isInsideNested(fn, node) {
  let inside = false;
  walk(fn.body, (n) => {
    if (inside || n === fn) return;
    if ((n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') && n.start <= node.start && n.end >= node.end) inside = true;
  });
  return inside;
}

module.exports = { TypeModel, inferSignatures, objectEntries, splitTop, cleanName, typeParamNames, EVENT_INTERFACES, BRIDGE_PLUMBING, parseFn, litType, walk, memberPath };
