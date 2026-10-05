'use strict';
// Decompile a Cocos Creator 3.x script bundle (SystemJS + Babel output) back into TypeScript sources.
//
//   System.register("chunks:///_virtual/Foo.ts", deps, function (_export, _context) {
//     var imports...; return { setters: [...], execute: function () { ...module body... } };
//   })
//
// Babel's loose class output (inheritsLoose / applyDecoratedDescriptor / initializerDefineProperty) is turned back
// into ES classes with @ccclass / @property decorators; TS enums, imports and exports are restored.
// All renames and rewrites are scope-aware (minifiers reuse short names in nested scopes).
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');
const { deobfuscate, cleanup } = require('./deobfuscate');
const { unmergeModules, GLOBAL_NAMES } = require('./unmerge');
const { reinlineClasses } = require('./reinline');
// a class/enum named like a global (Math, Object...) would shadow it inside its module
const safeName = (x) => (x && GLOBAL_NAMES.has(x) ? x + 'Class' : x);
const { decompressUuid } = require('../util/uuid');

const HELPER_DEP_RE = /rollupPluginModLoBabelHelpers|_rollupPluginBabelHelpers|babelHelpers/;
const VIRTUAL_RE = /^chunks:\/\/\/_virtual\//;
const GEN_OPTS = { comments: false, jsescOption: { minimal: true, quotes: 'single' } };
const PARSE_TS = { sourceType: 'module', plugins: ['typescript', 'decorators-legacy', 'classProperties'] };

function unparen(n) { while (n && t.isParenthesizedExpression(n)) n = n.expression; return n; }
const keyName = (p) => p && p.key && (p.key.name !== undefined ? p.key.name : p.key.value);

// ------------------------------------------------------------------ module discovery
function findModules(ast) {
  const mods = [];
  traverse(ast, {
    CallExpression(p) {
      const n = p.node;
      if (!(t.isMemberExpression(n.callee) && t.isIdentifier(n.callee.object, { name: 'System' }) && t.isIdentifier(n.callee.property, { name: 'register' }))) return;
      if (n.arguments.length < 3 || !t.isStringLiteral(n.arguments[0]) || !t.isArrayExpression(n.arguments[1]) || !t.isFunction(n.arguments[2])) return;
      mods.push({ id: n.arguments[0].value, deps: n.arguments[1].elements.map((e) => e && e.value), factoryPath: p.get('arguments.2') });
      p.skip();
    },
  });
  return mods;
}

function moduleFileName(id) {
  return id.replace(VIRTUAL_RE, '').replace(/^.*\//, '');
}

/** Pull setters / execute out of the factory: return { setters:[...], execute(){...} } */
function analyzeFactory(mod) {
  const fp = mod.factoryPath;
  const f = fp.node;
  const exportName = f.params[0] && t.isIdentifier(f.params[0]) ? f.params[0].name : null;
  const retIdx = f.body.body.findIndex((s) => t.isReturnStatement(s) && t.isObjectExpression(s.argument));
  if (retIdx < 0) return null;
  const retPath = fp.get(`body.body.${retIdx}`);
  const propsPaths = retPath.get('argument.properties');
  const setterPath = propsPaths.find((p) => keyName(p.node) === 'setters');
  const execPropPath = propsPaths.find((p) => keyName(p.node) === 'execute');
  if (!execPropPath) return null;
  const execPath = execPropPath.isObjectMethod() ? execPropPath : execPropPath.get('value');
  const bindings = [];
  const setters = setterPath ? setterPath.node.value : null;
  if (setters && t.isArrayExpression(setters)) {
    setters.elements.forEach((s, i) => {
      const dep = mod.deps[i];
      if (!s || !t.isFunction(s)) { bindings.push({ dep, sideEffect: true }); return; }
      const param = s.params[0] && s.params[0].name;
      const visit = (node) => {
        if (t.isExpressionStatement(node)) return visit(node.expression);
        if (t.isSequenceExpression(node)) return node.expressions.forEach(visit);
        if (t.isAssignmentExpression(node) && t.isIdentifier(node.left)) {
          const r = node.right;
          if (t.isMemberExpression(r) && t.isIdentifier(r.object, { name: param })) bindings.push({ local: node.left.name, imported: r.computed ? r.property.value : r.property.name, dep });
          else if (t.isIdentifier(r, { name: param })) bindings.push({ local: node.left.name, namespace: true, dep });
          else if (t.isAssignmentExpression(r)) { visit(r); const last = bindings[bindings.length - 1]; if (last) bindings.push({ ...last, local: node.left.name }); }
        }
      };
      (s.body.body || []).forEach(visit);
      if (!bindings.some((b) => b.dep === dep)) bindings.push({ dep, sideEffect: true });
    });
  }
  return { exportName, execPath, bindings };
}

// ------------------------------------------------------------------ recognizers
function enumFromIIFE(n) {
  n = unparen(n);
  if (!t.isCallExpression(n) || !t.isFunctionExpression(unparen(n.callee)) || n.arguments.length !== 1) return null;
  const fn = unparen(n.callee);
  if (fn.params.length !== 1 || !t.isIdentifier(fn.params[0])) return null;
  const arg = n.arguments[0];
  if (!(t.isObjectExpression(arg) && arg.properties.length === 0) && !t.isLogicalExpression(arg)) return null;
  const e = fn.params[0].name;
  const members = [];
  const stmts = fn.body.body;
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i];
    if (t.isReturnStatement(s) && t.isIdentifier(s.argument, { name: e })) { if (i !== stmts.length - 1) return null; continue; }
    if (!t.isExpressionStatement(s) || !t.isAssignmentExpression(s.expression)) return null;
    const a = s.expression;
    if (t.isMemberExpression(a.left) && a.left.computed && t.isAssignmentExpression(a.left.property)) {
      const inner = a.left.property;
      if (!t.isMemberExpression(inner.left) || !t.isIdentifier(inner.left.object, { name: e })) return null;
      members.push({ name: inner.left.computed ? inner.left.property.value : inner.left.property.name, value: inner.right });
    } else if (t.isMemberExpression(a.left) && t.isIdentifier(a.left.object, { name: e })) {
      members.push({ name: a.left.computed ? a.left.property.value : a.left.property.name, value: a.right });
    } else return null;
  }
  return members.length ? members : null;
}

/** Babel class IIFE: function (Super) { function Ctor(){...} ...; return Ctor; }(SuperExpr) */
function classFromIIFE(n) {
  n = unparen(n);
  if (!t.isCallExpression(n)) return null;
  const fn = unparen(n.callee);
  if (!t.isFunctionExpression(fn) || n.arguments.length > 1) return null;
  const body = fn.body.body;
  if (!body.length) return null;
  const last = body[body.length - 1];
  if (!t.isReturnStatement(last)) return null;
  let retName = null;
  if (t.isIdentifier(last.argument)) retName = last.argument.name;
  else if (t.isCallExpression(last.argument) && t.isIdentifier(last.argument.arguments[0])) retName = last.argument.arguments[0].name;
  if (!retName) return null;
  const ctorIdx = body.findIndex((s) => t.isFunctionDeclaration(s) && s.id && s.id.name === retName);
  if (ctorIdx < 0) return null;
  return { ctorName: retName, ctorIdx, superParam: fn.params[0] && t.isIdentifier(fn.params[0]) ? fn.params[0].name : null };
}

// ------------------------------------------------------------------ per module analysis
class ModuleDecompiler {
  constructor(mod, info) {
    this.mod = mod;
    this.info = info;
    this.helpers = new Map();       // local -> helper name
    this.importLocals = new Map();  // local -> binding
    this.classes = [];
    this.enums = [];
    this.rf = null;
    this.exports = [];
    this.warnings = [];
    for (const b of info.bindings) {
      if (!b.local) continue;
      if (HELPER_DEP_RE.test(b.dep || '')) this.helpers.set(b.local, b.imported);
      else this.importLocals.set(b.local, b);
    }
  }

  run() {
    const execPath = this.info.execPath;
    const bodyPaths = execPath.get('body.body');
    // _RF.push({}, cid, name) / _RF.pop()
    for (const sp of bodyPaths) {
      const s = sp.node;
      if (!t.isExpressionStatement(s) || !t.isCallExpression(s.expression) || !t.isMemberExpression(s.expression.callee)) continue;
      const c = s.expression.callee;
      if (!t.isMemberExpression(c.object) || !c.object.property || c.object.property.name !== '_RF') continue;
      if (c.property.name === 'push') { const a = s.expression.arguments; this.rf = { cid: a[1] && a[1].value, name: a[2] && a[2].value }; }
      sp.remove();
    }
    // locate class / enum IIFEs (kept in place; identified by node identity)
    const classByNode = new Map(), enumByNode = new Map(), enumLocals = new Set();
    execPath.traverse({
      CallExpression: {
        exit: (p) => {
          const en = enumFromIIFE(p.node);
          if (en) {
            const rec = { members: en, path: p, id: this.enums.length };
            // TS emits  E || (E = {})  or, for an exported enum,  E || (E = _export("Name", {}))
            const arg = unparen(p.node.arguments[0]);
            if (t.isLogicalExpression(arg, { operator: '||' }) && t.isIdentifier(arg.left)) {
              rec.local = arg.left.name;
              enumLocals.add(rec.local);
              const r = unparen(arg.right);
              const v = t.isAssignmentExpression(r) ? unparen(r.right) : null;
              if (v && t.isCallExpression(v) && this.info.exportName && t.isIdentifier(v.callee, { name: this.info.exportName }) && t.isStringLiteral(v.arguments[0])) rec.argExport = v.arguments[0].value;
            }
            this.enums.push(rec); enumByNode.set(p.node, rec); return;
          }
          const cls = classFromIIFE(p.node);
          if (cls) {
            const rec = { ...cls, path: p, fieldDecorators: new Map(), classDecorators: [], staticFields: [], id: this.classes.length };
            this.classes.push(rec);
            classByNode.set(p.node, rec);
          }
        },
      },
      FunctionExpression: {
        exit: (p) => {
          // class without methods/superclass: Babel emits the bare constructor  (U = function () { initializerDefineProperty(this, ...) })
          if (p.parentPath.isCallExpression({ callee: p.node }) || classByNode.has(p.node)) return;
          let decorated = false;
          traverse.cheap(p.node.body, (n) => { if (t.isCallExpression(n) && t.isIdentifier(n.callee) && this.helpers.get(n.callee.name) === "initializerDefineProperty" && t.isThisExpression(n.arguments[0])) decorated = true; });
          // empty class: ccclass("X")(C = function () {})  /  D(C = function () {}) with D = ccclass("X")
          if (!decorated) {
            let q = p.parentPath;
            if (q.isAssignmentExpression() && q.node.right === p.node) q = q.parentPath;
            const call = q.isCallExpression() ? q.node : null;
            const arg0 = call && unparen(call.arguments[0]);
            const isArg = arg0 === p.node || (t.isAssignmentExpression(arg0) && arg0.right === p.node);
            const c = call && call.callee;
            const looksCcclass = t.isCallExpression(c) && t.isIdentifier(c.callee) && t.isStringLiteral(c.arguments[0]) && c.arguments.length === 1;
            const viaLocal = t.isIdentifier(c) && p.node.body.body.length === 0;
            if (isArg && (looksCcclass || viaLocal) && p.node.params.length === 0) decorated = true;
          }
          // class with static fields only:  _export("X", function () {}).FIELD = value
          if (!decorated && this.info.exportName) {
            const call = p.parentPath;
            if (call.isCallExpression() && call.node.arguments[1] === p.node && t.isIdentifier(call.node.callee, { name: this.info.exportName })
              && call.parentPath.isMemberExpression({ object: call.node }) && call.parentPath.parentPath.isAssignmentExpression({ left: call.parentPath.node })) decorated = true;
          }
          if (!decorated) return;
          const rec = { bare: true, ctorName: p.node.id ? p.node.id.name : "", superParam: null, path: p, fieldDecorators: new Map(), classDecorators: [], staticFields: [], id: this.classes.length };
          this.classes.push(rec);
          classByNode.set(p.node, rec);
        },
      },
    });

    const env = new Map();
    const aliasToName = new Map();
    const decoratorLocals = new Map();
    const exportFn = this.info.exportName;
    const self = this;

    function evalExpr(n) {
      n = unparen(n);
      if (classByNode.has(n)) return { k: 'class', c: classByNode.get(n) };
      if (enumByNode.has(n)) {
        const e = enumByNode.get(n);
        if (e.local) { env.set(e.local, { k: 'enum', e }); aliasToName.set(e.local, { k: 'enum', e }); }
        if (e.argExport && !e.argExportDone) { e.argExportDone = true; self.exports.push({ name: e.argExport, value: { k: 'enum', e }, node: n }); }
        return { k: 'enum', e };
      }
      if (t.isUnaryExpression(n) && (n.operator === '!' || n.operator === 'void')) {
        const a = unparen(n.argument);
        if (enumByNode.has(a) || classByNode.has(a)) return evalExpr(a);
      }
      if (t.isIdentifier(n)) return env.has(n.name) ? env.get(n.name) : { k: 'ast', node: n };
      if (t.isSequenceExpression(n)) { let v; for (const e of n.expressions) v = evalExpr(e); return v; }
      if (t.isAssignmentExpression(n) && n.operator === '=') {
        if (t.isIdentifier(n.left)) { const v = evalExpr(n.right); env.set(n.left.name, v); return v; }
        if (t.isMemberExpression(n.left) && !n.left.computed) {
          const o = evalExpr(n.left.object);
          if (o.k === 'class') { o.c.staticFields.push({ key: n.left.property.name, value: n.right }); return { k: 'ast', node: n.right }; }
        }
        return { k: 'residual', node: n };
      }
      if (t.isLogicalExpression(n) && n.operator === '||') {
        const l = evalExpr(n.left);
        if (l.k === 'class') return l;
        return evalExpr(n.right);
      }
      if (t.isMemberExpression(n) && !n.computed && n.property.name === 'prototype') {
        const o = evalExpr(n.object);
        return o.k === 'class' ? { k: 'proto', c: o.c } : { k: 'ast', node: n };
      }
      if (t.isCallExpression(n)) {
        if (exportFn && t.isIdentifier(n.callee, { name: exportFn })) {
          if (t.isStringLiteral(n.arguments[0])) {
            // _export("X", void 0) only declares the binding up front; the value is exported later
            const valNode = unparen(n.arguments[1]);
            if (!valNode || t.isUnaryExpression(valNode, { operator: 'void' }) || t.isIdentifier(valNode, { name: 'undefined' })) return { k: 'placeholder' };
            const v = evalExpr(n.arguments[1]);
            self.exports.push({ name: n.arguments[0].value, value: v, node: n.arguments[1] });
            return v;
          }
          if (t.isObjectExpression(n.arguments[0])) {
            for (const p of n.arguments[0].properties) if (t.isObjectProperty(p)) self.exports.push({ name: keyName(p), value: evalExpr(p.value), node: p.value });
            return { k: 'ast', node: t.identifier('undefined') };
          }
        }
        const helper = t.isIdentifier(n.callee) ? self.helpers.get(n.callee.name) : null;
        if (helper === 'applyDecoratedDescriptor') {
          const [target, key, decs, desc] = n.arguments;
          const tgt = evalExpr(target);
          const cls = tgt.k === 'proto' || tgt.k === 'class' ? tgt.c : null;
          if (cls && t.isStringLiteral(key)) {
            const decorators = t.isArrayExpression(decs) ? decs.elements.map((d) => self.resolveNode(d, env)) : [];
            let initializer = null, hasInitializer = false, accessor = false;
            if (t.isObjectExpression(desc)) {
              const ini = desc.properties.find((p) => keyName(p) === 'initializer');
              if (ini) {
                hasInitializer = true;
                const fnNode = t.isObjectMethod(ini) ? ini : ini.value;
                const stmts = fnNode.body && fnNode.body.body;
                if (stmts && stmts.length === 1 && t.isReturnStatement(stmts[0])) initializer = stmts[0].argument;
                else if (stmts && stmts.length) initializer = t.callExpression(t.arrowFunctionExpression([], fnNode.body), []);
              }
            } else accessor = true;
            cls.fieldDecorators.set(key.value, { decorators, initializer, hasInitializer, accessor, isStatic: tgt.k === 'class' });
            return { k: 'desc', key: key.value };
          }
        }
        if (n.arguments.length === 1) {
          // JS evaluates the callee before the argument (minifiers reuse the decorator variable inside it)
          const calleeNode = self.resolveNode(n.callee, env);
          const argV = evalExpr(n.arguments[0]);
          if (argV.k === 'class') { argV.c.classDecorators.push(calleeNode); return argV; }
        }
        return { k: 'ast', node: n };
      }
      return { k: 'ast', node: n };
    }

    const out = [];
    for (const sp of execPath.get('body.body')) {
      const s = sp.node;
      if (t.isExpressionStatement(s) && t.isMemberExpression(s.expression) && !s.expression.computed && t.isIdentifier(s.expression.object)) continue;
      if (t.isVariableDeclaration(s)) {
        const keep = [];
        for (const d of s.declarations) {
          if (d.init && t.isMemberExpression(d.init) && !d.init.computed && t.isIdentifier(d.init.object) && this.isDecoratorNs(d.init.object.name) && t.isIdentifier(d.id)) {
            decoratorLocals.set(d.id.name, { member: d.init.property.name, ns: d.init.object.name });
            continue;
          }
          if (!d.init) { if (!(t.isIdentifier(d.id) && enumLocals.has(d.id.name))) keep.push(d); continue; }
          const before = this.exports.length;
          const v = evalExpr(d.init);
          const newExports = this.exports.slice(before);
          if (v.k === 'class' || v.k === 'enum') {
            if (t.isIdentifier(d.id)) aliasToName.set(d.id.name, v);
            this.emitFromExports(out, newExports, v);
            continue;
          }
          if (newExports.length) {
            this.emitFromExports(out, newExports, null);
            if (t.isIdentifier(d.id)) aliasToName.set(d.id.name, { k: 'export', name: newExports[newExports.length - 1].name });
            continue;
          }
          keep.push(d);
        }
        // do not detach the consumed declarators yet: renames must still reach them (done at emit time)
        if (keep.length) out.push({ stmt: s, keepDecls: keep.length === s.declarations.length ? null : keep });
        continue;
      }
      if (t.isExpressionStatement(s)) {
        // decorator temporaries (D = ccclass("X"), P = property(Node)) are consumed by the class they decorate
        const ex = s.expression;
        if (t.isAssignmentExpression(ex, { operator: '=' }) && t.isIdentifier(ex.left) && t.isCallExpression(ex.right)
          && ((t.isIdentifier(ex.right.callee) && decoratorLocals.has(ex.right.callee.name)) || (t.isMemberExpression(ex.right.callee) && t.isIdentifier(ex.right.callee.object) && this.isDecoratorNs(ex.right.callee.object.name)))) {
          evalExpr(ex);
          continue;
        }
        const before = this.exports.length;
        const v = evalExpr(s.expression);
        const newExports = this.exports.slice(before);
        if (v.k === 'placeholder') continue;
        if (newExports.length || v.k === 'class' || v.k === 'enum') {
          this.emitFromExports(out, newExports, v.k === 'class' || v.k === 'enum' ? v : null);
          if (v.k === 'residual') out.push({ stmt: t.expressionStatement(v.node) });
          continue;
        }
      }
      out.push({ stmt: s });
    }
    // a kept statement may still contain a class/enum IIFE: declare it first, reference it by name
    const final = [];
    for (const item of out) {
      if (item.stmt || (item.valueExport && item.node && typeof item.node === 'object')) {
        const used = [];
        const scan = item.stmt ? (item.keepDecls ? t.variableDeclaration(item.stmt.kind, item.keepDecls) : item.stmt) : item.node;
        traverse.cheap(scan, (n) => { const c = classByNode.get(n) || enumByNode.get(n); if (c) used.push(c); });
        for (const c of used) {
          if (c.emitted) continue;
          c.emitted = true;
          final.push(classByNode.has(c.path.node) ? { cls: c, exportAs: null } : { en: c, exportAs: null });
        }
        if (used.length) item.inlineRefs = used;
      }
      final.push(item);
    }
    for (const c of this.classes) if (!c.emitted) final.push({ cls: c, exportAs: null });
    for (const e of this.enums) if (!e.emitted) final.push({ en: e, exportAs: null });

    // names
    const baseName = moduleFileName(this.mod.id).replace(/\.(ts|js)$/, '');
    for (const c of this.classes) {
      const ccName = c.classDecorators.map((d) => (t.isCallExpression(d) && t.isStringLiteral(d.arguments[0]) ? d.arguments[0].value : null)).find(Boolean);
      const isDefault = c.exportName === 'default';
      const candidates = [!isDefault ? c.exportName : null, ccName, (this.classes.length === 1 || isDefault) && this.rf ? this.rf.name : null, isDefault ? baseName : null,
        c.ctorName.length > 3 ? c.ctorName : null, this.classes.length === 1 ? baseName : null];
      c.name = safeName(candidates.find((x) => x && t.isValidIdentifier(x))) || `${baseName.replace(/\W/g, '_')}Class${c.id}`;
      c.ccclassName = ccName || null;
    }
    for (const e of this.enums) e.name = safeName((e.exportName && e.exportName !== 'default' && t.isValidIdentifier(e.exportName)) ? e.exportName : `${baseName.replace(/\W/g, '_')}Enum${e.id}`);
    const def = this.exports.find((x) => x.name === 'default');
    this.defaultName = !def ? null : def.value.k === 'class' ? def.value.c.name : def.value.k === 'enum' ? def.value.e.name : (t.isValidIdentifier(baseName) ? baseName : null);

    this.env = env;
    this.aliasToName = aliasToName;
    this.decoratorLocals = decoratorLocals;
    this.outItems = final;
    return this;
  }

  isDecoratorNs(local) {
    const b = this.importLocals.get(local);
    return b && b.imported === '_decorator';
  }

  resolveNode(n, env, depth = 0) {
    n = unparen(n);
    if (depth < 10 && t.isIdentifier(n) && env.has(n.name)) {
      const v = env.get(n.name);
      if (v.k === 'ast') return this.resolveNode(v.node, env, depth + 1);
    }
    return n;
  }

  emitFromExports(out, newExports, v) {
    let placed = false;
    for (const e of newExports) {
      if (e.value.k === 'class') {
        const c = e.value.c;
        if (!c.emitted) { c.emitted = true; c.exportName = e.name; out.push({ cls: c, exportAs: e.name }); }
        else out.push({ reexport: e.name, of: c });
        if (v && v.k === 'class' && v.c === c) placed = true;
      } else if (e.value.k === 'enum') {
        const en = e.value.e;
        if (!en.emitted) { en.emitted = true; en.exportName = e.name; out.push({ en, exportAs: e.name }); }
        else out.push({ reexport: e.name, of: en });
        if (v && v.k === 'enum' && v.e === en) placed = true;
      } else out.push({ valueExport: e.name, node: e.node });
    }
    if (v && !placed) {
      if (v.k === 'class' && !v.c.emitted) { v.c.emitted = true; out.push({ cls: v.c, exportAs: null }); }
      if (v.k === 'enum' && !v.e.emitted) { v.e.emitted = true; out.push({ en: v.e, exportAs: null }); }
    }
  }
}

// ------------------------------------------------------------------ class reconstruction (on attached paths)
function usesOwnThisPath(fnPath) {
  let uses = false;
  fnPath.traverse({
    ThisExpression(p) { if (p.getFunctionParent() === fnPath || nearestNonArrow(p) === fnPath) uses = true; },
    Super() { uses = true; },
    MetaProperty() { uses = true; },
    Identifier(p) { if (p.node.name === 'arguments' && p.isReferencedIdentifier() && nearestNonArrow(p) === fnPath) uses = true; },
    'FunctionExpression|FunctionDeclaration|ObjectMethod|ClassMethod'(p) { if (p !== fnPath) p.skip(); },
  });
  return uses;
}
function nearestNonArrow(p) {
  let f = p.getFunctionParent();
  while (f && f.isArrowFunctionExpression()) f = f.getFunctionParent();
  return f;
}

/** Replace a self/this alias binding by `this`, converting capturing callbacks into arrow functions. */
function replaceSelfAlias(ownerFnPath, name) {
  const b = ownerFnPath.scope.getBinding(name);
  if (!b) return false;
  let needAlias = false;
  for (const ref of b.referencePaths.slice()) {
    if (ref.removed || !ref.node) continue;
    // functions between the reference and the owner
    const chain = [];
    let f = ref.getFunctionParent();
    while (f && f !== ownerFnPath && f.node !== ownerFnPath.node) { chain.push(f); f = f.getFunctionParent(); }
    const convertible = chain.every((fp) => fp.isArrowFunctionExpression() || (fp.isFunctionExpression() && !fp.node.id && !fp.node.generator && !usesOwnThisPath(fp)));
    if (!convertible) { needAlias = true; continue; }
    for (const fp of chain) if (fp.isFunctionExpression()) fp.replaceWith(t.arrowFunctionExpression(fp.node.params, fp.node.body, fp.node.async));
    if (!ref.removed) ref.replaceWith(t.thisExpression());
  }
  return needAlias;
}

function rewriteSuperRefs(fnPath, superParam, superExpr) {
  if (!superParam) return;
  const b = fnPath.scope.getBinding(superParam);
  if (!b) return;
  for (const ref of b.referencePaths.slice()) {
    if (ref.removed) continue;
    // Super.prototype.m.call(this, ...)  /  Super.prototype.m.apply(this, arguments)
    const proto = ref.parentPath;
    if (proto && proto.isMemberExpression({ object: ref.node }) && proto.node.property.name === 'prototype') {
      const m = proto.parentPath;
      const via = m && m.parentPath;
      const call = via && via.parentPath;
      if (m && m.isMemberExpression({ object: proto.node }) && via.isMemberExpression({ object: m.node }) && call && call.isCallExpression({ callee: via.node })) {
        const kind = via.node.property.name;
        const args = call.node.arguments;
        if ((kind === 'call' || kind === 'apply') && t.isThisExpression(args[0])) {
          const callee = t.memberExpression(t.super(), m.node.property, m.node.computed);
          if (kind === 'call') { call.replaceWith(t.callExpression(callee, args.slice(1))); continue; }
          if (t.isIdentifier(args[1], { name: 'arguments' })) { call.replaceWith(t.callExpression(callee, [t.spreadElement(t.identifier('arguments'))])); continue; }
        }
      }
    }
    if (superExpr) ref.replaceWith(t.cloneNode(superExpr, true));
  }
}

function analyzeCtor(ctorNode, superParam, helpers) {
  const stmts = ctorNode.body.body;
  let selfName = null, superArgs = null, implicit = false, i = 0, argsArray = null;
  const helperOf = (n) => (t.isIdentifier(n) ? helpers.get(n.name) : null);
  if (t.isForStatement(stmts[0]) && stmts[0].init && t.isVariableDeclaration(stmts[0].init) && generate(stmts[0].init).code.includes('arguments.length')) {
    const decls = stmts[0].init.declarations;
    const arrDecl = decls.find((d) => d.init && t.isNewExpression(d.init) && t.isIdentifier(d.init.callee, { name: 'Array' }));
    if (arrDecl) argsArray = arrDecl.id.name;
    if (decls[0] && !decls[0].init) selfName = decls[0].id.name;
    i = 1;
  } else if (t.isVariableDeclaration(stmts[0]) && stmts[0].declarations.length === 1 && !stmts[0].declarations[0].init) {
    selfName = stmts[0].declarations[0].id.name; i = 1;
  }
  const isSuperCall = (e) => {
    if (!t.isLogicalExpression(e) || e.operator !== '||' || !t.isThisExpression(e.right)) return null;
    const c = e.left;
    if (!t.isCallExpression(c) || !t.isMemberExpression(c.callee)) return null;
    const obj = c.callee.object, prop = c.callee.property.name;
    if (prop === 'call' && t.isIdentifier(obj, { name: superParam }) && t.isThisExpression(c.arguments[0])) return { args: c.arguments.slice(1) };
    if (prop === 'apply' && t.isMemberExpression(obj) && obj.property.name === 'call' && t.isIdentifier(obj.object, { name: superParam })) return { implicit: true };
    if (prop === 'apply' && t.isIdentifier(obj, { name: superParam }) && t.isThisExpression(c.arguments[0]) && t.isIdentifier(c.arguments[1], { name: 'arguments' })) return { implicit: true };
    return null;
  };
  const rest = [];
  let superFound = !superParam, skipIdx = new Set();
  for (let k = 0; k < i; k++) skipIdx.add(k);
  for (; i < stmts.length; i++) {
    const s = stmts[i];
    if (!superFound) {
      if (t.isReturnStatement(s) && s.argument) { const sc = isSuperCall(s.argument); if (sc) { superFound = true; implicit = !!sc.implicit; superArgs = sc.args || null; skipIdx.add(i); continue; } }
      // minifiers fold the super call into the first helper call:  helper(F = Super.call(this) || this, ...)
      if (t.isExpressionStatement(s) && t.isCallExpression(s.expression) && t.isAssignmentExpression(s.expression.arguments[0]) && t.isIdentifier(s.expression.arguments[0].left)) {
        const a0 = s.expression.arguments[0];
        const sc = isSuperCall(a0.right);
        if (sc) { superFound = true; selfName = a0.left.name; implicit = !!sc.implicit; superArgs = sc.args || null; s.expression.arguments[0] = t.thisExpression(); rest.push(s); continue; }
      }
      if (t.isExpressionStatement(s) && t.isAssignmentExpression(s.expression)) {
        const a = s.expression;
        if (t.isIdentifier(a.left)) { const sc = isSuperCall(a.right); if (sc) { superFound = true; selfName = a.left.name; implicit = !!sc.implicit; superArgs = sc.args || null; skipIdx.add(i); continue; } }
        if (t.isMemberExpression(a.left) && t.isAssignmentExpression(a.left.object) && t.isIdentifier(a.left.object.left)) {
          const sc = isSuperCall(a.left.object.right);
          if (sc) {
            superFound = true; selfName = a.left.object.left.name; implicit = !!sc.implicit; superArgs = sc.args || null;
            a.left.object = t.thisExpression();   // (F = super...).x = v  ->  this.x = v
            rest.push(s); continue;
          }
        }
      }
    }
    rest.push(s);
  }
  return { selfName, superArgs, implicit, argsArray, rest, skipIdx, helperOf };
}

function extractFields(ana, params) {
  const { selfName, rest, helperOf, argsArray } = ana;
  const isSelf = (n) => (selfName && t.isIdentifier(n, { name: selfName })) || t.isThisExpression(n) || (t.isCallExpression(n) && helperOf(n.callee) === 'assertThisInitialized');
  const paramNames = new Set(params.map((p) => (t.isIdentifier(p) ? p.name : null)).filter(Boolean));
  const refsParams = (n) => { let r = false; traverse.cheap(n, (x) => { if (t.isIdentifier(x) && (paramNames.has(x.name) || x.name === 'arguments' || (argsArray && x.name === argsArray))) r = true; }); return r; };
  const fields = [];
  let j = 0;
  for (; j < rest.length; j++) {
    const s = rest[j];
    if (!t.isExpressionStatement(s)) break;
    const e = s.expression;
    if (t.isCallExpression(e) && helperOf(e.callee) === 'initializerDefineProperty' && isSelf(e.arguments[0]) && t.isStringLiteral(e.arguments[1])) { fields.push({ key: e.arguments[1].value, decorated: true }); continue; }
    if (t.isAssignmentExpression(e) && e.operator === '=' && t.isMemberExpression(e.left) && !e.left.computed && isSelf(e.left.object) && !refsParams(e.right)) {
      const undef = t.isIdentifier(e.right, { name: 'undefined' });
      fields.push({ key: e.left.property.name, value: undef ? null : e.right, declared: undef });
      continue;
    }
    break;
  }
  let body = rest.slice(j);
  const last = body[body.length - 1];
  if (last && t.isReturnStatement(last) && last.argument && isSelf(last.argument)) body = body.slice(0, -1);
  return { fields, body };
}

function typeFromDecorator(decs, initializer) {
  const fromTypeNode = (n) => {
    if (!n) return null;
    if (t.isArrayExpression(n) && n.elements.length === 1) { const e = fromTypeNode(n.elements[0]); return e ? t.tsArrayType(e) : null; }
    if (t.isIdentifier(n)) {
      if (['CCFloat', 'CCInteger', 'Float', 'Integer'].includes(n.name)) return t.tsNumberKeyword();
      if (['CCBoolean', 'Boolean'].includes(n.name)) return t.tsBooleanKeyword();
      if (['CCString', 'String'].includes(n.name)) return t.tsStringKeyword();
      return t.tsTypeReference(t.identifier(n.name));
    }
    if (t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.object)) return t.tsTypeReference(t.tsQualifiedName(t.identifier(n.object.name), t.identifier(n.property.name)));
    if (t.isCallExpression(n) && t.isIdentifier(n.callee) && /^(Enum|ccenum)$/.test(n.callee.name) && t.isIdentifier(n.arguments[0])) return t.tsTypeReference(t.identifier(n.arguments[0].name));
    return null;
  };
  for (const d of decs || []) {
    if (!t.isCallExpression(d) || !d.arguments.length) continue;
    const a = d.arguments[0];
    if (t.isObjectExpression(a)) { const tp = a.properties.find((p) => keyName(p) === 'type'); if (tp) { const r = fromTypeNode(tp.value); if (r) return r; } }
    else { const r = fromTypeNode(a); if (r) return r; }
  }
  if (initializer) {
    if (t.isNumericLiteral(initializer) || (t.isUnaryExpression(initializer) && initializer.operator === '-' && t.isNumericLiteral(initializer.argument))) return t.tsNumberKeyword();
    if (t.isStringLiteral(initializer) || t.isTemplateLiteral(initializer)) return t.tsStringKeyword();
    if (t.isBooleanLiteral(initializer)) return t.tsBooleanKeyword();
  }
  return null;
}

/** Rewrites in place (scope-aware) then builds the ClassDeclaration node. */
function reconstructClass(cls, helpers, warnings) {
  const callPath = cls.path;
  const fnPath = cls.bare ? callPath : callPath.get('callee');
  const fnNode = cls.bare ? callPath.node : unparen(callPath.node.callee);
  const superExpr = cls.bare ? null : callPath.node.arguments[0] || null;
  const ctorPath = cls.bare ? callPath : fnPath.get(`body.body.${cls.ctorIdx}`);

  // 1. constructor analysis once, before any rewrite (it recognizes `Super.call(this)` by the IIFE parameter)
  const ana = analyzeCtor(ctorPath.node, cls.superParam, helpers);
  // 2. self alias -> this (scope aware)
  let needAlias = false;
  if (ana.selfName) needAlias = replaceSelfAlias(ctorPath, ana.selfName);
  // 3. super refs: Super.prototype.m.call(this) -> super.m(), other refs -> real superclass expression
  rewriteSuperRefs(fnPath, cls.superParam, superExpr);
  // 4. assertThisInitialized(x) -> x
  fnPath.traverse({ CallExpression(p) { if (t.isIdentifier(p.node.callee) && helpers.get(p.node.callee.name) === 'assertThisInitialized' && p.node.arguments.length === 1 && !p.scope.getBinding(p.node.callee.name)) p.replaceWith(p.node.arguments[0]); } });
  // statements after super(): same indices as analysed, contents rewritten in place
  const rest = ctorPath.node.body.body.filter((s, idx) => !ana.skipIdx.has(idx));
  const params = ctorPath.node.params;
  const { fields, body: ctorBody } = extractFields({ selfName: ana.selfName, rest, helperOf: ana.helperOf, argsArray: ana.argsArray }, params);
  const superArgs = ana.superArgs;
  const implicit = ana.implicit;

  const members = [];
  const seen = new Set();
  const addField = (key, value, decorators, isStatic) => {
    const typeAnn = typeFromDecorator(decorators, value);
    members.push(t.classProperty(t.identifier(key), value || null, typeAnn ? t.tsTypeAnnotation(typeAnn) : null,
      decorators && decorators.length ? decorators.map((d) => t.decorator(d)) : null, false, !!isStatic));
  };
  for (const f of fields) {
    seen.add(f.key);
    if (f.decorated) { const d = cls.fieldDecorators.get(f.key) || { decorators: [] }; addField(f.key, d.hasInitializer ? d.initializer : null, d.decorators, false); }
    else addField(f.key, f.value, null, false);
  }
  for (const [key, d] of cls.fieldDecorators) {
    if (seen.has(key) || d.accessor) continue;
    addField(key, d.hasInitializer ? d.initializer : null, d.decorators, d.isStatic);
  }
  for (const sf of cls.staticFields) addField(sf.key, sf.value, null, true);

  const needCtor = ctorBody.length > 0 || params.length > 0 || (superArgs && superArgs.length > 0) || needAlias;
  if (needCtor) {
    const body = [];
    if (cls.superParam) body.push(t.expressionStatement(t.callExpression(t.super(), implicit ? [t.spreadElement(t.identifier('arguments'))] : superArgs || [])));
    if (needAlias) body.push(t.variableDeclaration('const', [t.variableDeclarator(t.identifier(ana.selfName), t.thisExpression())]));
    body.push(...ctorBody);
    members.push(t.classMethod('constructor', t.identifier('constructor'), params, t.blockStatement(body)));
  }

  // methods / statics / accessors
  const accessorDecorators = (key) => { const d = cls.fieldDecorators.get(key); return d && d.accessor ? d.decorators.map((x) => t.decorator(x)) : null; };
  const addAccessors = (arr, isStatic) => {
    if (!t.isArrayExpression(arr)) return;
    for (const el of arr.elements) {
      if (!t.isObjectExpression(el)) continue;
      const kp = el.properties.find((p) => keyName(p) === 'key');
      const key = kp && kp.value.value;
      for (const kind of ['get', 'set']) {
        const p = el.properties.find((x) => keyName(x) === kind);
        if (!p) continue;
        const fn = t.isObjectMethod(p) ? p : p.value;
        const m = t.classMethod(kind, t.identifier(key), fn.params, fn.body, false, !!isStatic);
        if (kind === 'get') m.decorators = accessorDecorators(key);
        members.push(m);
      }
    }
  };
  const ctorName = cls.name;
  let protoAlias = null;
  const leftovers = [];
  const body = cls.bare ? [] : fnNode.body.body;
  for (let k = 0; k < body.length; k++) {
    const s = body[k];
    if (k === cls.ctorIdx) continue;
    if (k === body.length - 1 && t.isReturnStatement(s)) { if (t.isCallExpression(s.argument) && helpers.get(s.argument.callee.name) === 'createClass') { addAccessors(s.argument.arguments[1], false); addAccessors(s.argument.arguments[2], true); } continue; }
    if (t.isVariableDeclaration(s) && s.declarations.length === 1 && t.isMemberExpression(s.declarations[0].init) && t.isIdentifier(s.declarations[0].init.object, { name: ctorName }) && s.declarations[0].init.property.name === 'prototype') { protoAlias = s.declarations[0].id.name; continue; }
    if (t.isExpressionStatement(s)) {
      const e = s.expression;
      if (t.isCallExpression(e) && t.isIdentifier(e.callee) && helpers.get(e.callee.name) === 'inheritsLoose') continue;
      if (t.isCallExpression(e) && t.isIdentifier(e.callee) && helpers.get(e.callee.name) === 'createClass') { addAccessors(e.arguments[1], false); addAccessors(e.arguments[2], true); continue; }
      if (t.isAssignmentExpression(e) && e.operator === '=' && t.isMemberExpression(e.left) && !e.left.computed) {
        const L = e.left;
        const key = L.property.name;
        const onProto = (protoAlias && t.isIdentifier(L.object, { name: protoAlias })) || (t.isMemberExpression(L.object) && t.isIdentifier(L.object.object, { name: ctorName }) && L.object.property.name === 'prototype');
        const onCtor = t.isIdentifier(L.object, { name: ctorName });
        if (onProto || onCtor) {
          if (t.isFunctionExpression(e.right)) { members.push(t.classMethod('method', t.identifier(key), e.right.params, e.right.body, false, onCtor, e.right.generator, e.right.async)); continue; }
          // method produced by a closure, e.g. Babel's async wrapper:
          //   p.m = function () { var f = asyncToGenerator(regeneratorRuntime().mark(...)); return function () { return f.apply(this, arguments); }; }()
          // -> evaluated once in a static field, the method forwards to it
          const iife = t.isCallExpression(e.right) && !e.right.arguments.length && t.isFunctionExpression(unparen(e.right.callee)) ? unparen(e.right.callee) : null;
          const retFn = iife && iife.body.body.length && t.isReturnStatement(iife.body.body[iife.body.body.length - 1]) && t.isFunctionExpression(iife.body.body[iife.body.body.length - 1].argument);
          if (retFn) {
            const holder = `__${/mark\(|asyncToGenerator/.test(generate(iife).code.slice(0, 400)) ? 'async' : 'fn'}_${key}`;
            members.push(t.classProperty(t.identifier(holder), e.right, null, null, false, true));
            const call = t.callExpression(t.memberExpression(t.memberExpression(t.identifier(cls.name), t.identifier(holder)), t.identifier('apply')), [t.thisExpression(), t.identifier('args')]);
            members.push(t.classMethod('method', t.identifier(key), [t.restElement(t.identifier('args'))], t.blockStatement([t.returnStatement(call)]), false, onCtor));
            continue;
          }
          if (onCtor) { addField(key, e.right, null, true); continue; }
        }
      }
    }
    leftovers.push(s);
  }
  // statements kept after the class must not use the IIFE's prototype alias any more
  for (const s of leftovers) {
    const e = t.isExpressionStatement(s) ? s.expression : null;
    if (protoAlias && e && t.isAssignmentExpression(e) && t.isMemberExpression(e.left) && t.isIdentifier(e.left.object, { name: protoAlias })) e.left.object = t.memberExpression(t.identifier(cls.name), t.identifier('prototype'));
  }
  const decorators = cls.classDecorators.slice().reverse().map((d) => t.decorator(d));
  const decl = t.classDeclaration(t.identifier(cls.name), superExpr, t.classBody(members), decorators.length ? decorators : null);
  if (leftovers.length) warnings.push(`Class ${cls.name}: ${leftovers.length} câu lệnh không nhận dạng được, giữ lại sau class`);
  return { decl, leftovers };
}

function enumDeclaration(en) {
  const members = en.members.map((m) => t.tsEnumMember(t.isValidIdentifier(m.name) ? t.identifier(m.name) : t.stringLiteral(m.name), m.value));
  return t.tsEnumDeclaration(t.identifier(en.name), t.tsEnumBody ? t.tsEnumBody(members) : members);
}

// ------------------------------------------------------------------ post passes (fresh scopes after reparse)
function postProcess(programAst, helperNameOf) {
  const helperOf = (p, name) => (!p.scope.getBinding(name) ? helperNameOf(name) : null);
  traverse(programAst, {
    ConditionalExpression(p) {
      // null == (tmp = X) ? undefined : tmp.y   ->  X?.y
      const n = p.node, tst = n.test;
      if (!t.isBinaryExpression(tst) || (tst.operator !== '==' && tst.operator !== '===') || !t.isIdentifier(n.consequent, { name: 'undefined' })) return;
      const [nul, asg] = t.isNullLiteral(tst.left) ? [tst.left, tst.right] : [tst.right, tst.left];
      if (!t.isNullLiteral(nul) || !t.isAssignmentExpression(asg) || !t.isIdentifier(asg.left)) return;
      const tmp = asg.left.name, alt = n.alternate;
      let r = null;
      if (t.isMemberExpression(alt) && t.isIdentifier(alt.object, { name: tmp })) r = t.optionalMemberExpression(asg.right, alt.property, alt.computed, true);
      else if (t.isCallExpression(alt) && t.isMemberExpression(alt.callee) && t.isIdentifier(alt.callee.object, { name: tmp })) r = t.optionalCallExpression(t.optionalMemberExpression(asg.right, alt.callee.property, alt.callee.computed, true), alt.arguments, false);
      if (r) p.replaceWith(r);
    },
    CallExpression(p) {
      const n = p.node;
      if (!t.isIdentifier(n.callee)) return;
      const h = helperOf(p, n.callee.name);
      if (h === 'extends') n.callee = t.memberExpression(t.identifier('Object'), t.identifier('assign'));
      else if (h === 'assertThisInitialized' && n.arguments.length === 1) p.replaceWith(n.arguments[0]);
    },
    ForStatement(p) {
      // for (var step, other = .., it = _createForOfIteratorHelperLoose(arr); !(step = it()).done;) { var x = step.value, y = ..; ... }
      const n = p.node;
      if (!t.isVariableDeclaration(n.init) || n.update) return;
      const decls = n.init.declarations;
      const itDecl = decls.find((d) => t.isCallExpression(d.init) && t.isIdentifier(d.init.callee) && helperOf(p, d.init.callee.name) === 'createForOfIteratorHelperLoose');
      if (!itDecl || !t.isIdentifier(itDecl.id)) return;
      // test: !(step = it()).done
      const tst = n.test;
      if (!t.isUnaryExpression(tst, { operator: '!' }) || !t.isMemberExpression(tst.argument) || tst.argument.property.name !== 'done') return;
      const asg = tst.argument.object;
      if (!t.isAssignmentExpression(asg) || !t.isIdentifier(asg.left) || !t.isCallExpression(asg.right) || !t.isIdentifier(asg.right.callee, { name: itDecl.id.name })) return;
      const step = asg.left.name;
      const body = (n.body && n.body.body) || [];
      const first = body[0];
      const hoisted = decls.filter((x) => x !== itDecl && !(t.isIdentifier(x.id, { name: step }) && !x.init));
      let loop;
      const d = first && t.isVariableDeclaration(first) && first.declarations.length ? first.declarations[0] : null;
      if (d && t.isMemberExpression(d.init) && t.isIdentifier(d.init.object, { name: step }) && d.init.property.name === 'value') {
        const rest = first.declarations.slice(1);
        const newBody = [...(rest.length ? [t.variableDeclaration(first.kind, rest)] : []), ...body.slice(1)];
        loop = t.forOfStatement(t.variableDeclaration('const', [t.variableDeclarator(d.id)]), itDecl.init.arguments[0], t.blockStatement(newBody));
      } else {
        // the minifier inlined the loop variable: the body reads step.value directly
        let ok = true;
        const uses = [];
        p.get('body').traverse({
          Identifier(q) {
            if (q.node.name !== step || !q.isReferencedIdentifier()) return;
            const m = q.parentPath;
            if (m.isMemberExpression({ object: q.node }) && !m.node.computed && t.isIdentifier(m.node.property, { name: 'value' }) && !m.parentPath.isAssignmentExpression({ left: m.node })) uses.push(m);
            else ok = false;
          },
        });
        if (!ok || !uses.length) return;
        let nm = 'item';
        while (p.scope.hasBinding(nm) || p.scope.hasReference(nm)) nm += '_';
        for (const u of uses) u.replaceWith(t.identifier(nm));
        loop = t.forOfStatement(t.variableDeclaration('const', [t.variableDeclarator(t.identifier(nm))]), itDecl.init.arguments[0], t.isBlockStatement(n.body) ? n.body : t.blockStatement([n.body]));
      }
      if (hoisted.length && (p.parentPath.isBlockStatement() || p.parentPath.isProgram())) p.replaceWithMultiple([t.variableDeclaration(n.init.kind, hoisted), loop]);
      else if (!hoisted.length) p.replaceWith(loop);
    },
    IfStatement(p) {
      // if (a(), b) {...}  ->  a(); if (b) {...}
      const tst = p.node.test;
      if (!t.isSequenceExpression(tst) || !(p.parentPath.isBlockStatement() || p.parentPath.isProgram() || p.parentPath.isSwitchCase())) return;
      const exprs = tst.expressions.slice();
      const last = exprs.pop();
      p.node.test = last;
      p.insertBefore(exprs.map((e) => t.expressionStatement(e)));
    },
    'FunctionExpression|FunctionDeclaration|ArrowFunctionExpression|ClassMethod'(p) {
      // if (a === undefined) a = X;  ->  default parameter
      const n = p.node;
      if (!t.isBlockStatement(n.body)) return;
      const stmts = n.body.body;
      while (stmts.length) {
        const s = stmts[0];
        if (!t.isIfStatement(s) || s.alternate) break;
        const tst = s.test;
        if (!t.isBinaryExpression(tst) || tst.operator !== '===') break;
        const [u, id] = t.isIdentifier(tst.left, { name: 'undefined' }) ? [tst.left, tst.right] : [tst.right, tst.left];
        if (!t.isIdentifier(u, { name: 'undefined' }) || !t.isIdentifier(id)) break;
        const cons = t.isBlockStatement(s.consequent) ? s.consequent.body : [s.consequent];
        if (cons.length !== 1 || !t.isExpressionStatement(cons[0]) || !t.isAssignmentExpression(cons[0].expression) || !t.isIdentifier(cons[0].expression.left, { name: id.name })) break;
        const idx = n.params.findIndex((pp) => t.isIdentifier(pp, { name: id.name }));
        if (idx < 0) break;
        n.params[idx] = t.assignmentPattern(n.params[idx], cons[0].expression.right);
        stmts.shift();
      }
    },
    StringLiteral(p) { if (p.node.extra) delete p.node.extra; },
  });
  // this aliases inside methods: var F = this; ... function () { F.x } -> arrow + this
  traverse(programAst, {
    ClassMethod(p) {
      const aliases = [];
      p.traverse({
        VariableDeclarator(vp) { if (t.isIdentifier(vp.node.id) && t.isThisExpression(vp.node.init) && vp.getFunctionParent() === p) aliases.push(vp.node.id.name); },
        'FunctionExpression|FunctionDeclaration'(fp) { fp.skip(); },
      });
      for (const a of aliases) if (!replaceSelfAlias(p, a)) { /* alias fully replaced */ }
      // plain callbacks that do not need their own this -> arrows (readability)
      p.traverse({
        FunctionExpression(fp) {
          if (fp.node.id || fp.node.generator) return;
          if (!fp.parentPath.isCallExpression() || fp.parentPath.node.callee === fp.node) return;
          if (usesOwnThisPath(fp)) return;
          fp.replaceWith(t.arrowFunctionExpression(fp.node.params, fp.node.body, fp.node.async));
        },
      });
    },
  });
  // module-level callbacks that do not use their own this -> arrows
  traverse(programAst, {
    FunctionExpression(fp) {
      if (fp.node.id || fp.node.generator) return;
      if (!fp.parentPath.isCallExpression() || fp.parentPath.node.callee === fp.node) return;
      if (fp.findParent((x) => x.isClassMethod())) return;
      if (usesOwnThisPath(fp)) return;
      fp.replaceWith(t.arrowFunctionExpression(fp.node.params, fp.node.body, fp.node.async));
    },
  });
  // drop unused temp/alias declarations (re-crawl: bindings are stale after replacements)
  for (let pass = 0; pass < 3; pass++) {
    traverse(programAst, { Program(p) { p.scope.crawl(); } });
    traverse(programAst, {
      VariableDeclarator(p) {
        const n = p.node;
        if (!t.isIdentifier(n.id)) return;
        const b = p.scope.getBinding(n.id.name);
        if (!b || b.referenced || b.constantViolations.length) return;
        if (!n.init || t.isThisExpression(n.init) || t.isIdentifier(n.init)) p.remove();
      },
    });
  }
}

// ------------------------------------------------------------------ emit
function resolveDepId(dep) {
  if (!dep) return null;
  if (dep.startsWith('./')) return 'chunks:///_virtual/' + dep.slice(2);
  return dep;
}

function emitModule(entry, byId, options) {
  const { dc, info } = entry;
  const factoryPath = dc.mod.factoryPath;
  const execPath = info.execPath;
  const warnings = dc.warnings.slice();
  const rename = (scopePath, from, to) => {
    if (!from || !to || from === to || !t.isValidIdentifier(to)) return false;
    const b = scopePath.scope.getBinding(from);
    if (!b) return false;
    const existing = scopePath.scope.getBinding(to);
    if (existing && existing !== b) return false;
    scopePath.scope.rename(from, to);
    return true;
  };

  // ---- scope-aware renames on the attached AST
  const importNames = new Map();
  for (const [local, b] of dc.importLocals) {
    let want = b.namespace ? null : b.imported;
    const target = byId.get(resolveDepId(b.dep));
    if (want === 'default') want = (target && target.dc.defaultName) || null;
    if (b.namespace) want = target ? moduleFileName(target.id).replace(/\.(ts|js)$/, '') : null;
    importNames.set(local, want && rename(factoryPath, local, want) ? want : local);
  }
  const decoratorFinal = new Map();
  for (const [local, d] of dc.decoratorLocals) decoratorFinal.set(local, rename(execPath, local, d.member) ? d.member : local);
  for (const [alias, v] of dc.aliasToName) {
    const name = v.k === 'class' ? v.c.name : v.k === 'enum' ? v.e.name : v.name;
    if (name) rename(execPath, alias, name);
  }
  for (const c of dc.classes) {
    if (c.bare) { c.ctorName = c.name; continue; }
    const fnPath = c.path.get('callee');
    if (!rename(fnPath, c.ctorName, c.name)) {
      // name clash inside the IIFE: rewrite only the references of the constructor binding
      const b = fnPath.scope.getBinding(c.ctorName);
      if (b) { for (const r of b.referencePaths) if (!r.removed) r.replaceWith(t.identifier(c.name)); b.identifier.name = c.name; }
    }
    c.ctorName = c.name;
  }

  // ---- program body
  const body = [];
  const groups = new Map();
  for (const [local, b] of dc.importLocals) (groups.get(b.dep) || groups.set(b.dep, []).get(b.dep)).push({ ...b, local: importNames.get(local) });
  const source = (dep) => {
    const target = byId.get(resolveDepId(dep));
    if (target && options.pathOf) return options.pathOf(entry, target);
    if (target) return './' + moduleFileName(target.id).replace(/\.(ts|js)$/, '');
    return dep && dep.startsWith('./') ? dep.replace(/\.(ts|js)$/, '') : dep;
  };
  for (const [dep, list] of groups) {
    const specs = [];
    for (const b of list) {
      if (b.namespace) specs.push(t.importNamespaceSpecifier(t.identifier(b.local)));
      else if (b.imported === 'default') specs.unshift(t.importDefaultSpecifier(t.identifier(b.local)));
      else specs.push(t.importSpecifier(t.identifier(b.local), t.identifier(b.imported)));
    }
    body.push(t.importDeclaration(specs, t.stringLiteral(source(dep))));
  }
  for (const b of info.bindings) if (b.sideEffect && !HELPER_DEP_RE.test(b.dep || '') && !groups.has(b.dep)) body.push(t.importDeclaration([], t.stringLiteral(source(b.dep))));

  if (dc.decoratorLocals.size) {
    const byNs = new Map();
    for (const [local, d] of dc.decoratorLocals) (byNs.get(d.ns) || byNs.set(d.ns, []).get(d.ns)).push({ local: decoratorFinal.get(local), member: d.member });
    for (const [ns, list] of byNs) {
      body.push(t.variableDeclaration('const', [t.variableDeclarator(
        t.objectPattern(list.map((x) => t.objectProperty(t.identifier(x.member), t.identifier(x.local), false, x.member === x.local))),
        t.identifier(importNames.get(ns) || ns))]));
    }
  }

  // reconstruct classes first (in-place rewrites need attached paths), then assemble
  const built = new Map();
  for (const c of dc.classes) built.set(c, reconstructClass(c, dc.helpers, warnings));

  const markBeforeExport = (exp) => { exp.start = 1; exp.declaration.start = 1; return exp; };
  for (const item of dc.outItems) {
    if (item.stmt) {
      if (item.inlineRefs) for (const c of item.inlineRefs) if (!c.path.removed) c.path.replaceWith(t.identifier(c.name));
      if (item.keepDecls) item.stmt.declarations = item.keepDecls;
      body.push(item.stmt);
      continue;
    }
    if (item.cls) {
      const { decl, leftovers } = built.get(item.cls);
      if (item.exportAs === 'default') body.push(markBeforeExport(t.exportDefaultDeclaration(decl)));
      else if (item.exportAs && item.exportAs === item.cls.name) body.push(markBeforeExport(t.exportNamedDeclaration(decl)));
      else {
        body.push(decl);
        if (item.exportAs) body.push(t.exportNamedDeclaration(null, [t.exportSpecifier(t.identifier(item.cls.name), t.identifier(item.exportAs))]));
      }
      body.push(...leftovers);
      continue;
    }
    if (item.en) {
      const decl = enumDeclaration(item.en);
      if (item.exportAs === 'default') { body.push(decl); body.push(t.exportDefaultDeclaration(t.identifier(item.en.name))); }
      else if (item.exportAs && item.exportAs === item.en.name) body.push(t.exportNamedDeclaration(decl));
      else { body.push(decl); if (item.exportAs) body.push(t.exportNamedDeclaration(null, [t.exportSpecifier(t.identifier(item.en.name), t.identifier(item.exportAs))])); }
      continue;
    }
    if (item.reexport) { body.push(t.exportNamedDeclaration(null, [t.exportSpecifier(t.identifier(item.of.name), t.identifier(item.reexport))])); continue; }
    if (item.valueExport) {
      // class IIFE inside the exported value (x = new (class IIFE)()): declared above, referenced by name
      if (item.inlineRefs) for (const c of item.inlineRefs) if (!c.path.removed && c.path.node !== item.node) c.path.replaceWith(t.identifier(c.name));
      const n = item.node;
      if (item.valueExport === 'default') body.push(t.exportDefaultDeclaration(n));
      else if (t.isIdentifier(n)) body.push(t.exportNamedDeclaration(null, [t.exportSpecifier(t.identifier(n.name), t.identifier(item.valueExport))]));
      else if (t.isFunctionExpression(n) && !n.id) body.push(t.exportNamedDeclaration(t.functionDeclaration(t.identifier(item.valueExport), n.params, n.body, n.generator, n.async)));
      else body.push(t.exportNamedDeclaration(t.variableDeclaration('const', [t.variableDeclarator(t.identifier(item.valueExport), n)])));
    }
  }

  let code = generate(t.file(t.program(body)), GEN_OPTS).code;
  let ast2;
  try { ast2 = parser.parse(code, PARSE_TS); }
  catch (err) { warnings.push('Không phân tích lại được mã sinh ra: ' + err.message); return finish(entry, code, warnings); }
  const helperNames = new Map(dc.helpers);
  postProcess(ast2, (n) => helperNames.get(n));
  // helpers still in use -> import from the generated helpers module
  const stillUsed = new Set();
  traverse(ast2, { Identifier(p) { if (helperNames.has(p.node.name) && p.isReferencedIdentifier() && !p.scope.getBinding(p.node.name)) stillUsed.add(p.node.name); } });
  if (stillUsed.size) {
    ast2.program.body.unshift(t.importDeclaration([...stillUsed].map((l) => t.importSpecifier(t.identifier(l), t.identifier(helperNames.get(l)))), t.stringLiteral(options.helpersImport ? options.helpersImport(entry) : './_babelHelpers')));
    warnings.push(`Còn dùng helper Babel: ${[...stillUsed].map((l) => helperNames.get(l)).join(', ')}`);
    entry.needsHelpers = [...stillUsed].map((l) => helperNames.get(l));
  }
  traverse(ast2, { Program(p) { p.scope.crawl(); } });   // register bindings of the import just inserted
  traverse(ast2, {
    ImportDeclaration(p) {
      if (!p.node.specifiers.length) return;
      p.node.specifiers = p.node.specifiers.filter((s) => { const b = p.scope.getBinding(s.local.name); return b && b.referenced; });
      if (!p.node.specifiers.length) p.remove();
    },
  });
  // decorators before `export` survive the reparse via source positions
  code = generate(ast2, GEN_OPTS, code).code;
  return finish(entry, formatTs(code), warnings);
}

function finish(entry, code, warnings) {
  return {
    id: entry.id, fileName: entry.fileName, code, warnings, rf: entry.dc.rf,
    uuid: entry.dc.rf && entry.dc.rf.cid ? decompressUuid(entry.dc.rf.cid) : null,
    classes: entry.dc.classes.map((c) => ({ name: c.name, ccclass: c.ccclassName, fields: [...c.fieldDecorators.keys()] })),
    needsHelpers: entry.needsHelpers || [],
  };
}

/** Light formatting: 4-space indent, blank lines between class members and top-level declarations. */
function formatTs(code) {
  // const {\n  ccclass,\n  property\n} = _decorator;  ->  const { ccclass, property } = _decorator;
  code = code.replace(/(const|let|var) \{\n((?:[ \t]+[\w$]+(?:: [\w$]+)?,?\n)+)\} = /g, (m, kw, props) => `${kw} { ${props.split('\n').map((x) => x.trim()).filter(Boolean).join(' ')} } = `);
  // @property({\n  type: X\n})  ->  @property({ type: X })
  code = code.replace(/@([\w$.]+)\(\{\n((?:[ \t]+[^\n{}]{1,80},?\n){1,3})[ \t]*\}\)/g, (m, name, props) => `@${name}({ ${props.split('\n').map((x) => x.trim()).filter(Boolean).join(' ')} })`);
  const lines = code.split('\n').map((l) => { const m = l.match(/^( +)/); return m ? ' '.repeat(m[1].length * 2) + l.slice(m[1].length) : l; });
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const prev = out.length ? out[out.length - 1] : undefined;
    const isImport = /^import\b/.test(l);
    const topDecl = /^(export\s+)?(default\s+)?(abstract\s+)?(class|enum|function|interface|const\s+\{)|^@/.test(l);
    const member = /^ {4}(@|(static\s+)?(async\s+)?(get\s+|set\s+)?[A-Za-z_$][\w$]*\s*\(|constructor\s*\()/.test(l);
    if (prev !== undefined && prev.trim() !== '') {
      if (/^import\b/.test(prev) && !isImport) out.push('');
      else if (topDecl && !/^@/.test(prev) && !isImport) out.push('');
      else if (member && !/^\s*@/.test(prev) && !/\{\s*$/.test(prev)) out.push('');
    }
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// ------------------------------------------------------------------ public API
/**
 * @param {string} code  contents of assets/<bundle>/index.js
 * @param {object} options { warn, pathOf(fromEntry, toEntry), helpersImport(entry) }
 */
/**
 * Decompile the script bundles of a build in one pass (sources: [{ code, tag }], tag = bundle name),
 * so imports between bundles (main -> resources ...) resolve to the right module and path.
 */
function decompileBundles(sources, options = {}) {
  const warn = options.warn || (() => {});
  const byId = new Map();
  const entries = [];
  let deobCount = 0;
  for (const src of sources) {
    const deob = deobfuscate(src.code);
    deobCount += deob.replaced;
    let clean = cleanup(deob.code);
    // "merged" builds: every script in one module -> split back into one module per script
    const um = unmergeModules(clean);
    if (um.merged) { clean = cleanup(um.code); if (options.onUnmerge) options.onUnmerge(um); }
    // flattened class IIFEs (terser inline) -> canonical Babel form
    const ri = reinlineClasses(clean);
    if (ri.count) clean = cleanup(ri.code);
    const ast = parser.parse(clean, { sourceType: 'script', allowReturnOutsideFunction: true, errorRecovery: true });
    const mods = findModules(ast);
    for (const mod of mods) {
      if (mod.id.endsWith('/main') || /rollupPluginModLoBabelHelpers/.test(mod.id) || byId.has(mod.id)) continue;
      const info = analyzeFactory(mod);
      if (!info) continue;
      try {
        const dc = new ModuleDecompiler(mod, info).run();
        const entry = { id: mod.id, fileName: moduleFileName(mod.id), deps: mod.deps, dc, info, tag: src.tag };
        entries.push(entry);
        byId.set(mod.id, entry);
      } catch (err) { warn(`Phân tích ${mod.id} thất bại: ${err.message}`); }
    }
  }
  if (options.planPaths) options.planPaths(entries);
  const modules = [];
  for (const entry of entries) {
    try { modules.push({ ...emitModule(entry, byId, options), tag: entry.tag }); }
    catch (err) {
      warn(`Không dịch ngược được ${entry.fileName}: ${err.message}`);
      modules.push({ id: entry.id, fileName: entry.fileName, tag: entry.tag, error: err.message, rf: entry.dc.rf, uuid: entry.dc.rf && entry.dc.rf.cid ? decompressUuid(entry.dc.rf.cid) : null, code: '', warnings: [] });
    }
  }
  return { modules, deobfuscated: deobCount, entries };
}

function decompileBundle(code, options = {}) {
  return decompileBundles([{ code, tag: null }], options);
}

module.exports = { decompileBundle, decompileBundles, moduleFileName, formatTs };
