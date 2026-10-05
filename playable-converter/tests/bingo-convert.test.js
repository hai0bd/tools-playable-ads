"use strict";

// Kiểu build "bingo" trong converter: nhận diện file Bingo, đọc gói ZIP bên trong, thay file, đổi mạng.

var assert = require("assert");
var zlib = require("zlib");
var core = require("../converter-core");
var B = require("../bingo-core"); // require là đã registerBuild("bingo")

function u8(s) { return core.utf8Bytes(s); }
function deflate(b) { return new Uint8Array(zlib.deflateRawSync(Buffer.from(b.buffer, b.byteOffset, b.length))); }
function same(a, b, msg) { assert.deepStrictEqual(Array.from(a), Array.from(b), msg); }
function entriesOf(zip) { var out = {}; B.readZipEntries(zip).forEach(function (e) { out[e.name] = e; }); return out; }
function payloadOf(html) {
    var it = core.extractEmbeddedData(html).filter(function (i) { return i.source === "super-html-zip"; })[0];
    assert.ok(it, "có payload __zip");
    return { item: it, zip: it.encoding === "base64" ? core.decodeBase64Bytes(it.payload) : core.decodeBase122Bytes(it.payload) };
}

/* ------------------------------------------------ gói giống Bingo thật: không index.html, có runtime riêng */

var png = new Uint8Array(2000), mp3 = new Uint8Array(1500), i;
for (i = 0; i < png.length; i++) png[i] = (i * 31 + 7) & 255;
png[0] = 0x89; png[1] = 0x50; png[2] = 0x4e; png[3] = 0x47;
for (i = 0; i < mp3.length; i++) mp3[i] = (i * 17 + 3) & 255;
var CC = "var cc = {};\n" + "function engine() { return 'x'; }\n".repeat(200);
var FILES = {
    "application.js": u8("System.register([], function () {});"),
    "index.js": u8("System.register(['./application.js'], function () {});"),
    "src/polyfills.bundle.js": u8("window.__polyfilled = true;"),
    "src/system.bundle.js": u8("window.System = {};"),
    "src/import-map.json": u8('{"imports":{"cc":"./../cocos-js/cc.js"}}'),
    "src/settings.json": u8('{"CocosEngine":"3.8.7"}'),
    "cocos-js/cc.js": u8(CC),
    "assets/main/config.json": u8('{"name":"main"}'),
    "assets/main/index.js": u8("System.register([], function () { PlayableSDK.download(); });"),
    "assets/main/native/02/tex.png": png,
    "assets/main/native/aa/sound.mp3": mp3,
    "BingoEngine.js": u8("/* bingo engine */"),
    "PlayableSDK.js": u8("/* bingo sdk */")
};
var GAME_FILES = Object.keys(FILES).filter(function (n) { return !/^(BingoEngine|PlayableSDK)\.js$/.test(n); }).sort();
var zip = core.assembleZip(Object.keys(FILES).map(function (name) { return { name: name, data: FILES[name], deflated: deflate(FILES[name]) }; }), new Date(2026, 0, 1));

function bingoHtml(channel, enc) {
    var payload = enc === "base64" ? core.encodeBase64Bytes(zip) : core.encodeBase122Bytes(zip);
    var demo = channel === "google" ? "ExitApi.exit()"
        : channel === "mintegral" ? "window.install()"
        : channel === "ironsource" ? "dapi.openStoreUrl()"
        : "if(typeof mraid==='undefined')return;var _i=\"https://apps.apple.com/app/id1\",_a=\"https://play.google.com/store/apps/details?id=x.y\",_u=/iPhone|iPad|iPod/i.test(navigator.userAgent)?(_i||_a):(_a||_i);mraid.open(_u);";
    return '<!DOCTYPE html><html><head><base href="./"><meta charset="utf-8"><title>Cocos Creator | Demo</title>'
        + '<meta name="viewport" content="width=device-width,user-scalable=no"><meta name="format-detection" content="telephone=no">'
        + "<style>body{margin:0;background:#333}#GameDiv{width:100%}</style>"
        + '<script type="text/javascript">function bingoPlayableApiDemo(){' + demo + "}</script>"
        + (channel === "unity" || channel === "ironsource" ? '<script src="mraid.js"></script>' : "")
        + (channel === "google" ? '<meta name="ad.orientation" content="portrait,landscape"><script type="text/javascript" src="https://tpc.googlesyndication.com/pagead/gadgets/html5/api/exitapi.js"></script>' : "")
        + '</head><body><div id="GameDiv" cc_exact_fit_screen="true"><div id="Cocos3dGameContainer"><canvas id="GameCanvas" tabindex="99"></canvas></div></div>'
        + '<script>window.__zipEncoding="' + enc + '";window.__zip="' + payload + '";</script>'
        + '<script type="systemjs-importmap">{"imports":{"cc":"./cocos-js/cc.js"}}</script>'
        + "<script>var _0x1={};function _0xabc(){return 'obfuscated runtime';}</script>"
        + '<script>window.addEventListener("load",function(){});</script></body></html>';
}

/* ---------------------------------------------------------------------------- nhận diện */

var applovin = bingoHtml("applovin", "base122");
assert.strictEqual(core.detectBuild(applovin), "bingo", "file Bingo → build bingo");
assert.strictEqual(core.detectBuild(bingoHtml("google", "base64")), "bingo", "bản Google (base64) cũng là bingo");
assert.strictEqual(core.analyze(applovin, "x.html").zipEncoding, "base122", "analyze đọc encoding base122");
assert.strictEqual(core.analyze(bingoHtml("google", "base64"), "x.html").zipEncoding, "base64", "analyze đọc encoding base64");
assert.strictEqual(core.detectSourceNetwork(applovin, "260911_AppLovin_Bock_Crush.html"), "applovin", "tên file thắng");
assert.strictEqual(core.detectSourceNetwork(applovin, "260911_Unity_Bock_Crush.html"), "unity", "tên file thắng (Unity)");
assert.strictEqual(core.detectSourceNetwork(applovin, "x.html"), "applovin", "không tên: mraid.open + không có mraid.js → AppLovin");
assert.strictEqual(core.detectSourceNetwork(bingoHtml("unity", "base122"), "x.html"), "unity", "không tên: có thẻ mraid.js → Unity");
assert.strictEqual(core.detectSourceNetwork(bingoHtml("google", "base64"), "x.html"), "google", "ExitApi → Google");
assert.strictEqual(core.detectSourceNetwork(bingoHtml("mintegral", "base122"), "x.html"), "mintegral", "install → Mintegral");
assert.strictEqual(core.detectSourceNetwork(bingoHtml("ironsource", "base122"), "260911_ironSource_x.html"), "ironsource", "ironSource theo tên file");
assert.strictEqual(core.detectSourceNetwork(bingoHtml("ironsource", "base122"), "x.html"), "ironsource", "dapi → ironSource");

/* --------------------------------------------------------------------------- đọc gói */

var items = B.packageItems(applovin);
assert.strictEqual(items.length, Object.keys(FILES).length, "liệt kê đủ file trong gói");
var byName = {};
items.forEach(function (it) { byName[it.context] = it; });
assert.strictEqual(byName["assets/main/native/02/tex.png"].kind, "image");
assert.strictEqual(byName["assets/main/native/02/tex.png"].mediaType, "image/png");
assert.strictEqual(byName["assets/main/native/aa/sound.mp3"].kind, "audio");
assert.strictEqual(byName["assets/main/config.json"].kind, "data");
assert.strictEqual(byName["cocos-js/cc.js"].kind, "data");
assert.strictEqual(byName["cocos-js/cc.js"].bytes, u8(CC).length, "bytes = kích thước gốc");
assert.ok(byName["cocos-js/cc.js"].packed < byName["cocos-js/cc.js"].bytes, "packed = kích thước nén");
assert.strictEqual(items[0].id, "zip-1");
assert.strictEqual(items[0].source, "bingo-zip");
assert.strictEqual(items[0].encoding, "zip");
assert.ok(items[0].line >= 1, "có số dòng");
same(B.inflateEntry(byName["cocos-js/cc.js"].entry), u8(CC), "inflateEntry bung đúng");
same(B.inflateEntry(byName["assets/main/native/02/tex.png"].entry), png, "inflateEntry bung png");

var scripts = B.packageScripts(applovin);
var scriptNames = scripts.map(function (s) { return s.name; }).sort();
assert.deepStrictEqual(scriptNames, ["application.js", "assets/main/config.json", "assets/main/index.js", "cocos-js/cc.js", "index.js", "src/import-map.json", "src/polyfills.bundle.js", "src/settings.json", "src/system.bundle.js"], "scripts: js/json trong gói, bỏ runtime Bingo");
var byScript = {};
scripts.forEach(function (s) { byScript[s.name] = s; });
assert.strictEqual(byScript["assets/main/index.js"].kind, "game");
assert.strictEqual(byScript["assets/main/config.json"].kind, "config");
assert.strictEqual(byScript["application.js"].kind, "boot");
assert.strictEqual(byScript["cocos-js/cc.js"].kind, "engine");
assert.strictEqual(byScript["cocos-js/cc.js"].source, "zip");
assert.strictEqual(byScript["cocos-js/cc.js"].id, "zip:cocos-js/cc.js");
assert.strictEqual(byScript["cocos-js/cc.js"].size, u8(CC).length);
assert.strictEqual(byScript["cocos-js/cc.js"].text, CC, "text bung lười đúng nội dung");

/* --------------------------------------------------------------------------- thay file */

var newPng = new Uint8Array(900);
for (i = 0; i < newPng.length; i++) newPng[i] = (i * 5) & 255;
var edited = B.replacePackageEntry(applovin, "assets/main/native/02/tex.png", newPng, null);
assert.strictEqual(core.detectBuild(edited), "bingo", "vẫn là file Bingo sau khi thay");
assert.ok(edited.indexOf('window.__zipEncoding="base122";window.__zip="') >= 0, "giữ nguyên vỏ payload");
var p2 = payloadOf(edited), e2 = entriesOf(p2.zip);
same(B.inflateEntry(e2["assets/main/native/02/tex.png"]), newPng, "png mới nằm trong gói");
assert.strictEqual(e2["assets/main/native/02/tex.png"].method, 0, "không có deflated → store");
same(e2["cocos-js/cc.js"].raw, entriesOf(zip)["cocos-js/cc.js"].raw, "entry khác chép nguyên byte nén");
assert.strictEqual(e2["cocos-js/cc.js"].crc, entriesOf(zip)["cocos-js/cc.js"].crc, "giữ CRC gốc");
assert.deepStrictEqual(Object.keys(e2).sort(), Object.keys(FILES).sort(), "danh sách file không đổi");

var newJs = u8("System.register([], function () { PlayableSDK.download(); PlayableSDK.game_end(); });" + " ".repeat(300));
var edited2 = B.replacePackageEntry(edited, "assets/main/index.js", newJs, deflate(newJs));
var e3 = entriesOf(payloadOf(edited2).zip);
assert.strictEqual(e3["assets/main/index.js"].method, 8, "có deflated nhỏ hơn → deflate");
same(B.inflateEntry(e3["assets/main/index.js"]), newJs, "js mới bung đúng");
same(B.inflateEntry(e3["assets/main/native/02/tex.png"]), newPng, "lần thay trước vẫn còn");

var added = B.replacePackageEntry(applovin, "assets/extra.txt", u8("hello"), null);
assert.ok(entriesOf(payloadOf(added).zip)["assets/extra.txt"], "tên mới → thêm vào gói");
var dropped = B.rebuildZip(B.readZipEntries(zip), { "PlayableSDK.js": null });
assert.ok(!entriesOf(dropped)["PlayableSDK.js"], "rebuildZip: null → bỏ file");

// Ghép lại không sửa gì → byte gói ra vẫn đọc được và giữ nguyên nội dung
var rebuilt = B.rebuildZip(B.readZipEntries(zip), {});
var er = entriesOf(rebuilt);
Object.keys(FILES).forEach(function (n) { same(B.inflateEntry(er[n]), FILES[n], "rebuildZip giữ " + n); });

/* --------------------------------------------------------------------------- đổi mạng */

var targets = ["applovin", "mintegral", "unity", "google", "pangle"];
var results = core.convertAll(applovin, "bingo", targets, {});
assert.strictEqual(results.length, 5);
results.forEach(function (r) {
    assert.deepStrictEqual(r.errors, [], r.target + ": validate không báo lỗi");
    assert.ok(!r.warnings.some(function (w) { return /mouse/.test(w); }), r.target + ": không cảnh báo mouse (code game nằm trong ZIP)");
    assert.ok(r.warnings.some(function (w) { return /runtime riêng của Bingo/.test(w); }), r.target + ": báo đã bỏ BingoEngine/PlayableSDK");
    assert.strictEqual(core.detectBuild(r.html), "super-html", r.target + ": file ra theo khung Super HTML (convert tiếp được)");
    assert.strictEqual(core.detectSuperHtmlVersion(r.html), "new");
    var p = payloadOf(r.html), en = entriesOf(p.zip);
    assert.strictEqual(p.item.encoding, r.target === "google" ? "base64" : "base122", r.target + ": encoding theo kênh");
    assert.deepStrictEqual(Object.keys(en).sort(), GAME_FILES, r.target + ": gói ra = gói vào trừ runtime Bingo");
    Object.keys(en).forEach(function (n) { same(B.inflateEntry(en[n]), FILES[n], r.target + ": nội dung " + n + " nguyên vẹn"); });
    // Vỏ HTML lấy từ file Bingo: title, meta, style, markup body; script khởi động là khung chuẩn 3.x
    assert.ok(r.html.indexOf("<title>Cocos Creator | Demo</title>") >= 0, r.target + ": giữ title");
    assert.ok(r.html.indexOf('<meta name="format-detection" content="telephone=no">') >= 0, r.target + ": giữ meta gốc");
    assert.ok(r.html.indexOf("body{margin:0;background:#333}#GameDiv{width:100%}") >= 0, r.target + ": giữ style của Bingo");
    assert.ok(r.html.indexOf('<canvas id="GameCanvas" tabindex="99"></canvas>') >= 0, r.target + ": giữ markup GameDiv");
    assert.ok(r.html.indexOf("bingoPlayableApiDemo") < 0 && r.html.indexOf("_0xabc") < 0, r.target + ": bỏ runtime cũ của Bingo");
    assert.ok(r.html.indexOf('<script type="systemjs-importmap">{"imports":{"cc":"./cocos-js/cc.js"}}</script>') >= 0, r.target + ": import map rebase");
    assert.ok(r.html.indexOf('"scripts":[{"src":"src/polyfills.bundle.js"},{"src":"src/system.bundle.js"},{"text":') >= 0, r.target + ": khung khởi động 3.x");
    // Store URL lấy từ hàm CTA của Bingo khi không truyền option
    assert.ok(r.html.indexOf('"android":"https://play.google.com/store/apps/details?id=x.y"') >= 0 && r.html.indexOf('"ios":"https://apps.apple.com/app/id1"') >= 0, r.target + ": store URL đọc từ file Bingo");
    assert.ok((r.html.match(/<meta name="ad\.orientation"/g) || []).length === (r.target === "google" ? 1 : 0), r.target + ": ad.orientation chỉ có ở Google");
    assert.ok((r.html.indexOf("exitapi.js") >= 0) === (r.target === "google"), r.target + ": exitapi chỉ có ở Google");
    assert.ok((r.html.indexOf('<script src="mraid.js"></script>') >= 0) === (r.target === "unity"), r.target + ": mraid.js chỉ có ở Unity");
});

// Option store URL đè lên URL trong file
var withUrl = core.convert(applovin, "bingo", "unity", { androidUrl: "https://play.google.com/store/apps/details?id=new.app", iosUrl: "" });
assert.ok(withUrl.html.indexOf('"android":"https://play.google.com/store/apps/details?id=new.app"') >= 0, "option androidUrl đè");
assert.ok(withUrl.html.indexOf('"ios":"https://apps.apple.com/app/id1"') >= 0, "iOS trống → giữ URL trong file");

// Nguồn Google (base64) → AppLovin: mã hoá lại base122, bỏ thẻ Google
var fromGoogle = core.convert(bingoHtml("google", "base64"), "bingo", "applovin", {});
assert.strictEqual(payloadOf(fromGoogle.html).item.encoding, "base122", "base64 → base122 khi đổi sang AppLovin");
assert.ok(fromGoogle.html.indexOf("exitapi.js") < 0 && fromGoogle.html.indexOf("ad.orientation") < 0, "bỏ thẻ Google của nguồn");
assert.deepStrictEqual(Object.keys(entriesOf(payloadOf(fromGoogle.html).zip)).sort(), GAME_FILES, "gói giữ nguyên qua transcode");

// Gói đã sửa asset → convert mang theo asset mới
var convEdited = core.convert(edited2, "bingo", "applovin", {});
var ce = entriesOf(payloadOf(convEdited.html).zip);
same(B.inflateEntry(ce["assets/main/native/02/tex.png"]), newPng, "convert dùng png đã thay");
same(B.inflateEntry(ce["assets/main/index.js"]), newJs, "convert dùng js đã thay");

// File ra convert tiếp được bằng rule Super HTML (không phải chèn tạm adapter)
var again = core.convert(results[0].html, "super-html", "mintegral", {});
assert.ok(!again.warnings.some(function (w) { return /Không tìm thấy block/.test(w); }), "file ra đổi mạng tiếp bằng convertSuperHtml sạch");

/* ------------------------------------------ gói Bingo từ build Cocos Creator 2.4 (dòng Block Crusher) */

var FILES2 = {
    "main.js": u8("window.boot = function () { cc.game.run({}, function () {}); };"),
    "src/settings.js": u8('window._CCSettings={platform:"web-mobile",launchScene:"db://assets/Scene/Game.fire",jsList:[]};'),
    "cocos2d-js-min.js": u8("window.cc = {};" + " ".repeat(200)),
    "physics-min.js": u8("/* physics */"),
    "assets/internal/config.json": u8('{"name":"internal"}'),
    "assets/main/config.json": u8('{"name":"main","scenes":{"db://assets/Scene/Game.fire":0}}'),
    "assets/main/index.js": u8('"undefined"!=typeof PlayableSDK&&(PlayableSDK.download(),PlayableSDK.game_end());'),
    "assets/main/native/bd/bd08b3f5.png": png,
    "splash.png": png,
    "favicon.ico": u8("ico"),
    "BingoEngine.js": u8("/* bingo engine */"),
    "PlayableSDK.js": u8("/* bingo sdk */")
};
var GAME_FILES2 = Object.keys(FILES2).filter(function (n) { return !/^(BingoEngine|PlayableSDK)\.js$/.test(n); }).sort();
var zip2 = core.assembleZip(Object.keys(FILES2).map(function (name) { return { name: name, data: FILES2[name], deflated: deflate(FILES2[name]) }; }), new Date(2026, 0, 1));
var bingo2x = '<!DOCTYPE html><html><head><base href="https://localhost/"><meta charset="utf-8"><title>Cocos Creator | Block-Crusher</title>'
    + '<meta name="viewport" content="width=device-width,user-scalable=no"><meta name="screen-orientation" content="">'
    + "<style>body{overflow:hidden}#splash{background:#171717 url(./splash.png) no-repeat center}</style>"
    + '<script type="text/javascript">function bingoPlayableApiDemo(){if(typeof mraid===\'undefined\')return;var _i="https://play.google.com/store/apps/details?id=com.monster.blockcrusher",_a="https://play.google.com/store/apps/details?id=com.monster.blockcrusher";mraid.open(_a);}</script>'
    + '</head><body><canvas id="GameCanvas" oncontextmenu="event.preventDefault()" tabindex="0"></canvas><div id="splash" style="display:none"><div class="progress-bar"><span></span></div></div>'
    + "<script>(function(){var S=7;window.base122Decode=function(d){return d;};})();</script>"
    + '<script>window.__zipEncoding="base122";window.__zip="' + core.encodeBase122Bytes(zip2) + '";</script>'
    + '<script type="text/javascript">window.__BINGO_VERSION__="2.0.4";window.__COCOS_VERSION__="2.4.11";</script></body></html>';

assert.strictEqual(core.detectBuild(bingo2x), "bingo", "Bingo 2.x → build bingo");
assert.strictEqual(core.detectSourceNetwork(bingo2x, "260911_AppLovin_Bock_Crush1_Shiba_Captian.html"), "applovin", "mạng nguồn 2.x theo tên file");
assert.ok(B.packageScripts(bingo2x).some(function (s) { return s.name === "cocos2d-js-min.js" && s.kind === "engine"; }), "tab Scripts xếp cocos2d-js-min.js vào nhóm engine");

core.convertAll(bingo2x, "bingo", targets, {}).forEach(function (r) {
    var tag = "2.x " + r.target + ": ";
    assert.deepStrictEqual(r.errors, [], tag + "validate không báo lỗi");
    assert.strictEqual(core.detectBuild(r.html), "super-html", tag + "file ra theo khung Super HTML");
    var p = payloadOf(r.html), en = entriesOf(p.zip);
    assert.deepStrictEqual(Object.keys(en).sort(), GAME_FILES2, tag + "gói ra = gói vào trừ runtime Bingo");
    Object.keys(en).forEach(function (n) { same(B.inflateEntry(en[n]), FILES2[n], tag + "nội dung " + n + " nguyên vẹn"); });
    assert.ok(r.html.indexOf('"scripts":[{"src":"src/settings.js"},{"src":"main.js"},{"text":"(function () {') >= 0, tag + "khởi động theo thứ tự 2.x");
    assert.ok(r.html.indexOf('load(\\"cocos2d-js-min.js\\"') >= 0 && r.html.indexOf('load(\\"physics-min.js\\", window.boot)') >= 0, tag + "loader nạp engine + physics");
    assert.ok(r.html.indexOf('<canvas id="GameCanvas" oncontextmenu="event.preventDefault()" tabindex="0"></canvas><div id="splash" style="display:none">') >= 0, tag + "giữ canvas + splash của vỏ Bingo");
    assert.ok(r.html.indexOf("<title>Cocos Creator | Block-Crusher</title>") >= 0 && r.html.indexOf("#splash{background:#171717 url(./splash.png)") >= 0, tag + "giữ title + style");
    assert.ok(r.html.indexOf("https://localhost/") < 0 && r.html.indexOf('<base href="./">') >= 0, tag + "không giữ base href của Bingo");
    assert.ok(r.html.indexOf("__BINGO_VERSION__") < 0 && r.html.indexOf("base122Decode=function(d)") < 0 && r.html.indexOf("bingoPlayableApiDemo") < 0, tag + "bỏ runtime Bingo");
    assert.ok(r.html.indexOf('"android":"https://play.google.com/store/apps/details?id=com.monster.blockcrusher"') >= 0, tag + "store URL đọc từ file Bingo 2.x");
    assert.ok(r.html.indexOf("System.import") < 0 && r.html.indexOf("systemjs-importmap") < 0, tag + "không lẫn khung 3.x");
});

// Bản Facebook (payload tách ra zip.js) → báo lỗi rõ
var fb = applovin.replace(/<script>window\.__zipEncoding[\s\S]*?<\/script>/, '<script src="zip.js"></script>');
assert.strictEqual(core.detectBuild(fb), "bingo");
assert.throws(function () { core.convert(fb, "bingo", "applovin", {}); }, /zip\.js/, "thiếu __zip → nhắc bản Facebook");

console.log("bingo-convert tests passed");
