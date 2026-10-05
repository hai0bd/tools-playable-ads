'use strict';
// Undo javascript-obfuscator style "string array" obfuscation and tidy up minified output.
// Strategy: locate the string array provider, its decoder function and the rotation IIFE; run just those in
// a sandbox, then replace every decoder call with the literal string it returns.
const vm = require('vm');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const GEN = { comments: false, jsescOption: { minimal: true } };

function parse(code) {
  return parser.parse(code, { sourceType: 'script', allowReturnOutsideFunction: true, errorRecovery: true });
}

function isStringArray(node) {
  return t.isArrayExpression(node) && node.elements.length >= 3 && node.elements.every((e) => t.isStringLiteral(e));
}

function findObfuscatorParts(ast) {
  const body = ast.program.body;
  let provider = null; // { name, node }
  for (const st of body) {
    if (t.isVariableDeclaration(st)) {
      for (const d of st.declarations) if (t.isIdentifier(d.id) && isStringArray(d.init)) { provider = { name: d.id.name, node: st }; break; }
    } else if (t.isFunctionDeclaration(st) && st.id) {
      // function _0xabc(){ var a=[...]; _0xabc=function(){return a}; return _0xabc(); }
      const inner = st.body.body.find((s) => t.isVariableDeclaration(s) && s.declarations.some((d) => isStringArray(d.init)));
      if (inner) { provider = { name: st.id.name, node: st }; }
    }
    if (provider) break;
  }
  if (!provider) return null;
  const decoders = [];
  for (const st of body) {
    if (!t.isFunctionDeclaration(st) || !st.id || st === provider.node || st.params.length < 1) continue;
    let refs = false;
    traverse.cheap(st, (n) => { if (t.isIdentifier(n, { name: provider.name })) refs = true; });
    if (refs) decoders.push(st);
  }
  if (!decoders.length) return null;
  // rotation: (function (arr, target) {...})(provider, 0x1234) anywhere at top level (often inside a sequence)
  let rotation = null;
  traverse(ast, {
    CallExpression(p) {
      if (rotation) return;
      const n = p.node;
      if ((t.isFunctionExpression(n.callee) || t.isArrowFunctionExpression(n.callee)) && n.arguments.length === 2 &&
          t.isIdentifier(n.arguments[0], { name: provider.name }) && t.isNumericLiteral(n.arguments[1])) {
        rotation = p;
      }
    },
  });
  return { provider, decoders, rotation };
}

/** Returns { code, replaced } */
function deobfuscate(code) {
  let ast;
  try { ast = parse(code); } catch { return { code, replaced: 0 }; }
  const parts = findObfuscatorParts(ast);
  if (!parts) return { code, replaced: 0 };
  const { provider, decoders, rotation } = parts;
  const sandbox = {};
  vm.createContext(sandbox);
  try {
    const src = [generate(provider.node, GEN).code, ...decoders.map((d) => generate(d, GEN).code)];
    if (rotation) src.push('(' + generate(rotation.node, GEN).code + ');');
    src.push(`this.__decoders = { ${decoders.map((d) => `${JSON.stringify(d.id.name)}: ${d.id.name}`).join(', ')} };`);
    vm.runInContext(src.join('\n'), sandbox, { timeout: 5000 });
  } catch (e) {
    return { code, replaced: 0, error: 'sandbox: ' + e.message };
  }
  const decoderNames = new Set(decoders.map((d) => d.id.name));
  const decoderNodes = new Set(decoders);

  // Does `name` (in `path`'s scope) alias a decoder (directly or through `var x = decoder` chains)?
  function resolveDecoder(path, name, depth = 0) {
    if (depth > 30) return null;
    const b = path.scope.getBinding(name);
    if (!b) return decoderNames.has(name) ? name : null;
    if (b.path.isFunctionDeclaration() && decoderNodes.has(b.path.node)) return name;
    if (b.path.isVariableDeclarator() && t.isIdentifier(b.path.node.init) && b.constantViolations.length === 0) {
      return resolveDecoder(b.path, b.path.node.init.name, depth + 1);
    }
    return null;
  }

  let replaced = 0;
  traverse(ast, {
    CallExpression(p) {
      const n = p.node;
      if (!t.isIdentifier(n.callee) || !n.arguments.length || !n.arguments.every((a) => t.isNumericLiteral(a) || t.isStringLiteral(a))) return;
      const dec = resolveDecoder(p, n.callee.name);
      if (!dec) return;
      try {
        const v = sandbox.__decoders[dec](...n.arguments.map((a) => a.value));
        if (typeof v === 'string') { p.replaceWith(t.stringLiteral(v)); replaced++; }
      } catch { /* leave call */ }
    },
  });
  // drop scaffolding
  if (rotation) {
    if (rotation.parentPath.isSequenceExpression()) rotation.remove();
    else if (rotation.parentPath.isExpressionStatement()) rotation.parentPath.remove();
  }
  ast.program.body = ast.program.body.filter((s) => s !== provider.node && !decoderNodes.has(s));
  return { code: generate(ast, GEN).code, replaced };
}

/** Readability passes that keep semantics: remove dead aliases, !0/!1, split sequences, && -> if, etc. */
function cleanup(code) {
  for (let i = 0; i < 6; i++) {
    const ast = parse(code);
    let changed = false;
    traverse(ast, {
      VariableDeclarator(p) {
        // unused `var x = y` where y is an unbound identifier (left-over decoder aliases) or another dead alias
        const n = p.node;
        if (!t.isIdentifier(n.id) || !t.isIdentifier(n.init)) return;
        const own = p.scope.getBinding(n.id.name);
        if (!own || own.referenced) return;
        const init = p.scope.getBinding(n.init.name);
        if (!init || (init.path.isVariableDeclarator() && t.isIdentifier(init.path.node.init))) { p.remove(); changed = true; }
      },
      ExpressionStatement(p) {
        // `h.property;` pure member access left by the minifier
        const e = p.node.expression;
        if (t.isMemberExpression(e) && t.isIdentifier(e.object) && !e.computed) { p.remove(); changed = true; }
      },
      UnaryExpression: {
        exit(p) {
          const n = p.node;
          if (n.operator === '!' && t.isNumericLiteral(n.argument) && (n.argument.value === 0 || n.argument.value === 1)) { p.replaceWith(t.booleanLiteral(n.argument.value === 0)); changed = true; }
          else if (n.operator === '!' && t.isArrayExpression(n.argument) && n.argument.elements.length === 0) { p.replaceWith(t.booleanLiteral(false)); changed = true; }
          else if (n.operator === '!' && t.isBooleanLiteral(n.argument)) { p.replaceWith(t.booleanLiteral(!n.argument.value)); changed = true; }
          else if (n.operator === 'void' && t.isNumericLiteral(n.argument)) { p.replaceWith(t.identifier('undefined')); changed = true; }
        },
      },
      MemberExpression(p) {
        const n = p.node;
        if (n.computed && t.isStringLiteral(n.property) && /^[A-Za-z_$][\w$]*$/.test(n.property.value)) { n.property = t.identifier(n.property.value); n.computed = false; changed = true; }
      },
      'ObjectProperty|ObjectMethod'(p) {
        const n = p.node;
        if (!n.computed && t.isStringLiteral(n.key) && /^[A-Za-z_$][\w$]*$/.test(n.key.value)) { n.key = t.identifier(n.key.value); changed = true; }
      },
      NumericLiteral(p) { if (p.node.extra) delete p.node.extra; },
      StringLiteral(p) { if (p.node.extra && p.node.extra.raw && p.node.extra.raw[0] !== '"' && p.node.extra.raw[0] !== "'") delete p.node.extra; },
    });
    const gen = generate(ast, GEN).code;
    if (!changed) { code = gen; break; }
    code = gen;
  }
  // structural pass
  const ast = parse(code);
  const stmts = (exprs) => exprs.map((e) => t.expressionStatement(e));
  const replaceStmt = (p, list) => {
    if (p.parentPath.isBlockStatement() || p.parentPath.isProgram() || p.parentPath.isSwitchCase()) p.replaceWithMultiple(list);
    else p.replaceWith(t.blockStatement(list));
  };
  traverse(ast, {
    ExpressionStatement: {
      exit(p) {
        const e = p.node.expression;
        if (t.isSequenceExpression(e)) replaceStmt(p, stmts(e.expressions));
        else if (t.isLogicalExpression(e) && (e.operator === '&&' || e.operator === '||') && !t.isLogicalExpression(e.right) && !t.isAssignmentExpression(e.left)) {
          const test = e.operator === '&&' ? e.left : t.unaryExpression('!', e.left);
          replaceStmt(p, [t.ifStatement(test, t.blockStatement(t.isSequenceExpression(e.right) ? stmts(e.right.expressions) : [t.expressionStatement(e.right)]))]);
        } else if (t.isConditionalExpression(e)) {
          const blk = (x) => t.blockStatement(t.isSequenceExpression(x) ? stmts(x.expressions) : [t.expressionStatement(x)]);
          replaceStmt(p, [t.ifStatement(e.test, blk(e.consequent), blk(e.alternate))]);
        }
      },
    },
    ReturnStatement: {
      exit(p) {
        const a = p.node.argument;
        if (a && t.isSequenceExpression(a)) {
          const ex = a.expressions.slice();
          const last = ex.pop();
          replaceStmt(p, [...stmts(ex), t.returnStatement(last)]);
        }
      },
    },
    IfStatement: {
      exit(p) {
        const n = p.node;
        if (!t.isBlockStatement(n.consequent)) n.consequent = t.blockStatement([n.consequent]);
        if (n.alternate && !t.isBlockStatement(n.alternate) && !t.isIfStatement(n.alternate)) n.alternate = t.blockStatement([n.alternate]);
      },
    },
    'ForStatement|WhileStatement|DoWhileStatement|ForInStatement|ForOfStatement': {
      exit(p) { if (!t.isBlockStatement(p.node.body)) p.node.body = t.blockStatement([p.node.body]); },
    },
  });
  return generate(ast, GEN).code;
}

module.exports = { deobfuscate, cleanup, parse };
