/*
 * mindworks-core.js — kiểu build "MindWorks / Mintegral offline package" cho playable-converter.
 * ---------------------------------------------------------------------------------------------
 * Pipeline playable của MindWorks (bộ phận creative của Mintegral): build Cocos Creator 2.4 web-mobile
 * được nén thành JSON map `đường dẫn → nội dung`, deflate rồi base64 vào `window.__adapter_zip__`
 * (chia nhiều script, nối bằng `+=`), bung bởi `window.__adapter_init`.
 * Đăng ký qua registerBuild("mindworks"). Cần converter-core.js.
 *
 * UMD, zero-dependency → chạy cả browser (app.js) lẫn Node (tests).
 * Global: window.MindWorksBuild   |   Node: require("./mindworks-core")
 *
 * VÌ SAO detectBuild KHÔNG BẮT ĐƯỢC BẰNG LUẬT CŨ: luật `cocos-old` đòi `openAdUrl = function` và
 * `_CCSettings` xuất hiện trong HTML. Creative này có cả hai — nhưng nằm trong payload nén, nên
 * mọi regex chạy trên HTML đều mù.
 *
 * KHÔNG ĐỤNG VÀO PAYLOAD. Không cần bung 2,5 MB base64 ra sửa rồi nén lại, vì code game đã định
 * tuyến sẵn qua biến toàn cục:
 *
 *     window.advChannels = "Mintegral";
 *     gameReadyHandle: "Mintegral" == advChannels && window.gameReady && window.gameReady()
 *     gameEndHandle:   "Mintegral" == advChannels && window.gameEnd   && window.gameEnd()
 *     btnInstall:      "Mintegral" == advChannels ? (gameEndHandle(), window.install && window.install())
 *                    : "Google"    == advChannels ? ExitApi.exit()
 *                    : "AppLovin"  == advChannels && mraid.open()
 *
 * Nhánh "Mintegral" là nhánh DUY NHẤT đi qua toàn biến toàn cục ghi đè được — hai nhánh kia gọi
 * thẳng ExitApi/mraid và `mraid.open()` còn không truyền URL. Nên adapter ghim advChannels về
 * "Mintegral" cho MỌI mạng đích (đây là lựa chọn ĐƯỜNG ĐI, không phải mạng đầu ra) rồi tự cấp
 * window.install/gameReady/gameEnd theo target. Nhờ vậy cũng không phụ thuộc creative gốc ship
 * sẵn giá trị nào.
 *
 * Link store cũ nằm ở `MW_CONFIG.store_url.{ios,android}` và cũng được thay. Lưu ý cho đúng:
 * ĐÓ KHÔNG PHẢI đường CTA sống. Đo lúc chạy thì `window.MW_CONFIG` bị lớp MindWorks thay bằng một
 * object nhỏ hơn (chỉ còn alway_portrait/alway_landscape/logo_position/render_type) trước khi có ai
 * đọc `store_url`. Thay nó là để file không còn mang link app của creative gốc — CTA thật đi qua
 * `window.install` mà adapter cấp.
 */
(function (root, factory) {
    var isNode = typeof module === "object" && module.exports && typeof require === "function";
    var core = isNode ? require("./converter-core") : root.PlayableConverter;
    var api = factory(core);
    if (isNode) module.exports = api;
    root.MindWorksBuild = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (core) {
    "use strict";

    var ADAPTER_ZIP = /window\s*\.\s*__adapter_zip__\s*\+?=/;
    var MW_CONFIG = /window\s*\.\s*MW_CONFIG\s*=/;

    function isMindWorks(html) {
        return ADAPTER_ZIP.test(html);
    }

    // Thay đúng một khoá trong khối `store_url: { ios: "…", android: "…" }` của MW_CONFIG.
    // "$" trong URL phải nhân đôi vì replace() coi $& / $1 là ký hiệu.
    function replaceStoreUrl(html, key, value) {
        var regex = new RegExp("(\\bstore_url\\s*:\\s*\\{[^}]*?\\b" + key + "\\s*:\\s*)([\"'])[^\"']*\\2");
        if (!regex.test(html)) return null;
        return html.replace(regex, "$1$2" + core.escapeJsString(value).replace(/\$/g, "$$$$") + "$2");
    }

    // quiet = đã báo "không thấy MW_CONFIG" rồi thì đừng kêu thêm 2 lần về store_url nằm trong nó.
    // File đã gỡ sẵn lớp MindWorks bằng tay là trường hợp hợp lệ, không phải lỗi.
    function applyStoreUrls(html, options, warnings, quiet) {
        var android = (options.androidUrl || "").trim();
        var ios = (options.iosUrl || "").trim();
        var preferred = android || ios;
        if (!preferred) return html;
        var out = html;
        [["android", android || preferred], ["ios", ios || preferred]].forEach(function (pair) {
            var next = replaceStoreUrl(out, pair[0], pair[1]);
            if (next === null) {
                if (!quiet) warnings.push("Không thấy MW_CONFIG.store_url." + pair[0] + " để thay link.");
            } else out = next;
        });
        return out;
    }

    function buildAdapter(target, options) {
        options = options || {};
        var android = core.escapeJsString(options.androidUrl || "");
        var ios = core.escapeJsString(options.iosUrl || "");
        var lines = [
            "function _pcMwUrl() {",
            "    var android = '" + android + "', ios = '" + ios + "';",
            "    var preferred = /iphone|ipad|ipod|macintosh/i.test((navigator.userAgent || \"\").toLowerCase()) ? ios : android;",
            "    return preferred || android || ios || \"\";",
            "}",
            "function _pcMwCta() { " + core.targetClickCode(target, "_pcMwUrl()", "_pcMwCta") + "; }",
            // Ghim đường đi của CTA. Setter rỗng chứ không bỏ trống: code game chạy trong "use strict",
            // gán vào thuộc tính chỉ có getter sẽ ném TypeError và chết cả module.
            "try {",
            "    Object.defineProperty(window, \"advChannels\", {",
            "        configurable: true,",
            "        get: function () { return \"Mintegral\"; },",
            "        set: function () { }",
            "    });",
            "} catch (e) { window.advChannels = \"Mintegral\"; }"
        ];
        if (target === "mintegral") {
            lines.push(
                // Mintegral tự cấp install/gameReady/gameEnd lúc serve; lớp offline của MindWorks có
                // stub riêng, nên chỉ đỡ vào khi mạng thật sự không cấp.
                "if (typeof window.install !== \"function\" || window.OFFLINE_GAMEREADY !== undefined) window.install = _pcMwCta;",
                "if (typeof window.gameClose !== \"function\") window.gameClose = function () { };",
                // Game tự gán window.gameStart trong module GameDataCenter, nhưng module đó chỉ chạy khi Cocos
                // nạp bundle main — có thể SAU lúc gameReady, mà SDK kiểm typeof gameStart đúng lúc đó.
                // Đỡ trước bằng hàm rỗng; game gán đè sau (bản đo được cũng chỉ console.log).
                "if (typeof window.gameStart !== \"function\") window.gameStart = function () { };",
                "var _pcMwReady = false, _pcMwEnded = false;",
                "function _pcMwNotifyReady() { if (_pcMwReady) return; _pcMwReady = true; window.gameReady && window.gameReady(); }",
                "function _pcMwNotifyEnd() { if (_pcMwEnded) return; _pcMwEnded = true; window.gameEnd && window.gameEnd(); }"
            );
        } else {
            // Các mạng khác: window.install của lớp offline MindWorks chỉ hiện toast
            // "offline, check your network." — phải thay hẳn thì CTA mới sống.
            lines.push("window.install = _pcMwCta;");
        }
        return lines.join("\n");
    }

    // Hàm thay thế chứ không phải chuỗi: $& $` $' $1 trong content bị String.replace hiểu là ký hiệu.
    function insertBeforeClosingBody(html, content) {
        return /<\/body>/i.test(html)
            ? html.replace(/<\/body>/i, function () { return content + "\n</body>"; })
            : html + "\n" + content;
    }

    function removeInjected(html) {
        return html.replace(/\s*<script\b[^>]*data-playable-converter=["']mindworks["'][^>]*>[\s\S]*?<\/script>/gi, "");
    }

    function retarget(html, target, options) {
        var warnings = [];
        var out = removeInjected(html);
        var hasConfig = MW_CONFIG.test(out);
        if (!hasConfig) warnings.push("Không thấy window.MW_CONFIG (lớp MindWorks đã bị gỡ?). Adapter vẫn chạy vì CTA đi qua window.install, nhưng không có MW_CONFIG.store_url để thay link cũ.");
        if (!ADAPTER_ZIP.test(out)) warnings.push("Không thấy window.__adapter_zip__; hãy nhúng tham chiếu từ xa trước rồi convert lại.");
        out = applyStoreUrls(out, options || {}, warnings, !hasConfig);
        // Thẻ mraid.js: chỉ Unity cần (xem bảng kênh trong converter-core.setMraidTag).
        if (typeof core.setMraidTag === "function") out = core.setMraidTag(out, target === "unity");
        // Google bắt buộc có exitapi.js + meta ad.orientation; các mạng khác phải KHÔNG có.
        if (typeof core.configureGoogleExitApi === "function") out = core.configureGoogleExitApi(out, target);
        out = insertBeforeClosingBody(out, '<script data-playable-converter="mindworks">\n' + buildAdapter(target, options) + "\n</script>");
        return { html: out, warnings: warnings };
    }

    if (core && typeof core.registerBuild === "function") core.registerBuild("mindworks", retarget);

    return {
        isMindWorks: isMindWorks,
        retarget: retarget,
        buildAdapter: buildAdapter,
        applyStoreUrls: applyStoreUrls
    };
});
