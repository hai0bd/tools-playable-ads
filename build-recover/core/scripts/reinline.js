'use strict';
// Aggressive minifiers (terser inline/hoist_funs) flatten Babel's class IIFE:
//
//   function n() { ...ctor... }                       // hoisted to the module scope
//   X((u(n, l = Component), (e = n.prototype).onLoad = function () {...}, e.foo = ..., e = n))
//
// instead of   X(function (l) { function n() {...} u(n, l); var e = n.prototype; e.onLoad = ...; return n; }(Component))
// This pass rebuilds the canonical IIFE so the class decompiler can handle it.
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const GEN = { comments: false, jsescOption: { minimal: true } };

function helperLocals(regPath, canonical) {
  const out = new Set();
  const f = regPath.node.arguments[2];
  const deps = regPath.node.arguments[1].elements.map((e) => e && e.value);
  const ret = f.body.body.find((s) => t.isReturnStatement(s) && t.isObjectExpression(s.argument));
  if (!ret) return out;
  const setters = ret.argument.properties.find((p) => p.key && (p.key.name || p.key.value) === 'setters');
  if (!setters || !t.isArrayExpression(setters.value)) return out;
  setters.value.elements.forEach((s, i) => {
    if (!/BabelHelpers|babelHelpers/.test(deps[i] || '') || !t.isFunction(s)) return;
    const param = s.params[0] && s.params[0].name;
    traverse.cheap(s.body, (n) => {
      if (t.isAssignmentExpression(n) && t.isIdentifier(n.left) && t.isMemberExpression(n.right) && t.isIdentifier(n.right.object, { name: param })) {
        const name = n.right.computed ? n.right.property.value : n.right.property.name;
        if (name === canonical) out.add(n.left.name);
      }
    });
  });
  return out;
}

const isProtoOf = (n, ctor) => t.isMemberExpression(n) && t.isIdentifier(n.object, { name: ctor }) && ((t.isIdentifier(n.property, { name: 'prototype' }) && !n.computed) || t.isStringLiteral(n.property, { value: 'prototype' }));

function uniqueName(scope, base) {
  let n = base, k = 1;
  while (scope.hasBinding(n, true) || scope.hasGlobal(n) || scope.hasReference(n)) n = `${base}${k++}`;
  return n;
}

const helperCache = new WeakMap();
function helperLocalsOf(execPath, canonical) {
  const reg = execPath.findParent((p) => p.isCallExpression() && t.isMemberExpression(p.node.callee) && t.isIdentifier(p.node.callee.object, { name: 'System' }));
  if (!reg) return new Set();
  const key = reg.node;
  let m = helperCache.get(key);
  if (!m) helperCache.set(key, m = new Map());
  if (!m.has(canonical)) m.set(canonical, helperLocals(reg, canonical));
  return m.get(canonical);
}

/** Rebuild one flattened class starting at the inheritsLoose call path. Returns true when rewritten. */
function rebuild(callPath, execPath) {
  const [ctorId, sup] = callPath.node.arguments;
  if (!t.isIdentifier(ctorId)) return false;
  const ctor = ctorId.name;
  const ctorBinding = callPath.scope.getBinding(ctor);
  if (!ctorBinding || !ctorBinding.path.isFunctionDeclaration()) return false;
  if (ctorBinding.path.getFunctionParent() !== execPath && ctorBinding.path.parentPath.parentPath !== execPath) return false;
  const seqPath = callPath.parentPath;
  if (!seqPath.isSequenceExpression()) return false;
  const exprs = seqPath.node.expressions;
  const start = exprs.indexOf(callPath.node);
  if (start < 0) return false;
  // members: consecutive definitions right after inheritsLoose; the rest of the sequence is left untouched
  const createClassLocals = helperLocalsOf(execPath, 'createClass');
  let protoAliasScan = null;
  const isMemberDef = (e) => {
    if (t.isAssignmentExpression(e, { operator: '=' }) && t.isIdentifier(e.left) && isProtoOf(e.right, ctor)) { protoAliasScan = e.left.name; return true; }
    if (t.isCallExpression(e) && t.isIdentifier(e.callee) && createClassLocals.has(e.callee.name) && t.isIdentifier(e.arguments[0], { name: ctor })) return true;
    if (!t.isAssignmentExpression(e) || !t.isMemberExpression(e.left)) return false;
    const obj = e.left.object;
    if (t.isAssignmentExpression(obj, { operator: '=' }) && t.isIdentifier(obj.left) && isProtoOf(obj.right, ctor)) { protoAliasScan = obj.left.name; return true; }
    return (protoAliasScan && t.isIdentifier(obj, { name: protoAliasScan })) || t.isIdentifier(obj, { name: ctor }) || isProtoOf(obj, ctor);
  };
  let end = start + 1;
  while (end < exprs.length && isMemberDef(exprs[end])) end++;
  // a trailing  X = ctor  directly after the members keeps the class in X
  let assignTo = null;
  if (end === exprs.length - 1 && t.isAssignmentExpression(exprs[end], { operator: '=' }) && t.isIdentifier(exprs[end].left) && t.isIdentifier(exprs[end].right, { name: ctor })) { assignTo = exprs[end].left.name; end++; }

  // superclass: inheritsLoose(n, l = Super) -> IIFE param l, argument Super
  let superParam, superArg;
  if (t.isAssignmentExpression(sup, { operator: '=' }) && t.isIdentifier(sup.left)) { superParam = sup.left.name; superArg = sup.right; }
  else if (t.isIdentifier(sup)) { superParam = sup.name; superArg = sup; }
  else { superParam = uniqueName(execPath.scope, '_super'); superArg = sup; }

  // members: (A = n.prototype).m = fn, A.m2 = fn, n.s = v, createClass(n, ...) ...
  const proto = uniqueName(execPath.scope, '_proto');
  let protoAlias = null, usesProto = false;
  const body = [];
  for (let k = start + 1; k < end - (assignTo ? 1 : 0); k++) {
    const e = exprs[k];
    if (t.isAssignmentExpression(e) && t.isMemberExpression(e.left)) {
      const obj = e.left.object;
      if (t.isAssignmentExpression(obj, { operator: '=' }) && t.isIdentifier(obj.left) && isProtoOf(obj.right, ctor)) { protoAlias = obj.left.name; e.left.object = t.identifier(proto); usesProto = true; }
      else if (protoAlias && t.isIdentifier(obj, { name: protoAlias })) { e.left.object = t.identifier(proto); usesProto = true; }
    } else if (t.isAssignmentExpression(e, { operator: '=' }) && t.isIdentifier(e.left) && isProtoOf(e.right, ctor)) {
      protoAlias = e.left.name; usesProto = true;
      continue;
    }
    body.push(t.expressionStatement(e));
  }

  const ctorDecl = ctorBinding.path.node;
  const inMembers = (r) => { const e = r.findParent((p) => p.parentPath === seqPath); return e && exprs.indexOf(e.node) >= start && exprs.indexOf(e.node) < end; };
  const outerRefs = ctorBinding.referencePaths.filter((r) => !inMembers(r));
  const iifeBody = [
    ctorDecl,
    t.expressionStatement(t.callExpression(t.identifier(callPath.node.callee.name), [t.identifier(ctor), t.identifier(superParam)])),
    ...(usesProto ? [t.variableDeclaration('var', [t.variableDeclarator(t.identifier(proto), t.memberExpression(t.identifier(ctor), t.identifier('prototype')))])] : []),
    ...body,
    t.returnStatement(t.identifier(ctor)),
  ];
  let value = t.callExpression(t.functionExpression(null, [t.identifier(superParam)], t.blockStatement(iifeBody)), [superArg]);
  if (outerRefs.length) value = t.assignmentExpression('=', t.identifier(ctor), value);
  if (assignTo) value = t.assignmentExpression('=', t.identifier(assignTo), value);
  const newExprs = [...exprs.slice(0, start), value, ...exprs.slice(end)];
  seqPath.replaceWith(newExprs.length === 1 ? newExprs[0] : t.sequenceExpression(newExprs));
  if (outerRefs.length) ctorBinding.path.replaceWith(t.variableDeclaration('var', [t.variableDeclarator(t.identifier(ctor))]));
  else ctorBinding.path.remove();
  return true;
}

/** Rewrite every flattened class of every System.register module. */
function reinlineClasses(code) {
  let ast;
  try { ast = parser.parse(code, { sourceType: 'script', allowReturnOutsideFunction: true, errorRecovery: true }); } catch { return { code, count: 0 }; }
  let count = 0;
  traverse(ast, {
    CallExpression(p) {
      const n = p.node;
      if (!(t.isMemberExpression(n.callee) && t.isIdentifier(n.callee.object, { name: 'System' }) && t.isIdentifier(n.callee.property, { name: 'register' }))) return;
      if (n.arguments.length < 3 || !t.isFunction(n.arguments[2])) return;
      const inh = helperLocals(p, 'inheritsLoose');
      if (!inh.size) return;
      const ret = p.get('arguments.2.body.body').find((s) => s.isReturnStatement() && s.get('argument').isObjectExpression());
      const exec = ret && ret.get('argument.properties').find((q) => q.node.key && (q.node.key.name || q.node.key.value) === 'execute');
      if (!exec) return;
      const execPath = exec.isObjectMethod() ? exec : exec.get('value');
      const calls = [];
      execPath.traverse({ CallExpression(q) { if (t.isIdentifier(q.node.callee) && inh.has(q.node.callee.name) && q.getFunctionParent() === execPath) calls.push(q); } });
      for (const c of calls) { try { if (!c.removed && rebuild(c, execPath)) count++; } catch { /* leave as is */ } }
      p.skip();
    },
  });
  if (!count) return { code, count: 0 };
  return { code: generate(ast, GEN).code, count };
}

module.exports = { reinlineClasses };
