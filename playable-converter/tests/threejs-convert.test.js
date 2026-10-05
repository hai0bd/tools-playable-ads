"use strict";

// Build Three.js template AVK (bundle Parcel 1): nhận diện, asset trong PROJECT.DAT, convert 5 mạng,
// rồi chạy thật adapter trong vm với MRAID / ExitApi / Mintegral giả.
var assert = require("assert");
var vm = require("vm");
var core = require("../converter-core");

// Runtime Parcel 1 nguyên văn từ build thật: adapter tìm module API qua window.parcelRequire.cache của nó.
var PARCEL_PRELUDE = `parcelRequire = function (e, r, n, t) { var i = "function" == typeof parcelRequire && parcelRequire, o = "function" == typeof require && require; function u(n, t) { if (!r[n]) { if (!e[n]) { var f = "function" == typeof parcelRequire && parcelRequire; if (!t && f) return f(n, !0); if (i) return i(n, !0); if (o && "string" == typeof n) return o(n); var c = new Error("Cannot find module '" + n + "'"); throw c.code = "MODULE_NOT_FOUND", c } p.resolve = function (r) { return e[n][1][r] || r }, p.cache = {}; var l = r[n] = new u.Module(n); e[n][0].call(l.exports, p, l, l.exports, this) } return r[n].exports; function p(e) { return u(p.resolve(e)) } } u.isParcelRequire = !0, u.Module = function (e) { this.id = e, this.bundle = u, this.exports = {} }, u.modules = e, u.cache = r, u.parent = i, u.register = function (r, n) { e[r] = [function (e, r) { r.exports = n }, {}] }; for (var f = 0; f < n.length; f++)u(n[f]); if (n.length) { var c = u(n[n.length - 1]); "object" == typeof exports && "undefined" != typeof module ? module.exports = c : "function" == typeof define && define.amd ? define(function () { return c }) : t && (this[t] = c) } return u }(`;

var PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
var JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQN";
var MP3 = "SUQzAwAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjI5LjEwMAAAAAAAAAAA";
var LZ_OBJ = "N4IgLgpgtgxg9iAXCAjAWgMwCYBsBOCABAHwH0BGAQwGMAbAVwGcAXAJwEsA7AcwEsQA";
var MTL = Buffer.from("# Blender MTL File: 'sector.blend'\nnewmtl Wall\nKd 0.8 0.8 0.8\n").toString("base64");

// Ba module như bản V3 (template cũ: không có nhánh "gg"; MraidClientAPI đọc viewableChange như object).
var MODULES = `{
    "Gm1e": [function (require, module, exports) {
        window.PROJECT = {};
        PROJECT.DAT = new function () { this.product = "AVK_Test", this.version = "0.1.0", this.pictures = {}, this.textures = {}, this.other = {}, this.obj = "sector", this.android_url = "https://play.google.com/store/apps/details?id=com.test", this.ios_url = "https://play.google.com/store/apps/details?id=com.test" },
        PROJECT.DAT.pictures.logo = "${PNG}", PROJECT.DAT.textures["Zombi [Albedo]"] = "${JPEG}", PROJECT.DAT.other["gun.mp3"] = "${MP3}",
        PROJECT.DAT.obj = "${LZ_OBJ}", PROJECT.DAT.mtl = "${MTL}";
        // input: mousedown mousemove mouseup
        PROJECT.MAIN = function (api) { window.__started = (window.__started || 0) + 1; window.__size = api.getSize(); };
    }, {}],
    "Api1": [function (require, module, exports) {
        "use strict"; exports.__esModule = !0;
        var i = function () { function t() { this.avk_play_class = "MraidClientAPI", this.gameStarted = !1, this.onReadyDone = !1 } return t.prototype.init = function (t) { if (this.gameInitFunction = t, "loading" === window.mraid.getState()) { var i = this; window.mraid.addEventListener("ready", function () { i.onReadyCallback.call(i) }) } else this.onReadyCallback() }, t.prototype.getSize = function () { return window.mraid.getMaxSize() }, t.prototype.open = function (t) { window.mraid.open(t) }, t.prototype.onReadyCallback = function () { if (!this.onReadyDone) { this.onReadyDone = !0; var t = this; window.mraid.addEventListener("viewableChange", function (i) { t.adVisibleCallback.call(t, i) }), window.mraid.isViewable() && this.adVisibleCallback({ isViewable: !0 }) } }, t.prototype.adVisibleCallback = function (t) { t.isViewable && !this.gameStarted && (this.gameStarted = !0, this.gameInitFunction()) }, t.prototype.playableFinished = function () { }, t }(); exports.MraidClientAPI = i;
        var o = function () { function t() { this.avk_play_class = "BrowserClientAPI" } return t.prototype.init = function (t) { t() }, t.prototype.getSize = function () { return { width: jQuery(window).width(), height: jQuery(window).height() } }, t.prototype.open = function (t) { alert(t) }, t.prototype.playableFinished = function () { }, t }(); exports.BrowserClientAPI = o;
        var u = function () { function t() { this.avk_play_class = "MintegralClientAPI" } return t.prototype.init = function (t) { window.gameReady && window.gameReady(), t() }, t.prototype.getSize = function () { return { width: 1, height: 1 } }, t.prototype.open = function (t) { window.install && window.install() }, t.prototype.playableFinished = function () { window.gameEnd && window.gameEnd() }, t }(); exports.MintegralClientAPI = u;
        var p = function () { function t() { this.avk_play_class = "UnityClientAPI" } return t.prototype.init = function (t) { t() }, t.prototype.getSize = function () { return { width: 1, height: 1 } }, t.prototype.open = function (t) { window.mraid.open(t) }, t.prototype.playableFinished = function () { }, t }(); exports.UnityClientAPI = p;
    }, {}],
    "7QCb": [function (require, module, exports) {
        "use strict"; exports.__esModule = !0, require("./src/gamecontrol"); var e = require("./src/api"); window.addEventListener("load", function () { var n; "mn" === playableSource ? n = new e.MintegralClientAPI : "un" === playableSource ? n = new e.UnityClientAPI : "mraid" in window ? n = new e.MraidClientAPI : n = new e.BrowserClientAPI, playableApi = n, n.init(function () { PROJECT.MAIN = new PROJECT.MAIN(n) }) });
    }, { "./src/gamecontrol": "Gm1e", "./src/api": "Api1" }]
}, {}, ["7QCb"], null)`;

function fixture(source, extraTop) {
    return [
        "<!DOCTYPE html>",
        "<html>",
        "<head>",
        '\t<script src="mraid.js"></script>',
        '\t<meta charset="utf-8" />',
        "</head>",
        "",
        "<body>",
        '\t<script type="text/javascript">',
        '\t\tfunction gameStart() { } function gameClose() { } var playableSource = "' + source + '";',
        '\t\tvar playableVersion = "/*AVK_BUILD_ID*/";',
        "\t\tvar playableApi = false;",
        "\t\twindow.sendEvent = function (event) { };",
        extraTop || "",
        "\t</script>",
        '\t<script type="text/javascript">' + PARCEL_PRELUDE + MODULES + "</script>",
        "",
        "</body>",
        "",
        "</html>"
    ].join("\n");
}

function count(html, regex) { return (html.match(regex) || []).length; }

function inlineScripts(html) {
    var out = [], regex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi, match;
    while ((match = regex.exec(html))) if (!/\bsrc\s*=/.test(match[1])) out.push(match[2]);
    return out;
}

// Chạy các <script> inline như trình duyệt: global chung là window, load do test tự bắn, timer do test tự xả.
function run(html, env, log) {
    var listeners = {}, timers = [];
    var win = {
        console: console,
        innerWidth: 320,
        innerHeight: 480,
        addEventListener: function (type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
        setTimeout: function (fn) { timers.push({ fn: fn, cleared: false }); return timers.length; },
        clearTimeout: function (id) { if (timers[id - 1]) timers[id - 1].cleared = true; },
        alert: function (message) { log.push("alert:" + message); },
        open: function (url) { log.push("window.open:" + url); }
    };
    win.window = win;
    Object.keys(env || {}).forEach(function (key) { win[key] = env[key]; });
    vm.createContext(win);
    inlineScripts(html).forEach(function (code) { vm.runInContext(code, win); });
    return {
        win: win,
        load: function () { (listeners.load || []).forEach(function (fn) { fn(); }); },
        flushTimers: function () { timers.forEach(function (timer) { if (!timer.cleared) { timer.cleared = true; timer.fn(); } }); }
    };
}

function fakeMraid(log, state, viewable) {
    var handlers = {};
    return {
        state: state,
        viewable: viewable,
        getState: function () { return this.state; },
        isViewable: function () { return this.viewable; },
        addEventListener: function (type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
        fire: function (type, arg) { (handlers[type] || []).forEach(function (fn) { fn(arg); }); },
        open: function (url) { log.push("mraid.open:" + url); }
    };
}

// ---- Nhận diện ----
var source = fixture("mr");
assert.strictEqual(core.detectBuild(source), "threejs");
assert.strictEqual(core.detectSourceNetwork(source, "Nextbots_V3_Applovin.html"), "applovin");
assert.strictEqual(core.detectSourceNetwork(source, "Nextbots_V3_Unity.html"), "unity", '"mr" là MRAID chung: tên file quyết định');
assert.strictEqual(core.detectSourceNetwork(source, "playable.html"), "applovin");
assert.strictEqual(core.detectSourceNetwork(fixture("mn"), "Nextbots_V3_Applovin.html"), "mintegral", "playableSource rõ ràng thắng tên file");
assert.strictEqual(core.detectSourceNetwork(fixture("gg"), "playable.html"), "google", "lớp MintegralClientAPI có sẵn trong mọi bản không được làm đoán nhầm");
assert.strictEqual(core.analyze(source, "playable.html").avkProduct, "AVK_Test 0.1.0");

// ---- Asset trong PROJECT.DAT ----
var byContext = {};
core.extractEmbeddedData(source).forEach(function (item) { if (item.source === "avk-data") byContext[item.context] = item; });
assert.deepStrictEqual(Object.keys(byContext).sort(), ["mtl/sector.mtl", "other/gun.mp3", "pictures/logo.png", "textures/Zombi [Albedo].jpg"]);
assert.strictEqual(byContext["pictures/logo.png"].mediaType, "image/png");
assert.strictEqual(byContext["pictures/logo.png"].kind, "image");
assert.strictEqual(byContext["textures/Zombi [Albedo].jpg"].mediaType, "image/jpeg");
assert.strictEqual(byContext["other/gun.mp3"].kind, "audio");
assert.strictEqual(byContext["mtl/sector.mtl"].kind, "data");
assert.ok(!Object.keys(byContext).some(function (key) { return byContext[key].payload === LZ_OBJ; }), "PROJECT.DAT.obj nén LZString, không phải base64 của file");

var newPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]).toString("base64");
var edited = core.replaceEmbeddedData(source, byContext["pictures/logo.png"].id, "data:image/png;base64," + newPng);
assert.ok(edited.indexOf('PROJECT.DAT.pictures.logo = "' + newPng + '"') >= 0, "thay asset ghi đúng vào PROJECT.DAT");

// ---- Cấu trúc file ra ----
var MRAID_TAG = /<script\b[^>]*src\s*=\s*["']mraid\.js["']/g;
var expected = { applovin: ["mr", 1], unity: ["un", 1], mintegral: ["mn", 0], google: ["gg", 0], pangle: ["pg", 0] };
core.convertAll(source, "threejs", null, {}).forEach(function (result) {
    var html = result.html, tag = result.target + ": ";
    assert.ok(html.indexOf('var playableSource = "' + expected[result.target][0] + '"') >= 0, tag + "playableSource");
    assert.strictEqual(count(html, MRAID_TAG), expected[result.target][1], tag + "thẻ mraid.js");
    assert.strictEqual(count(html, /exitapi\.js/g), result.target === "google" ? 1 : 0, tag + "exitapi.js");
    assert.strictEqual(count(html, /data-playable-converter="threejs-adapter"/g), 1, tag + "đúng một adapter");
    assert.deepStrictEqual(result.errors, [], tag + "validate không lỗi");
    assert.ok(!result.warnings.some(function (w) { return /gameStart/.test(w); }), tag + "function gameStart() {} được tính là hook Mintegral");
    assert.strictEqual(core.detectSourceNetwork(html, "playable.html"), result.target, tag + "file ra nhận lại đúng mạng");
});

var back = core.convert(core.convert(source, "threejs", "google").html, "threejs", "applovin").html;
assert.ok(back.indexOf('var playableSource = "mr"') >= 0);
assert.strictEqual(count(back, MRAID_TAG), 1, "convert lại: thẻ mraid.js không nhân đôi");
assert.strictEqual(count(back, /exitapi\.js|ad\.orientation/g), 0, "convert lại: bỏ phần của Google");
assert.strictEqual(count(back, /data-playable-converter="threejs-adapter"/g), 1, "convert lại: adapter cũ bị gỡ");

assert.ok(core.convert(source, "threejs", "applovin", {}).warnings.some(function (w) { return /ios_url/.test(w); }), "ios_url trỏ Google Play phải cảnh báo ở AppLovin");
assert.ok(!core.convert(source, "threejs", "google", {}).warnings.some(function (w) { return /ios_url/.test(w); }), "Google gọi ExitApi, không dùng link trong file");
var withUrls = core.convert(source, "threejs", "unity", { androidUrl: "https://play.google.com/store/apps/details?id=com.new", iosUrl: "https://apps.apple.com/app/id123" });
assert.ok(withUrls.html.indexOf('this.android_url = "https://play.google.com/store/apps/details?id=com.new"') >= 0);
assert.ok(withUrls.html.indexOf('this.ios_url = "https://apps.apple.com/app/id123"') >= 0);
assert.ok(!withUrls.warnings.some(function (w) { return /ios_url/.test(w); }));

var handPatchedGoogle = fixture("gg", "\t\twindow.install = window.download = function () { ExitApi.exit(); };");
assert.ok(core.convert(handPatchedGoogle, "threejs", "mintegral", {}).warnings.some(function (w) { return /window\.install/.test(w); }), "bản Google vá tay đè window.install phải cảnh báo khi ra Mintegral");

// ---- Chạy thử adapter ----
// Google trên template cũ: không có nhánh "gg", BrowserClientAPI.open gốc là alert(url).
var log = [];
var google = run(core.convert(source, "threejs", "google").html, { ExitApi: { exit: function () { log.push("ExitApi.exit"); } } }, log);
google.load();
assert.strictEqual(google.win.__started, 1, "Google: game chạy ngay");
assert.strictEqual(google.win.__size.width, 320, "getSize gốc lỗi (không có jQuery) thì lấy kích thước cửa sổ");
google.win.playableApi.open("https://store");
assert.deepStrictEqual(log, ["ExitApi.exit"]);

log = [];
var pangle = run(core.convert(source, "threejs", "pangle").html, { openAppStore: function () { log.push("openAppStore"); } }, log);
pangle.load();
pangle.win.playableApi.open("https://store");
assert.deepStrictEqual(log, ["openAppStore"]);

log = [];
var mintegral = run(core.convert(source, "threejs", "mintegral").html, {
    gameReady: function () { log.push("gameReady"); },
    gameEnd: function () { log.push("gameEnd"); },
    install: function () { log.push("install"); }
}, log);
mintegral.load();
assert.strictEqual(mintegral.win.__started, 1);
mintegral.win.playableApi.open("https://store");
mintegral.win.playableApi.playableFinished();
assert.deepStrictEqual(log, ["gameReady", "install", "gameEnd"]);

// AppLovin xem thử trên trình duyệt (không có MRAID): chạy ngay, CTA mở tab mới.
log = [];
var analytics = { trackEvent: function (name) { log.push("AL:" + name); } };
var preview = run(core.convert(source, "threejs", "applovin").html, { ALPlayableAnalytics: analytics }, log);
preview.load();
assert.strictEqual(preview.win.__started, 1);
preview.win.playableApi.open("https://store");
assert.deepStrictEqual(log, ["AL:LOADING", "AL:LOADED", "AL:DISPLAYED", "AL:CTA_CLICKED", "window.open:https://store"]);

// AppLovin có MRAID: chờ ready rồi viewableChange(true). MRAID truyền boolean, bản gốc đọc .isViewable nên kẹt.
log = [];
var mraid = fakeMraid(log, "loading", false);
var applovin = run(core.convert(source, "threejs", "applovin").html, { mraid: mraid, ALPlayableAnalytics: analytics }, log);
applovin.load();
assert.strictEqual(applovin.win.__started, undefined, "chưa ready thì chưa chạy");
mraid.state = "default";
mraid.fire("ready");
assert.strictEqual(applovin.win.__started, undefined, "ready nhưng chưa hiển thị thì chưa chạy");
mraid.viewable = true;
mraid.fire("viewableChange", true);
assert.strictEqual(applovin.win.__started, 1, "viewableChange(true) phải chạy game");
mraid.fire("viewableChange", true);
applovin.flushTimers();
assert.strictEqual(applovin.win.__started, 1, "không chạy lại lần hai");
assert.strictEqual(applovin.win.__size.width, 320, "mraid thiếu getMaxSize thì lấy kích thước cửa sổ");
applovin.win.playableApi.open("https://store");
assert.ok(log.indexOf("mraid.open:https://store") >= 0);

log = [];
var neverViewable = fakeMraid(log, "default", false);
var late = run(core.convert(source, "threejs", "applovin").html, { mraid: neverViewable }, log);
late.load();
assert.strictEqual(late.win.__started, undefined);
late.flushTimers();
assert.strictEqual(late.win.__started, 1, "MRAID không báo viewable thì sau 2 s vẫn chạy");

log = [];
var unity = run(core.convert(source, "threejs", "unity").html, { mraid: fakeMraid(log, "default", true) }, log);
unity.load();
assert.strictEqual(unity.win.__started, 1, "Unity: đang hiển thị thì chạy ngay");
unity.win.playableApi.open("https://store");
assert.deepStrictEqual(log, ["mraid.open:https://store"]);

console.log("threejs convert tests passed");
