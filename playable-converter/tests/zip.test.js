"use strict";

var assert = require("assert");
var zlib = require("zlib");
var core = require("../converter-core");

// 1) CRC32 — vector chuẩn "123456789" => 0xCBF43926
assert.strictEqual(core.crc32(core.utf8Bytes("123456789")) >>> 0, 0xCBF43926, "CRC32 chuẩn");

// Trình đọc ZIP tối giản (đọc central directory) để verify ngược output của assembleZip.
function readZip(bytes) {
    var buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
    var eocd = buf.length - 22; // writer không ghi comment nên EOCD = 22 byte cuối
    assert.strictEqual(buf.readUInt32LE(eocd), 0x06054b50, "EOCD signature");
    var count = buf.readUInt16LE(eocd + 10);
    var cdOffset = buf.readUInt32LE(eocd + 16);
    var entries = {};
    var p = cdOffset;
    for (var i = 0; i < count; i++) {
        assert.strictEqual(buf.readUInt32LE(p), 0x02014b50, "central dir signature");
        var method = buf.readUInt16LE(p + 10);
        var crc = buf.readUInt32LE(p + 16) >>> 0;
        var csize = buf.readUInt32LE(p + 20);
        var usize = buf.readUInt32LE(p + 24);
        var nameLen = buf.readUInt16LE(p + 28);
        var extraLen = buf.readUInt16LE(p + 30);
        var commentLen = buf.readUInt16LE(p + 32);
        var localOff = buf.readUInt32LE(p + 42);
        var name = buf.toString("utf8", p + 46, p + 46 + nameLen);
        assert.strictEqual(buf.readUInt32LE(localOff), 0x04034b50, "local signature (" + name + ")");
        var lNameLen = buf.readUInt16LE(localOff + 26);
        var lExtraLen = buf.readUInt16LE(localOff + 28);
        var dataStart = localOff + 30 + lNameLen + lExtraLen;
        var raw = buf.slice(dataStart, dataStart + csize);
        var data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
        assert.strictEqual(data.length, usize, "uncompressed size khớp (" + name + ")");
        assert.strictEqual(core.crc32(new Uint8Array(data)) >>> 0, crc, "CRC khớp (" + name + ")");
        entries[name] = new Uint8Array(data);
        p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

// 2) Entry store (không nén) — có ký tự UTF-8
var textA = "Hello, Playable! " + "áàảãạ".repeat(3);
var z1 = core.assembleZip([{ name: "a.txt", data: core.utf8Bytes(textA), deflated: null }]);
assert.strictEqual(String.fromCharCode(z1[0], z1[1], z1[2], z1[3]), "PK", "local magic PK\\x03\\x04");
var r1 = readZip(z1);
assert.deepStrictEqual(Array.from(r1["a.txt"]), Array.from(core.utf8Bytes(textA)), "store round-trip");

// 3) Entry deflate (giả lập CompressionStream bằng zlib.deflateRawSync)
var bigText = "AAAA".repeat(5000) + "<html>index</html>";
var bigBytes = core.utf8Bytes(bigText);
var deflated = new Uint8Array(zlib.deflateRawSync(Buffer.from(bigBytes)));
assert.ok(deflated.length < bigBytes.length, "deflate phải nhỏ hơn bản gốc");
var z2 = core.assembleZip([{ name: "index.html", data: bigBytes, deflated: deflated }]);
var r2 = readZip(z2);
assert.deepStrictEqual(Array.from(r2["index.html"]), Array.from(bigBytes), "deflate round-trip");

// 3b) deflated có nhưng KHÔNG nhỏ hơn -> tự chuyển store
var tiny = core.utf8Bytes("ab");
var fakeBigger = new Uint8Array([1, 2, 3, 4, 5]);
var z3 = core.assembleZip([{ name: "t.txt", data: tiny, deflated: fakeBigger }]);
var r3 = readZip(z3); // readZip sẽ assert method đúng qua việc giải nén; store nên đọc thẳng
assert.deepStrictEqual(Array.from(r3["t.txt"]), Array.from(tiny), "fallback store khi deflate không lợi");

// 4) ZIP LỒNG: vỏ ngoài chứa z2 (một .zip) ở dạng store + 1 file .html nén
var outer = core.assembleZip([
    { name: "google.zip", data: z2, deflated: null },
    { name: "applovin.html", data: bigBytes, deflated: deflated }
]);
var rOuter = readZip(outer);
assert.ok(rOuter["google.zip"], "vỏ ngoài có entry google.zip");
assert.ok(rOuter["applovin.html"], "vỏ ngoài có entry applovin.html");
assert.deepStrictEqual(Array.from(rOuter["google.zip"]), Array.from(z2), "google.zip byte-identical (store)");
var rInner = readZip(rOuter["google.zip"]); // parse 2 tầng
assert.deepStrictEqual(Array.from(rInner["index.html"]), Array.from(bigBytes), "nested zip -> index.html round-trip");

console.log("zip tests passed");
