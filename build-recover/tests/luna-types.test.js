'use strict';
// Luna → Unity C#: type hierarchy, types only the code defines, inferred signatures, Luna stub, DOTween copy.
// Synthetic Bridge.NET code shaped like real builds (DollController : Item, nested enums, Singleton$1(T)…).
// With BUILD_RECOVER_UNITY_REFS (folder(s) with UnityEngine.UI.dll / Unity.TextMeshPro.dll / spine-*.dll, e.g. a
// project's Library/ScriptAssemblies) and a Unity install, every sample in _out/luna/ is also compiled with Roslyn.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TypeModel, inferSignatures } = require('../core/luna/unity/types');
const { classSource } = require('../core/luna/unity/csharp');
const extras = require('../core/luna/unity/extras');
const { translateFunction } = require('../core/luna/unity/js2cs');
const { Out } = require('../core/luna/unity/project');

const CODE = [
  'Bridge.define("DollBase.Configs",{statics:{fields:{IS_DONE_DRESSUP:!1,KEY:null,MAX:0},ctors:{init:function(){this.KEY="Key",this.MAX=5}}}})',
  'Bridge.define("DollBase.Configs.SOUND_TYPE",{$kind:1006,statics:{fields:{CLICK_DOLL:0,BLINK:3,alarm:10}}})',
  'Bridge.define("IClickable",{$kind:3})',
  'Bridge.define("Singleton$1",(function(e){return{inherits:[UnityEngine.MonoBehaviour],statics:{fields:{instance:Bridge.getDefaultValue(e)},props:{Instance:{get:function(){return Bridge.rValue(Singleton$1(e).instance)}}}},methods:{Awake:function(){}}}}))',
  'Bridge.define("UserData",{inherits:function(){return[Singleton$1(UserData)]},statics:{props:{Level:{get:function(){return UnityEngine.PlayerPrefs.GetInt(DollBase.Configs.KEY,1)},set:function(e){UnityEngine.PlayerPrefs.SetInt(DollBase.Configs.KEY,e)}}}},methods:{Awake$1:function(){Singleton$1(UserData).prototype.Awake.call(this)}}})',
  'Bridge.define("Item",{inherits:[UnityEngine.MonoBehaviour,IClickable],fields:{Type:0,IndexLayer:0,_checkDrag:!1},methods:{Start:function(){},SetIndexLayer:function(e){this.IndexLayer=e},OnMouseDown:function(){}}})',
  'Bridge.define("DollController",{inherits:[Item],fields:{_idHair:0,_sound:0,_name:null},props:{IdHair:{get:function(){return this._idHair}}},ctors:{init:function(){this._sound=DollBase.Configs.SOUND_TYPE.BLINK,this._name="Judy"}},' +
    'methods:{Start$1:function(){Item.prototype.Start.call(this)},SetIndexLayer:function(e){this.IndexLayer=e},UpdateHair:function(e){-1!==e&&(this._idHair=e,this.ShowBlink(0))},ShowBlink:function(e){},' +
    'Play:function(e){e===DollBase.Configs.SOUND_TYPE.BLINK&&this.ShowBlink(1)},Play$1:function(e,t){void 0===t&&(t=!0),this.Show(e,t)},Show:function(e,t){this._name=e},GetHair:function(){return this._idHair},Wait:function(){var e=0,t=new Bridge.GeneratorEnumerator(Bridge.fn.bind(this,function(){for(;;)switch(e){case 0:return t.current=null,e=1,!0;default:return!1}}));return t}},' +
    'statics:{methods:{Make:function($){return $},Make$1:function($){return $}}}})',
  'Bridge.define("GM",{inherits:[UnityEngine.MonoBehaviour],fields:{doll:null},methods:{Start:function(){this.doll.UpdateHair(112),this.doll.Play(DollBase.Configs.SOUND_TYPE.alarm),this.doll.Play$1("hi"),Luna.Unity.Playable.InstallFullGame(),Luna.Unity.Analytics.LogEvent(Luna.Unity.Analytics.EventType.EndCardShown)}}})',
].join(',');

// minimal UnityProject the C# writer needs (no scenes): DollController has a deserializer, Item has none
function fakeProject(code = CODE) {
  return {
    m: { x: { code }, schema: { D: { DollController: function (e, t, n) { var i = n || e.c('DollController'), A = t; return (i.Type = A[0]), (i.IndexLayer = A[1]), (i._idHair = A[2]), i; } } } },
    typeAvailable: (t) => /^UnityEngine\./.test(t),
    intHint: () => false,
    scriptSamples: new Map(),
    eventMethods: new Map(),
    scriptKinds: new Map(),
  };
}

test('types: lớp cơ sở, interface, enum lồng, generic', () => {
  const m = new TypeModel(CODE);
  assert.strictEqual(m.get('DollController').baseRaw, 'Item');
  assert.deepStrictEqual(m.get('Item').interfaces, ['IClickable']);
  assert.strictEqual(m.get('DollBase.Configs.SOUND_TYPE').kind, 'enum');
  assert.strictEqual(m.get('DollBase.Configs.SOUND_TYPE').outer, 'DollBase.Configs');
  assert.strictEqual(m.namespaceOf('DollBase.Configs'), 'DollBase');
  assert.deepStrictEqual(m.get('Singleton$1').generic, ['e']);
  assert.strictEqual(m.csType(m.get('UserData').baseRaw), 'Singleton<UserData>');
  assert.ok(m.isComponent('DollController') && m.isComponent('UserData'));
  assert.deepStrictEqual([...m.inheritedFieldNames('DollController')].sort(), ['IndexLayer', 'Type', '_checkDrag']);
  assert.deepStrictEqual(m.enumValues('DollBase.Configs.SOUND_TYPE'), [['CLICK_DOLL', 0], ['BLINK', 3], ['alarm', 10]]);
});

test('types: suy kiểu tham số / giá trị trả về từ cách code dùng', () => {
  const m = new TypeModel(CODE);
  const fields = { 'DollController._idHair': 'int', 'DollController._name': 'string', 'Item.IndexLayer': 'int' };
  const s = inferSignatures(m, (c, f) => fields[c + '.' + f] || null);
  const d = s.get('DollController');
  assert.strictEqual(d.get('UpdateHair').params[0].type, 'int', 'gán vào field int + gọi với 112');
  assert.strictEqual(d.get('ShowBlink').params[0].type, 'int', 'gọi với 0 và 1');
  assert.strictEqual(d.get('Play').params[0].type, 'DollBase.Configs.SOUND_TYPE', 'so sánh với enum');
  assert.strictEqual(d.get('Play$1').params[0].type, 'string', 'gọi với "hi" rồi gán vào field string');
  assert.strictEqual(d.get('Play$1').params[1].type, 'bool', 'void 0===t&&(t=!0)');
  assert.strictEqual(d.get('GetHair').ret, 'int');
  assert.strictEqual(d.get('Wait').ret, 'System.Collections.IEnumerator');
  assert.strictEqual(s.get('Item').get('SetIndexLayer').params[0].type, 'int');
});

test('C#: kế thừa thật, không khai lại field của lớp cơ sở, override, overload, kiểu suy ra', () => {
  const p = fakeProject();
  const item = classSource(p, 'Item', 'mono');
  assert.match(item, /public class Item : UnityEngine\.MonoBehaviour, IClickable/);
  assert.match(item, /public int Type;|public float Type;/);
  assert.match(item, /public int IndexLayer;/, 'field serialize của lớp cơ sở lấy từ dữ liệu lớp con');
  assert.match(item, /protected virtual void Start\(\)/);
  assert.match(item, /public virtual void SetIndexLayer\(int e\)/);
  const doll = classSource(p, 'DollController', 'mono');
  assert.match(doll, /public class DollController : Item\n/);
  assert.doesNotMatch(doll, /public \w+ (Type|IndexLayer);/, 'field của Item không được khai lại');
  assert.match(doll, /protected override void Start\(\)/, 'Start\$1 là Start của lớp con');
  assert.match(doll, /public override void SetIndexLayer\(int e\)/);
  assert.match(doll, /public void UpdateHair\(int e\)/);
  assert.match(doll, /public void Play\(DollBase\.Configs\.SOUND_TYPE e\)/, 'overload Play\$1 → Play vì kiểu tham số khác nhau');
  assert.match(doll, /public void Play\(string e, bool t = true\)/);
  assert.match(doll, /public int GetHair\(\)\n\s*\{[^}]*return default;/);
  assert.match(doll, /public System\.Collections\.IEnumerator Wait\(\)/);
  assert.match(doll, /public DollBase\.Configs\.SOUND_TYPE _sound = DollBase\.Configs\.SOUND_TYPE\.BLINK;/, 'field runtime kiểu enum + giá trị khởi tạo');
  assert.match(doll, /public string _name = "Judy";/);
  assert.match(doll, /public int IdHair \{ get => this\._idHair; \}/);
  assert.match(doll, /public static object Make_static|public static object Make\(object p0\)/, 'tên tham số "\$" → hợp lệ');
  assert.match(doll, /\/\/ base\.Start\(\);/, 'Item.prototype.Start.call(this) → base.Start()');
  const cfg = classSource(p, 'DollBase.Configs', null);
  assert.match(cfg, /namespace DollBase\n\{\n    public class Configs\n/, 'lớp hằng số: không kế thừa MonoBehaviour');
  assert.match(cfg, /public static string KEY = "Key";/);
  assert.match(cfg, /public enum SOUND_TYPE\n\s*\{\n\s*CLICK_DOLL = 0,\n\s*BLINK = 3,\n\s*alarm = 10,/);
  const ud = classSource(p, 'UserData', 'mono');
  assert.match(ud, /public class UserData : Singleton<UserData>/);
  assert.match(ud, /public static int Level \{ get => UnityEngine\.PlayerPrefs\.GetInt\(DollBase\.Configs\.KEY, 1\); set => UnityEngine\.PlayerPrefs\.SetInt\(DollBase\.Configs\.KEY, value\); \}/);
  assert.match(ud, /protected override void Awake\(\)/);
  const sg = classSource(p, 'Singleton$1', null);
  assert.match(sg, /public class Singleton<T> : UnityEngine\.MonoBehaviour/);
  assert.match(sg, /public static T instance;/);
  assert.match(sg, /public static T Instance/);
  assert.match(classSource(p, 'IClickable', null), /public interface IClickable\n\{\n\}/);
});

test('js2cs: if với biểu thức dấu phẩy, && có nhiều lệnh, gọi lớp cơ sở', () => {
  const t = translateFunction('function(e){if(this.a=1,e)this.g();this.x&&(this.y=5,this.z()),Item.prototype.OnTriggerEnter.call(this,e)}').lines.join('\n');
  assert.match(t, /^this\.a = 1;\nif \(e\)/);
  assert.match(t, /if \(this\.x\)\n\{\n    this\.y = 5;\n    this\.z\(\);\n\}/);
  assert.match(t, /base\.OnTriggerEnter\(e\);/);
});

test('Luna stub: đúng các API code game gọi', () => {
  const api = extras.lunaUsage(new TypeModel(CODE));
  assert.ok(api.Playable.methods.has('InstallFullGame'));
  assert.ok(api.Analytics.methods.has('LogEvent'));
  assert.ok(api.Analytics.enums.get('EventType').has('EndCardShown'));
  const cs = extras.lunaStubSource(api);
  assert.match(cs, /namespace Luna\.Unity/);
  assert.match(cs, /public static void InstallFullGame\(params object\[\] args\)/);
  assert.match(cs, /public enum EventType\n\s*\{\n\s*EndCardShown,/);
});

test('DOTween: chép cả thư mục Demigiant kèm .meta gốc, bỏ Examples', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'br-dotween-src-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'br-dotween-out-'));
  try {
    const d = path.join(src, 'Assets', 'Plugins', 'Demigiant');
    fs.mkdirSync(path.join(d, 'DOTween', 'Modules'), { recursive: true });
    fs.mkdirSync(path.join(d, 'DOTweenPro Examples'), { recursive: true });
    fs.writeFileSync(path.join(d, 'DOTween', 'DOTween.dll'), 'dll');
    fs.writeFileSync(path.join(d, 'DOTween', 'DOTween.dll.meta'), 'guid: a811bde74b26b53498b4f6d872b09b6d');
    fs.writeFileSync(path.join(d, 'DOTween', 'Modules', 'DOTweenModuleUI.cs'), '// ui');
    fs.writeFileSync(path.join(d, 'DOTweenPro Examples', 'Demo.unity'), 'x');
    let n = 0;
    const p = { out: new Out(out), count: () => n++ };
    assert.strictEqual(path.resolve(extras.findDOTween(src)), path.resolve(d, 'DOTween'));
    const r = extras.copyDOTween(p, src);
    assert.ok(r && !r.pro);
    assert.strictEqual(fs.readFileSync(path.join(out, 'Assets/Plugins/Demigiant/DOTween/DOTween.dll.meta'), 'utf8'), 'guid: a811bde74b26b53498b4f6d872b09b6d', 'GUID gốc');
    assert.ok(fs.existsSync(path.join(out, 'Assets/Plugins/Demigiant/DOTween/Modules/DOTweenModuleUI.cs.meta')), 'file thiếu .meta được tạo meta');
    assert.ok(!fs.existsSync(path.join(out, 'Assets/Plugins/Demigiant/DOTweenPro Examples')));
    assert.strictEqual(extras.findDOTween(out + '/nothing'), null);
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- full recoveries: generated C# must compile
const SAMPLES = path.join(__dirname, '..', '_out', 'luna');
const samples = fs.existsSync(SAMPLES) ? fs.readdirSync(SAMPLES).filter((f) => /\.html$/.test(f) && !/balloon-old/.test(f)) : [];
const { compileCheck, findUnityData } = require('../scripts/compile-check');
const canCompile = !!process.env.BUILD_RECOVER_UNITY_REFS && !!findUnityData();

for (const f of samples) {
  test('Luna → Unity C#: ' + f, { timeout: 300000, skip: canCompile ? false : 'cần Unity + BUILD_RECOVER_UNITY_REFS để compile' }, () => {
    const { recover } = require('../core');
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'br-luna-cs-'));
    try {
      recover(path.join(SAMPLES, f), { out });
      // no class declares a field its user base class declares (Unity: "serialized multiple times")
      const files = [];
      (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const x = path.join(d, e.name); if (e.isDirectory()) walk(x); else if (/\.cs$/.test(e.name)) files.push(x); } })(path.join(out, 'Assets', 'Scripts'));
      const classes = new Map();
      for (const x of files) {
        const src = fs.readFileSync(x, 'utf8');
        const m = src.match(/^\s*public (?:abstract )?class (\w+)(?:<[^>]+>)? : (\w+)/m);
        const fields = [...src.matchAll(/^ {4}(?:\[System\.NonSerialized\] )?public (?!static|override|virtual|void|class|enum|struct|interface)[\w.<>, \[\]]+ (\w+)( = [^;]+)?;/gm)].map((y) => y[1]);
        if (m) classes.set(m[1], { base: m[2], fields });
      }
      for (const [name, c] of classes) {
        for (let b = classes.get(c.base), guard = 0; b && guard < 20; b = classes.get(b.base), guard++) {
          const dup = c.fields.filter((x) => b.fields.includes(x));
          assert.deepStrictEqual(dup, [], `${name} khai lại field của ${c.base}`);
        }
      }
      const r = compileCheck(out);
      assert.deepStrictEqual(r.errors.slice(0, 10), []);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
}
