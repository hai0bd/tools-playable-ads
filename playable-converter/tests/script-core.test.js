"use strict";

var assert = require("assert");
var core = require("../script-core");

// ── HTML mẫu: 3 file .js trong __res + 2 inline + 1 json + 1 script ngoài ──
var html = [
    "<!doctype html><html><body>",
    '<script type="text/javascript">window._builderVersion = \'23\'</' + "script>",
    '<script type="text/javascript" id="say-res">window.__res = {',
    '"main.js":"var a=1;\\nconsole.log(\\"hi\\");",',
    '"assets/main/index.js":"var g=2;",',
    '"cocos2d-js-min.js":"var e=3;",',
    '"config.json":"{\\"types\\":[],\\"uuids\\":[]}",',
    '"tex/a.png":"data:image/png;base64,QUJD"',
    "};</" + "script>",
    '<script type="text/javascript">function boot(){ return window.__res["main.js"]; }</' + "script>",
    '<script type="application/json">{"not":"js"}</' + "script>",
    '<script src="ext.js"></' + "script>",
    "</body></html>"
].join("\n");

// ── 1. listScripts: đúng số lượng & phân loại ──
var list = core.listScripts(html);
var names = list.map(function (s) { return s.name; });

// .js + .json trong __res (KHÔNG lấy .png), 2 inline (KHÔNG lấy src / thẻ chứa __res={)
assert.strictEqual(list.filter(function (s) { return s.source === "res"; }).length, 4, "phải có 3 .js + 1 config.json trong __res");
assert.strictEqual(list.filter(function (s) { return s.source === "inline"; }).length, 2, "phải có 2 inline script");
assert.ok(names.indexOf("tex/a.png") < 0, "không được coi .png là script");
assert.ok(names.indexOf("config.json") >= 0, "phải liệt kê cả config.json");

var byName = {};
list.forEach(function (s) { byName[s.name] = s; });
assert.strictEqual(byName["main.js"].kind, "boot");
assert.strictEqual(byName["assets/main/index.js"].kind, "game");
assert.strictEqual(byName["cocos2d-js-min.js"].kind, "engine");
assert.strictEqual(byName["config.json"].kind, "config", "config.json phải có kind 'config', không phải theo đường dẫn");
assert.strictEqual(core.isJSON("config.json"), true);
assert.strictEqual(core.isJSON("main.js"), false);

// sửa config.json cũng round-trip đúng (nó cũng là string literal trong __res)
var cfg = core.replaceScript(html, "res:config.json", '{"a":1,"b":[2,3]}');
var cfgBack = core.listScripts(cfg).filter(function (s) { return s.id === "res:config.json"; })[0];
assert.strictEqual(cfgBack.text, '{"a":1,"b":[2,3]}');

// giá trị được unescape đúng (\n và \" trong string literal)
assert.strictEqual(byName["main.js"].text, 'var a=1;\nconsole.log("hi");');

// thẻ chỉ ĐỌC window.__res vẫn phải giữ lại (chỉ bỏ thẻ định nghĩa `window.__res = {`)
var inlines = list.filter(function (s) { return s.source === "inline"; });
assert.ok(inlines.some(function (s) { return s.text.indexOf("function boot()") >= 0; }),
    "thẻ inline tham chiếu __res phải được giữ, không bị nhầm là kho asset");
assert.ok(!inlines.some(function (s) { return s.text.indexOf("window.__res = {") >= 0; }),
    "thẻ định nghĩa kho __res phải bị bỏ qua");

// ── 2. identity round-trip: thay bằng chính nội dung cũ → HTML KHÔNG đổi ──
var cur = html;
list.forEach(function (s) {
    var out = core.replaceScript(cur, s.id, s.text);
    assert.strictEqual(out.length, cur.length, "identity không được đổi kích thước: " + s.name);
    var again = core.listScripts(out).filter(function (x) { return x.id === s.id; })[0];
    assert.strictEqual(again.text, s.text, "identity phải giữ nguyên nội dung: " + s.name);
    cur = out;
});
assert.strictEqual(cur, html, "round-trip toàn bộ phải cho HTML y hệt bản gốc");

// ── 3. sửa thật: đọc lại đúng nội dung mới ──
var edited = core.replaceScript(html, "res:assets/main/index.js", 'var g=3;\nvar s="x";');
var back = core.listScripts(edited).filter(function (s) { return s.id === "res:assets/main/index.js"; })[0];
assert.strictEqual(back.text, 'var g=3;\nvar s="x";');
assert.ok(edited.indexOf("window.__res") >= 0, "HTML vẫn còn kho __res");

// ── 4. escape </script> khi ghi vào __res (nếu không sẽ đóng thẻ sớm → vỡ file) ──
var danger = core.replaceScript(html, "res:main.js", 'var s="</script>";');
var d = core.listScripts(danger).filter(function (s) { return s.id === "res:main.js"; })[0];
assert.strictEqual(d.text, 'var s="</script>";', "giá trị đọc lại phải nguyên vẹn");
assert.ok(danger.slice(d.start, d.end).indexOf("</script>") < 0, "payload không được chứa </script> thô");

// ── 5. inline script KHÔNG thể chứa </script> → phải báo lỗi rõ ràng ──
var inlineId = inlines[0].id;
assert.throws(function () { core.replaceScript(html, inlineId, 'var s="</script>";'); },
    /script/i, "phải từ chối nhúng </script> vào thẻ inline");

// ── 6. beautifyJS: bung code minified nhưng GIỮ syntax hợp lệ ──
var min = 'function f(a){if(a){return"x;y"}else{return/a;b/.test("c")?1:2}}var r=f(1);';
var pretty = core.beautifyJS(min);
assert.ok(pretty.split("\n").length > 3, "phải xuống dòng");
assert.doesNotThrow(function () { new Function(pretty); }, "code sau format phải parse được");
// chuỗi và regex chứa ';' không được cắt sai
assert.ok(pretty.indexOf('"x;y"') >= 0, "chuỗi có ';' phải nguyên vẹn");
assert.ok(pretty.indexOf("/a;b/") >= 0, "regex có ';' phải nguyên vẹn");

// giữ ASI: code không minified dựa vào newline để kết câu
var asi = "var a = 1\nvar b = 2\n// ghi chu\nvar c = 3";
var prettyAsi = core.beautifyJS(asi);
assert.doesNotThrow(function () { new Function(prettyAsi); }, "không được phá ASI / nuốt comment //");

// quá lớn → trả null để UI biết mà từ chối
assert.strictEqual(core.beautifyJS("var a=1;", 4), null);

console.log("script-core.test.js: OK");
