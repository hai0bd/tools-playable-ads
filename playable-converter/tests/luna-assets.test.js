"use strict";

// Ảnh của Luna nằm ở <img data-mime="…" data-src122="…"> chứ không phải data: URI, nên trước đây
// bảng asset không thấy gì. Hai cái bẫy ở đây đều đã đo trên creative thật:
//   1. Payload nằm trong thuộc tính HTML → '<' '>' '&' bị escape, phải gỡ trước khi giải.
//   2. Luna dùng base122 CHUẨN (6 ký tự né); bảng 7 phần tử của repo (thêm '<') tạo ra chỉ số 6 mà
//      bộ giải của Luna tra ra undefined → playable đứng ở màn loading dù byte không đổi.
var assert = require("assert");
var core = require("../converter-core");

// PNG 1x1 thật, có đủ byte 0x3C ('<') và 0x26 ('&') để ép cả hai bẫy lộ ra.
var PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c633c26010000ff00025a029b0000000049454e44ae426082", "hex");

// ── 1. Bảng chuẩn vs bảng có '<' ──
var std = core.encodeBase122Bytes(new Uint8Array(PNG), { standard: true });
var withLt = core.encodeBase122Bytes(new Uint8Array(PNG));
assert.ok(Buffer.from(core.decodeBase122Bytes(std)).equals(PNG), "bảng chuẩn: giải lại đúng byte");
assert.ok(Buffer.from(core.decodeBase122Bytes(withLt)).equals(PNG), "bảng repo: giải lại đúng byte");
assert.ok(std.indexOf('"') < 0 && std.indexOf("&") < 0, "bảng chuẩn không phát ra \" hay & (nằm trong bảng né)");
assert.strictEqual(core.encodeBase122Bytes(new Uint8Array(PNG)), withLt, "mặc định vẫn là bảng cũ, không đổi hành vi");

// ── 2. Đọc được ảnh trong thẻ <img data-src122> ──
function tag(payload, id, mime) {
    return '<img crossorigin="" data-mime="' + mime + '" data-src122="' + payload + '" id="' + id + '" style="display:none"/>';
}
// Escape đúng như trình sinh HTML của Luna làm.
function escapeAttr(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

var html = "<html><body>" + tag(escapeAttr(std), "assets/bundles/-1/42.png", "image/png")
    + tag(escapeAttr(std), "assets/bundles/-1/43.jpg", "image/jpeg")
    + '<img src="data:image/png;base64,' + PNG.toString("base64") + '">'
    + "</body></html>";

var items = core.extractEmbeddedData(html);
var luna = items.filter(function (x) { return x.source === "luna-img"; });
assert.strictEqual(luna.length, 2, "thấy đủ 2 ảnh Luna");
assert.strictEqual(luna[0].context, "assets/bundles/-1/42.png", "lấy tên từ thuộc tính id");
assert.strictEqual(luna[0].mediaType, "image/png");
assert.strictEqual(luna[1].mediaType, "image/jpeg");
assert.ok(items.some(function (x) { return x.source === "data-uri"; }), "không phá bộ thu data URI sẵn có");

// Payload đã gỡ escape nên giải ra đúng PNG gốc.
assert.ok(Buffer.from(core.decodeBase122Bytes(luna[0].payload)).equals(PNG), "gỡ &lt;/&amp; rồi mới giải");
assert.ok(luna[0].payload.indexOf("&lt;") < 0, "payload trả về là bản đã gỡ escape");

// ── 3. Thay ảnh: escape lại, và file vẫn đọc lại được ──
var other = Buffer.concat([PNG, Buffer.from([0x3c, 0x26, 0x22])]);   // thêm '<' '&' '"' vào đuôi
var replaced = core.replaceEmbeddedData(html, luna[0].id, core.encodeBase122Bytes(new Uint8Array(other), { standard: true }));
assert.ok(replaced.indexOf('data-src122="') >= 0, "thuộc tính còn nguyên hình");
var after = core.extractEmbeddedData(replaced).filter(function (x) { return x.source === "luna-img"; });
assert.strictEqual(after.length, 2, "sau khi thay vẫn đọc lại được cả 2");
assert.ok(Buffer.from(core.decodeBase122Bytes(after[0].payload)).equals(other), "ảnh mới round-trip đúng byte");
assert.ok(Buffer.from(core.decodeBase122Bytes(after[1].payload)).equals(PNG), "ảnh còn lại không bị đụng");

// Thuộc tính phải được escape lại, nếu không dấu " sẽ cắt ngang thẻ.
var attr = replaced.match(/data-src122="([^"]*)"/)[1];
assert.ok(attr.indexOf('"') < 0, "không để lọt dấu nháy kép vào thuộc tính");

console.log("luna-assets.test.js: OK");
