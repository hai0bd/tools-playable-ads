/*
 * playsmart-core.js — kiểu build "PlaySmart / QICI" cho playable-converter (logic thuần, không DOM).
 * ---------------------------------------------------------------------------------------------
 * Creative của Zingfront chạy engine QICI + runtime PlaySmart (namespace `ps.*`), thường gặp ở
 * quảng cáo Mintegral. Đăng ký qua registerBuild("playsmart") nên convert()/convertAll() dùng như
 * mọi build khác. Cần converter-core.js: browser phải nạp trước, Node tự require.
 *
 * UMD, zero-dependency → chạy cả browser (app.js) lẫn Node (tests).
 * Global: window.PlaySmartBuild   |   Node: require("./playsmart-core")
 *
 * HAI THỨ PHẢI GỠ, và chúng KHÔNG nằm ở đâu đoán được từ tên file:
 *   1. Khối `var OMG = {...}` — tham số serve-time: imp_url (tracking), ins_url (link store),
 *      config (rid token, IP, model máy). Code game chỉ đọc nó một chỗ duy nhất và có guard đủ,
 *      nên xoá sạch là an toàn.
 *   2. SDK MOF của Mintegral — file duy nhất trong creative là code mạng. URL của nó là hash nên
 *      phải nhận qua NỘI DUNG (`var OMG=OMG||{}` + cacheCheck/MtgDispatch).
 *
 * KHÔNG gỡ listener `PLAYABLE:switchScene`: nhìn thì giống tooling xem trước, nhưng chính code
 * game vừa dispatch vừa lắng nghe event đó để đổi scene. Bỏ đi là đụng vào logic game.
 *
 * MỌI LUẬT NHẬN DIỆN ĐỀU NEO ĐẦU CHUỖI (`^`). Khớp lỏng ở giữa thân script là cực nguy hiểm:
 * file game logic 497 KB có nhắc tên event lẫn tên biến của SDK, khớp lỏng là xoá nhầm cả file.
 *
 * CẠM BẪY CHÍNH: SDK ở mục 2 không chỉ làm tracking, nó còn giữ chuỗi khởi động
 * initPage → showMyAd → waitForGameStart → gameStart(). Build phát hành đặt
 * MainConfig.autoGameStart = false và để UIRoot.visible = false lúc ready, nên gỡ SDK mà không mồi
 * lại gameStart() thì game nằm im ở màn đen. Xem buildBootstrap().
 */
(function (root, factory) {
    var isNode = typeof module === "object" && module.exports && typeof require === "function";
    var core = isNode ? require("./converter-core") : root.PlayableConverter;
    var api = factory(core);
    if (isNode) module.exports = api;
    root.PlaySmartBuild = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (core) {
    "use strict";

    var SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

    // Khối tham số serve-time (mục 1). Phân biệt với SDK bằng chỗ mở ngoặc: `= {` chứ không `= OMG ||`.
    var SERVE_CONFIG = /^\s*var\s+OMG\s*=\s*\{/;

    // SDK MOF (mục 2): mở đầu bằng `var OMG=OMG||{}` và luôn kèm ít nhất một trong các tên này.
    var MOF_OPEN = /^\s*var\s+OMG\s*=\s*OMG\s*\|\|\s*\{\s*\}\s*;/;
    var MOF_MARK = /\bcacheCheck\b|\bMtgDispatch\b|\bwaitForGameStart\b/;

    function escapeHtmlComment(text) {
        return String(text).replace(/--/g, "- -").replace(/</g, "&lt;");
    }

    function dropped(what) {
        return "<!-- playable-converter: gỡ " + escapeHtmlComment(what) + " -->";
    }

    // Quét từng thẻ <script> và bỏ hai loại trên. Làm theo NỘI DUNG chứ không theo thứ tự hay tên
    // file: trong creative thật, SDK không nằm đầu danh sách script, và file ngay cạnh nó lại là
    // file game (urlMapConfig) — xoá theo vị trí là giết nhầm.
    function stripAdLayer(html, warnings) {
        var removed = { config: 0, sdk: 0 };
        var out = html.replace(SCRIPT_TAG, function (all, attrs, body) {
            // Phải là thuộc tính src thật. `\bsrc` khớp cả data-src="…" (gạch nối là ranh giới từ)
            // nên thẻ đã nhúng bị tưởng là script ngoài rồi bỏ qua — SDK lọt lưới vì đúng lỗi này.
            if (/(?:^|\s)src\s*=/.test(attrs)) return all;
            if (MOF_OPEN.test(body) && MOF_MARK.test(body)) { removed.sdk++; return dropped("SDK MOF của Mintegral"); }
            if (SERVE_CONFIG.test(body)) { removed.config++; return dropped("tham số serve-time OMG"); }
            return all;
        });
        if (!removed.sdk) {
            // Bản tải từ SocialPeta còn trỏ CDN thì SDK vẫn là thẻ <script src> với URL dạng hash —
            // không có cách nào nhận ra từ URL. Phải chạy bước nhúng trước.
            warnings.push(/<script\b[^>]*\bsrc\s*=\s*["']https?:/i.test(html)
                ? "Chưa thấy SDK MOF dạng inline mà file vẫn còn <script src> ra ngoài: hãy nhúng tham chiếu từ xa trước rồi convert lại."
                : "Không tìm thấy SDK MOF của Mintegral trong file; có thể nó đã được gỡ từ trước.");
        }
        if (!removed.config) warnings.push("Không tìm thấy khối tham số serve-time OMG.");
        return out;
    }

    /*
     * Mồi nổ gameStart(). Game khai báo `function gameStart()` ở cấp cao nhất (tức window.gameStart)
     * nhưng KHÔNG tự gọi; trong luồng quảng cáo thì SDK gọi hộ.
     *
     * Mintegral gọi window.gameStart() khi quảng cáo thật sự hiện, nên ở đó phải nhường mạng trước
     * (GRACE) rồi mới tự mồi — mồi sớm là game chạy lúc người dùng chưa nhìn thấy.
     */
    function buildBootstrap(target) {
        var grace = target === "mintegral" ? 50 : 0;   // 50 nhịp × 100ms = 5 giây
        return [
            "(function () {",
            "    var GRACE = " + grace + ", ticks = 0, readyTicks = 0;",
            "    var timer = setInterval(function () {",
            "        if (++ticks > 900) { clearInterval(timer); console.warn(\"[playable-converter] hết giờ chờ ps.hasReady\"); return; }",
            "        if (!window.ps || !ps.hasReady) return;",
            (target === "mintegral" ? "        _pcPsNotifyReady();" : "        // (chỉ Mintegral mới cần phát lại gameReady)"),
            "        if (ps.hasStart) { clearInterval(timer); return; }",
            "        if (++readyTicks <= GRACE) return;",
            "        clearInterval(timer);",
            "        if (typeof window.gameStart === \"function\") window.gameStart();",
            "    }, 100);",
            "})();"
        ];
    }

    function buildAdapter(target, options) {
        options = options || {};
        var android = core.escapeJsString(options.androidUrl || "");
        var ios = core.escapeJsString(options.iosUrl || "");
        var lines = [
            "function _pcPsUrl() {",
            "    var android = '" + android + "', ios = '" + ios + "';",
            "    var preferred = /iphone|ipad|ipod|macintosh/i.test((navigator.userAgent || \"\").toLowerCase()) ? ios : android;",
            "    return preferred || android || ios || \"\";",
            "}",
            "function _pcPsCta() { " + core.targetClickCode(target, "_pcPsUrl()", "_pcPsCta") + "; }"
        ];
        if (target === "mintegral") {
            lines.push(
                // Mintegral tự cấp window.install lúc serve; chỉ đỡ khi nó vắng mặt.
                "if (typeof window.install !== \"function\") window.install = _pcPsCta;",
                "if (typeof window.gameClose !== \"function\") window.gameClose = function () { };",
                "var _pcPsReady = false, _pcPsEnded = false;",
                "function _pcPsNotifyReady() { if (_pcPsReady) return; _pcPsReady = true; window.gameReady && window.gameReady(); }",
                "function _pcPsNotifyEnd() { if (_pcPsEnded) return; _pcPsEnded = true; window.gameEnd && window.gameEnd(); }",
                // Game tự gọi window.gameEnd trong ps.gameEnd; bọc thêm để nếu SDK của mạng nạp muộn
                // hơn lần gọi đó thì vẫn còn một lần phát lại.
                "if (window.ps && typeof ps.gameEnd === \"function\") { var _pcPsEndOrig = ps.gameEnd; ps.gameEnd = function () { var r = _pcPsEndOrig.apply(this, arguments); _pcPsNotifyEnd(); return r; }; }"
            );
        } else {
            // Các mạng khác không cấp window.install: CTA của game (`window.install && window.install()`)
            // chỉ sống lại khi ta tự định nghĩa nó.
            lines.push("window.install = _pcPsCta;");
        }
        return lines.concat(buildBootstrap(target)).join("\n");
    }

    // Hàm thay thế chứ không phải chuỗi: $& $` $' $1 trong content bị String.replace hiểu là ký hiệu.
    function insertBeforeClosingBody(html, content) {
        return /<\/body>/i.test(html)
            ? html.replace(/<\/body>/i, function () { return content + "\n</body>"; })
            : html + "\n" + content;
    }

    function removeInjected(html) {
        return html.replace(/\s*<script\b[^>]*data-playable-converter=["']playsmart["'][^>]*>[\s\S]*?<\/script>/gi, "");
    }

    function retarget(html, target, options) {
        var warnings = [];
        var out = removeInjected(html);
        out = stripAdLayer(out, warnings);
        // Thẻ mraid.js: chỉ Unity cần (xem bảng kênh trong converter-core.setMraidTag).
        if (typeof core.setMraidTag === "function") out = core.setMraidTag(out, target === "unity");
        // Google bắt buộc có exitapi.js + meta ad.orientation; các mạng khác phải KHÔNG có.
        if (typeof core.configureGoogleExitApi === "function") out = core.configureGoogleExitApi(out, target);
        if (!/\bfunction\s+gameStart\s*\(/.test(out)) warnings.push("Không thấy khai báo gameStart() của PlaySmart; mồi nổ có thể không gọi được gì.");
        out = insertBeforeClosingBody(out, '<script data-playable-converter="playsmart">\n' + buildAdapter(target, options) + "\n</script>");
        return { html: out, warnings: warnings };
    }

    if (core && typeof core.registerBuild === "function") core.registerBuild("playsmart", retarget);

    return {
        retarget: retarget,
        stripAdLayer: stripAdLayer,
        buildAdapter: buildAdapter,
        buildBootstrap: buildBootstrap
    };
});
