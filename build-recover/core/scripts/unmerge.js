'use strict';
// Some builds (3.6, "merge all scripts") bundle every script into ONE SystemJS module (chunks:///main.js):
// Babel helpers are inlined as function declarations and each original script is a segment delimited by
// cclegacy._RF.push({}, cid, "Name") ... cclegacy._RF.pop(). Scripts reference each other through shared
// variables instead of imports.
// This pass rewrites such a module into one regular System.register module per segment, with the imports
// (cc, Babel helpers, other segments) and exports the decompiler expects.
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const GEN = { comments: false, jsescOption: { minimal: true } };
const HELPERS_DEP = './rollupPluginModLoBabelHelpers.js';
// names a recovered class/const must never take (they would shadow the global inside the module)
const GLOBAL_NAMES = new Set(('Math Object Array String Number Boolean Symbol Date JSON RegExp Error TypeError RangeError Map Set WeakMap WeakSet ' +
  'Promise Proxy Reflect Function Infinity NaN undefined globalThis window document console navigator performance location ' +
  'setTimeout clearTimeout setInterval clearInterval requestAnimationFrame cancelAnimationFrame parseInt parseFloat isNaN isFinite ' +
  'encodeURIComponent decodeURIComponent Int8Array Uint8Array Uint8ClampedArray Int16Array Uint16Array Int32Array Uint32Array ' +
  'Float32Array Float64Array ArrayBuffer DataView Intl BigInt Image Audio XMLHttpRequest fetch localStorage cc CC_EDITOR CC_DEBUG ' +
  'CC_DEV CC_JSB CC_BUILD CC_PREVIEW CC_TEST cce Editor System arguments eval').split(' '));

/** Recognize an inlined Babel helper from its body. */
function helperKind(code, fn) {
  const has = (re) => re.test(code);
  if (has(/this hasn't been initialised/)) return 'assertThisInitialized';
  if (has(/Invalid attempt to iterate non-iterable instance/)) return has(/\.next\.bind\(|\["next"\]\["bind"\]|\['next'\]\['bind'\]/) ? 'createForOfIteratorHelperLoose' : 'createForOfIteratorHelper';
  if (has(/Invalid attempt to spread non-iterable/)) return 'toConsumableArray';
  if (has(/Invalid attempt to destructure non-iterable/)) return 'slicedToArray';
  if (has(/regeneratorRuntime|GeneratorFunction/)) return 'regeneratorRuntime';
  if (has(/initializer/) && has(/reduce/)) return 'applyDecoratedDescriptor';
  if (has(/initializer/) && has(/defineProperty/)) return 'initializerDefineProperty';
  if (has(/Object(\.|\[["'])create/) && has(/constructor/)) return 'inheritsLoose';
  if (has(/setPrototypeOf/) && has(/__proto__/) && !has(/getPrototypeOf/)) return 'setPrototypeOf';
  if (has(/getPrototypeOf/) && !has(/setPrototypeOf\s*\(/)) return 'getPrototypeOf';
  if (has(/new Promise/) && has(/throw/)) return 'asyncToGenerator';
  if (has(/Promise(\.|\[["'])resolve/) && fn.params.length >= 6) return 'asyncGeneratorStep';
  if (has(/\.raw\s*=|\["raw"\]\s*=/)) return 'taggedTemplateLiteralLoose';
  if (has(/Object(\.|\[["'])assign/) && has(/hasOwnProperty/)) return 'extends';
  if (has(/toPrimitive/)) return has(/String|Number/) && fn.params.length === 2 ? 'toPrimitive' : 'toPropertyKey';
  if (has(/writable/) && has(/prototype/) && fn.params.length === 3) return 'createClass';
  if (has(/enumerable/) && has(/configurable/) && has(/defineProperty/) && fn.params.length === 2) return 'defineProperties';
  if (has(/enumerable/) && has(/defineProperty/) && fn.params.length === 3) return 'defineProperty';
  if (has(/new Array\(/) && fn.params.length === 2) return 'arrayLikeToArray';
  if (has(/Arguments/) && has(/Map|Set/) && fn.params.length === 2) return 'unsupportedIterableToArray';
  return null;
}

const isRf = (node, what) => {
  if (!t.isExpressionStatement(node) || !t.isCallExpression(node.expression)) return null;
  const c = node.expression.callee;
  if (!t.isMemberExpression(c) || !t.isMemberExpression(c.object)) return null;
  const rf = c.object.property, m = c.property;
  if (!(t.isIdentifier(rf, { name: '_RF' }) || t.isStringLiteral(rf, { value: '_RF' }))) return null;
  const name = t.isIdentifier(m) ? m.name : m.value;
  return name === what ? node.expression : null;
};

function findRegisters(ast) {
  const out = [];
  traverse(ast, {
    CallExpression(p) {
      const n = p.node;
      if (!(t.isMemberExpression(n.callee) && t.isIdentifier(n.callee.object, { name: 'System' }) && t.isIdentifier(n.callee.property, { name: 'register' }))) return;
      if (n.arguments.length < 3 || !t.isStringLiteral(n.arguments[0]) || !t.isArrayExpression(n.arguments[1]) || !t.isFunction(n.arguments[2])) return;
      out.push(p);
      p.skip();
    },
  });
  return out;
}

/** Pieces of a register call: export fn name, deps, setters (per dep: [{local, imported}]), execute path. */
function factoryParts(regPath) {
  const f = regPath.get('arguments.2');
  const deps = regPath.node.arguments[1].elements.map((e) => e && e.value);
  const exportName = f.node.params[0] && t.isIdentifier(f.node.params[0]) ? f.node.params[0].name : '_export';
  const ret = f.get('body.body').find((s) => s.isReturnStatement() && t.isObjectExpression(s.node.argument));
  if (!ret) return null;
  const props = ret.get('argument.properties');
  const keyOf = (p) => (p.node.key && (p.node.key.name || p.node.key.value));
  const setterProp = props.find((p) => keyOf(p) === 'setters');
  const execProp = props.find((p) => keyOf(p) === 'execute');
  if (!execProp) return null;
  const execPath = execProp.isObjectMethod() ? execProp : execProp.get('value');
  const setters = deps.map(() => []);
  const setterNodes = setterProp ? setterProp.node.value.elements : [];
  setterNodes.forEach((s, i) => {
    if (!s || !t.isFunction(s)) return;
    const param = s.params[0] && s.params[0].name;
    const visit = (node) => {
      if (t.isExpressionStatement(node)) return visit(node.expression);
      if (t.isSequenceExpression(node)) return node.expressions.forEach(visit);
      if (t.isAssignmentExpression(node) && t.isIdentifier(node.left)) {
        const r = node.right;
        if (t.isMemberExpression(r) && t.isIdentifier(r.object, { name: param })) setters[i].push({ local: node.left.name, imported: r.computed ? r.property.value : r.property.name });
        else if (t.isAssignmentExpression(r)) { visit(r); const last = setters[i][setters[i].length - 1]; if (last) setters[i].push({ ...last, local: node.left.name }); }
      }
    };
    (s.body.body || []).forEach(visit);
  });
  return { deps, exportName, setters, execPath };
}

/**
 * Rewrite merged modules into one module per _RF segment. Returns the new code (or the same code when the
 * bundle has no merged module) and the source of the inlined helpers.
 */
function unmergeModules(code) {
  let ast;
  try { ast = parser.parse(code, { sourceType: 'script', allowReturnOutsideFunction: true, errorRecovery: true }); } catch { return { code, merged: 0 }; }
  const regs = findRegisters(ast);
  const replacements = [];
  const helperSources = new Map();
  let merged = 0;
  for (const reg of regs) {
    const parts = factoryParts(reg);
    if (!parts) continue;
    const bodyPaths = parts.execPath.get('body.body');
    if (bodyPaths.filter((sp) => isRf(sp.node, 'push')).length < 2) continue;
    const out = splitModule(reg, parts, bodyPaths, helperSources);
    if (!out) continue;
    replacements.push({ start: reg.node.start, end: reg.node.end, text: out.join(',\n') });
    merged++;
  }
  if (!replacements.length) return { code, merged: 0 };
  replacements.sort((a, b) => b.start - a.start);
  let s = code;
  for (const r of replacements) s = s.slice(0, r.start) + '(' + r.text + ')' + s.slice(r.end);
  return { code: s, merged, helperSources };
}

function splitModule(reg, parts, bodyPaths, helperSources) {
  const { exportName: E, execPath } = parts;
  const scope = execPath.scope;
  // ---- helpers and segments
  const helpers = new Map();          // local fn name -> canonical helper name
  const sharedFns = new Map();        // other top-level function declarations (copied where used)
  const segments = [];
  let cur = null, pending = [];
  for (const sp of bodyPaths) {
    const n = sp.node;
    if (t.isFunctionDeclaration(n) && n.id) {
      const src = generate(n, GEN).code;
      const kind = helperKind(src, n);
      if (kind) { helpers.set(n.id.name, kind); if (!helperSources.has(kind)) helperSources.set(kind, { local: n.id.name, src }); continue; }
      if (!cur && !segments.length) { sharedFns.set(n.id.name, n); continue; }
    }
    const push = isRf(n, 'push');
    if (push) {
      const a = push.arguments;
      cur = { name: a[2] && t.isStringLiteral(a[2]) ? a[2].value : `Script${segments.length}`, stmts: [...pending, sp] };
      pending = [];
      segments.push(cur);
      continue;
    }
    if (isRf(n, 'pop')) { if (cur) { cur.stmts.push(sp); cur = null; } continue; }
    if (cur) cur.stmts.push(sp); else pending.push(sp);
  }
  if (!segments.length) return null;
  if (pending.length) segments[segments.length - 1].stmts.push(...pending);

  const segOfStmt = new Map();
  segments.forEach((s, i) => s.stmts.forEach((sp) => segOfStmt.set(sp.node, i)));
  const segOf = (p) => { const top = p.findParent((pp) => segOfStmt.has(pp.node)) || (segOfStmt.has(p.node) ? p : null); return top ? segOfStmt.get(top.node) : -1; };
  const posOf = (p) => (p.node && p.node.start) || 0;

  // ---- where does every variable of the merged scope live
  const home = new Map();             // binding name -> segment index
  const assigners = new Map();        // binding name -> Set(segment) that assign it
  for (const [name, b] of Object.entries(scope.bindings)) {
    if (helpers.has(name) || sharedFns.has(name)) continue;
    const writes = [];
    if (b.path.isVariableDeclarator() && b.path.node.init) writes.push(b.path);
    for (const cv of b.constantViolations) writes.push(cv);
    if (b.path.isFunctionDeclaration()) writes.push(b.path);
    writes.sort((x, y) => posOf(x) - posOf(y));
    const segs = new Set(writes.map(segOf).filter((i) => i >= 0));
    assigners.set(name, segs);
    const first = writes.map(segOf).find((i) => i >= 0);
    home.set(name, first !== undefined ? first : segOf(b.path));
  }

  // ---- names for bindings read by other segments
  const ccclassFns = new Set();
  for (const [name, b] of Object.entries(scope.bindings)) {
    const init = b.path.isVariableDeclarator() ? b.path.node.init : null;
    if (init && t.isMemberExpression(init) && ((t.isIdentifier(init.property) && init.property.name === 'ccclass') || t.isStringLiteral(init.property, { value: 'ccclass' }))) ccclassFns.add(name);
  }
  const exportNames = new Map();      // binding -> export name
  // identifiers used as globals anywhere in the merged module are reserved too
  const usedNames = new Set(GLOBAL_NAMES);
  execPath.traverse({ ReferencedIdentifier(p) { if (!p.scope.hasBinding(p.node.name, true)) usedNames.add(p.node.name); } });
  const valuesOf = (name) => {
    const b = scope.bindings[name];
    const out = [];
    if (!b) return out;
    if (b.path.isVariableDeclarator() && b.path.node.init) out.push(b.path.get('init'));
    for (const cv of b.constantViolations) if (cv.isAssignmentExpression()) out.push(cv.get('right'));
    return out;
  };
  // ccclass name APPLIED to a class:  ccclass("X")(cls)  or  D(cls) with D = ccclass("X")
  // (a bare ccclass("X") only creates the decorator)
  const isCcclassCall = (x) => t.isCallExpression(x) && t.isIdentifier(x.callee) && ccclassFns.has(x.callee.name) && t.isStringLiteral(x.arguments[0]);
  const ccNameOfCall = (n) => {
    if (!t.isCallExpression(n)) return null;
    if (isCcclassCall(n.callee)) return n.callee.arguments[0].value;
    if (!t.isIdentifier(n.callee) || ccclassFns.has(n.callee.name)) return null;
    for (const v of valuesOf(n.callee.name)) {
      const x = v.node;
      if (t.isCallExpression(x) && t.isIdentifier(x.callee) && ccclassFns.has(x.callee.name) && t.isStringLiteral(x.arguments[0])) return x.arguments[0].value;
    }
    return null;
  };
  const ccNameIn = (p) => {
    let found = ccNameOfCall(p.node);
    if (!found) p.traverse({ CallExpression(q) { if (!found) found = ccNameOfCall(q.node); }, Function(q) { q.skip(); } });
    return found;
  };
  const enumIndex = new Map();
  const isEnumBinding = (name) => {
    const b = scope.bindings[name];
    return !!b && b.constantViolations.some((cv) => cv.isAssignmentExpression() && t.isObjectExpression(cv.node.right) && !cv.node.right.properties.length && cv.parentPath.isLogicalExpression());
  };
  // class IIFE:  function () { function C() {...} ...; return C; }()   or a bare constructor function
  const classLike = (n) => {
    n = n && t.isParenthesizedExpression(n) ? n.expression : n;
    if (t.isNewExpression(n)) return classLike(n.callee);          // instance of a class IIFE
    if (t.isFunctionExpression(n)) return true;
    if (!t.isCallExpression(n) || !t.isFunctionExpression(n.callee)) return false;
    const body = n.callee.body.body, last = body[body.length - 1];
    return !!last && t.isReturnStatement(last) && t.isIdentifier(last.argument) && body.some((s) => t.isFunctionDeclaration(s) && s.id && s.id.name === last.argument.name);
  };
  // static event names  C.MOVE = "EasyControllerEvent.MOVE"  reveal the class name
  const staticNameHint = (name) => {
    const b = scope.bindings[name];
    const seen = new Map();
    for (const r of (b ? b.referencePaths : [])) {
      const m = r.parentPath;
      if (!m.isMemberExpression({ object: r.node }) || !m.parentPath.isAssignmentExpression({ left: m.node })) continue;
      const v = m.parentPath.node.right;
      const mm = t.isStringLiteral(v) && v.value.match(/^([A-Za-z_$][\w$]*)\.[\w$.-]+$/);
      if (mm) seen.set(mm[1], (seen.get(mm[1]) || 0) + 1);
    }
    const best = [...seen.entries()].sort((a, b) => b[1] - a[1])[0];
    return best && best[1] >= 2 ? best[0] : null;
  };
  const classCount = new Map();
  const exportNameOf = (name) => {
    if (exportNames.has(name)) return exportNames.get(name);
    let found = null, isClass = false;
    for (const v of valuesOf(name)) {
      found = ccNameIn(v);
      if (found) break;
      if (classLike(v.node)) isClass = true;
      else v.traverse({ FunctionExpression(p) { if (/inheritsLoose/.test(generate(p.node, GEN).code.slice(0, 4000))) isClass = true; } });
    }
    const seg = segments[home.get(name)];
    if (isClass && !found && seg) {
      const hint = staticNameHint(name);
      const k = classCount.get(seg) || 0;
      classCount.set(seg, k + 1);
      found = hint || (k === 0 && !usedNames.has(seg.name) ? seg.name : `${seg.name}Class${k}`);
      if (valuesOf(name).some((v) => t.isNewExpression(v.node))) found = found[0].toLowerCase() + found.slice(1);
    }
    let enumName = null;
    if (!found && !isClass && isEnumBinding(name) && seg) {
      const k = enumIndex.get(seg) || 0;
      enumIndex.set(seg, k + 1);
      enumName = `${seg.name}Enum${k}`;
    }
    // a binding holding an instance (x = new (class IIFE)()) is named after the class in camelCase
    const isInstance = valuesOf(name).some((v) => t.isNewExpression(v.node));
    const className = isClass && seg ? seg.name : null;
    let want = found || (className && isInstance ? className[0].toLowerCase() + className.slice(1) : className) || enumName || name;
    if (GLOBAL_NAMES.has(want)) want = want + 'Class';
    if (!t.isValidIdentifier(want)) want = name;
    let final = want, k = 1;
    while (usedNames.has(final)) final = `${want}${k++}`;
    usedNames.add(final);
    exportNames.set(name, final);
    return final;
  };

  // ---- pure aliases (X = importLocal.a.b / X = Math.sin): re-declared in every segment that uses them
  const importLocalsAll = new Set(parts.setters.flat().map((x) => x.local));
  const aliases = new Map();          // binding -> init node
  const rootOf = (n) => { while (t.isMemberExpression(n)) n = n.object; return n; };
  for (const [name, b] of Object.entries(scope.bindings)) {
    if (!b.path.isVariableDeclarator() || !b.path.node.init || b.constantViolations.length) continue;
    const init = b.path.node.init;
    if (!t.isMemberExpression(init) || init.computed && !t.isStringLiteral(init.property)) continue;
    const root = rootOf(init);
    if (!t.isIdentifier(root)) continue;
    if (importLocalsAll.has(root.name) || !execPath.scope.hasBinding(root.name, true)) aliases.set(name, init);
  }
  const aliasUse = segments.map(() => new Set());
  // ---- which bindings each segment reads from elsewhere
  const importsOf = segments.map(() => new Map());   // seg -> Map(binding -> home seg)
  const helperUse = segments.map(() => new Set());
  const sharedUse = segments.map(() => new Set());
  const localDecl = segments.map(() => new Set());   // bindings to declare in the segment
  for (const [name, b] of Object.entries(scope.bindings)) {
    const refs = [...b.referencePaths, ...b.constantViolations];
    if (helpers.has(name)) { for (const r of refs) { const s = segOf(r); if (s >= 0) helperUse[s].add(name); } continue; }
    if (sharedFns.has(name)) { for (const r of refs) { const s = segOf(r); if (s >= 0) sharedUse[s].add(name); } continue; }
    if (aliases.has(name)) { for (const r of refs) { const s = segOf(r); if (s >= 0) aliasUse[s].add(name); } continue; }
    const h = home.get(name);
    const writers = assigners.get(name) || new Set();
    if (h >= 0) localDecl[h].add(name);
    for (const w of writers) localDecl[w].add(name);         // a segment that assigns a binding owns its copy
    for (const r of b.referencePaths) {
      const s = segOf(r);
      if (s < 0 || s === h || writers.has(s)) continue;
      importsOf[s].set(name, h);
    }
  }
  // shared (non-helper) functions may themselves use helpers
  for (let i = 0; i < segments.length; i++) {
    for (const f of sharedUse[i]) {
      traverse.cheap(sharedFns.get(f), (n) => { if (t.isIdentifier(n) && helpers.has(n.name)) helperUse[i].add(n.name); });
    }
  }

  const wrap = (node, name) => t.callExpression(t.identifier(E), [t.stringLiteral(name), node]);
  // ---- every @ccclass of a segment is exported under its class name (as in the original source)
  const exported = new Map();          // binding -> name
  const wrappedHere = new Set();
  segments.forEach((s) => {
    for (const sp of s.stmts) {
      const n = sp.node;
      if (t.isVariableDeclaration(n)) {
        sp.get('declarations').forEach((dp) => {
          if (!dp.node.init || !t.isIdentifier(dp.node.id) || exported.has(dp.node.id.name)) return;
          const cn = ccNameIn(dp.get('init'));
          if (cn && t.isValidIdentifier(cn) && !usedNames.has(cn)) { usedNames.add(cn); exportNames.set(dp.node.id.name, cn); exported.set(dp.node.id.name, cn); dp.node.init = wrap(dp.node.init, cn); wrappedHere.add(dp.node.id.name); }
        });
      } else if (t.isExpressionStatement(n)) {
        const e = n.expression;
        if (t.isAssignmentExpression(e, { operator: '=' }) && t.isIdentifier(e.left)) {
          if (exported.has(e.left.name)) continue;
          const cn = ccNameIn(sp.get('expression.right'));
          if (cn && t.isValidIdentifier(cn) && !usedNames.has(cn)) { usedNames.add(cn); exportNames.set(e.left.name, cn); exported.set(e.left.name, cn); e.right = wrap(e.right, cn); wrappedHere.add(e.left.name); }
        } else if (!(t.isCallExpression(e) && t.isIdentifier(e.callee, { name: E }))) {
          const cn = ccNameIn(sp.get('expression'));
          if (cn && t.isValidIdentifier(cn) && !usedNames.has(cn)) { usedNames.add(cn); n.expression = wrap(e, cn); }
        }
      }
    }
  });
  // ---- bindings read by another segment: wrap their home assignment in _export()
  for (let i = 0; i < segments.length; i++) for (const [name] of importsOf[i]) if (!exported.has(name)) exported.set(name, exportNameOf(name));
  for (const [name, expName] of exported) {
    if (wrappedHere.has(name)) continue;
    const b = scope.bindings[name];
    const h = home.get(name);
    let done = false;
    if (b.path.isVariableDeclarator() && b.path.node.init && segOf(b.path) === h) { b.path.node.init = wrap(b.path.node.init, expName); done = true; }
    if (!done) {
      const cv = b.constantViolations.filter((c) => c.isAssignmentExpression() && segOf(c) === h).sort((x, y) => posOf(x) - posOf(y));
      const last = cv[cv.length - 1];
      if (last) { last.node.right = wrap(last.node.right, expName); done = true; }
    }
    if (!done) segments[h].extraTail = (segments[h].extraTail || []).concat(t.expressionStatement(wrap(t.identifier(name), expName)));
  }

  // ---- emit one System.register per segment
  const ccDeps = parts.deps.map((d, i) => ({ dep: d, setters: parts.setters[i] }));
  const idOf = new Map();
  const taken = new Set();
  segments.forEach((s, i) => {
    let id = `chunks:///_virtual/${s.name}.ts`, k = 1;
    while (taken.has(id)) id = `chunks:///_virtual/${s.name}_${k++}.ts`;
    taken.add(id);
    idOf.set(i, id);
  });
  const texts = [];
  segments.forEach((s, i) => {
    const deps = [], setters = [], importLocals = [];
    const used = new Set();
    for (const sp of s.stmts) traverse.cheap(sp.node, (n) => { if (t.isIdentifier(n)) used.add(n.name); });
    for (const a of aliasUse[i]) traverse.cheap(aliases.get(a), (n) => { if (t.isIdentifier(n)) used.add(n.name); });
    for (const tail of s.extraTail || []) traverse.cheap(tail, (n) => { if (t.isIdentifier(n)) used.add(n.name); });
    for (const f of sharedUse[i]) traverse.cheap(sharedFns.get(f), (n) => { if (t.isIdentifier(n)) used.add(n.name); });
    for (const d of ccDeps) {
      const mine = d.setters.filter((x) => used.has(x.local));
      if (!mine.length) continue;
      deps.push(d.dep);
      setters.push(`function (m) { ${mine.map((x) => `${x.local} = m[${JSON.stringify(x.imported)}];`).join(' ')} }`);
      importLocals.push(...mine.map((x) => x.local));
    }
    if (helperUse[i].size) {
      deps.push(HELPERS_DEP);
      setters.push(`function (m) { ${[...helperUse[i]].map((h) => `${h} = m[${JSON.stringify(helpers.get(h))}];`).join(' ')} }`);
      importLocals.push(...helperUse[i]);
    }
    const byHome = new Map();
    for (const [name, h] of importsOf[i]) (byHome.get(h) || byHome.set(h, []).get(h)).push(name);
    for (const [h, names] of byHome) {
      deps.push('./' + idOf.get(h).replace('chunks:///_virtual/', ''));
      setters.push(`function (m) { ${names.map((n) => `${n} = m[${JSON.stringify(exported.get(n))}];`).join(' ')} }`);
      importLocals.push(...names);
    }
    // statements: keep only the declarators this segment owns
    const declared = new Set();
    const stmts = [];
    for (const sp of s.stmts) {
      const n = sp.node;
      if (t.isVariableDeclaration(n)) {
        const keep = n.declarations.filter((d) => !t.isIdentifier(d.id) || localDecl[i].has(d.id.name) || (aliases.has(d.id.name) && aliasUse[i].has(d.id.name)));
        keep.forEach((d) => t.isIdentifier(d.id) && declared.add(d.id.name));
        if (keep.length) stmts.push(generate(t.variableDeclaration(n.kind, keep), GEN).code);
        continue;
      }
      if (t.isFunctionDeclaration(n) && n.id) declared.add(n.id.name);
      stmts.push(generate(n, GEN).code);
    }
    for (const tail of s.extraTail || []) stmts.push(generate(tail, GEN).code);
    const missing = [...localDecl[i]].filter((n) => !declared.has(n) && !importsOf[i].has(n) && !aliases.has(n));
    const aliasDecls = [...aliasUse[i]].filter((a) => !declared.has(a)).map((a) => `var ${a} = ${generate(aliases.get(a), GEN).code};`);
    const fnDecls = [...sharedUse[i]].map((f) => generate(sharedFns.get(f), GEN).code);
    const head = aliasDecls.join('\n') + '\n' + (missing.length ? `var ${missing.join(', ')};\n` : '') + fnDecls.join('\n');
    const factory = `function (${E}) {\n  "use strict";\n${importLocals.length ? `  var ${[...new Set(importLocals)].join(', ')};\n` : ''}  return {\n    setters: [${setters.join(', ')}],\n    execute: function () {\n${head}\n${stmts.join('\n')}\n    }\n  };\n}`;
    texts.push(`System.register(${JSON.stringify(idOf.get(i))}, ${JSON.stringify(deps)}, ${factory})`);
  });
  return texts;
}

module.exports = { unmergeModules, helperKind, GLOBAL_NAMES };
