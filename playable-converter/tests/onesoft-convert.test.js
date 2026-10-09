"use strict";

// Kiểu build ONESOFT: nhận diện (resMap + Config.PlayableAdsType), đổi mạng bằng cách ghi enum, thay
// link store trong Config và các thẻ SDK đi kèm. Fixture dựng theo đúng hình dạng đã đo trên creative
// thật "Sticker Book: Coloring Puzzle" (Cocos Creator 2.4.9, Config version 6h24).
var assert = require("assert");
var core = require("../converter-core");
var Onesoft = require("../onesoft-core");

var OLD_ANDROID = "https://play.google.com/store/apps/details?id=com.old.sticker";
var OLD_IOS = "https://apps.apple.com/us/app/old-sticker/id111";
var NEW = { androidUrl: "https://play.google.com/store/apps/details?id=com.new.game", iosUrl: "https://apps.apple.com/app/id999" };

// Module Config đã minify: cả enum, link, version và mạng đang chọn nằm trong một constructor.
function config(type, android, ios) {
    return 'cc._RF.push(e,"7d48bRdZalKc4WFuQbqjqyw","Config"),i.default=void 0;var s=new(function(){function t(){' +
        'this.isPlaySound=!0,this.defaultAds=0,this.IronSource=1,this.Unity=2,this.Adwords=3,this.Applovin=4,' +
        'this.Facebook=5,this.Adcolony=6,this.Mintegral=7,this.Vungle=8,this.Maio=9,this.Pangle=10,this.Moloco=11,this.Yandex=12,' +
        'this.StickerBook=7,this.linkAndroid="' + android + '",this.linkiOS="' + ios + '",this.version="6h24",' +
        'this.PlayableAdsGame=this.StickerBook,this.PlayableAdsType=this.' + type + ',' +
        'this.PlayableAdsType!==this.Adwords&&this.PlayableAdsType!==this.Facebook||(this.isPlaySound=!1)}var e=t.prototype;' +
        'return e.onGameReady=function(){this.PlayableAdsType===this.Mintegral&&window.gameReady&&window.gameReady()},' +
        'e.openLinkApp=function(){this.PlayableAdsType===this.Unity||this.PlayableAdsType===this.Applovin?' +
        'cc.sys.os==cc.sys.OS_IOS?mraid.open(this.linkiOS):mraid.open(this.linkAndroid):' +
        'this.PlayableAdsType===this.IronSource?dapi.openStoreUrl():' +
        'this.PlayableAdsType===this.Adwords?cc.sys.os==cc.sys.OS_IOS?window.open(this.linkiOS):window.open(this.linkAndroid):' +
        'this.PlayableAdsType===this.Mintegral?window.install&&window.install():' +
        'this.PlayableAdsType===this.Pangle?window.openAppStore():void 0},' +
        'e.onEndGame=function(){this.PlayableAdsType===this.Mintegral&&window.gameEnd&&window.gameEnd()},' +
        't}());i.default=s,cc._RF.pop()';
}

function page(type, android, ios, extraHead) {
    return '<!DOCTYPE html><html><head>' + (extraHead || "") + '<meta charset="utf-8"/><title>StickerBook</title></head><body>' +
        '<canvas id="GameCanvas"></canvas>' +
        '<script>window.resMap = {"internal/config.json": "{\\"paths\\":{}}", "main/index.png": "iVBORw0KGgo="};</script>' +
        '<script>window._CCSettings = { platform: "web-mobile" };</script>' +
        '<script>cc.ENGINE_VERSION="2.4.9";document.addEventListener("mousedown",function(){});' +
        'document.addEventListener("mousemove",function(){});document.addEventListener("mouseup",function(){});</script>' +
        "<script>" + config(type, android, ios) + "</script>" +
        "</body></html>";
}

var SRC = page("Mintegral", OLD_ANDROID, OLD_IOS);

/* ------------------------------------------------------------------ nhận diện */

assert.strictEqual(core.detectBuild(SRC), "onesoft");
assert.strictEqual(core.detectSourceNetwork(SRC, "x.html"), "mintegral", "mạng nguồn đọc từ Config, không đoán theo window.install");
assert.strictEqual(core.detectSourceNetwork(page("Applovin", OLD_ANDROID, OLD_IOS), "x.html"), "applovin",
    "bản AppLovin vẫn có window.install trong code — luật cũ sẽ đoán nhầm là Mintegral");
assert.strictEqual(core.detectSourceNetwork(page("Adwords", OLD_ANDROID, OLD_IOS), "x.html"), "google");

var info = core.analyze(SRC, "sticker.html");
assert.strictEqual(info.build, "onesoft");
assert.strictEqual(info.onesoftVersion, "6h24");
assert.ok(info.mouseSupport, "engine nằm trong trang nên soi được mouse event");

// Thiếu MỘT trong hai dấu hiệu thì không phải build này.
assert.notStrictEqual(core.detectBuild(SRC.replace(/window\.resMap = \{[^<]*\};/, "")), "onesoft");
assert.notStrictEqual(core.detectBuild(SRC.replace(/this\.PlayableAdsType=this\.Mintegral/, "this.foo=1")), "onesoft");
assert.strictEqual(Onesoft.isOnesoft(SRC), true);

/* ------------------------------------------------------------------ đổi mạng */

var ENUM = { applovin: "Applovin", unity: "Unity", google: "Adwords", mintegral: "Mintegral", pangle: "Pangle" };
Object.keys(core.NETWORKS).forEach(function (target) {
    var out = core.convert(SRC, null, target, NEW);
    var html = out.html;
    assert.ok(html.indexOf("this.PlayableAdsType=this." + ENUM[target]) >= 0, target + ": Config trỏ đúng enum");
    // Chỉ một chỗ gán: đổi nhầm thành nhiều giá trị là CTA chạy nhánh khác onGameReady.
    assert.strictEqual((html.match(/this\.PlayableAdsType\s*=\s*this\.[A-Za-z_]\w*/g) || []).length, 1, target + ": đúng một phép gán");
    assert.strictEqual(html.indexOf("com.old.sticker"), -1, target + ": không còn link Android cũ");
    assert.strictEqual(html.indexOf("old-sticker"), -1, target + ": không còn link iOS cũ");
    assert.deepStrictEqual(core.findStoreLinks(html).sort(), [NEW.androidUrl, NEW.iosUrl].sort(), target + ": chỉ còn link mới");
    assert.strictEqual(out.warnings.filter(function (w) { return /link store cũ/.test(w); }).length, 0, target + ": không cảnh báo link sót");
    assert.strictEqual(out.warnings.length, 0, target + ": không cảnh báo gì — " + out.warnings.join(" | "));
    assert.ok(/Đã đổi Config\.PlayableAdsType: Mintegral → /.test(out.notes.join(" ")) || target === "mintegral", target + ": có ghi chú đổi enum");

    // resMap phải nguyên vẹn: đây là toàn bộ asset của game.
    assert.ok(html.indexOf('"main/index.png": "iVBORw0KGgo="') >= 0, target + ": không đụng vào resMap");

    var validation = core.validate(html, target, "onesoft");
    assert.deepStrictEqual(validation.errors, [], target + ": validate không có lỗi");

    // Adapter chèn đúng một lần, kể cả khi convert lại từ bản đã convert.
    var again = core.convert(html, null, target, NEW);
    assert.strictEqual((again.html.match(/data-playable-converter="onesoft"/g) || []).length, 1, target + ": convert lại không nhân bản adapter");
    assert.strictEqual((again.html.match(/<script\b[^>]*\bsrc\s*=\s*["']mraid\.js["']/gi) || []).length, target === "unity" ? 1 : 0, target + ": thẻ mraid.js không nhân bản");
});

/* ------------------------------------------------------------------ thẻ SDK theo mạng */

var google = core.convert(SRC, null, "google", NEW).html;
assert.ok(/ExitApi\.exit\(\)/.test(google), "Google: CTA đi qua ExitApi (nhánh Adwords của build chỉ gọi window.open)");
assert.ok(/exitapi\.js/.test(google) && /name="ad\.orientation"/.test(google), "Google: có exitapi.js + meta ad.orientation");

var unity = core.convert(SRC, null, "unity", NEW).html;
assert.ok(/<script src="mraid\.js"><\/script>/.test(unity), "Unity: có thẻ mraid.js");
assert.strictEqual(/mraid\.js/.test(core.convert(SRC, null, "applovin", NEW).html), false, "AppLovin: KHÔNG có thẻ mraid.js");
assert.strictEqual(/exitapi\.js/.test(unity), false, "mạng khác Google: không có exitapi.js");

var mintegral = core.convert(SRC, null, "mintegral", NEW).html;
assert.ok(/window\.gameStart = function/.test(mintegral) && /window\.gameClose = function/.test(mintegral), "Mintegral: có gameStart/gameClose cho SDK kiểm");
assert.deepStrictEqual(core.validate(mintegral, "mintegral", "onesoft").warnings.filter(function (w) { return /gameStart/.test(w); }), []);

var pangle = core.convert(SRC, null, "pangle", NEW).html;
assert.ok(/window\.openAppStore = _pcOsFallback/.test(pangle), "Pangle: có đường dự phòng cho openAppStore");

/* ------------------------------------------------------------------ adapter là JS hợp lệ */

Object.keys(core.NETWORKS).forEach(function (target) {
    var src = Onesoft.buildAdapter(target, NEW);
    assert.doesNotThrow(function () { new Function(src); }, target + ": adapter là JS hợp lệ");
    assert.ok(src.indexOf("</script") < 0 && src.indexOf("<!--") < 0, target + ": adapter không chứa chuỗi phá thẻ <script>");
});

/* ------------------------------------------------------------------ link store: chỉ nhập một bên */

var androidOnly = core.convert(SRC, null, "applovin", { androidUrl: NEW.androidUrl });
assert.ok(androidOnly.html.indexOf('this.linkiOS="' + NEW.androidUrl + '"') >= 0, "chỉ nhập Android → linkiOS lấy theo Android, không để trống");
assert.strictEqual(androidOnly.warnings.filter(function (w) { return /link store cũ/.test(w); }).length, 0);

var keep = core.convert(SRC, null, "applovin", {});
assert.ok(keep.html.indexOf('this.linkAndroid="' + OLD_ANDROID + '"') >= 0, "không nhập link mới → giữ nguyên link trong file");
assert.strictEqual(keep.warnings.length, 0);

// linkiOS rỗng (đo được trên bản 6c24) vẫn phải nhận link mới.
var emptyIos = core.convert(page("Mintegral", OLD_ANDROID, ""), null, "mintegral", NEW);
assert.ok(emptyIos.html.indexOf('this.linkiOS="' + NEW.iosUrl + '"') >= 0, "ô iOS rỗng được điền link mới");

/* ------------------------------------------------------------------ lớp phát hành còn sót */

var withExternal = page("Mintegral", OLD_ANDROID, OLD_IOS, '<script src="https://sp2cdn-idea-global.zingfront.com/sp_opera/a15cba11870a53db84107723974befd9.js"></script>');
var external = core.convert(withExternal, null, "mintegral", NEW);
assert.strictEqual(external.warnings.filter(function (w) { return /script ngoài/.test(w); }).length, 1,
    "script ngoài dạng hash trần không gỡ theo URL được (cùng thư mục với SDK của PlaySmart) → phải báo");

// Lớp MindWorks offline bản mới thì gỡ được vì khớp theo tên file.
var withOfflineLayer = page("Mintegral", OLD_ANDROID, OLD_IOS,
    '<script src="js/webAudioCheck.js"></script>' +
    '<script src="https://sp2cdn-idea-global.zingfront.com/sp_opera/5dcc43027f19f3dd2026f717b8f369d9/js/mw_config.js"></script>' +
    '<script src="https://sp2cdn-idea-global.zingfront.com/sp_opera/5dcc43027f19f3dd2026f717b8f369d9/js/package_loading.js"></script>' +
    '<script src="https://sp2cdn-idea-global.zingfront.com/sp_opera/mobvista_playable_js/DynamicLoader.js"></script>' +
    '<script src="https://sp2cdn-idea-global.zingfront.com/sp_opera/5dcc43027f19f3dd2026f717b8f369d9/js/mtg_offline_package.js"></script>');
var cleaned = core.convert(withOfflineLayer, null, "mintegral", NEW);
assert.strictEqual(cleaned.warnings.filter(function (w) { return /script ngoài/.test(w); }).length, 0, "cả 5 thẻ của lớp phát hành đã được gỡ");
assert.ok(/Đã gỡ lớp phát hành Mintegral/.test(cleaned.notes.join(" ")), "có ghi chú đã gỡ lớp phát hành");

console.log("onesoft convert tests passed");
