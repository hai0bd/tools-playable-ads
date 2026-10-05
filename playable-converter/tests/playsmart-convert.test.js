"use strict";

// Build PlaySmart/QICI (creative Zingfront, thường gặp ở Mintegral): nhận diện, gỡ lớp quảng cáo,
// và mồi lại gameStart() — thứ mà SDK vừa gỡ vốn đang giữ. Phần cuối chạy THẬT đoạn adapter trong
// vm với ps/mraid giả, vì "có sinh ra đúng chuỗi" không chứng minh được là nó chạy đúng.
var assert = require("assert");
var vm = require("vm");
var core = require("../converter-core");
require("../playsmart-core");

var NEW_URL = "https://play.google.com/store/apps/details?id=com.new.game";

// Vỏ tối giản nhưng giữ đúng các dấu hiệu của creative thật: khối serve-time OMG, SDK MOF
// (mở đầu `var OMG=OMG||{}`), engine QICI, runtime ps.*, và listener của trình sửa creative.
var SERVE = '<script>var OMG = {imp_url: "https://at-ali-mtgtracking-adx.rayjump.com/imp?drp=abc", ins_url: "https://play.google.com/store/apps/details?id=com.old.game", config: "%7B%22aid%22%3A%2228000%22%7D", adapter_dns: "https://play.mintegral.com"}</script>';
var SDK = '<script>var OMG=OMG||{};var cacheCheck={ws:false,ir:false};function MtgDispatch(n){}function waitForGameStart(){gameStart()}function trackImpression(){}window.install=function(){};</script>';
var ENGINE = "<script>var qici = {}; qici.config = { gameName: 'huanzhuang', useLanguages: true };</script>";
var GAME = [
    "<script>",
    "var ps = {}; ps.mainState = {}; ps.hasReady = false; ps.hasStart = false;",
    "ps.Behaviour = function () {};",
    "function gameStart() { ps.hasStart = true; }",
    "ps.install = function () { window.install && window.install(); };",
    "ps.gameEnd = function (result) { if (window['gameEnd']) window['gameEnd'](result); return 'da ket thuc'; };",
    "</script>"
].join("\n");
var EDITOR = "<script>document.addEventListener('PLAYABLE:switchScene', function (a) { var b = String(a.detail.scene); })</script>";

var SOURCE = [
    "<html><head><meta charset=\"utf-8\"><title>YoYa</title></head><body>",
    SERVE, SDK, ENGINE, GAME,
    '<div id="gameDiv"></div>',
    EDITOR,
    "</body></html>"
].join("\n");

// ── 1. Nhận diện ──
assert.strictEqual(core.detectBuild(SOURCE), "playsmart", "ps.* + qici.config → playsmart");
assert.strictEqual(core.analyze(SOURCE, "YoYa.html").build, "playsmart");

// ── 2. Gỡ đúng ba thứ, giữ nguyên phần còn lại ──
var out = core.convert(SOURCE, "playsmart", "applovin", { androidUrl: NEW_URL });
assert.ok(out.html.indexOf("rayjump.com/imp") < 0, "bỏ imp_url tracking");
assert.ok(out.html.indexOf("com.old.game") < 0, "bỏ link store cũ trong OMG");
assert.ok(out.html.indexOf("MtgDispatch") < 0, "bỏ SDK MOF");
assert.ok(out.html.indexOf("waitForGameStart") < 0, "bỏ luôn chuỗi khởi động của SDK");
// Listener PLAYABLE:switchScene KHÔNG được gỡ: chính code game vừa dispatch vừa nghe event đó.
assert.ok(/addEventListener\(\s*['"]PLAYABLE:switchScene/.test(out.html), "giữ listener switchScene — đó là logic game");
assert.ok(/gỡ SDK MOF/.test(out.html), "để lại dấu vết đã gỡ gì");

// Code game phải còn nguyên vẹn.
assert.ok(out.html.indexOf("qici.config") >= 0, "giữ engine QICI");
assert.ok(out.html.indexOf("function gameStart()") >= 0, "giữ gameStart của game");
assert.ok(out.html.indexOf('id="gameDiv"') >= 0, "giữ container");
assert.strictEqual(out.warnings.length, 0, "vỏ đủ dấu hiệu thì không cảnh báo gì");

/* ── 2b. HỒI QUY: khớp lỏng ở giữa thân script là xoá nhầm cả file game ──
 * File game thật (6b8119e3 của YoYa, 497 KB) vừa dispatch vừa nghe PLAYABLE:switchScene, và có
 * nhắc cả tên biến của SDK. Luật nhận diện phải neo đầu chuỗi, nếu không nguyên khối game bay mất
 * mà convert vẫn báo thành công — đúng lỗi đã xảy ra lúc chạy thử trên file thật.
 */
var GAME_LOOKALIKE = [
    "<script>",
    "var qici = {}; qici.config = { gameName: 'x' };",
    "var ps = {}; ps.mainState = {}; ps.Behaviour = function () {};",
    "function gameStart() { ps.hasStart = true; }",
    "document.addEventListener('PLAYABLE:switchScene', function (t) { var e = t.detail.scene; });",
    "function dispatchScene(n) { document.dispatchEvent(new CustomEvent('PLAYABLE:switchScene', { detail: { scene: n } })); }",
    "var doc = 'SDK cu tung dung var OMG=OMG||{}; va cacheCheck de dan MtgDispatch';",
    "</script>"
].join("\n");
var keep = core.convert("<html><body>" + GAME_LOOKALIKE + "</body></html>", "playsmart", "applovin", { androidUrl: NEW_URL });
assert.ok(keep.html.indexOf("function gameStart()") >= 0, "không được xoá script game chỉ vì nó NHẮC tới tên của SDK");
assert.ok(keep.html.indexOf("dispatchScene") >= 0);
assert.ok(keep.html.indexOf("cacheCheck") >= 0, "chuỗi nằm giữa thân script thì không tính");

// ── 3. CTA theo từng mạng, và validate của converter phải sạch ──
[
    ["applovin", /mraid\.open/],
    ["unity", /mraid\.open/],
    ["google", /ExitApi\.exit/],
    ["pangle", /openAppStore/],
    ["mintegral", /window\.install/]
].forEach(function (pair) {
    var target = pair[0];
    var res = core.convert(SOURCE, "playsmart", target, { androidUrl: NEW_URL });
    assert.ok(pair[1].test(res.html), "CTA của " + target);
    assert.ok(res.html.indexOf(NEW_URL) >= 0, "link mới được ghi vào (" + target + ")");
    var v = core.validate(res.html, target, "playsmart");
    assert.deepStrictEqual(v.errors, [], "validate " + target + ": " + v.errors.join(" | "));
});

/* ── 3b. Thẻ <script src="mraid.js">: CHỈ Unity cần ──
 * File mraid.js do SDK của mạng phục vụ, không nằm trong gói. AppLovin tự chèn nên khai thêm là
 * thừa; Google validator thì báo thiếu file. Theo bảng kênh của bingo-core.js.
 */
var MRAID_TAG_RE = /<script\b[^>]*\ssrc\s*=\s*["']mraid\.js["']/;
["applovin", "unity", "mintegral", "google", "pangle"].forEach(function (target) {
    var html = core.convert(SOURCE, "playsmart", target, { androidUrl: NEW_URL }).html;
    assert.strictEqual(MRAID_TAG_RE.test(html), target === "unity", target + ": thẻ mraid.js");
});

// Convert lại từ bản Unity sang mạng khác thì thẻ phải bị gỡ, không dính lại.
var fromUnity = core.convert(SOURCE, "playsmart", "unity", { androidUrl: NEW_URL }).html;
assert.ok(MRAID_TAG_RE.test(fromUnity));
assert.ok(!MRAID_TAG_RE.test(core.convert(fromUnity, "playsmart", "google", { androidUrl: NEW_URL }).html), "Unity → Google phải gỡ thẻ");

// ── 4. Mintegral: không giành window.install của mạng, và có đủ gameReady/gameEnd ──
var mtg = core.convert(SOURCE, "playsmart", "mintegral", { androidUrl: NEW_URL }).html;
assert.ok(/if \(typeof window\.install !== "function"\) window\.install = _pcPsCta;/.test(mtg), "chỉ đỡ khi mạng không cấp install");
assert.ok(/window\.gameReady && window\.gameReady\(\)/.test(mtg));
assert.ok(/window\.gameEnd && window\.gameEnd\(\)/.test(mtg));
var alv = core.convert(SOURCE, "playsmart", "applovin", { androidUrl: NEW_URL }).html;
assert.ok(/^\s*window\.install = _pcPsCta;/m.test(alv), "mạng khác thì gán thẳng");

// ── 5. Convert lại nhiều lần không chồng adapter ──
var twice = core.convert(out.html, "playsmart", "google", { androidUrl: NEW_URL }).html;
assert.strictEqual((twice.match(/data-playable-converter="playsmart"/g) || []).length, 1, "chỉ còn 1 khối adapter");
assert.ok(/ExitApi\.exit/.test(twice) && !/mraid\.open/.test(twice), "adapter cũ bị thay hẳn, không sót CTA mạng trước");

// ── 6. File chưa nhúng (còn trỏ CDN) thì phải nhắc, đừng im lặng bỏ sót SDK ──
var SHELL = '<html><body><script src="https://sp2cdn-idea-global.zingfront.com/sp_opera/abc.js"></script>' + ENGINE + GAME + "</body></html>";
var shellOut = core.convert(SHELL, "playsmart", "applovin", { androidUrl: NEW_URL });
assert.ok(shellOut.warnings.some(function (w) { return /nhúng tham chiếu từ xa trước/.test(w); }), "nhắc chạy bước nhúng trước");

// ── 7. Chạy thật mồi nổ: đúng thứ mà SDK vừa gỡ đang giữ ──
function runAdapter(html, env) {
    var code = html.match(/<script data-playable-converter="playsmart">([\s\S]*?)<\/script>/)[1];
    var pending = [];
    var sandbox = {
        console: { warn: function () { }, log: function () { } },
        navigator: { userAgent: "Mozilla/5.0 (Linux; Android 10)" },
        setInterval: function (fn) { pending.push(fn); return pending.length; },
        clearInterval: function () { pending.length = 0; }
    };
    Object.keys(env || {}).forEach(function (k) { sandbox[k] = env[k]; });
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return { sandbox: sandbox, tick: function (n) { for (var i = 0; i < (n || 1); i++) if (pending[0]) pending[0](); } };
}

// 7a. AppLovin: hễ game báo ready là mồi ngay.
var started = false;
var ps = { hasReady: false, hasStart: false };
var run = runAdapter(alv, { ps: ps, gameStart: function () { started = true; ps.hasStart = true; } });
run.sandbox.window.gameStart = run.sandbox.gameStart;
run.tick(5);
assert.strictEqual(started, false, "chưa ready thì chưa mồi");
ps.hasReady = true;
run.tick(1);
assert.strictEqual(started, true, "ready là gọi gameStart()");
run.tick(3);
assert.strictEqual(started, true, "đã start rồi thì thôi, không gọi lại");

// 7b. Mintegral: nhường mạng gọi trước, quá 5 giây mới tự mồi.
var mStarted = 0;
var mps = { hasReady: true, hasStart: false };
var mrun = runAdapter(mtg, { ps: mps, gameStart: function () { mStarted++; mps.hasStart = true; }, gameReady: function () { } });
mrun.sandbox.window.gameStart = mrun.sandbox.gameStart;
mrun.tick(50);
assert.strictEqual(mStarted, 0, "trong 5 giây đầu phải nhường mạng gọi gameStart");
mrun.tick(1);
assert.strictEqual(mStarted, 1, "quá hạn thì tự mồi");

// 7c. Mintegral: mạng gọi trước thì adapter im lặng.
var nStarted = 0;
var nps = { hasReady: true, hasStart: false };
var nrun = runAdapter(mtg, { ps: nps, gameStart: function () { nStarted++; }, gameReady: function () { } });
nrun.sandbox.window.gameStart = nrun.sandbox.gameStart;
nrun.tick(3);
nps.hasStart = true;             // mạng đã gọi
nrun.tick(60);
assert.strictEqual(nStarted, 0, "mạng đã start thì adapter không chen vào");

// 7d. CTA thật sự mở đúng link mới qua API của mạng.
var opened = [];
var cps = { hasReady: false, hasStart: false };
var crun = runAdapter(alv, { ps: cps, mraid: { open: function (u) { opened.push(u); } } });
crun.sandbox.window.install();
assert.deepStrictEqual(opened, [NEW_URL], "CTA gọi mraid.open với link mới");

// 7e. iOS thì lấy link iOS.
var iosOpened = [];
var irun = runAdapter(core.convert(SOURCE, "playsmart", "applovin", { androidUrl: NEW_URL, iosUrl: "https://apps.apple.com/app/id123" }).html,
    { ps: { hasReady: false, hasStart: false }, mraid: { open: function (u) { iosOpened.push(u); } } });
irun.sandbox.navigator.userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)";
irun.sandbox.window.install();
assert.deepStrictEqual(iosOpened, ["https://apps.apple.com/app/id123"], "máy iOS dùng link App Store");

// 7f. Mintegral: ps.gameEnd của game được bọc để phát lại gameEnd, và giá trị trả về giữ nguyên.
var ended = 0;
var eps = {
    hasReady: false, hasStart: false,
    gameEnd: function (result) { return "goc:" + result; }
};
var erun = runAdapter(mtg, { ps: eps, gameEnd: function () { ended++; }, gameReady: function () { } });
assert.strictEqual(eps.gameEnd(true), "goc:true", "bọc rồi vẫn trả đúng giá trị gốc");
assert.strictEqual(ended, 1, "phát lại gameEnd của mạng");
eps.gameEnd(true);
assert.strictEqual(ended, 1, "chỉ phát lại một lần");

console.log("playsmart-convert.test.js: OK");
