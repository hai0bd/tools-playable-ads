/*
 * decode-core.js — giải mã ↔ mã hoá đoạn URL-encoded (spVars / decodeURIComponent) trong playable.
 * -----------------------------------------------------------------------------------------------
 * UMD, zero-dependency → chạy cả browser (decode.html) lẫn Node (tests).
 * Global: window.DecodeCore   |   Node: require("./decode-core")
 *
 * Bài toán: config kiểu SayGames nhúng dạng  ...decodeURIComponent('%7B%22a%22:1%7D')...
 * Sửa tay chuỗi %XX rất dễ sai. Tool này: dán đoạn mã → giải mã ra JSON đọc được → sửa →
 * mã hoá lại → dán về. Giữ nguyên "vỏ" (var x = JSON.parse(decodeURIComponent('…'))) nếu có.
 *
 * CẠM BẪY đã xử lý: encodeURIComponent KHÔNG mã hoá dấu nháy đơn ' — mà payload lại nằm trong
 * '…' → một ' lọt ra là vỡ file. Config CarRace có value chứa code ("…, 'RaceCamera', 0);").
 * => luôn thay ' → %27 sau khi encode (decode vẫn ra đúng).
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    root.DecodeCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    // Tách "vỏ" decodeURIComponent('…') / decodeURIComponent("…") nếu người dùng dán cả câu.
    // Trả { hadWrapper, prefix, suffix, quote, payload } — reassemble = prefix + payload + suffix.
    function analyze(input) {
        var src = String(input == null ? "" : input);
        // tìm decodeURIComponent( 'xxx' ) hoặc "xxx" — lấy chuỗi dài nhất (thường là config chính)
        var re = /decodeURIComponent\(\s*(['"])([\s\S]*?)\1\s*\)/g, m, best = null;
        while ((m = re.exec(src))) {
            if (!best || m[2].length > best.payload.length) {
                var q = m[1], payloadStart = m.index + m[0].indexOf(q) + 1;
                best = { quote: q, payload: m[2], prefix: src.slice(0, payloadStart), suffix: src.slice(payloadStart + m[2].length) };
            }
        }
        if (best) { best.hadWrapper = true; return best; }
        // không có vỏ → coi cả input (đã trim) là payload thuần
        var trimmed = src.trim();
        return { hadWrapper: false, prefix: "", suffix: "", quote: "'", payload: trimmed };
    }

    // Giải mã payload URL-encoded → { decoded, isJSON, pretty, error }
    function decode(payload) {
        var decoded;
        try { decoded = decodeURIComponent(String(payload)); }
        catch (e) { decoded = String(payload); } // không phải URL-encoded hợp lệ → giữ nguyên
        try {
            var o = JSON.parse(decoded);
            return { decoded: decoded, isJSON: true, pretty: JSON.stringify(o, null, 2), value: o };
        } catch (e) {
            return { decoded: decoded, isJSON: false, pretty: decoded };
        }
    }

    // Mã hoá lại text → payload an toàn để nhúng trong '…' hoặc "…".
    // isJSON=true: validate + nén JSON trước (báo lỗi nếu JSON sai). quote: ký tự bọc ('|").
    function encode(text, opts) {
        opts = opts || {};
        var s = String(text == null ? "" : text);
        if (opts.isJSON) {
            var o = JSON.parse(s);           // ném lỗi nếu JSON không hợp lệ → UI bắt
            s = JSON.stringify(o);           // nén, chuẩn hoá
        }
        var out = encodeURIComponent(s);
        // encodeURIComponent bỏ sót ' ( ) ! * ~ — chỉ ' gây vỡ khi bọc '…'; " đã được encode.
        out = out.replace(/'/g, "%27");
        if (opts.quote === '"') out = out.replace(/"/g, "%22"); // phòng khi bọc "…" (thực ra " đã encode)
        return out;
    }

    // Ghép payload mới vào lại vỏ gốc.
    function reassemble(analysis, newPayload) {
        return analysis.hadWrapper ? (analysis.prefix + newPayload + analysis.suffix) : newPayload;
    }

    // Tiện ích: kiểm tra 1 chuỗi JSON có hợp lệ không → {ok, error, line, col}
    function validateJSON(text) {
        try { JSON.parse(text); return { ok: true }; }
        catch (e) {
            var msg = e.message, pos = (msg.match(/position (\d+)/) || [])[1];
            var line = null, col = null;
            if (pos != null) { var upto = String(text).slice(0, +pos); line = upto.split("\n").length; col = pos - upto.lastIndexOf("\n"); }
            return { ok: false, error: msg, line: line, col: col };
        }
    }

    return { analyze: analyze, decode: decode, encode: encode, reassemble: reassemble, validateJSON: validateJSON };
});
