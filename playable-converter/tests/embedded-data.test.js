"use strict";

var assert = require("assert");
var core = require("../converter-core");

var html = [
    '<img src="data:image/png;base64,QUJDRA==">',
    '<script>',
    'var packedBase122 = "héllo✓";',
    'var decoded = atob("SGVsbG8=");',
    'var other = base122.decode("payload-✓");',
    'var config = { audioBase64: "U09VTkQ=" };',
    'window.__zip = "UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==";',
    'var resources = { "textures/hero.png": "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=" };',
    '</script>'
].join("\n");

var items = core.extractEmbeddedData(html);
assert.deepStrictEqual(items.map(function (item) { return item.encoding; }), [
    "base64", "base122", "base64", "base122", "base64", "base64", "base64"
]);
assert.strictEqual(items[0].context, "image/png");
assert.strictEqual(items[0].fullValue, "data:image/png;base64,QUJDRA==");
assert.strictEqual(items[0].mediaType, "image/png");
assert.strictEqual(items[1].context, "packedBase122");
assert.strictEqual(items[2].context, "atob");
assert.strictEqual(items[3].context, "base122.decode");
assert.strictEqual(items[4].context, "audioBase64");
assert.strictEqual(items[5].context, "window.__zip");
assert.strictEqual(items[5].mediaType, "application/zip");
assert.strictEqual(items[6].context, "textures/hero.png");

var emptyZipBase64 = "UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==";
var emptyZipBytes = core.decodeBase64Bytes(emptyZipBase64);
assert.strictEqual(emptyZipBytes.length, 22);
assert.strictEqual(String.fromCharCode(emptyZipBytes[0], emptyZipBytes[1]), "PK");
assert.strictEqual(core.encodeBase64Bytes(emptyZipBytes), emptyZipBase64);
assert.strictEqual(core.detectSuperHtmlVersion('window.zip = "' + emptyZipBase64 + '";'), "new");

var fakeZipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 10, 13, 34, 38, 92, 60, 255]);
var fakeZipBase122 = core.encodeBase122Bytes(fakeZipBytes);
assert.deepStrictEqual(Array.from(core.decodeBase122Bytes(fakeZipBase122)), Array.from(fakeZipBytes));
var base122ZipHtml = '<script>window.__zipEncoding="base122";window.__zip="' + fakeZipBase122 + '";</script>';
var base122ZipItems = core.extractEmbeddedData(base122ZipHtml);
assert.strictEqual(base122ZipItems.length, 1);
assert.strictEqual(base122ZipItems[0].encoding, "base122");
assert.strictEqual(base122ZipItems[0].context, "window.__zip");
assert.strictEqual(base122ZipItems[0].mediaType, "application/zip");
assert.ok(base122ZipItems[0].payload.indexOf('"') < 0, "Encoded Base122 zip payload should be safe inside double quotes");

var replacedBase64 = core.replaceEmbeddedData(html, "base64-1", "data:image/png;base64,TkVX");
assert.ok(replacedBase64.indexOf("data:image/png;base64,TkVX") >= 0);
assert.ok(replacedBase64.indexOf("SGVsbG8=") >= 0, "Only the selected payload should change");

var replacedBase122 = core.replaceEmbeddedData(html, "base122-2", "new-✓");
assert.ok(replacedBase122.indexOf('base122.decode("new-✓")') >= 0);
var replacedEscapedBase122 = core.replaceEmbeddedData(html, "base122-2", JSON.stringify("new-✓"));
assert.ok(replacedEscapedBase122.indexOf('base122.decode("new-✓")') >= 0);

assert.throws(function () {
    core.replaceEmbeddedData(html, "base64-1", "not base64!");
}, /Base64/);

assert.throws(function () {
    core.replaceEmbeddedData(html, "base122-1", 'bad"quote');
}, /JavaScript/);

console.log("embedded-data tests passed");
