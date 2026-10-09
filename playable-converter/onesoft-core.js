/*
 * onesoft-core.js — kiểu build "ONESOFT" cho playable-converter.
 * ---------------------------------------------------------------------------------------------
 * Pipeline: Cocos Creator 2.4.9 (web-mobile) + packer riêng + framework playable dùng chung cho cả
 * line sản phẩm của studio (enum PlayableAdsGame: G_1942, G_1945, Falcon, Galaxiga, FalconVip,
 * StickBattle, StickerBook — package tương ứng đều dạng com.os.* / invaders.os.*).
 * Đăng ký qua registerBuild("onesoft"). Cần converter-core.js.
 *
 * UMD, zero-dependency → chạy cả browser (app.js) lẫn Node (tests).
 * Global: window.OnesoftBuild   |   Node: require("./onesoft-core")
 *
 * HAI DẤU HIỆU NHẬN DIỆN (converter-core.isOnesoft):
 *   window.resMap = { "<path>": "<base64|json>" }   — packer: asset nằm thẳng trong một map, KHÔNG
 *     nén zip. Loader tự viết trong trang (loadBundle/loadJson/loadImg/loadDomAudio/loadWebAudio)
 *     đọc từ map đó thay cho cc.assetManager tải file rời.
 *   this.PlayableAdsType = this.<Mạng>              — framework playable.
 *
 * KHÔNG CẦN ADAPTER CTA. Khác mọi build khác trong tool: code game đã có sẵn nhánh cho TẤT CẢ các
 * mạng, chọn bằng đúng một biến:
 *
 *     openLinkApp():  Unity | Applovin → mraid.open(linkiOS / linkAndroid)
 *                     IronSource       → dapi.openStoreUrl()
 *                     Adwords          → window.open(linkiOS / linkAndroid)
 *                     Facebook, Moloco → FbPlayableAd.onCTAClick()
 *                     Adcolony         → mraid.openStore(…)
 *                     Mintegral        → window.install()
 *                     Vungle           → parent.postMessage("download", "*")
 *                     Maio             → Maio.openClickUrl(…)
 *                     Pangle           → window.openAppStore()
 *                     Yandex           → yandexHTML5BannerApi.getClickURLNum(1)
 *     onGameReady():  Mintegral → window.gameReady()
 *     onEndGame():    Mintegral → window.gameEnd()
 *
 * Nên việc chuyển đổi chỉ là GHI ĐÚNG GIÁ TRỊ enum — không chèn hàm CTA từ ngoài vào, không đụng
 * vào resMap (760–850 KB base64). Link store do converter-core.replaceConfigStoreLinks thay, vì
 * `this.linkAndroid`/`this.linkiOS` là ô dùng chung cho mọi build.
 *
 * ADAPTER CÒN LẠI CHỈ ĐỂ VÁ HAI CHỖ build thiếu so với yêu cầu của mạng:
 *   - Google: nhánh Adwords gọi window.open(), nhưng playable Google phải click qua ExitApi.exit()
 *     (và validate() của tool cũng đòi có chuỗi đó). Bọc window.open thay vì sửa nhánh đã minify.
 *   - Mintegral: SDK kiểm typeof gameStart/gameClose; build không khai báo hai hàm này.
 * Cùng với stub mraid/openAppStore CHỈ khi mạng chưa cấp, để mở file bằng tay vẫn bấm được CTA.
 */
(function (root, factory) {
    var isNode = typeof module === "object" && module.exports && typeof require === "function";
    var core = isNode ? require("./converter-core") : root.PlayableConverter;
    var api = factory(core);
    if (isNode) module.exports = api;
    root.OnesoftBuild = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (core) {
    "use strict";

    var TYPE_ASSIGN = /(\bthis\.PlayableAdsType\s*=\s*this\.)([A-Za-z_]\w*)/;

    // Mạng đích của tool → tên enum trong module Config. Chỉ 5 mạng tool xuất ra; các giá trị còn lại
    // (IronSource, Facebook, Vungle, Maio, Moloco, Yandex, Adcolony) chỉ dùng để ĐỌC mạng nguồn.
    var TARGET_ENUM = {
        applovin: "Applovin",
        unity: "Unity",
        google: "Adwords",
        mintegral: "Mintegral",
        pangle: "Pangle"
    };

    function isOnesoft(html) {
        return core.isOnesoft(html);
    }

    // Ghi enum mạng đích vào Config. Các biểu thức so sánh phía sau (PlayableAdsType !== this.Adwords …)
    // đọc lại chính giá trị này lúc chạy nên không cần sửa.
    // → { html, from } ; `from` rỗng nghĩa là không đổi được (lý do đã nằm trong warnings).
    function applyNetwork(html, target, warnings) {
        warnings = warnings || [];
        var name = TARGET_ENUM[target];
        if (!name) {
            warnings.push("Build ONESOFT không có nhánh cho mạng " + target + "; giữ nguyên PlayableAdsType.");
            return { html: html, from: "" };
        }
        if (!TYPE_ASSIGN.test(html)) {
            warnings.push("Không thấy this.PlayableAdsType trong module Config; không đổi được mạng.");
            return { html: html, from: "" };
        }
        var from = "";
        var out = html.replace(TYPE_ASSIGN, function (all, head, current) {
            from = current;
            return head + name;
        });
        return { html: out, from: from };
    }

    function buildAdapter(target, options) {
        options = options || {};
        var android = core.escapeJsString(options.androidUrl || "");
        var ios = core.escapeJsString(options.iosUrl || "");
        var lines = [
            // Link dự phòng cho các stub bên dưới. Để trống cả hai (người dùng không nhập link mới) thì
            // stub không mở gì — link thật nằm trong Config, chỉ code game đọc được.
            "function _pcOsUrl() {",
            "    var android = '" + android + "', ios = '" + ios + "';",
            "    var isIos = /iphone|ipad|ipod|macintosh/i.test((navigator.userAgent || \"\").toLowerCase());",
            "    return (isIos ? (ios || android) : (android || ios)) || \"\";",
            "}",
            "function _pcOsFallback() { var url = _pcOsUrl(); if (url) window.open(url, \"_blank\"); }"
        ];
        if (target === "google") {
            // Nhánh Adwords gọi window.open(link) — trong khung quảng cáo của Google việc đó không mở
            // được store, phải đi qua ExitApi. Giữ lại hàm gốc làm đường dự phòng khi mở file bằng tay.
            lines.push(
                "var _pcOsOpen = window.open;",
                "window.open = function (url, name, features) {",
                "    if (window.ExitApi && typeof window.ExitApi.exit === \"function\") { window.ExitApi.exit(); return null; }",
                "    return _pcOsOpen ? _pcOsOpen.call(window, url, name || \"_blank\", features) : null;",
                "};"
            );
        }
        if (target === "mintegral") {
            // SDK Mintegral kiểm typeof gameStart/gameClose trước khi cho playable chạy; build không
            // khai báo hai hàm này (chỉ có gameReady/gameEnd qua Config).
            lines.push(
                "if (typeof window.gameStart !== \"function\") window.gameStart = function () { };",
                "if (typeof window.gameClose !== \"function\") window.gameClose = function () { };",
                // window.install do mạng cấp; mở ngoài Mintegral thì không có → CTA chết.
                "if (typeof window.install !== \"function\") window.install = _pcOsFallback;"
            );
        }
        if (target === "pangle") {
            lines.push("if (typeof window.openAppStore !== \"function\") window.openAppStore = _pcOsFallback;");
        }
        if (target === "applovin" || target === "unity" || target === "mintegral") {
            // Nhánh Unity/Applovin gọi `mraid.open(...)` trần: không có mraid là ReferenceError, click
            // im lặng. Mạng thật định nghĩa mraid TRƯỚC nội dung (Unity qua thẻ mraid.js ở <head>,
            // AppLovin do SDK chèn), nên stub này chỉ sống khi mở file bằng tay.
            lines.push(
                "if (typeof window.mraid === \"undefined\") window.mraid = {",
                "    open: function (url) { if (url) window.open(url, \"_blank\"); else _pcOsFallback(); },",
                "    openStore: function (url) { if (url) window.open(url, \"_blank\"); else _pcOsFallback(); },",
                "    getState: function () { return \"default\"; },",
                "    addEventListener: function () { },",
                "    removeEventListener: function () { }",
                "};"
            );
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
        return html.replace(/\s*<script\b[^>]*data-playable-converter=["']onesoft["'][^>]*>[\s\S]*?<\/script>/gi, "");
    }

    // Script ngoài còn sót sau khi stripServingLayers chạy: với build này asset và code game đều nằm
    // trong trang, nên mọi <script src> còn lại đều là lớp phát hành — mà không đọc được nội dung thì
    // không gỡ chắc tay được (xem ghi chú SERVING_SRC). Báo để người dùng nhúng rồi convert lại.
    // mraid.js và exitapi.js là thẻ do chính tool chèn cho mạng đích — không tính là lớp phát hành.
    var EXPECTED_SRC = /(?:^|\/)mraid\.js(?:[?#]|$)|googlesyndication\.com\/pagead\/gadgets\/html5\/api\/exitapi\.js/i;

    function remainingExternalScripts(html) {
        var list = [];
        html.replace(/<script\b[^>]*\ssrc\s*=\s*["']([^"']+)["'][^>]*>/gi, function (all, src) {
            if (!EXPECTED_SRC.test(src)) list.push(src);
            return all;
        });
        return list;
    }

    function retarget(html, target, options) {
        var warnings = [], notes = [];
        var out = removeInjected(html);
        if (!/\bwindow\s*\.\s*resMap\s*=\s*\{/.test(out)) warnings.push("Không thấy window.resMap; asset có thể đã bị tách ra file rời.");
        var applied = applyNetwork(out, target, warnings);
        out = applied.html;
        if (applied.from && applied.from !== TARGET_ENUM[target]) notes.push("Đã đổi Config.PlayableAdsType: " + applied.from + " → " + TARGET_ENUM[target]);
        // Thẻ mraid.js: chỉ Unity cần (xem bảng kênh trong converter-core.setMraidTag).
        if (typeof core.setMraidTag === "function") out = core.setMraidTag(out, target === "unity");
        // Google bắt buộc có exitapi.js + meta ad.orientation; các mạng khác phải KHÔNG có.
        if (typeof core.configureGoogleExitApi === "function") out = core.configureGoogleExitApi(out, target);
        var external = remainingExternalScripts(out);
        if (external.length) warnings.push("Còn " + external.length + " script ngoài: " + external.join(" , ") + " — hãy nhúng tham chiếu từ xa rồi convert lại.");
        out = insertBeforeClosingBody(out, '<script data-playable-converter="onesoft">\n' + buildAdapter(target, options) + "\n</script>");
        return { html: out, warnings: warnings, notes: notes };
    }

    if (core && typeof core.registerBuild === "function") core.registerBuild("onesoft", retarget);

    return {
        isOnesoft: isOnesoft,
        retarget: retarget,
        buildAdapter: buildAdapter,
        applyNetwork: applyNetwork,
        TARGET_ENUM: TARGET_ENUM
    };
});
