"use strict";

// Phần lõi của kiểu build Bingo: runtime nhúng (inflate, base122, ZIP, resolve URL, PlayableSDK),
// adapter kênh và khung trang. Luồng nhận diện / đọc gói / đổi mạng qua converter ở bingo-convert.test.js.

var assert = require("assert");
var zlib = require("zlib");
var core = require("../converter-core");
var B = require("../bingo-core");

function u8(s) { return core.utf8Bytes(s); }
function same(a, b, msg) { assert.deepStrictEqual(Array.from(a), Array.from(b), msg); }

var pngBytes = new Uint8Array(3000);
for (var i = 0; i < pngBytes.length; i++) pngBytes[i] = (i * 7919 + 13) & 255;
var bigJs = "var cc = {};\n" + "function f(){ return 'AAAAAAAAAAAAAAAAAA'; }\n".repeat(400);

/* ------------------------------------------------------------------------ adapter kênh */

var runtime = B.runtimeSource();
assert.ok(!/<\/script/i.test(runtime) && runtime.indexOf("<!--") < 0, "runtime không chứa chuỗi phá thẻ <script>");
assert.ok(/^function \(CFG\) \{/.test(runtime), "runtimeSource là một function expression nhận CFG");
assert.ok(runtime.indexOf("function inflateRaw(") >= 0, "runtime mang theo inflateRaw");

B.CHANNELS.forEach(function (ch) {
    var src = B.adapterSource(ch.key);
    assert.ok(/^window\.super_html = \{[\s\S]*\};$/m.test(src), ch.key + ": khối window.super_html = {…};");
    ["download:", "game_end:", "game_ready:", "is_hide_download:"].forEach(function (k) { assert.ok(src.indexOf(k) >= 0, ch.key + ": có " + k); });
    assert.doesNotThrow(function () { new Function(src); }, ch.key + ": adapter là JS hợp lệ");
});
assert.deepStrictEqual(B.CHANNELS.map(function (c) { return c.key; }), ["AppLovin", "Unity", "Google", "Mintegral", "TikTok"], "đúng 5 mạng đầu ra của converter");
Object.keys(core.NETWORKS).forEach(function (target) { assert.ok(B.channel(target), "mạng " + target + " của converter có kênh tương ứng"); });
assert.ok(B.adapterSource("Mintegral").indexOf("window.gameReady && window.gameReady()") >= 0, "Mintegral đúng dạng validate() tìm");
assert.ok(B.adapterSource("Google").indexOf("window.ExitApi.exit()") >= 0, "Google gọi ExitApi.exit");
assert.ok(B.adapterSource("TikTok").indexOf("window.openAppStore()") >= 0, "Pangle gọi openAppStore");
assert.ok(B.adapterSource("AppLovin").indexOf("mraidOpen(url)") >= 0 && B.adapterSource("Unity").indexOf("mraidOpen(url)") >= 0, "AppLovin / Unity mở store qua MRAID");
assert.strictEqual(B.channel("pangle").key, "TikTok", "tên converter pangle → kênh TikTok");
assert.strictEqual(B.channel("APPLOVIN").key, "AppLovin", "không phân biệt hoa thường");
assert.strictEqual(B.channel("nope"), null);

/* -------------------------------------------------------------------------- khung trang */

var map3x = {
    "index.js": u8("x"), "src/system.bundle.js": u8("x"), "src/polyfills.bundle.js": u8("x"),
    "src/import-map.json": u8('{"imports":{"cc":"./../cocos-js/cc.js"}}'), "cocos-js/cc.js": u8("x")
};
var w = [], page = B.preparePage(map3x, w);
assert.deepStrictEqual(page.scripts.map(function (s) { return s.src || "inline"; }), ["src/polyfills.bundle.js", "src/system.bundle.js", "inline"], "khung 3.x: polyfills → system → System.import");
assert.strictEqual(page.importMap, '{"imports":{"cc":"./cocos-js/cc.js"}}', "import map rebase từ src/ về gốc");
assert.ok(page.body.indexOf('<canvas id="GameCanvas"') >= 0, "markup GameDiv");
assert.ok(w.some(function (x) { return /khung index\.html chuẩn/.test(x); }), "báo dùng khung chuẩn khi thiếu index.html");

var shell = '<html><head><title>Shell Title</title><meta name="viewport" content="w"><meta name="ad.orientation" content="portrait"><style>body { color: red; }</style></head>'
    + '<body><div id="GameDiv"><canvas id="GameCanvas"></canvas></div><script>runtime()</script></body></html>';
var w2 = [], page2 = B.preparePage(map3x, w2, shell);
assert.strictEqual(page2.title, "Shell Title", "title từ shell");
assert.strictEqual(page2.metas, '<meta name="viewport" content="w">', "meta từ shell, bỏ ad.orientation");
assert.strictEqual(page2.css, "body{color:red}", "style từ shell, đã minify");
assert.strictEqual(page2.body, '<div id="GameDiv"><canvas id="GameCanvas"></canvas></div>', "body từ shell, bỏ script");
assert.strictEqual(w2.length, 0, "có shell thì không cảnh báo khung chuẩn");

var withIndex = {
    "index.html": u8('<html><head><title>T</title><link rel="stylesheet" href="style.css"></head><body><div id="GameDiv"></div>'
        + '<script src="src/settings.js"></script><script src="main.js"></script><script type="systemjs-importmap">{"imports":{"a":"./b.js"}}</script><script>window.boot()</script></body></html>'),
    "style.css": u8("body { margin: 0 } /* c */"), "src/settings.js": u8("x"), "main.js": u8("x")
};
var w3 = [], page3 = B.preparePage(withIndex, w3);
assert.deepStrictEqual(page3.scripts, [{ src: "src/settings.js" }, { src: "main.js" }, { text: "window.boot()" }], "có index.html: lặp lại đúng thứ tự script");
assert.strictEqual(page3.css, "body{margin:0}", "link stylesheet được inline + minify");
assert.strictEqual(page3.importMap, '{"imports":{"a":"./b.js"}}', "import map inline giữ nguyên gốc");
assert.throws(function () { B.preparePage({ "a.txt": u8("x") }, []); }, /không nhận ra build web-mobile/, "gói lạ → lỗi rõ");

// Cocos Creator 2.x: settings → main.js → loader nạp engine (+ physics) rồi gọi window.boot()
var map2x = { "main.js": u8("x"), "src/settings.js": u8("x"), "cocos2d-js-min.js": u8("x"), "physics-min.js": u8("x"), "assets/main/index.js": u8("x") };
var w4 = [], page4 = B.preparePage(map2x, w4);
assert.deepStrictEqual(page4.scripts.slice(0, 2), [{ src: "src/settings.js" }, { src: "main.js" }], "2.x: settings rồi main.js");
assert.strictEqual(page4.scripts.length, 3, "2.x: thêm đúng một script loader");
var loader = page4.scripts[2].text;
assert.ok(loader.indexOf('load("cocos2d-js-min.js"') >= 0 && loader.indexOf('load("physics-min.js", window.boot)') >= 0 && loader.indexOf("window.boot()") >= 0, "2.x: loader nạp engine, physics rồi window.boot");
assert.doesNotThrow(function () { new Function(loader); }, "loader 2.x là JS hợp lệ");
assert.strictEqual(page4.importMap, null, "2.x không có import map");
assert.ok(/id="GameCanvas"/.test(page4.body) && /id="splash"/.test(page4.body), "2.x: có canvas và #splash cho main.js");
assert.ok(page4.css.indexOf("#Cocos2dGameContainer") >= 0, "2.x: CSS container của 2.x");
assert.ok(w4.some(function (x) { return /Cocos 2\.x/.test(x); }), "báo dùng khung chuẩn 2.x");

// Chạy thử loader: engine không bật physics thì bỏ qua physics-min.js
function runLoader(src, globals) {
    var loaded = [], booted = 0;
    var doc = {
        body: { appendChild: function (s) { loaded.push(s.src); s.parentNode = this; s._fire("load"); }, removeChild: function () { } },
        createElement: function () {
            var h = {};
            return { addEventListener: function (ev, fn) { h[ev] = fn; }, _fire: function (ev) { if (ev === "load" && loaded[loaded.length - 1] === "cocos2d-js-min.js") Object.assign(g, globals); if (h[ev]) h[ev](); } };
        }
    };
    var g = { boot: function () { booted++; } };
    new Function("document", "window", "with (window) {" + src + "}")(doc, g);
    return { loaded: loaded, booted: booted };
}
assert.deepStrictEqual(runLoader(loader, { CC_PHYSICS_BUILTIN: true, CC_PHYSICS_CANNON: false }), { loaded: ["cocos2d-js-min.js", "physics-min.js"], booted: 1 }, "physics bật → nạp physics rồi boot");
assert.deepStrictEqual(runLoader(loader, { CC_PHYSICS_BUILTIN: false, CC_PHYSICS_CANNON: false }), { loaded: ["cocos2d-js-min.js"], booted: 1 }, "physics tắt → boot luôn");

// md5Cache (tên kèm hash), không có physics
var page5 = B.preparePage({ "main.1a2b3.js": u8("x"), "src/settings.4c5d6.js": u8("x"), "cocos2d-js-min.7e8f9.js": u8("x") }, []);
assert.deepStrictEqual(page5.scripts.slice(0, 2), [{ src: "src/settings.4c5d6.js" }, { src: "main.1a2b3.js" }], "2.x md5Cache: đúng tên có hash");
assert.ok(page5.scripts[2].text.indexOf('load("cocos2d-js-min.7e8f9.js"') >= 0 && page5.scripts[2].text.indexOf("physics") < 0, "không có physics thì loader không nhắc tới");

// Vỏ thiếu #splash → bổ sung; vỏ không có GameCanvas → giữ markup khung chuẩn
var page6 = B.preparePage(map2x, [], '<html><head><title>S</title></head><body><canvas id="GameCanvas"></canvas><script>x()</script></body></html>');
assert.strictEqual(page6.body, '<canvas id="GameCanvas"></canvas><div id="splash" style="display:none"><div class="progress-bar"><span></span></div></div>', "vỏ thiếu splash → thêm vào");
var page7 = B.preparePage(map3x, [], '<html><head><title>S</title></head><body><div id="x"></div></body></html>');
assert.ok(/id="GameCanvas"/.test(page7.body) && page7.title === "S", "vỏ không có canvas → giữ body khung chuẩn, vẫn lấy title");

/* ---------------------------------------------------------------------------- runtime */

function makeRuntime(baseHref, cfg) {
    var win = {
        location: { href: baseHref },
        navigator: { userAgent: "Mozilla/5.0 (Linux; Android 13) Chrome/120" },
        atob: function (s) { return Buffer.from(s, "base64").toString("binary"); },
        URL: URL,
        addEventListener: function () { }
    };
    var doc = { baseURI: baseHref, addEventListener: function () { } };
    var src = "(" + runtime + ")(" + JSON.stringify(Object.assign({ version: "t", channel: "PureHTML", testOnly: true, scripts: [] }, cfg || {})) + ")";
    new Function("window", "document", "navigator", src)(win, doc, win.navigator);
    return win;
}

var win = makeRuntime("https://ads.example.com/creative/123/index.html");
var PB = win.__playable;
assert.ok(PB && win.PlayableSDK, "runtime dựng __playable + PlayableSDK");

// inflate JS: stored / fixed / dynamic Huffman đều phải ra đúng, kể cả khi không biết trước kích thước
[
    { name: "stored", data: u8("hello stored block"), opt: { level: 0 } },
    { name: "fixed", data: u8("abcabcabcabc-fixed-huffman-small"), opt: { level: 6 } },
    { name: "dynamic", data: u8(bigJs + JSON.stringify({ a: [1, 2, 3], b: "xyz".repeat(300) })), opt: { level: 9 } },
    { name: "binary", data: pngBytes, opt: { level: 9 } }
].forEach(function (s) {
    var d = new Uint8Array(zlib.deflateRawSync(Buffer.from(s.data), s.opt));
    same(PB.inflate(d, s.data.length), s.data, "inflate " + s.name);
    same(PB.inflate(d, 0), s.data, "inflate " + s.name + " (không biết size)");
    same(B.inflateRaw(d, s.data.length), s.data, "inflateRaw module = runtime (" + s.name + ")");
});

// base122 round-trip qua toàn bộ 256 giá trị byte (bao gồm 7 ký tự cấm) và mọi độ dài lẻ
var all = new Uint8Array(256 * 3 + 5);
for (i = 0; i < all.length; i++) all[i] = i & 255;
same(PB.decodeBase122(core.encodeBase122Bytes(all)), all, "base122 round-trip");
assert.ok(!/[\x00\n\r"&\\<]/.test(core.encodeBase122Bytes(all)), "chuỗi base122 không chứa ký tự cấm");
for (var len = 0; len < 9; len++) same(PB.decodeBase122(core.encodeBase122Bytes(all.subarray(0, len))), all.subarray(0, len), "base122 độ dài " + len);
same(PB.decodeBase64(core.encodeBase64Bytes(all)), all, "base64 round-trip");

// readZip đọc được zip do assembleZip tạo
var d1 = new Uint8Array(zlib.deflateRawSync(Buffer.from(u8(bigJs))));
var zip = core.assembleZip([{ name: "a/b.js", data: u8(bigJs), deflated: d1 }, { name: "c.png", data: pngBytes, deflated: null }], new Date(2026, 0, 1));
var list = PB.readZip(zip);
assert.deepStrictEqual(list.map(function (e) { return [e.name, e.method, e.usize]; }), [["a/b.js", 8, u8(bigJs).length], ["c.png", 0, pngBytes.length]], "readZip mục lục");
same(PB.inflate(list[0].raw, list[0].usize), u8(bigJs), "readZip + inflate entry");
same(list[1].raw, pngBytes, "readZip entry store");

// resolve: URL đủ kiểu → tên file trong gói
PB.files["cocos-js/cc.js"] = new Uint8Array(1);
PB.files["assets/main/index.js"] = new Uint8Array(1);
PB.files["index.js"] = new Uint8Array(1);
PB.files["src/settings.json"] = new Uint8Array(1);
var R = PB.resolve;
assert.strictEqual(R("cocos-js/cc.js"), "cocos-js/cc.js", "tương đối");
assert.strictEqual(R("./cocos-js/cc.js?v=3#x"), "cocos-js/cc.js", "bỏ query/hash");
assert.strictEqual(R("src/../cocos-js/cc.js"), "cocos-js/cc.js", "..");
assert.strictEqual(R("https://ads.example.com/creative/123/cocos-js/cc.js"), "cocos-js/cc.js", "tuyệt đối cùng thư mục");
assert.strictEqual(R("https://ads.example.com/creative/123/src/settings.json"), "src/settings.json", "tuyệt đối cùng thư mục (con)");
assert.strictEqual(R("https://ads.example.com/creative/123/missing.js"), null, "cùng thư mục nhưng không có → null");
assert.strictEqual(R("https://other.example.com/creative/123/cocos-js/cc.js"), null, "khác origin → không đụng");
assert.strictEqual(R("https://ads.example.com/sdk/mraid/index.js"), null, "cùng origin nhưng ngoài thư mục gốc → không đụng (dù đuôi trùng index.js)");
assert.strictEqual(R("//cdn.example.com/index.js"), null, "protocol-relative → không đụng");
assert.strictEqual(R("blob:https://ads.example.com/uuid"), null, "blob: bỏ qua");
assert.strictEqual(R("data:image/png;base64,AAAA"), null, "data: bỏ qua");
assert.strictEqual(R("about:blank"), null, "about:blank bỏ qua");
assert.strictEqual(R("about:index.js"), "index.js", "about:<đường dẫn> (SystemJS trong srcdoc) → so đuôi");
assert.strictEqual(R({ url: "assets/main/index.js" }), "assets/main/index.js", "Request object");
assert.strictEqual(R("mraid.js"), null, "file ngoài gói → null");
assert.strictEqual(R(""), null, "rỗng");

var fileWin = makeRuntime("file:///D:/out/x.html");
fileWin.__playable.files["index.js"] = new Uint8Array(1);
assert.strictEqual(fileWin.__playable.resolve("file:///D:/out/index.js"), "index.js", "file:// cùng thư mục");
assert.strictEqual(fileWin.__playable.resolve("file:///D:/out/nope.js"), null, "file:// thiếu → null");

var srcdocWin = makeRuntime("about:srcdoc");
srcdocWin.__playable.files["cocos-js/cc.js"] = new Uint8Array(1);
assert.strictEqual(srcdocWin.__playable.resolve("https://host/any/where/cocos-js/cc.js"), "cocos-js/cc.js", "không biết base → so đuôi");

// store URL theo nền tảng + PlayableSDK uỷ quyền cho super_html
var cfgWin = makeRuntime("https://x.y/z/index.html", { android: "https://play.google.com/a", ios: "https://apps.apple.com/i" });
assert.strictEqual(cfgWin.__playable.url(), "https://play.google.com/a", "Android UA → URL Android");
cfgWin.navigator.userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)";
assert.strictEqual(cfgWin.__playable.url(), "https://apps.apple.com/i", "iPhone UA → URL iOS");
var onlyAndroid = makeRuntime("https://x.y/z/index.html", { android: "https://play.google.com/a" });
onlyAndroid.navigator.userAgent = "iPhone";
assert.strictEqual(onlyAndroid.__playable.url(), "https://play.google.com/a", "thiếu iOS → dùng Android");
var none = makeRuntime("https://x.y/z/index.html", {});
none.super_html = { google_play_url: "https://play.google.com/from-game" };
assert.strictEqual(none.__playable.url(), "https://play.google.com/from-game", "không cấu hình → lấy URL game set vào super_html");

var calls = [];
cfgWin.super_html = { download: function () { calls.push("download"); }, game_end: function () { calls.push("end"); } };
cfgWin.PlayableSDK.download();
cfgWin.PlayableSDK.game_end();
cfgWin.PlayableSDK.game_end();
assert.deepStrictEqual(calls, ["download", "end"], "PlayableSDK uỷ quyền cho super_html, game_end chỉ 1 lần");
var seq = [];
cfgWin.PlayableSDK.onPause(function () { seq.push("pause"); });
cfgWin.PlayableSDK.onResume(function () { seq.push("resume"); });
cfgWin.PlayableSDK.onMute(function () { seq.push("mute"); });
["resume", "pause", "pause", "resume", "mute", "mute"].forEach(function (e) { cfgWin.__playable.fire(e); });
assert.deepStrictEqual(seq, ["pause", "resume", "mute"], "fire khử trùng lặp trạng thái");

// mraidOpen: chờ ready khi mraid còn loading, gọi mraid.open(url); không có mraid thì window.open
var opened = [], readyCb = null;
var mraidWin = makeRuntime("https://x.y/z/index.html", { android: "https://play.google.com/a" });
mraidWin.mraid = { getState: function () { return "loading"; }, addEventListener: function (ev, cb) { if (ev === "ready") readyCb = cb; }, open: function (u) { opened.push(u); } };
mraidWin.__playable.mraidOpen();
assert.deepStrictEqual(opened, [], "còn loading → chưa mở");
readyCb();
assert.deepStrictEqual(opened, ["https://play.google.com/a"], "ready → mraid.open(URL)");
var plainWin = makeRuntime("https://x.y/z/index.html", { android: "https://play.google.com/a" });
var winOpened = [];
plainWin.open = function (u) { winOpened.push(u); return {}; };
plainWin.__playable.mraidOpen();
assert.deepStrictEqual(winOpened, ["https://play.google.com/a"], "không có mraid → window.open");

console.log("bingo-core tests passed");
