"use strict";

// Lớp PHÁT HÀNH của Mintegral dính theo bản tải từ SocialPeta (stripServingLayers trong converter-core).
// Chữ ký lấy từ file thật: Dress_Spy V7 (Luna), V8 (MindWorks Cocos), V9 (PlaySmart) và các file SDK
// công khai của Mintegral (PlProtocol.js, PlHacks.js, m_util.js, m_toolkit.js, preview_util.js).
var assert = require("assert");
var vm = require("vm");
var core = require("../converter-core");
var MindWorks = require("../mindworks-core");
var PlaySmart = require("../playsmart-core");

var BABEL = '"use strict";var _typeof="function"==typeof Symbol&&"symbol"==typeof Symbol.iterator?function(e){return typeof e}:function(e){return e};';
function umd(name, body) {
    return '!function(e,t){"object"==typeof exports&&"object"==typeof module?module.exports=t():"function"==typeof define&&define.amd?define("' + name + '",[],t):"object"==typeof exports?exports.' + name + '=t():e.' + name + '=t()}(window,(function(){' + (body || "") + '}));';
}
function script(code, attrs) { return "<script" + (attrs || "") + ">" + code + "</script>"; }

var LAYERS = {
    audioCheck: '\n/* eslint-disable */\n(function (window, document) {\n  const audioCtxList = [];\n  var AudioContext = window.AudioContext;\n  function gameStartCheck() { window.isGameStarted = true; audioCtxList.length = 0; }\n  if (typeof window.MW_gameStartCheck === "undefined") window.MW_gameStartCheck = gameStartCheck;\n  return gameStartCheck\n})(window, document)\n',
    plProtocol: umd("PlProtocol", 'return function(){window.gameReady=function(){parent.postMessage({type:"PLAYABLE:protocol"},"*")}}'),
    dynamicLoader: '!function(t, e) {\n    "object" == typeof exports && "object" == typeof module ? module.exports = e() : "function" == typeof define && define.amd ? define("DynamicLoader", [], e) : t.DynamicLoader = e()\n}(window, (function() { document.write(\'<script id="MTG_UTIL" src="https://sp2cdn-idea-global.zingfront.com/sp_opera/mobvista_playable_js/m_util.js"><\\/script>\') }));',
    offline: BABEL + '!function(e){e.layerTips=function(){},window.UF||(window.UF=e)}({}),window.MTG_OFFLINE_PACKAGE={init:function(){window.gameReady=function(){window.OFFLINE_GAMEREADY=!0},window.install=function(){window.UF.layerTips("offline, check your network.")}}},window.MUTIL_ONLINE&&window.gameReady?setTimeout(function(){window.MW_INIT||window.MTG_OFFLINE_PACKAGE.init()},5e3):window.MUTIL_ONLINE||window.gameReady||window.MTG_OFFLINE_PACKAGE.init();',
    packageLoading: BABEL + '!function(o,g){o.packageLoading=new function(r){this.addLoading=function(){var A=g.createElement("div");A.id="mtg-package-loading",o.document.body.appendChild(A)},this.removeLoading=function(){}}({name:o.MW_CONFIG_I18N.getAppName()}),g.addEventListener("PLAYABLE:gameStart",function(){o.packageLoading.removeLoading()},!1)}(window,document);',
    mtgLoading: umd("MtgLoading", 'this.loadingPic="https://play.rayjump.com/hyplug/assets/loading-n-rep.gif"'),
    reportLog: umd("ReportLog", "new XMLHttpRequest"),
    plHacks: umd("PlHacks", "window.ps&&(ps.ScaleAdapterMtg.prototype.awake=function(){ps.install(),ps.gameEnd()})")
};

// Code GAME phải còn nguyên dù nhắc tên SDK: tên nằm giữa thân chứ không ở đầu, hoặc thiếu dấu hiệu thứ hai.
var GAME = {
    lunaTouchShim: '(()=>{let e;function t(e,t,n,o,i){o=o||0,i=i||0,this.identifier=t}"ontouchstart"in window||navigator.maxTouchPoints>2})()',
    playSmartRuntime: BABEL + 'var ps={};ps.disable_auto_click=function(){return window.MW_CONFIG&&window.MW_CONFIG.disable_auto_click};/* window.MTG_OFFLINE_PACKAGE={ chỉ là chữ */ps.note="packageLoading=new function";',
    lateUmdName: "!function(e,t){" + new Array(60).join("/* đệm */ ") + 'define("PlProtocol",[],t)}(window,function(){})',
    babelMentionsOffline: BABEL + "window.MTG_OFFLINE_PACKAGE={init:function(){}};window.game=1;"
};

var MW_CONFIG = 'window.MW_CONFIG = {\n  MTGMaterialUUID: \'m_en_aylaprinhz2_VL6Ify8g6_p_an_ty\',\n  MTGMaterialVersion: 3,\n  type: "playable",\n  channel: "m",\n  app_icons:"{\\"a6e4\\":\\"data:image/jpeg;base64,/9j/2wCE\\"}",\n  languages:"{\\"en\\":{\\"app_name\\":\\"Ayla World : Princess life\\"}}",\n  disable_global_click: false,\n  disable_auto_click: true,\n  store_url: {\n    ios: "https://play.google.com/store/apps/details?id=com.kitten.ayla",\n    android: "https://play.google.com/store/apps/details?id=com.kitten.ayla"\n  },\n  webp: false\n}\n';

var SOURCE = [
    "<!DOCTYPE html>",
    '<html><head><meta charset="utf-8">' + script(LAYERS.audioCheck) + "</head>",
    '<body mark="mobvista">',
    script("", ' src="https://play.rayjump.com/hyplug/PlProtocol.js"'),
    script(GAME.lunaTouchShim),
    script(MW_CONFIG),
    script(LAYERS.packageLoading),
    script(LAYERS.dynamicLoader),
    script(LAYERS.offline),
    script(LAYERS.mtgLoading),
    script(LAYERS.reportLog),
    script(LAYERS.plHacks),
    script(LAYERS.plProtocol),
    script("window.inlined=1", ' data-inlined-from="https://sp2cdn-idea-global.zingfront.com/sp_opera/js/web-audio-check.js"'),
    script("", ' src="https://sp2cdn-idea-global.zingfront.com/sp_opera/mobvista_playable_js/m_toolkit.js"'),
    script(GAME.playSmartRuntime),
    script(GAME.lateUmdName),
    script(GAME.babelMentionsOffline),
    "</body></html>"
].join("\n");

// ── 1. Gỡ đúng các lớp phát hành, giữ nguyên từng byte code game ──
var stripped = core.stripServingLayers(SOURCE);
var out = stripped.html;
[
    "web-audio-check", "PlProtocol.js", "trang loading tên/icon app gốc (mtg-package-loading)", "loader m_util (DynamicLoader)",
    "gói offline MTG_OFFLINE_PACKAGE", "MtgLoading", "ReportLog", "PlHacks", "m_toolkit.js"
].forEach(function (label) { assert.ok(stripped.removed.indexOf(label) >= 0, "phải gỡ: " + label + " — đã gỡ: " + stripped.removed.join(" | ")); });
assert.ok(out.indexOf("MW_gameStartCheck") < 0, "web-audio-check đã đi");
assert.ok(out.indexOf("packageLoading.removeLoading") < 0, "trang loading app gốc đã đi");
assert.ok(out.indexOf("MTG_UTIL") < 0 && out.indexOf("zingfront.com") < 0, "loader m_util + mọi URL CDN SocialPeta đã đi");
assert.ok(out.indexOf("rayjump.com") < 0, "không còn URL rayjump nào — kể cả trong comment dấu vết");
assert.ok(out.indexOf('define("MtgLoading"') < 0 && out.indexOf('define("ReportLog"') < 0 && out.indexOf('define("PlHacks"') < 0, "các UMD của lớp phát hành đã đi");
assert.ok(out.indexOf("window.inlined=1") < 0, "script mang data-inlined-from của lớp phát hành bị gỡ theo URL nguồn");
Object.keys(GAME).forEach(function (key) { assert.ok(out.indexOf(GAME[key]) >= 0, "code game phải còn nguyên: " + key); });
assert.ok(/removed Mintegral serving layer: web-audio-check/.test(out), "để lại dấu vết trong HTML");

// Chạy lại lần hai không đổi gì (bản đã bọc MW_CONFIG không bị bọc chồng).
var again = core.stripServingLayers(out);
assert.strictEqual(again.html, out, "idempotent");
assert.strictEqual(again.removed.length, 0);

// ── 2. MW_CONFIG: chỉ điền khoá còn thiếu, bỏ danh tính app gốc ──
var wrapped = out.match(/<script>\n(\(function \(baked\)[\s\S]*?)\n<\/script>/)[1];
function runConfig(existing) {
    var ctx = { window: {} };
    if (existing) ctx.window.MW_CONFIG = existing;
    vm.runInNewContext(wrapped, ctx);
    return ctx.window.MW_CONFIG;
}
var fresh = runConfig(null);
assert.strictEqual(fresh.disable_auto_click, true, "không có cấu hình nào thì dùng cờ của bản gốc");
assert.strictEqual(fresh.channel, "m");
["MTGMaterialUUID", "MTGMaterialVersion", "app_icons", "languages", "store_url"].forEach(function (key) {
    assert.ok(!(key in fresh), "bỏ khoá danh tính " + key);
});
// preview_util.js tạo sẵn MW_CONFIG tối thiểu: không được đè khoá của nó, nhưng phải có cờ của game.
var preview = runConfig({ alway_portrait: false, logo_position: "right", render_type: "1" });
assert.strictEqual(preview.logo_position, "right", "giữ khoá SDK test đã đặt");
assert.strictEqual(preview.disable_auto_click, true, "điền cờ mà runtime PlaySmart cần (thiếu thì tự chuyển store)");
// Mintegral chèn cấu hình chiến dịch MỚI lúc phát: không khoá nào bị đè, không lẫn danh tính app gốc.
var live = runConfig({ languages: '{"en":{"app_name":"My Game"}}', disable_auto_click: false });
assert.strictEqual(live.languages, '{"en":{"app_name":"My Game"}}');
assert.strictEqual(live.disable_auto_click, false);

// ── 3. Lớp vỏ lồng iframe MW_PLFRAME: PlProtocol ở đó là cầu outer thật → để nguyên ──
var shell = '<html><body><script src="https://play.rayjump.com/hyplug/PlProtocol.js"></script><iframe id="MW_PLFRAME" srcdoc="…"></iframe></body></html>';
assert.strictEqual(core.stripServingLayers(shell).html, shell);

// ── 4. convert() gỡ cho mọi build và báo lại qua notes ──
var mindworks = SOURCE.replace("</body>", script('window.__adapter_zip__="eJzs"') + script("window.__adapter_init=function(){}") + "</body>");
var converted = core.convert(mindworks, "mindworks", "mintegral", { androidUrl: "https://play.google.com/store/apps/details?id=com.new.game" });
assert.ok(converted.notes.length === 1 && /web-audio-check/.test(converted.notes[0]) && /MtgLoading/.test(converted.notes[0]), "notes liệt kê những gì đã gỡ");
assert.ok(converted.html.indexOf("packageLoading.removeLoading") < 0);
var clean = core.convert('<html><body><script>window.__adapter_zip__="eJzs"</script></body></html>', "mindworks", "mintegral", {});
assert.strictEqual(clean.notes.length, 0, "file không dính lớp phát hành thì không có ghi chú");
var all = core.convertAll(mindworks, "mindworks", ["mintegral"], {});
assert.ok(all[0].notes.length === 1, "convertAll chuyển notes ra kết quả cho app.js");

// ── 5. CTA không đệ quy khi SDK vắng mặt (đã gỡ gói offline thì window.install không còn stub) ──
function runCta(adapter, ctaName) {
    var opened = [];
    var ctx = { navigator: { userAgent: "Android" }, console: console, setInterval: function () { return 0; }, clearInterval: function () {} };
    ctx.window = ctx;
    ctx.open = function (url) { opened.push(url); };
    vm.runInNewContext(adapter, ctx);
    assert.strictEqual(ctx.window.install, ctx[ctaName], ctaName + " đỡ vào chỗ window.install còn trống");
    ctx.window.install();   // trước đây: RangeError: Maximum call stack size exceeded
    return opened;
}
assert.deepStrictEqual(runCta(MindWorks.buildAdapter("mintegral", { androidUrl: "https://x.test/a" }), "_pcMwCta"), ["https://x.test/a"]);
assert.deepStrictEqual(runCta(PlaySmart.buildAdapter("mintegral", { androidUrl: "https://x.test/p" }), "_pcPsCta"), ["https://x.test/p"]);

console.log("serving-layers tests passed");
