"use strict";

// Chèn adapter vào trang: phải trúng thẻ </body> THẬT của tài liệu.
//
// Creative tải từ SocialPeta hay đi kèm script container của Google (Closure), và script đó dựng
// một iframe bằng cách ghép NGUYÊN MỘT TÀI LIỆU HTML trong chuỗi JS — kể cả "<body></body></html>".
// Thẻ </body> đầu tiên của file vì thế nằm GIỮA một chuỗi JS, không phải thẻ của trang.
//
// Bản cũ dùng html.replace(/<\/body>/i, ...) — regex không cờ `g` nên thay lần khớp ĐẦU TIÊN:
// adapter bị nhét vào giữa chuỗi, dấu " trong data-playable-converter="..." đóng chuỗi sớm và
// script vỡ cú pháp ("Unexpected identifier 'luna'"). Test này neo lại hành vi đúng cho cả 5 chỗ
// cùng dùng một helper: converter-core, playsmart, mindworks, onesoft và inline-core.
var assert = require("assert");
var core = require("../converter-core");
var inline = require("../inline-core");
require("../playsmart-core");
require("../mindworks-core");
require("../onesoft-core");

// Script container: </body></html> nằm trong chuỗi JS, y như bản Google thật.
var TRAP = '<script>var frameDoc = "<html><head></head><body></body></html>"; window.__frameDoc = frameDoc;</script>';

// Kiểm mọi script nội tuyến của kết quả đều parse được, và chuỗi bẫy còn nguyên vẹn.
function assertIntact(html, label) {
    var regex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi, match, index = 0;
    while ((match = regex.exec(html))) {
        if (/\bsrc\s*=/.test(match[1])) continue;
        index++;
        try { new Function(match[2]); }
        catch (error) { assert.fail(label + " — script " + index + " vỡ cú pháp: " + error.message); }
    }
    assert.ok(html.indexOf('"<html><head></head><body></body></html>"') >= 0,
        label + " — chuỗi tài liệu trong script bị sửa");
    assert.ok(/data-playable-converter=/.test(html), label + " — không thấy adapter được chèn");
}

// ── 1. Luna: đúng ca lỗi thật (MotoWheelie_A_luna) ──
var luna = "<!doctype html><html><body>" + TRAP + "<script>window.Luna = Luna;</script></body></html>";
["applovin", "mintegral", "unity", "google"].forEach(function (target) {
    assertIntact(core.convert(luna, "luna", target, {}).html, "luna/" + target);
});

// ── 2. Các build khác cũng chèn qua cùng helper ──
var FIXTURES = {
    playsmart: "<!doctype html><html><body>" + TRAP
        + "<script>var qici = {}; qici.config = { gameName: 'x' }; var ps = {}; ps.hasReady = false; ps.hasStart = false;"
        + " function gameStart() { ps.hasStart = true; }</script></body></html>",
    mindworks: "<!doctype html><html><body>" + TRAP
        + '<script>window.MW_CONFIG = { store_url: { ios: "https://a", android: "https://b" } };'
        + ' window.__adapter_zip__ = "x"; function __adapter_init() {}</script></body></html>',
    setupConfig: "<!doctype html><html><body>" + TRAP
        + '<script>var setupConfig = { storeUrl: "https://old" };</script></body></html>'
};
assertIntact(core.convert(FIXTURES.playsmart, "playsmart", "applovin", {}).html, "playsmart");
assertIntact(core.convert(FIXTURES.mindworks, "mindworks", "applovin", {}).html, "mindworks");
assertIntact(core.convert(FIXTURES.setupConfig, "setup-config", "applovin", {}).html, "setup-config");

// ── 3. inline-core: script tải về cũng phải nằm trước </body> thật ──
(async function () {
    var shell = "<!doctype html><html><body>" + TRAP
        + '<script src="https://cdn.example.com/game.js"></script></body></html>';
    var result = await inline.inline(shell, {
        fetchText: function () { return Promise.resolve('window.game = "ok";'); }
    });
    var bodyEnd = result.html.lastIndexOf("</body>");
    assert.ok(result.html.indexOf('window.game = "ok";') < bodyEnd, "script nhúng phải nằm trước </body> cuối");
    assert.ok(result.html.indexOf('"<html><head></head><body></body></html>"') >= 0, "chuỗi tài liệu bị sửa");

    // ── 4. Không có </body> ngoài script: nối vào cuối, không chui vào chuỗi ──
    var noBody = "<!doctype html><html>" + TRAP;
    var tail = await inline.inline(noBody + '<script src="https://cdn.example.com/game.js"></script>', {
        fetchText: function () { return Promise.resolve('window.game = "ok";'); }
    });
    assert.ok(tail.html.indexOf('"<html><head></head><body></body></html>"') >= 0, "chuỗi tài liệu bị sửa (không body)");

    console.log("body-insert.test.js: OK");
})().catch(function (error) {
    console.error(error);
    process.exit(1);
});
