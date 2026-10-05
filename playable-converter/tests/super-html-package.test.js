"use strict";

// Gói window.__zip của Super HTML trong tab Asset nhúng: bung từng file, tên dễ đọc lấy từ config.json của Cocos,
// file nhị phân trong gói ở dạng chữ data URI (loader Super HTML đọc bằng JSZip async("text")) phải được gỡ khi
// xem/tải và bọc lại khi thay. Build Bingo (byte thô) giữ nguyên hành vi cũ.
var assert = require("assert");
var core = require("../converter-core");
var B = require("../bingo-core");

global.window = { BingoBuilder: B, PlayableConverter: core };
require("../bingo-panel");
var panel = window.BingoPanel;

// Cặp uuid thật lấy từ build Cocos 2.4 (PixelPaint EggCute): config.json lưu dạng nén 22 ký tự.
var CLICK = "0f9073fe-0f1e-4ed2-a95d-00bc409ecce7", FINISH = "5cf69202-6597-4946-ad22-9fd350a7567a";
var BG = "a8c96a84-61fe-442b-8914-c13cb45be5a7";
assert.strictEqual(B.decompressUuid("0fkHP+Dx5O0qldALxAnszn"), CLICK);
assert.strictEqual(B.decompressUuid("5c9pICZZdJRq0in9NQp1Z6"), FINISH);
assert.strictEqual(B.decompressUuid(BG.toUpperCase()), BG, "uuid đầy đủ giữ nguyên (viết thường)");

var MP3 = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6]);
var NEW_MP3 = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 9, 8, 7, 6, 5, 4, 3, 2]);
var PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
function dataUri(mime, bytes) { return "data:" + mime + ";base64," + core.encodeBase64Bytes(bytes); }
function same(a, b) { return a.length === b.length && Array.prototype.every.call(a, function (v, i) { return v === b[i]; }); }

var resourcesConfig = JSON.stringify({ paths: { "0": ["Audio/click", 0], "1": ["Audio/Finish", 0] }, types: ["cc.AudioClip"], uuids: ["0fkHP+Dx5O0qldALxAnszn", "5c9pICZZdJRq0in9NQp1Z6"], name: "resources" });
var mainConfig = JSON.stringify({ paths: { "0": ["Textures/bg", 0] }, types: ["cc.Texture2D"], uuids: [BG], name: "main" });
var zip = core.assembleZip([
    { name: "assets/resources/config.json", data: resourcesConfig },
    { name: "assets/resources/native/0f/" + CLICK + ".mp3", data: dataUri("audio/mpeg", MP3) },
    { name: "main.js", data: "window.boot = function () {};" }
]);
var res = {};
res["assets/main/config.json"] = mainConfig;
res["assets/main/native/a8/" + BG + ".png"] = dataUri("image/png", PNG);
res["assets/resources/native/5c/" + FINISH + ".mp3"] = dataUri("audio/mpeg", MP3);
function superHtml(withZip) {
    return [
        "<!doctype html><html><body><script>",
        "function super_log() {}",
        "window.super_html = { download: function () {}, game_ready: function () {} };",
        withZip ? 'window.__zip = "' + core.encodeBase64Bytes(zip) + '";' : "",
        "window.__res=" + JSON.stringify(res) + ";",
        "</script></body></html>"
    ].join("\n");
}
var html = superHtml(true);
assert.strictEqual(core.detectBuild(html), "super-html");

// ---- file trong gói: tên dễ đọc + gỡ data URI ----
var packed = B.packageItems(html);
var click = packed.filter(function (item) { return /\.mp3$/.test(item.context); })[0];
assert.strictEqual(click.label, "Audio/click.mp3");
assert.strictEqual(click.kind, "audio");
assert.strictEqual(packed.filter(function (item) { return item.context === "main.js"; })[0].label, "", "file không có trong config.json thì không gắn tên");
var file = B.entryFile(click.entry);
assert.ok(same(file.data, MP3), "entryFile trả byte mp3 thật, không phải chữ data URI");
assert.strictEqual(file.wrap, "data:audio/mpeg;base64,");
assert.strictEqual(B.entryFile(packed.filter(function (item) { return item.context === "main.js"; })[0].entry).wrap, "", "file chữ (js) không bị coi là data URI");

// ---- asset để thẳng trong window.__res: tên theo config.json (trong gói lẫn trong __res) ----
var labels = B.resAssetLabels(html);
var byLabel = {};
core.extractEmbeddedData(html).forEach(function (item) { if (labels[item.start]) byLabel[labels[item.start]] = item; });
assert.deepStrictEqual(Object.keys(byLabel).sort(), ["Audio/Finish.mp3", "Textures/bg.png"]);
assert.strictEqual(byLabel["Audio/Finish.mp3"].kind, "audio");

// ---- thay file: bọc lại đúng dạng data URI mà loader Super HTML chờ ----
var stored = B.packFile(click.entry, NEW_MP3);
assert.ok(/^data:audio\/mpeg;base64,/.test(Buffer.from(stored).toString("latin1")), "file mới được bọc thành chữ data URI");
var edited = B.replacePackageEntry(html, click.context, stored, null);
assert.strictEqual(core.detectBuild(edited), "super-html", "sau khi thay vẫn là Super HTML");
var after = B.packageItems(edited);
var clickAfter = after.filter(function (item) { return item.context === click.context; })[0];
assert.ok(same(B.entryFile(clickAfter.entry).data, NEW_MP3), "đọc lại ra đúng mp3 mới");
assert.strictEqual(B.entryFile(clickAfter.entry).wrap, "data:audio/mpeg;base64,");
assert.strictEqual(Buffer.from(B.entryFile(after.filter(function (item) { return item.context === "main.js"; })[0].entry).data).toString(), "window.boot = function () {};", "file khác trong gói giữ nguyên");
assert.strictEqual(clickAfter.label, "Audio/click.mp3");
assert.doesNotThrow(function () { core.convertAll(edited, "super-html", null, {}); }, "file đã thay vẫn convert được");

// ---- danh sách tab Asset nhúng (BingoPanel.embeddedItems) ----
var list = panel.embeddedItems(html, core.extractEmbeddedData(html));
assert.ok(list.some(function (item) { return item.source === "bingo-zip" && item.label === "Audio/click.mp3"; }), "Super HTML: bung file trong gói");
assert.ok(list.some(function (item) { return item.source === "data-uri" && item.label === "Audio/Finish.mp3"; }), "Super HTML: giữ asset trong __res, có tên");
assert.ok(list.some(function (item) { return item.source === "super-html-zip"; }), "Super HTML: vẫn giữ payload ZIP nguyên khối");
var oldStyle = superHtml(false);
var oldList = panel.embeddedItems(oldStyle, core.extractEmbeddedData(oldStyle));
assert.ok(!oldList.some(function (item) { return item.source === "bingo-zip"; }), "Super HTML bản cũ (chỉ __res) không có gói để bung");
assert.ok(oldList.some(function (item) { return item.label === "Textures/bg.png"; }), "Super HTML bản cũ: asset __res vẫn có tên từ config.json trong __res");

// ---- Bingo: byte thô trong gói, danh sách như trước (file trong gói + payload nguyên khối) ----
var rawZip = core.assembleZip([{ name: "assets/main/native/a8/" + BG + ".png", data: PNG }]);
var bingo = '<!doctype html><html><head><style>body{background:url(data:image/png;base64,' + core.encodeBase64Bytes(PNG) + ')}</style></head><body><script>window.__zip="'
    + core.encodeBase64Bytes(rawZip) + '";window.__zipEncoding="base64";</script></body></html>';
assert.strictEqual(core.detectBuild(bingo), "bingo");
var rawEntry = B.packageItems(bingo)[0].entry;
assert.strictEqual(B.entryFile(rawEntry).wrap, "", "Bingo để byte thô, không phải data URI");
assert.strictEqual(B.packFile(rawEntry, NEW_MP3), NEW_MP3, "Bingo: file mới ghi nguyên byte, không bọc");
var bingoList = panel.embeddedItems(bingo, core.extractEmbeddedData(bingo));
assert.deepStrictEqual(bingoList.map(function (item) { return item.source; }), ["bingo-zip", "super-html-zip"], "Bingo: chỉ file trong gói + payload nguyên khối, như trước");

console.log("super-html package tests passed");
