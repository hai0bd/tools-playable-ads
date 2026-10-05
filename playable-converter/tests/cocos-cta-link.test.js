"use strict";

// Build Cocos 2.x: nút CTA không gọi window.openAdUrl trực tiếp mà gọi method openAdUrl của
// component AdsManager trong scene. Method đó ghi đè window.androidLink/iosLink/defaultLink
// bằng giá trị NHÚNG TRONG SCENE (base64 trong window.resMap — replaceStoreUrls không thấy)
// rồi mới gọi ra ngoài. Adapter vì vậy phải GHIM link lúc chèn, không đọc lại biến toàn cục
// lúc click. Phần cuối chạy thật trong vm, mô phỏng đúng thứ tự ghi đè đó.
var assert = require("assert");
var vm = require("vm");
var core = require("../converter-core");

var OLD_ANDROID = "https://play.google.com/store/apps/details?id=com.draw.to.pee.bo";
var OLD_IOS = "https://apps.apple.com/us/app/lost-dog-puzzle-draw-to-home/id6445977978";
var NEW_ANDROID = "https://play.google.com/store/apps/details?id=com.m.mini4.collection.gameoffline";
var NEW_IOS = "https://apps.apple.com/us/app/id6445000001";

// Vỏ tối giản giữ đúng dấu hiệu của build cocos-old: biến toàn cục + switch adNetwork.
var SOURCE = [
    "<html><head></head><body>",
    '<canvas id="GameCanvas"></canvas>',
    "<script>",
    "var clickTag = '';",
    "var androidLink = '" + OLD_ANDROID + "';",
    "var iosLink = '" + OLD_IOS + "';",
    "var defaultLink = '" + OLD_ANDROID + "';",
    "openAdUrl = function () {",
    "  if (cc.sys.os == cc.sys.OS_ANDROID) { clickTag = androidLink; }",
    "  else if (cc.sys.os == cc.sys.OS_IOS) { clickTag = iosLink; } else { clickTag = defaultLink; }",
    "  var adNetwork = 'applovin';",
    "  switch (adNetwork) {",
    "    case 'adword': window.open(clickTag); break;",
    "    case 'applovin': mraid.open(clickTag); break;",
    "    default: window.open(clickTag);",
    "  }",
    "}",
    "</script>",
    "<script>window.resMap = {};</script>",
    "</body></html>"
].join("\n");

assert.strictEqual(core.detectBuild(SOURCE), "cocos-old");

var out = core.convert(SOURCE, "cocos-old", "applovin", { androidUrl: NEW_ANDROID, iosUrl: NEW_IOS });
var html = out.html;

// ── 1. Adapter ghim link thành hằng số, không còn đọc biến toàn cục lúc click ──
var adapter = /<script data-playable-converter="cocos-adapter">([\s\S]*?)<\/script>/.exec(html);
assert.ok(adapter, "phải chèn được cocos-adapter");
assert.ok(adapter[1].indexOf(JSON.stringify(NEW_ANDROID)) >= 0, "adapter phải nhúng link Android mới");
assert.ok(adapter[1].indexOf(JSON.stringify(NEW_IOS)) >= 0, "adapter phải nhúng link iOS mới");
assert.ok(
    /clickTag = cta(Android|Ios|Default)/.test(adapter[1]) && !/clickTag = (androidLink|iosLink|defaultLink)\b/.test(adapter[1]),
    "adapter không được gán clickTag từ biến toàn cục nữa"
);

// ── 2. Chạy thật: AdsManager ghi đè biến toàn cục rồi mới gọi window.openAdUrl ──
function runClick(osName) {
    var opened = [];
    var sandbox = { console: console };
    sandbox.window = sandbox;
    sandbox.cc = { sys: { os: osName, OS_ANDROID: "Android", OS_IOS: "iOS" } };
    sandbox.mraid = { open: function (url) { opened.push(url); } };
    sandbox.open = function (url) { opened.push(url); };
    sandbox.addEventListener = function () { };
    vm.createContext(sandbox);

    // Hai script trong <head> của bản đã convert, theo đúng thứ tự xuất hiện.
    var scripts = html.match(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g) || [];
    scripts.forEach(function (tag) {
        var body = tag.replace(/^<script(?: [^>]*)?>/, "").replace(/<\/script>$/, "");
        if (body.indexOf("openAdUrl") < 0) return;
        vm.runInContext(body, sandbox);
    });

    // Component AdsManager trong scene: link cũ, ghi đè xong mới gọi tiếp.
    vm.runInContext(
        'window.androidLink = ' + JSON.stringify(OLD_ANDROID) + ';' +
        'window.iosLink = ' + JSON.stringify(OLD_IOS) + ';' +
        'window.defaultLink = ' + JSON.stringify(OLD_ANDROID) + ';' +
        'window.openAdUrl ? window.openAdUrl() : window.open();',
        sandbox
    );
    return opened;
}

var onAndroid = runClick("Android");
assert.deepStrictEqual(onAndroid, [NEW_ANDROID], "Android: phải mở link mới, không phải link trong scene");

var onIos = runClick("iOS");
assert.deepStrictEqual(onIos, [NEW_IOS], "iOS: phải mở link mới, không phải link trong scene");

var onDesktop = runClick("Windows");
assert.deepStrictEqual(onDesktop, [NEW_ANDROID], "desktop: rơi về defaultLink đã ghim");

// ── 3. Không nhập URL: chụp biến toàn cục lúc adapter chạy, vẫn chặn được ghi đè ──
var untouched = core.convert(SOURCE, "cocos-old", "applovin", {});
var snapAdapter = /<script data-playable-converter="cocos-adapter">([\s\S]*?)<\/script>/.exec(untouched.html)[1];
assert.ok(
    snapAdapter.indexOf('typeof androidLink === "string"') >= 0,
    "không có URL người dùng thì adapter phải chụp biến toàn cục ngay lúc chạy"
);

console.log("cocos-cta-link: OK");
