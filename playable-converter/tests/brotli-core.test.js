/*
 * Test brotli-core: zlib của Node làm đáp án (bộ giải & bộ nén chuẩn của Google).
 *   - compress() → zlib phải giải ra đúng từng byte (và decompress() của chính mình cũng vậy).
 *   - dữ liệu zlib nén (có context modeling, block switch…) → decompress() phải ra đúng.
 *   - append() → giải ra đúng gốc + phần thêm, phần gốc không bị nén lại.
 * Chạy: node tests/brotli-core.test.js
 */
"use strict";
var assert = require("assert");
var zlib = require("zlib");
var B = require("../brotli-core");

var passed = 0, skipped = 0;
function ok(name, fn) {
    try { fn(); passed++; console.log("  ✓ " + name); }
    catch (e) { console.error("  ✗ " + name + "\n    " + (e.stack || e.message)); process.exitCode = 1; }
}

// PRNG cố định để dữ liệu test luôn như nhau. Math.imul bắt buộc: seed * 1103515245 vượt 2^53 thì mất
// bit thấp, dãy rơi vào chu kỳ ngắn và "dữ liệu ngẫu nhiên" lại nén được.
function rng(seed) { return function () { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; }; }
function randomBytes(n, seed) { var r = rng(seed), out = new Uint8Array(n); for (var i = 0; i < n; i++) out[i] = (r() * 256) | 0; return out; }
function concat(a, b) { var out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; }
function same(a, b) { return Buffer.from(a).equals(Buffer.from(b)); }
function zlibCompress(buf, quality) {
    return new Uint8Array(zlib.brotliCompressSync(Buffer.from(buf), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality } }));
}
// Dữ liệu kiểu mesh: float32 xen kẽ, lặp cấu trúc.
function floatData(n, seed) {
    var r = rng(seed), f = new Float32Array(n);
    for (var i = 0; i < n; i++) f[i] = Math.round((r() - 0.5) * 200) / 64 + (i % 12) * 0.25;
    return new Uint8Array(f.buffer);
}
// Chữ UTF-8 nhiều byte (Việt + CJK) — vùng ngữ cảnh UTF8 mà bảng Lut từng bị nhầm ranh giới.
function utf8Text(n, seed) {
    var r = rng(seed), words = ["đào", "tường", "thoát", "ngục", "牢", "挖", "逃脱", "ﾟｱｲ", "ê", "ơ", "ư", "Ｍｅｓｈ"], s = "";
    while (s.length < n) s += words[(r() * words.length) | 0] + ((r() * 10) | 0 ? "" : "\n");
    return new Uint8Array(Buffer.from(s, "utf8"));
}

console.log("brotli-core tests:");

var samples = [
    ["rỗng", new Uint8Array(0)],
    ["1 byte", new Uint8Array([42])],
    ["toàn số 0 (300 KB)", new Uint8Array(300000)],
    ["ngẫu nhiên 70 KB (khối không nén)", randomBytes(70000, 1)],
    ["lặp chuỗi", new Uint8Array(Buffer.from("abcabcabcabc".repeat(5000)))],
    ["float kiểu mesh 400 KB", floatData(100000, 2)],
    ["chữ UTF-8", utf8Text(60000, 3)],
    ["code JS của chính module", new Uint8Array(require("fs").readFileSync(__dirname + "/../brotli-core.js"))]
];

samples.forEach(function (s) {
    ok("compress → zlib & decompress giải đúng: " + s[0], function () {
        var enc = B.compress(s[1]);
        assert.ok(same(zlib.brotliDecompressSync(Buffer.from(enc)), s[1]), "zlib giải ra sai");
        assert.ok(same(B.decompress(enc), s[1]), "decompress của chính mình giải ra sai");
    });
});

ok("compress thực sự nén (không phải chỉ đóng gói thô)", function () {
    var text = samples[7][1];
    assert.ok(B.compress(text).length < text.length / 2.5, "code JS phải nén còn < 40%");
    assert.ok(B.compress(samples[2][1]).length < 64, "300 KB số 0 phải còn vài chục byte");
});

ok("dữ liệu không nén được đi nhánh meta-block thô (không phình quá vài byte)", function () {
    var noise = samples[3][1], enc = B.compress(noise);
    assert.ok(enc.length >= noise.length && enc.length < noise.length + 32, "70 KB ngẫu nhiên → " + enc.length + " byte");
});

[5, 11].forEach(function (q) {
    ok("decompress đọc đúng output của zlib (quality " + q + ")", function () {
        [floatData(60000, 4), randomBytes(20000, 5), concat(floatData(30000, 6), randomBytes(5000, 7))].forEach(function (buf) {
            assert.ok(same(B.decompress(zlibCompress(buf, q)), buf));
        });
    });
});

ok("decompress đọc đúng ngữ cảnh UTF8 (Lut1 ranh giới E0) trên output zlib", function () {
    var text = utf8Text(120000, 8), got;
    try { got = B.decompress(zlibCompress(text, 11)); }
    catch (e) {
        // Luna không dùng static dictionary nên bộ giải không mang theo; zlib thì đôi khi có. Chỉ được bỏ
        // qua khi phần đã giải KHỚP đúng dữ liệu gốc: bộ giải lệch nhịp (vd bảng Lut sai) cũng hay đâm
        // vào nhánh "dictionary" vì khoảng cách đọc sai vượt cửa sổ — đã từng chẩn đoán nhầm như vậy.
        if (/static dictionary/.test(e.message) && e.partial && same(e.partial, text.subarray(0, e.partial.length))) {
            skipped++; console.log("    (bỏ qua: zlib dùng static dictionary sau " + e.partial.length + " byte giải đúng)"); return;
        }
        throw e;
    }
    assert.ok(same(got, text));
});

ok("append: zlib giải ra gốc + phần thêm, phần gốc giữ nguyên bit", function () {
    var orig = floatData(80000, 9), compOrig = zlibCompress(orig, 11);
    [orig.subarray(1000, 41000), randomBytes(5000, 10), new Uint8Array([7])].forEach(function (extra) {
        var out = B.append(compOrig, extra);
        assert.ok(same(zlib.brotliDecompressSync(Buffer.from(out)), concat(orig, extra)), "zlib giải sai");
        assert.ok(same(B.decompress(out), concat(orig, extra)), "decompress giải sai");
        // Phần gốc được chép nguyên: chỉ tốn thêm ~kích thước dữ liệu mới (lặp lại lịch sử thì gần như 0).
        assert.ok(out.length <= compOrig.length + extra.length + 64, "append phình quá mức");
    });
    assert.ok(B.append(compOrig, orig.subarray(0, 40000)).length < compOrig.length + 100, "dữ liệu lặp lịch sử phải gần như miễn phí");
});

ok("append nối tiếp nhiều lần lên stream của chính mình", function () {
    var a = utf8Text(20000, 11), b = floatData(5000, 12), c = randomBytes(3000, 13);
    var out = B.append(B.append(B.compress(a), b), c);
    assert.ok(same(zlib.brotliDecompressSync(Buffer.from(out)), concat(concat(a, b), c)));
});

ok("scan: ghi lại WBITS, meta-block và vòng distance", function () {
    var info = B.scan(zlibCompress(floatData(50000, 14), 11));
    assert.ok(info.wbits >= 16 && info.wbits <= 24);
    assert.ok(info.blocks.length >= 1 && info.blocks[info.blocks.length - 1].end > 0);
    assert.strictEqual(info.ring.ring.length, 4);
});

ok("dữ liệu hỏng báo lỗi thay vì treo", function () {
    var enc = B.compress(floatData(20000, 15));
    assert.throws(function () { B.decompress(enc.subarray(0, enc.length >> 1)); });
});

console.log(passed + " test passed" + (skipped ? ", " + skipped + " bỏ qua" : "") + ".");
