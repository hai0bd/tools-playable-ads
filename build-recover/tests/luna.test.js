'use strict';
// Luna → Unity. Unit tests on synthetic data + (when sample playables sit in _out/luna/) a full recovery whose
// references must all resolve: every guid a scene/prefab/asset points to exists in the project, in a package the
// manifest pulls in, or among Unity's builtins. The bundle (browser) must write the same project as Node.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { extractLuna, base122 } = require('../core/luna/extract');
const { Schema, Ref, Vec3, List } = require('../core/luna/schema');
const { num, str, unityFile, flow } = require('../core/luna/unity/yaml');
const { translateFunction } = require('../core/luna/unity/js2cs');
const KNOWN = require('../core/luna/unity/known-guids.json');

const ROOT = path.join(__dirname, '..');
const SAMPLES = path.join(ROOT, '_out', 'luna');

test('yaml: số float32 ngắn nhất, chuỗi cần quote', () => {
  assert.strictEqual(num(0.400000005960464), '0.4');
  assert.strictEqual(num(-19), '-19');
  assert.strictEqual(num(1.17940435195862e-9), '1.1794044e-9');
  assert.strictEqual(str('Main Camera'), 'Main Camera');
  assert.strictEqual(str('a: b'), '"a: b"');
  assert.strictEqual(str('123'), '"123"');
  assert.strictEqual(str(''), '');
  const y = unityFile([{ classId: 1, fileId: 5, type: 'GameObject', body: { m_Name: 'X', m_Component: [{ component: flow({ fileID: 7 }) }], m_IsActive: true } }]);
  assert.match(y, /--- !u!1 &5\nGameObject:\n  m_Name: X\n  m_Component:\n  - component: \{fileID: 7\}\n  m_IsActive: 1\n/);
});

test('extract: payload Brotli base64/base122 và ảnh inline', () => {
  const json = zlib.brotliCompressSync(Buffer.from(JSON.stringify({ a: 1 }))).toString('base64');
  const code = zlib.brotliCompressSync(Buffer.from('var Deserializers={types:["X"]};')).toString('base64');
  const html = `<title>T</title><img id="assets/bundles/-1/5.png" src="data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}">
<script>decompressString("${json}", false).then(function (json) { window.jsons["assets/bundles.json"] = JSON.parse(json); });
decompressString("${code}", false).then(function (code) { window.eval(code); });</script>`;
  const x = extractLuna(html);
  assert.deepStrictEqual(x.jsons['assets/bundles.json'], { a: 1 });
  assert.match(x.code, /Deserializers/);
  assert.strictEqual(x.media['assets/bundles/-1/5.png'].bytes.toString(), 'PNGDATA');
  // base122 chuẩn: 7 bit/ký tự
  assert.deepStrictEqual([...base122('AB')], [131]);
});

test('schema: chạy Deserializers của build với ngữ cảnh ghi lại', () => {
  const code = `var Deserializers={
    "Luna.Unity.DTO.UnityEngine.Scene.GameObject":function(e,t,n){var i=n||e.c("Luna.Unity.DTO.UnityEngine.Scene.GameObject"),A=t;return i.name=A[0],i.tagId=A[1],i.enabled=!!A[2],i.isStatic=!!A[3],i.layer=A[4],i},
    Foo:function(e,t,n){for(var i=n||e.c("Foo"),A=t,r=A[3],s=new(System.Collections.Generic.List$1(Bridge.ns("UnityEngine.Transform"))),o=0;o<r.length;o+=2)e.r(r[o+0],r[o+1],1,s,"");return i.list=s,e.r(A[0],A[1],0,i,"target"),i.pos=new pc.Vec3(A[4],A[5],A[6]),i.on=!!A[2],i},
    types:["UnityEngine.Transform","UnityEngine.MonoBehaviour","Foo"],unityVersion:"2022.3.1f1"};`;
  const s = new Schema(code);
  const c = s.component({ type: 1, class: 2, id: 9, data: [0, 44, 1, [0, 5, 0, 6], 1, 2, 3] });
  assert.strictEqual(c.className, 'Foo');
  assert.ok(c.value.target instanceof Ref && c.value.target.type === 'UnityEngine.Transform' && c.value.target.id === 44);
  assert.ok(c.value.list instanceof List && c.value.list.items.length === 2);
  assert.ok(c.value.pos instanceof Vec3 && c.value.pos.z === 3);
  assert.strictEqual(c.value.on, true);
  assert.strictEqual(s.info().unityVersion, '2022.3.1f1');
});

test('js2cs: thành ngữ Bridge.NET → C#', () => {
  const t = translateFunction('function(){for(var e=this.transform.childCount-1|0;e>=0;e=e-1|0){var t=this.transform.GetChild(e).GetComponent(UnityEngine.RectTransform);this.items.add(t)}UnityEngine.MonoBehaviour.op_Equality(X.Instance,null)&&(X.Instance=this),this.a=!1,this.p=this.p.$clone().add(new pc.Vec3(1,2,.5)),this.StartCoroutine$1(this.Run())}');
  const out = t.lines.join('\n');
  assert.match(out, /for \(var e = this\.transform\.childCount - 1; e >= 0; e = e - 1\)/);
  assert.match(out, /GetComponent<RectTransform>\(\)/);
  assert.match(out, /this\.items\.Add\(t\)/);
  assert.match(out, /if \(\(X\.Instance == null\)\)\n\s+X\.Instance = this;/);
  assert.match(out, /this\.a = false;/);
  assert.match(out, /this\.p = \(this\.p \+ new Vector3\(1, 2, 0\.5f\)\);/);
  assert.match(out, /this\.StartCoroutine\(this\.Run\(\)\);/);
  const co = translateFunction('function(){var e=0,t=new Bridge.GeneratorEnumerator(Bridge.fn.bind(this,(function(){try{for(;;)switch(e){case 0:return t.current=new UnityEngine.WaitForSeconds(1),e=1,!0;case 1:this.Go();default:return!1}}catch(e){throw e}})));return t}');
  const cs = co.lines.join('\n');
  assert.ok(co.isCoroutine);
  assert.match(cs, /yield return new WaitForSeconds\(1\);/);
  assert.match(cs, /this\.Go\(\);\n\s+goto default;/);
});

test('scene transform: ghép theo post-order (con trước cha) như loader của Luna', () => {
  const { LunaModel } = require('../core/luna/model');
  const node = (id, name, children = [], components = []) => ({ id, name, components, children, parent: null });
  //  A            (root, lá)
  //  R            (root)
  //  ├ P
  //  │ ├ C1
  //  │ └ C2
  //  └ Q          (có RectTransform → Luna không phát entry cho nó)
  const c1 = node(1, 'C1'), c2 = node(2, 'C2');
  const p = node(3, 'P', [c1, c2]);
  const q = node(4, 'Q', [], [{ className: 'UnityEngine.RectTransform', id: 99 }]);
  const a = node(5, 'A');
  const r = node(6, 'R', [p, q]);
  // post-order qua [A, R]: A, C1, C2, P, (Q bỏ), R  —  pre-order sẽ là A, R, P, C1, C2
  const ids = [10, 11, 12, 13, 14];
  const n = ids.length;
  const rec = {
    name: 'S', transform_ids: ids,
    local_positions: Array.from({ length: n * 3 }, (_, k) => (k % 3 === 0 ? (k / 3) | 0 : 0)),
    local_rotations: Array.from({ length: n * 4 }, (_, k) => (k % 4 === 3 ? 1 : 0)),
    local_scales: Array.from({ length: n * 3 }, (_, k) => (k % 3 === 0 ? 1 + (((k / 3) | 0) / 10) : 1)),
  };
  const m = Object.create(LunaModel.prototype);
  m.errors = []; m.components = new Map(); m.x = { blobs: {} };
  m.sceneTransforms(rec, [a, r], -1);

  const tr = (nd) => nd.components.find((c) => c.className === 'UnityEngine.Transform');
  for (const [nd, i] of [[a, 0], [c1, 1], [c2, 2], [p, 3], [r, 4]]) {
    const t = tr(nd);
    assert.ok(t, `${nd.name}: thiếu Transform`);
    assert.strictEqual(t.id, ids[i], `${nd.name}: phải nhận transform_ids[${i}]`);
    assert.strictEqual(t.value.position.x, i, `${nd.name}: phải nhận local_positions[${i}]`);
    assert.strictEqual(t.value.scale.x, 1 + i / 10, `${nd.name}: phải nhận local_scales[${i}]`);
    assert.strictEqual(m.components.get(ids[i]).node, nd);
  }
  // cha KHÔNG được nhận entry của chính nó trước các con (lỗi pre-order cũ: R nhận entry [1])
  assert.notStrictEqual(tr(r).id, ids[1]);
  assert.strictEqual(tr(q), undefined, 'Q có RectTransform thì không lấy từ mảng');
  assert.deepStrictEqual(m.errors, []);
});

test('scene transform: lệch số lượng thì phải cảnh báo', () => {
  const { LunaModel } = require('../core/luna/model');
  const node = (id, name, children = []) => ({ id, name, components: [], children, parent: null });
  const child = node(1, 'C');
  const root = node(2, 'R', [child]);
  const m = Object.create(LunaModel.prototype);
  m.errors = []; m.components = new Map(); m.x = { blobs: {} };
  m.sceneTransforms({ name: 'S', transform_ids: [7], local_positions: [0, 0, 0], local_rotations: [0, 0, 0, 1], local_scales: [1, 1, 1] }, [root], -1);
  assert.match(m.errors[0] || '', /1 transform tách riêng nhưng 2 object thiếu Transform/);
});

// ---------------------------------------------------------------- full recoveries
const samples = fs.existsSync(SAMPLES) ? fs.readdirSync(SAMPLES).filter((f) => /\.html$/.test(f) && !/balloon-old/.test(f)) : [];

function allFiles(dir, base = '', out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) allFiles(path.join(dir, e.name), rel, out); else out.push(rel);
  }
  return out;
}

for (const f of samples) {
  test('Luna → Unity: ' + f, { timeout: 120000 }, () => {
    const { recover } = require('../core');
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'br-luna-'));
    try {
      const r = recover(path.join(SAMPLES, f), { out });
      assert.strictEqual(r.engine, 'unity');
      const files = allFiles(out);
      assert.ok(files.some((x) => /\.unity$/.test(x)), 'có scene');
      // every asset has its .meta, no .meta without its asset
      const set = new Set(files);
      for (const x of files) {
        if (/^(Assets)\//.test(x) && !/\.meta$/.test(x)) assert.ok(set.has(x + '.meta'), 'thiếu meta: ' + x);
        if (/\.meta$/.test(x)) assert.ok(set.has(x.slice(0, -5)) || !/\./.test(path.basename(x.slice(0, -5))) || fs.statSync(path.join(out, x.slice(0, -5))).isDirectory(), 'meta mồ côi: ' + x);
      }
      // every referenced guid resolves
      const guids = new Set();
      for (const x of files) if (/\.meta$/.test(x)) guids.add((fs.readFileSync(path.join(out, x), 'utf8').match(/^guid: (\w+)/m) || [])[1]);
      const known = new Set([...Object.values(KNOWN.scripts), ...Object.values(KNOWN.dllScripts || {}).map((d) => d[0]), ...Object.values(KNOWN.shaders), ...Object.values(KNOWN.assets), '0000000000000000e000000000000000', '0000000000000000f000000000000000']);
      const missing = new Set();
      for (const x of files) {
        if (!/\.(unity|prefab|mat|asset|anim|controller)$/.test(x)) continue;
        const y = fs.readFileSync(path.join(out, x), 'utf8');
        assert.ok(!/: (undefined|NaN)\s*$/m.test(y), `${x}: có giá trị undefined/NaN`);
        // only real references ({fileID, guid, type}): object names may contain "guid: …" text from the original
        for (const m of y.matchAll(/guid: (\w{32}), type:/g)) if (!guids.has(m[1]) && !known.has(m[1])) missing.add(`${x} → ${m[1]}`);
      }
      assert.deepStrictEqual([...missing].slice(0, 10), []);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
}
