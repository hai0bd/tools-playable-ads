"use strict";

// Build MindWorks / Mintegral offline package: Cocos 2.4 nén thành JSON map trong __adapter_zip__.
// Adapter KHÔNG bung payload — nó ghim đường đi CTA của game về nhánh toàn-biến-toàn-cục rồi tự cấp
// window.install/gameReady/gameEnd. Phần cuối chạy thật trong vm, mô phỏng đúng cách code game
// (chạy "use strict") gán lại advChannels sau khi adapter đã ghim.
var assert = require("assert");
var vm = require("vm");
var core = require("../converter-core");
require("../mindworks-core");

var NEW_ANDROID = "https://play.google.com/store/apps/details?id=com.new.game";
var NEW_IOS = "https://apps.apple.com/us/app/id999";

// Vỏ tối giản giữ đúng các dấu hiệu thật: MW_CONFIG (có store_url), payload chia 2 mảnh nối bằng
// `+=`, __adapter_init, và stub offline ghi đè được của lớp MindWorks.
var SOURCE = [
    '<html><head><title>Mintegral Interactive Ad</title></head><body mark="mobvista">',
    "<script>window.MW_CONFIG = {",
    "  MTGMaterialUUID: 'm_en_aylaprinhz2_VL6Ify8g6_p_an_ty', type: \"playable\", close_time: 15,",
    "  store_url: { ios: \"https://play.google.com/store/apps/details?id=com.kitten.ayla\", android: \"https://play.google.com/store/apps/details?id=com.kitten.ayla\" },",
    "  channel: \"m\", render_type: 1",
    "}</script>",
    '<script>window.gameReady=function(){window.OFFLINE_GAMEREADY=!0};window.install=function(){window.UF.layerTips("offline, check your network.")};</script>',
    '<script>window.__adapter_zip__="eJzsvQmz2rjSMPxX"</script>',
    '<script>window.__adapter_zip__+="1XdtX7Mzs2fW6kl"</script>',
    "<script>window.__adapter_plugins__=[]</script>",
    "<script>window.__adapter_init=function(){}</script>",
    '<canvas id="GameCanvas"></canvas>',
    "</body></html>"
].join("\n");

// ── 1. Nhận diện: luật cocos-old mù vì dấu hiệu nằm trong payload nén ──
assert.strictEqual(core.detectBuild(SOURCE), "mindworks");
assert.strictEqual(core.analyze(SOURCE, "pony.html").build, "mindworks");
assert.strictEqual(core.detectSourceNetwork(SOURCE, "pony.html"), "mintegral", 'mark="mobvista" → nguồn Mintegral');

// ── 2. Link store: sửa thẳng trong MW_CONFIG.store_url ──
var out = core.convert(SOURCE, "mindworks", "applovin", { androidUrl: NEW_ANDROID, iosUrl: NEW_IOS });
assert.ok(out.html.indexOf("com.kitten.ayla") < 0, "link app cũ phải biến mất");
assert.ok(/store_url\s*:\s*\{[^}]*ios:\s*"https:\/\/apps\.apple\.com\/us\/app\/id999"/.test(out.html), "ios trong store_url");
assert.ok(/store_url\s*:\s*\{[^}]*android:\s*"[^"]*id=com\.new\.game"/.test(out.html), "android trong store_url");
assert.strictEqual(out.warnings.length, 0);

// Chỉ có link Android thì dùng chung cho cả hai khoá.
var only = core.convert(SOURCE, "mindworks", "google", { androidUrl: NEW_ANDROID });
var storeBlock = only.html.match(/store_url\s*:\s*\{[^}]*\}/)[0];
assert.strictEqual((storeBlock.match(/id=com\.new\.game/g) || []).length, 2, "thiếu link iOS thì lấp cả hai khoá bằng link Android");

// Payload không bị đụng tới — đây là điểm chính của thiết kế.
assert.ok(out.html.indexOf('window.__adapter_zip__="eJzsvQmz2rjSMPxX"') >= 0, "mảnh 1 nguyên vẹn");
assert.ok(out.html.indexOf('window.__adapter_zip__+="1XdtX7Mzs2fW6kl"') >= 0, "mảnh 2 nguyên vẹn");

// ── 3. CTA theo từng mạng + validate sạch ──
[
    ["applovin", /mraid\.open/],
    ["unity", /mraid\.open/],
    ["google", /ExitApi\.exit/],
    ["pangle", /openAppStore/],
    ["mintegral", /window\.install/]
].forEach(function (pair) {
    var res = core.convert(SOURCE, "mindworks", pair[0], { androidUrl: NEW_ANDROID });
    assert.ok(pair[1].test(res.html), "CTA của " + pair[0]);
    var v = core.validate(res.html, pair[0], "mindworks");
    assert.deepStrictEqual(v.errors, [], "validate " + pair[0] + ": " + v.errors.join(" | "));
});

// ── 3b. Thẻ mraid.js: chỉ Unity cần (bảng kênh của bingo-core.js) ──
var MRAID_TAG_RE = /<script\b[^>]*\ssrc\s*=\s*["']mraid\.js["']/;
["applovin", "unity", "mintegral", "google", "pangle"].forEach(function (target) {
    var html = core.convert(SOURCE, "mindworks", target, { androidUrl: NEW_ANDROID }).html;
    assert.strictEqual(MRAID_TAG_RE.test(html), target === "unity", target + ": thẻ mraid.js");
});

// ── 4. Convert lại không chồng adapter ──
var twice = core.convert(out.html, "mindworks", "pangle", { androidUrl: NEW_ANDROID });
assert.strictEqual((twice.html.match(/data-playable-converter="mindworks"/g) || []).length, 1);
assert.ok(/openAppStore/.test(twice.html) && !/mraid\.open/.test(twice.html), "CTA mạng trước bị thay hẳn");

// ── 5. Thiếu dấu hiệu thì phải nhắc, đừng im lặng ──
var bare = core.convert("<html><body><canvas></canvas></body></html>", "mindworks", "applovin", { androidUrl: NEW_ANDROID });
assert.ok(bare.warnings.some(function (w) { return /MW_CONFIG/.test(w); }));
assert.ok(bare.warnings.some(function (w) { return /__adapter_zip__/.test(w); }));

/* ── 6. Chạy thật: ghim advChannels phải sống sót qua "use strict" của code game ──
 * Code game gán `window.advChannels = "Mintegral"` trong module "use strict". Nếu adapter định
 * nghĩa thuộc tính chỉ có getter thì phép gán đó ném TypeError và chết cả module — nên setter
 * rỗng là bắt buộc, không phải cho đẹp.
 */
function runAdapter(html, env) {
    var code = html.match(/<script data-playable-converter="mindworks">([\s\S]*?)<\/script>/)[1];
    var sandbox = { console: { log: function () { }, warn: function () { } }, navigator: { userAgent: "Mozilla/5.0 (Linux; Android 10)" } };
    Object.keys(env || {}).forEach(function (k) { sandbox[k] = env[k]; });
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox;
}

var opened = [];
var box = runAdapter(out.html, { mraid: { open: function (u) { opened.push(u); } } });
assert.strictEqual(box.advChannels, "Mintegral", "ghim được đường đi CTA");

// Game gán lại trong strict mode: không được ném, và không được đổi giá trị.
vm.runInContext('"use strict"; window.advChannels = "Google";', box);
assert.strictEqual(box.advChannels, "Mintegral", "gán của game bị bỏ qua, không ném lỗi");

// Mô phỏng btnInstall của game: nhánh Mintegral gọi gameEndHandle rồi window.install.
vm.runInContext([
    '"use strict";',
    "window.__log = [];",
    "window.gameEndHandle = function () { 'Mintegral' == advChannels && window.gameEnd && window.gameEnd(); };",
    "window.btnInstall = function () {",
    "    'Mintegral' == advChannels ? (window.gameEndHandle(), window.install && window.install())",
    "  : 'Google' == advChannels ? ExitApi.exit()",
    "  : 'AppLovin' == advChannels && mraid.open();",
    "};",
    "window.btnInstall();"
].join("\n"), box);
assert.deepStrictEqual(opened, [NEW_ANDROID], "CTA của game đi qua adapter và mở link mới");

// Máy iOS lấy link App Store.
var iosOpened = [];
var iosBox = runAdapter(out.html, { mraid: { open: function (u) { iosOpened.push(u); } } });
iosBox.navigator.userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)";
iosBox.install();
assert.deepStrictEqual(iosOpened, [NEW_IOS]);

// Mintegral: không giành install của mạng, nhưng phải thay stub offline của MindWorks.
var mtg = core.convert(SOURCE, "mindworks", "mintegral", { androidUrl: NEW_ANDROID }).html;
assert.ok(/window\.OFFLINE_GAMEREADY !== undefined/.test(mtg), "nhận ra stub offline để thay");
assert.ok(/window\.gameReady && window\.gameReady\(\)/.test(mtg));
assert.ok(/window\.gameEnd && window\.gameEnd\(\)/.test(mtg));

var netInstall = [];
var mtgBox = runAdapter(mtg, { install: function () { netInstall.push("mang"); } });
assert.strictEqual(typeof mtgBox.install, "function");
mtgBox.install();
assert.deepStrictEqual(netInstall, ["mang"], "mạng đã cấp install thì adapter nhường");

console.log("mindworks-convert.test.js: OK");
