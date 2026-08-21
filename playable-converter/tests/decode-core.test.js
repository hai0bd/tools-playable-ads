"use strict";
var assert = require("assert");
var core = require("../decode-core");

// ── 1. payload thuần: JSON round-trip ──
var obj = { car_configs: { value: { parts: [{ type: "Color", defaultName: "Gold", variants: [{ name: "Blue" }, { name: "Gold" }] }] } }, fps: 3, on: true };
var enc0 = encodeURIComponent(JSON.stringify(obj));
var a = core.analyze(enc0);
assert.strictEqual(a.hadWrapper, false, "chuỗi thuần → không có vỏ");
var d = core.decode(a.payload);
assert.strictEqual(d.isJSON, true);
assert.deepStrictEqual(JSON.parse(d.pretty), obj, "giải mã ra đúng object");

// mã hoá lại → giải mã lại phải khớp
var enc1 = core.encode(d.pretty, { isJSON: true });
assert.deepStrictEqual(JSON.parse(core.decode(enc1).pretty), obj, "round-trip JSON khớp");

// ── 2. có vỏ decodeURIComponent('…') → giữ nguyên vỏ ──
var line = "var spVars = JSON.parse(decodeURIComponent('" + enc0 + "'));";
var a2 = core.analyze(line);
assert.strictEqual(a2.hadWrapper, true);
assert.strictEqual(a2.payload, enc0, "trích đúng payload trong vỏ");
var out = core.reassemble(a2, core.encode(core.decode(a2.payload).pretty, { isJSON: true }));
assert.ok(out.indexOf("var spVars = JSON.parse(decodeURIComponent('") === 0, "giữ nguyên phần đầu");
assert.ok(/'\)\);$/.test(out), "giữ nguyên phần đuôi");
// và câu ghép lại phải chạy được (parse) → không có ' thô phá chuỗi
var payload2 = out.match(/decodeURIComponent\('([\s\S]*?)'\)/)[1];
assert.ok(payload2.indexOf("'") < 0, "payload không được chứa ' thô");
assert.deepStrictEqual(JSON.parse(decodeURIComponent(payload2)), obj);

// ── 3. CẠM BẪY dấu ': value chứa nháy đơn (như config CarRace) ──
var tricky = { a: "call(t, 'RaceCamera', 0);" };
var encT = core.encode(JSON.stringify(tricky), { isJSON: true });
assert.ok(encT.indexOf("'") < 0, "dấu ' trong value phải được mã hoá thành %27");
// nhúng vào '…' rồi 'chạy' như JS: decodeURIComponent phải bung đúng
var wrapped = "'" + encT + "'";
assert.deepStrictEqual(JSON.parse(decodeURIComponent(eval(wrapped))), tricky, "nhúng '…' vẫn parse đúng");

// ── 4. non-JSON text vẫn decode/encode được ──
var t = core.decode(encodeURIComponent("hello world & 50% off"));
assert.strictEqual(t.isJSON, false);
assert.strictEqual(t.decoded, "hello world & 50% off");
assert.strictEqual(decodeURIComponent(core.encode(t.decoded, {})), "hello world & 50% off");

// ── 5. encode báo lỗi khi JSON không hợp lệ ──
assert.throws(function () { core.encode("{ bad json", { isJSON: true }); });
var v = core.validateJSON("{ bad json");
assert.strictEqual(v.ok, false);
assert.ok(v.line >= 1);

console.log("decode-core.test.js: OK");
