'use strict';
// Bridge.NET JavaScript (as shipped in a Luna build) → C#-shaped source, for reading and porting by hand.
// Undoes what Bridge + Luna do to C#:
//   operator methods (Vector3.op_Addition(a, b), a.$clone().add(b)) → a + b      !0 / !1 → true / false
//   overload suffixes (StartCoroutine$1) → StartCoroutine                       x | 0, Bridge.Int.clip32(x) → (int)
//   GetComponent(UnityEngine.Image) → GetComponent<Image>()                      list.getItem(i) → list[i]
//   static extension calls (ShortcutExtensions.DOScale(t, v, d)) → t.DOScale(v, d)
//   Bridge.GeneratorEnumerator state machines → IEnumerator with yield return    Bridge.getEnumerator loops → foreach
// Types of locals come out as `var`; parameters stay untyped — the result is meant to be read and fixed, which is
// why the script writer keeps it inside a comment.
const parser = require('@babel/parser');

const STRIP_NS = /^(UnityEngine\.(UI\.|EventSystems\.|SceneManagement\.)?|System\.(Collections\.Generic\.|Collections\.|Linq\.)?|TMPro\.|DG\.Tweening\.|Spine\.Unity\.)/;
const EXTENSION_HOLDERS = /(^|\.)(ShortcutExtensions\d*|DOTweenModule\w+|TweenSettingsExtensions|TweenExtensions|Enumerable|Extensions?)$/;
const OPS = {
  op_Addition: '+', op_Subtraction: '-', op_Multiply: '*', op_Division: '/', op_Equality: '==', op_Inequality: '!=',
  op_LessThan: '<', op_GreaterThan: '>', op_LessThanOrEqual: '<=', op_GreaterThanOrEqual: '>=', op_Modulus: '%',
};
const VEC_METHODS = { add: '+', sub: '-', mul: '*', scale: '*', div: '/' };
const LIST_METHODS = { add: 'Add', addRange: 'AddRange', clear: 'Clear', contains: 'Contains', remove: 'Remove', removeAt: 'RemoveAt', insert: 'Insert', indexOf: 'IndexOf', toArray: 'ToArray', sort: 'Sort', reverse: 'Reverse', removeAll: 'RemoveAll', find: 'Find', exists: 'Exists', containsKey: 'ContainsKey', tryGetValue: 'TryGetValue' };
const PREC = { '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6, '===': 6, '!==': 6, '<': 7, '>': 7, '<=': 7, '>=': 7, instanceof: 7, in: 7, '<<': 8, '>>': 8, '>>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10 };

function typeText(node) {
  // UnityEngine.UI.Image / System.Collections.Generic.List$1(UnityEngine.Vector3) → Image / List<Vector3>
  if (!node) return 'object';
  if (node.type === 'Identifier') return node.name.replace(/\$\d+$/, '');
  if (node.type === 'MemberExpression' && !node.computed) {
    const full = memberPath(node);
    if (full) return full.replace(STRIP_NS, '').replace(/\$\d+$/, '').replace(/^Int32$/, 'int').replace(/^Single$/, 'float').replace(/^String$/, 'string').replace(/^Boolean$/, 'bool').replace(/^Double$/, 'double');
  }
  if (node.type === 'CallExpression' && /\$\d+$/.test(memberPath(node.callee) || '')) {
    return typeText(node.callee) + '<' + node.arguments.map(typeText).join(', ') + '>';
  }
  return 'object';
}

function memberPath(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'MemberExpression' && !node.computed) {
    const o = memberPath(node.object);
    return o ? o + '.' + node.property.name : null;
  }
  return null;
}
const looksLikeType = (n) => { const p = memberPath(n); return !!p && /^(UnityEngine|System|TMPro|DG|Spine|Cinemachine)\./.test(p) && /\.[A-Z]\w*(\$\d+)?$/.test(p); };
const isTrue = (n) => n && n.type === 'UnaryExpression' && n.operator === '!' && n.argument.type === 'NumericLiteral' && n.argument.value === 0;
const isFalse = (n) => n && n.type === 'UnaryExpression' && n.operator === '!' && n.argument.type === 'NumericLiteral' && n.argument.value === 1;

class Printer {
  constructor() { this.lines = []; this.depth = 0; }
  line(s) { this.lines.push('    '.repeat(this.depth) + s); }

  // ---------------------------------------------------------------- expressions
  expr(n, prec = 0) {
    switch (n.type) {
      case 'NumericLiteral': return Number.isInteger(n.value) ? String(n.value) : String(n.value) + 'f';
      case 'StringLiteral': return JSON.stringify(n.value);
      case 'BooleanLiteral': return String(n.value);
      case 'NullLiteral': return 'null';
      case 'Identifier': return n.name === 'undefined' ? 'null' : n.name.replace(/\$\d+$/, '');
      case 'ThisExpression': return 'this';
      case 'TemplateLiteral': return '$"' + n.quasis.map((q, i) => q.value.cooked + (n.expressions[i] ? '{' + this.expr(n.expressions[i]) + '}' : '')).join('') + '"';
      case 'ArrayExpression': return 'new[] { ' + n.elements.map((e) => this.expr(e)).join(', ') + ' }';
      case 'ObjectExpression': return '/* { ' + n.properties.map((p) => (p.key && (p.key.name || p.key.value)) + ': ' + (p.value ? this.expr(p.value) : '')).join(', ') + ' } */ null';
      case 'SequenceExpression': return n.expressions.map((e) => this.expr(e)).join(', ');
      case 'ParenthesizedExpression': return this.expr(n.expression, prec);
      case 'UnaryExpression': {
        if (isTrue(n)) return 'true';
        if (isFalse(n)) return 'false';
        if (n.operator === 'void') return 'null';
        if (n.operator === 'typeof') return 'typeof(' + this.expr(n.argument) + ')';
        if (n.operator === 'delete') return '/* delete */ ' + this.expr(n.argument);
        return n.operator + this.expr(n.argument, 11);
      }
      case 'UpdateExpression': return n.prefix ? n.operator + this.expr(n.argument, 11) : this.expr(n.argument, 11) + n.operator;
      case 'BinaryExpression': {
        // Bridge integer arithmetic: (a + b) | 0 → a + b
        if (n.operator === '|' && n.right.type === 'NumericLiteral' && n.right.value === 0) return this.expr(n.left, prec);
        const op = n.operator === '===' ? '==' : n.operator === '!==' ? '!=' : n.operator === '>>>' ? '>>' : n.operator;
        const p = PREC[n.operator] || 5;
        const s = this.expr(n.left, p) + ' ' + op + ' ' + this.expr(n.right, p + 1);
        return p < prec ? '(' + s + ')' : s;
      }
      case 'LogicalExpression': {
        const p = PREC[n.operator] || 1;
        const s = this.expr(n.left, p) + ' ' + (n.operator === '??' ? '??' : n.operator) + ' ' + this.expr(n.right, p + 1);
        return p < prec ? '(' + s + ')' : s;
      }
      case 'AssignmentExpression': {
        const s = this.expr(n.left) + ' ' + n.operator + ' ' + this.expr(n.right);
        return prec > 0 ? '(' + s + ')' : s;
      }
      case 'ConditionalExpression': {
        const s = this.expr(n.test, 1) + ' ? ' + this.expr(n.consequent) + ' : ' + this.expr(n.alternate);
        return prec > 0 ? '(' + s + ')' : s;
      }
      case 'MemberExpression': return this.member(n);
      case 'CallExpression': return this.call(n);
      case 'NewExpression': return this.newExpr(n);
      case 'FunctionExpression':
      case 'ArrowFunctionExpression': return this.lambda(n);
      default: return `/* ${n.type} */`;
    }
  }

  member(n) {
    if (n.computed) return this.expr(n.object, 12) + '[' + this.expr(n.property) + ']';
    const path = memberPath(n);
    if (path && /^(UnityEngine|System|TMPro|DG|Spine|Cinemachine)\./.test(path)) return path.replace(STRIP_NS, '').replace(/\$\d+$/, '');
    const name = n.property.name.replace(/\$\d+$/, '');
    if (name === 'length') return this.expr(n.object, 12) + '.Length';
    return this.expr(n.object, 12) + '.' + name;
  }

  args(list) { return list.map((a) => this.expr(a)).join(', '); }

  call(n) {
    const c = n.callee, a = n.arguments;
    const path = memberPath(c) || '';
    const last = c.type === 'MemberExpression' && !c.computed ? c.property.name : c.type === 'Identifier' ? c.name : '';
    const bare = last.replace(/\$\d+$/, '');
    // x.$clone() → x
    if (bare === '$clone' && c.type === 'MemberExpression') return this.expr(c.object, 12);
    // Vector3.op_Addition(a, b) → a + b
    if (OPS[bare] && a.length === 2) return '(' + this.expr(a[0], 9) + ' ' + OPS[bare] + ' ' + this.expr(a[1], 10) + ')';
    if (bare === 'op_UnaryNegation' && a.length === 1) return '-' + this.expr(a[0], 11);
    if (bare === 'op_Implicit' && a.length === 1) return this.expr(a[0]);
    if (bare === 'op_Explicit' && a.length === 1) return this.expr(a[0]);
    if (bare === 'op_LogicalNot' && a.length === 1) return '!' + this.expr(a[0], 11);
    // Luna's helpers for the implicit Vector2 ↔ Vector3 conversions
    if (/^(UnityEngine\.)?(Vector[234])\.FromVector[234]$/.test(path) && a.length === 1) return '(' + path.replace(/^UnityEngine\./, '').split('.')[0] + ')' + this.expr(a[0], 11);
    // pc.Vec3 math on a clone: a.$clone().add(b) → a + b
    if (c.type === 'MemberExpression' && VEC_METHODS[bare] && a.length === 1 && c.object.type === 'CallExpression' && memberPath(c.object.callee) && /\$clone$/.test(memberPath(c.object.callee))) {
      return '(' + this.expr(c.object, 9) + ' ' + VEC_METHODS[bare] + ' ' + this.expr(a[0], 10) + ')';
    }
    // Bridge runtime helpers
    if (/^Bridge\.Int\.(clip32|clipu32|clip64)$/.test(path)) return '(int)(' + this.expr(a[0]) + ')';
    if (/^Bridge\.Int\.(div|mul|mod)$/.test(path)) return '(' + this.expr(a[0], 9) + (bare === 'div' ? ' / ' : bare === 'mul' ? ' * ' : ' % ') + this.expr(a[1], 10) + ')';
    if (path === 'Bridge.is') return this.expr(a[0], 7) + ' is ' + typeText(a[1]);
    if (path === 'Bridge.as') return this.expr(a[0], 7) + ' as ' + typeText(a[1]);
    if (path === 'Bridge.cast') return '(' + typeText(a[1]) + ')' + this.expr(a[0], 11);
    if (path === 'Bridge.equals') return this.expr(a[0], 6) + ' == ' + this.expr(a[1], 7);
    if (path === 'Bridge.toString' || bare === 'toString') return (c.type === 'MemberExpression' && path !== 'Bridge.toString' ? this.expr(c.object, 12) : this.expr(a[0], 12)) + '.ToString()';
    if (path === 'Bridge.fn.cacheBind' || path === 'Bridge.fn.bind') {
      if (a[1] && (a[1].type === 'FunctionExpression' || a[1].type === 'ArrowFunctionExpression')) return this.lambda(a[1]);
      return a[1] ? this.expr(a[1]) : 'null';
    }
    if (path === 'Bridge.getDefaultValue' && a[0]) return 'default(' + typeText(a[0]) + ')';
    if (path === 'System.Array.init' && a.length >= 3) return 'new ' + typeText(a[2]) + '[' + this.expr(a[0]) + ']';
    if (/^System\.String\.(format|Format)$/.test(path)) return 'string.Format(' + this.args(a) + ')';
    if (/^System\.String\.isNullOrEmpty$/i.test(path)) return 'string.IsNullOrEmpty(' + this.args(a) + ')';
    if (/^System\.String\.concat$/i.test(path)) return a.map((x) => this.expr(x, 9)).join(' + ');
    if (/^Math\.\w+$/.test(path)) return 'Mathf.' + bare[0].toUpperCase() + bare.slice(1) + '(' + this.args(a) + ')';
    // generic Unity calls: GetComponent(UnityEngine.Image) → GetComponent<Image>()
    if (/^(GetComponent|GetComponentInChildren|GetComponentInParent|GetComponents|GetComponentsInChildren|GetComponentsInParent|AddComponent|FindObjectOfType|FindObjectsOfType|FindFirstObjectByType|Instantiate|Load|LoadAll)$/.test(bare) && a.length && looksLikeType(a[0])) {
      const target = c.type === 'MemberExpression' ? this.expr(c.object, 12) + '.' : '';
      const name = target && /^(Object|MonoBehaviour|Resources|UnityEngine\.Object)$/.test(this.expr(c.object)) ? (this.expr(c.object) === 'Resources' ? 'Resources.' : '') : target;
      return name + bare + '<' + typeText(a[0]) + '>(' + this.args(a.slice(1)) + ')';
    }
    // static extension-method call → instance call on the first argument
    if (c.type === 'MemberExpression' && EXTENSION_HOLDERS.test(memberPath(c.object) || '') && a.length) {
      let rest = a, generic = '';
      if (looksLikeType(a[0]) && a.length > 1) { generic = '<' + typeText(a[0]) + '>'; rest = a.slice(1); }
      return this.expr(rest[0], 12) + '.' + bare + generic + '(' + this.args(rest.slice(1)) + ')';
    }
    // List<T> / Dictionary: getItem / setItem / add…
    if (c.type === 'MemberExpression' && bare === 'getItem' && a.length === 1) return this.expr(c.object, 12) + '[' + this.expr(a[0]) + ']';
    if (c.type === 'MemberExpression' && bare === 'setItem' && a.length === 2) return this.expr(c.object, 12) + '[' + this.expr(a[0]) + '] = ' + this.expr(a[1]);
    if (c.type === 'MemberExpression' && LIST_METHODS[bare] && !/^[A-Z]/.test(bare)) return this.expr(c.object, 12) + '.' + LIST_METHODS[bare] + '(' + this.args(a) + ')';
    return this.expr(c, 12) + '(' + this.args(a) + ')';
  }

  newExpr(n) {
    const c = n.callee;
    // new (System.Collections.Generic.List$1(UnityEngine.Vector3).ctor)() → new List<Vector3>()
    if (c.type === 'MemberExpression' && !c.computed && /^(ctor|\$ctor\d+)$/.test(c.property.name) && c.object.type === 'CallExpression') {
      return 'new ' + typeText(c.object) + '(' + this.args(n.arguments) + ')';
    }
    if (c.type === 'MemberExpression' && !c.computed && /^(ctor|\$ctor\d+)$/.test(c.property.name)) return 'new ' + typeText(c.object) + '(' + this.args(n.arguments) + ')';
    const p = memberPath(c) || '';
    if (/^pc\.(Vec2|Vec3|Vec4|Quat|Color)$/.test(p)) return 'new ' + { Vec2: 'Vector2', Vec3: 'Vector3', Vec4: 'Vector4', Quat: 'Quaternion', Color: 'Color' }[p.slice(3)] + '(' + this.args(n.arguments) + ')';
    return 'new ' + typeText(c) + '(' + this.args(n.arguments) + ')';
  }

  lambda(fn) {
    const params = fn.params.map((x) => (x.type === 'Identifier' ? x.name : '_')).join(', ');
    const head = fn.params.length === 1 ? params : '(' + params + ')';
    const body = fn.body;
    if (body.type !== 'BlockStatement') return head + ' => ' + this.expr(body);
    if (body.body.length === 1 && body.body[0].type === 'ReturnStatement' && body.body[0].argument) return head + ' => ' + this.expr(body.body[0].argument);
    const sub = new Printer();
    sub.depth = this.depth + 1;
    body.body.forEach((s) => sub.stmt(s));
    return head + ' =>\n' + '    '.repeat(this.depth) + '{\n' + sub.lines.join('\n') + '\n' + '    '.repeat(this.depth) + '}';
  }

  // ---------------------------------------------------------------- statements
  block(n) {
    const list = n.type === 'BlockStatement' ? n.body : [n];
    this.line('{');
    this.depth++;
    list.forEach((s) => this.stmt(s));
    this.depth--;
    this.line('}');
  }

  stmt(n) {
    switch (n.type) {
      case 'ExpressionStatement': {
        const e = n.expression;
        if (e.type === 'SequenceExpression') { e.expressions.forEach((x) => this.stmt({ type: 'ExpressionStatement', expression: x })); return; }
        // a && b() / a || b() used as statements → if
        if (e.type === 'LogicalExpression' && (e.operator === '&&' || e.operator === '||')) {
          this.line('if (' + (e.operator === '||' ? '!(' + this.expr(e.left) + ')' : this.expr(e.left)) + ')');
          this.depth++; this.stmt({ type: 'ExpressionStatement', expression: e.right }); this.depth--;
          return;
        }
        if (e.type === 'ConditionalExpression') {
          this.line('if (' + this.expr(e.test) + ')');
          this.depth++; this.stmt({ type: 'ExpressionStatement', expression: e.consequent }); this.depth--;
          this.line('else');
          this.depth++; this.stmt({ type: 'ExpressionStatement', expression: e.alternate }); this.depth--;
          return;
        }
        this.line(this.expr(e) + ';');
        return;
      }
      case 'VariableDeclaration':
        for (const d of n.declarations) this.line(d.init ? 'var ' + (d.id.name || '_') + ' = ' + this.expr(d.init) + ';' : '/* var */ object ' + (d.id.name || '_') + ' = null;');
        return;
      case 'ReturnStatement':
        if (n.argument && n.argument.type === 'SequenceExpression') {
          const list = n.argument.expressions;
          list.slice(0, -1).forEach((x) => this.stmt({ type: 'ExpressionStatement', expression: x }));
          this.line('return ' + this.expr(list[list.length - 1]) + ';');
          return;
        }
        this.line(n.argument ? 'return ' + this.expr(n.argument) + ';' : 'return;');
        return;
      case 'IfStatement':
        this.line('if (' + this.expr(n.test) + ')');
        this.block(n.consequent);
        if (n.alternate) {
          if (n.alternate.type === 'IfStatement') { this.line('else'); this.stmt(n.alternate); } else { this.line('else'); this.block(n.alternate); }
        }
        return;
      case 'BlockStatement': this.block(n); return;
      case 'ForStatement': {
        const init = n.init ? (n.init.type === 'VariableDeclaration' ? 'var ' + n.init.declarations.map((d) => d.id.name + (d.init ? ' = ' + this.expr(d.init) : '')).join(', ') : this.expr(n.init)) : '';
        // for (var e = Bridge.getEnumerator(list); e.moveNext();) { var x = e.Current … } → foreach
        const en = n.init && n.init.type === 'VariableDeclaration' && n.init.declarations[0] && n.init.declarations[0].init;
        if (en && en.type === 'CallExpression' && /getEnumerator$/.test(memberPath(en.callee) || '') && n.body.type === 'BlockStatement') {
          const src = en.arguments[0] ? this.expr(en.arguments[0]) : this.expr(en.callee.object || en.callee);
          const first = n.body.body[0];
          const itemName = first && first.type === 'VariableDeclaration' && first.declarations[0].init && /Current$/.test(memberPath(first.declarations[0].init) || '') ? first.declarations[0].id.name : 'item';
          this.line(`foreach (var ${itemName} in ${src})`);
          this.block({ type: 'BlockStatement', body: n.body.body.slice(itemName === 'item' ? 0 : 1) });
          return;
        }
        this.line('for (' + init + '; ' + (n.test ? this.expr(n.test) : '') + '; ' + (n.update ? this.expr(n.update) : '') + ')');
        this.block(n.body);
        return;
      }
      case 'ForInStatement': this.line('foreach (var ' + (n.left.declarations ? n.left.declarations[0].id.name : this.expr(n.left)) + ' in ' + this.expr(n.right) + ')'); this.block(n.body); return;
      case 'ForOfStatement': this.line('foreach (var ' + (n.left.declarations ? n.left.declarations[0].id.name : this.expr(n.left)) + ' in ' + this.expr(n.right) + ')'); this.block(n.body); return;
      case 'WhileStatement': this.line('while (' + this.expr(n.test) + ')'); this.block(n.body); return;
      case 'DoWhileStatement': this.line('do'); this.block(n.body); this.line('while (' + this.expr(n.test) + ');'); return;
      case 'BreakStatement': this.line('break;'); return;
      case 'ContinueStatement': this.line('continue;'); return;
      case 'ThrowStatement': this.line('throw ' + this.expr(n.argument) + ';'); return;
      case 'EmptyStatement': return;
      case 'TryStatement':
        this.line('try'); this.block(n.block);
        if (n.handler) { this.line('catch' + (n.handler.param ? ' (System.Exception ' + n.handler.param.name + ')' : '')); this.block(n.handler.body); }
        if (n.finalizer) { this.line('finally'); this.block(n.finalizer); }
        return;
      case 'SwitchStatement':
        this.line('switch (' + this.expr(n.discriminant) + ')');
        this.line('{');
        this.depth++;
        n.cases.forEach((cs) => {
          this.line(cs.test ? 'case ' + this.expr(cs.test) + ':' : 'default:');
          this.depth++;
          cs.consequent.forEach((s) => this.stmt(s));
          this.depth--;
        });
        this.depth--;
        this.line('}');
        return;
      case 'FunctionDeclaration':
        this.line('// local function ' + (n.id ? n.id.name : '') + ':');
        this.line('System.Action ' + (n.id ? n.id.name : 'fn') + ' = ' + this.lambda(n) + ';');
        return;
      case 'LabeledStatement': this.line(n.label.name + ':'); this.stmt(n.body); return;
      default: this.line(`/* ${n.type} */`);
    }
  }
}

// ---------------------------------------------------------------- coroutines
/**
 * Bridge compiles an iterator method to
 *   var t = 0, n = new Bridge.GeneratorEnumerator(Bridge.fn.bind(this, function () { try { for (;;) switch (t) {
 *     case 0: … return n.current = X, t = 1, !0;  case 1: …  default: return !1 } } catch … }));  return n;
 * Rebuilt as the equivalent C# state machine (always valid C#; linear coroutines read naturally).
 */
function coroutine(p, body) {
  const decl = body.body.find((s) => s.type === 'VariableDeclaration' && s.declarations.some((d) => d.init && d.init.type === 'NewExpression' && /GeneratorEnumerator$/.test(memberPath(d.init.callee) || '')));
  if (!decl) return false;
  const genDecl = decl.declarations.find((d) => d.init && d.init.type === 'NewExpression');
  const enumName = genDecl.id.name;
  const bound = genDecl.init.arguments[0];
  const fn = bound && bound.type === 'CallExpression' ? bound.arguments[1] || bound.arguments[0] : bound;
  if (!fn || !fn.body) return false;
  const stateVar = decl.declarations.find((d) => d !== genDecl && d.init && d.init.type === 'NumericLiteral');
  // locals declared next to the enumerator (hoisted by Bridge)
  for (const d of decl.declarations) if (d !== genDecl && d !== stateVar) p.line(d.init ? `var ${d.id.name} = ${p.expr(d.init)};` : `/* var */ object ${d.id.name} = null;`);
  let sw = null;
  (function find(n) {
    if (!n || typeof n !== 'object' || sw) return;
    if (n.type === 'SwitchStatement') { sw = n; return; }
    for (const k of Object.keys(n)) if (k !== 'loc' && k !== 'start' && k !== 'end') { const v = n[k]; if (Array.isArray(v)) v.forEach(find); else if (v && typeof v.type === 'string') find(v); }
  })(fn.body);
  if (!sw) return false;
  const st = stateVar ? stateVar.id.name : 'state';
  p.line(`var ${st} = 0;`);
  p.line('while (true)');
  p.line('{');
  p.depth++;
  p.line(`switch (${st})`);
  p.line('{');
  p.depth++;
  sw.cases.forEach((cs, i) => {
    p.line(cs.test ? 'case ' + p.expr(cs.test) + ':' : 'default:');
    p.depth++;
    let ended = false;
    for (const s of cs.consequent) {
      // return n.current = X, t = k, !0  →  t = k; yield return X; break;
      if (s.type === 'ReturnStatement' && s.argument) {
        const parts = s.argument.type === 'SequenceExpression' ? s.argument.expressions : [s.argument];
        const last = parts[parts.length - 1];
        if (isTrue(last) || (last.type === 'BooleanLiteral' && last.value)) {
          let yielded = 'null';
          for (const x of parts.slice(0, -1)) {
            if (x.type === 'AssignmentExpression' && memberPath(x.left) === enumName + '.current') yielded = p.expr(x.right);
            else p.stmt({ type: 'ExpressionStatement', expression: x });
          }
          p.line(`yield return ${yielded};`);
          p.line('break;');
          ended = true;
          break;
        }
        if (isFalse(last) || (last.type === 'BooleanLiteral' && !last.value)) {
          parts.slice(0, -1).forEach((x) => p.stmt({ type: 'ExpressionStatement', expression: x }));
          p.line('yield break;');
          ended = true;
          break;
        }
      }
      p.stmt(s);
    }
    if (!ended) {
      // JS falls through into the next case; C# has to say so
      const next = sw.cases[i + 1];
      p.line(next ? (next.test ? `goto case ${p.expr(next.test)};` : 'goto default;') : 'yield break;');
    }
    p.depth--;
  });
  p.depth--;
  p.line('}');
  p.depth--;
  p.line('}');
  return true;
}

/** "function(a, b){…}" → { params: ['a','b'], lines: [...] } in C# style, or null when it does not parse. */
function translateFunction(src) {
  let fn;
  try {
    const ast = parser.parse('(' + src + ')', { sourceType: 'script', errorRecovery: true });
    fn = ast.program.body[0] && ast.program.body[0].expression;
  } catch { return null; }
  if (!fn || (fn.type !== 'FunctionExpression' && fn.type !== 'ArrowFunctionExpression')) return null;
  const p = new Printer();
  const body = fn.body.type === 'BlockStatement' ? fn.body : { type: 'BlockStatement', body: [{ type: 'ReturnStatement', argument: fn.body }] };
  let isCoroutine = false;
  try {
    if (/GeneratorEnumerator/.test(src)) isCoroutine = coroutine(p, body);
    if (!isCoroutine) body.body.forEach((s) => {
      // Bridge optional args: void 0 === x && (x = 5)  →  (default value)
      p.stmt(s);
    });
  } catch (e) { return null; }
  return { params: fn.params.map((x) => (x.type === 'Identifier' ? x.name : '_')), lines: p.lines, isCoroutine };
}

module.exports = { translateFunction };
