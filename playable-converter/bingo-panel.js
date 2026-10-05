// bingo-panel.js — phần UI cho gói ZIP (window.__zip) của build Bingo và Super HTML trong playable-converter.
// Logic thuần (giải mã __zip, đọc/ghép ZIP, đổi mạng) nằm ở bingo-core.js; file này chỉ dựng DOM:
//   - tab "Asset nhúng": mỗi file trong gói ZIP là một dòng — xem ảnh/âm thanh, tải về, chọn file mới để thay;
//   - tab "Scripts": cung cấp file .js/.json trong gói qua hook extraScripts/replaceExtra của script-panel.
// Item của gói mang source "bingo-zip" cho cả hai kiểu build.
// Cùng khuôn với mesh-panel.js / script-panel.js: IIFE riêng, xuất window.BingoPanel; thiếu core thì bỏ qua.
(function () {
    "use strict";
    var B = window.BingoBuilder, core = window.PlayableConverter;
    if (!B || !core) return;

    // Nén DEFLATE bằng API trình duyệt; thiếu API thì trả null → file được lưu thô (store) trong gói.
    function deflateRaw(bytes) {
        if (typeof CompressionStream !== "function") return Promise.resolve(null);
        try {
            var cs = new CompressionStream("deflate-raw");
            var done = new Response(cs.readable).arrayBuffer(); // tiêu thụ trước khi ghi, tránh deadlock
            var w = cs.writable.getWriter();
            w.write(bytes); w.close();
            return done.then(function (ab) { return new Uint8Array(ab); }, function () { return null; });
        } catch (e) { return Promise.resolve(null); }
    }
    var COMPRESSED = /\.(png|jpe?g|webp|gif|mp3|m4a|aac|ogg|oga|mp4|webm|woff2?)$/i;

    function fmt(n) {
        if (n < 1024) return n + " B";
        if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
        return (n / 1048576).toFixed(2) + " MB";
    }
    // Bingo luôn có gói; Super HTML bản mới có window.__zip (hoặc window.zip), bản cũ chỉ có window.__res.
    function buildOf(html) { try { return core.detectBuild(html); } catch (e) { return "unknown"; } }
    function packaged(html, build) {
        build = build || buildOf(html);
        return build === "bingo" || (build === "super-html" && /\bwindow\s*(?:\.\s*(?:__zip|zip)|\[\s*["'](?:__zip|zip)["']\s*\])\s*=/.test(html));
    }

    function items(html) { if (!packaged(html)) return []; try { return B.packageItems(html); } catch (e) { return []; } }
    function scripts(html) { if (!packaged(html)) return []; try { return B.packageScripts(html); } catch (e) { return []; } }

    /* Danh sách cho tab Asset nhúng (list = kết quả extractEmbeddedData của converter).
       Bingo: các file trong gói thay cho payload khổng lồ vô nghĩa; payload ZIP nguyên khối vẫn giữ ở cuối để
       tải / thay cả gói khi cần. Super HTML: giữ asset để thẳng trong window.__res (gắn tên dễ đọc từ
       config.json) rồi nối thêm các file trong gói — hai nơi cùng chứa asset của game. */
    function embeddedItems(html, list) {
        var build = buildOf(html);
        if (build === "bingo") {
            var packed = items(html);
            return packed.length ? packed.concat(list.filter(function (item) { return item.source === "super-html-zip"; })) : list;
        }
        if (build !== "super-html") return list;
        try {
            var labels = B.resAssetLabels(html);
            list.forEach(function (item) { if (labels[item.start]) item.label = labels[item.start]; });
        } catch (e) { }
        return packaged(html, build) ? list.concat(items(html)) : list;
    }
    function replaceScript(html, script, newText) {
        var data = core.utf8Bytes(newText);
        return deflateRaw(data).then(function (d) { return B.replacePackageEntry(html, script.name, data, d); });
    }

    // Byte thật của file (Super HTML bọc file trong gói thành chữ data URI). Item được dựng lại mỗi khi HTML
    // đổi nên cache theo item là đủ.
    function fileOf(item) {
        if (!item._file) item._file = B.entryFile(item.entry);
        return item._file;
    }
    function blobUrlOf(item) {
        if (!item._url) item._url = URL.createObjectURL(new Blob([fileOf(item).data], { type: item.mediaType }));
        return item._url;
    }
    function button(label, handler, cls) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "embedded-button" + (cls ? " " + cls : "");
        b.textContent = label;
        b.addEventListener("click", handler);
        return b;
    }

    /* Một dòng trong tab Asset nhúng. ctx: { html() → HTML hiện tại, onHtml(newHtml), notice(msg, isError),
       download(blob, filename) } do app.js cung cấp. */
    function buildRow(item, ctx) {
        var row = document.createElement("article");
        row.className = "embedded-item";

        var header = document.createElement("div");
        header.className = "embedded-item-header";
        var title = document.createElement("div");
        var badge = document.createElement("span");
        badge.className = "encoding-badge zip";
        badge.textContent = item.method === 8 ? "ZIP · DEFLATE" : "ZIP · STORE";
        var name = document.createElement("strong");
        name.textContent = item.label || item.context;
        name.title = item.context;
        title.append(badge, name);
        var meta = document.createElement("span");
        meta.className = "embedded-meta";
        header.append(title, meta);
        row.appendChild(header);

        var visual = document.createElement("div");
        visual.className = "embedded-visual";
        try {
            if (/^image\//.test(item.mediaType)) {
                var img = document.createElement("img");
                img.className = "embedded-image";
                img.alt = item.context;
                img.loading = "lazy";
                img.src = blobUrlOf(item);
                visual.appendChild(img);
            } else if (/^audio\//.test(item.mediaType)) {
                var audio = document.createElement("audio");
                audio.className = "embedded-audio";
                audio.controls = true;
                audio.preload = "metadata";
                audio.src = blobUrlOf(item);
                visual.appendChild(audio);
            } else if (/^(text\/|application\/json)/.test(item.mediaType) && item.bytes <= 200 * 1024) {
                var code = document.createElement("code");
                code.className = "payload-preview";
                var txt = new TextDecoder("utf-8").decode(B.inflateEntry(item.entry)).replace(/\s+/g, " ");
                code.textContent = txt.length > 160 ? txt.slice(0, 160) + "…" : txt;
                visual.appendChild(code);
            }
        } catch (e) {
            var fail = document.createElement("span");
            fail.className = "image-fallback";
            fail.textContent = "Không bung được file: " + e.message;
            visual.appendChild(fail);
        }
        row.appendChild(visual);
        // Ảnh/âm thanh đã bung ở trên: báo kích thước file thật (bản bọc data URI dài hơn khoảng 1/3).
        var wrapped = item._file && item._file.wrap;
        meta.textContent = "#" + item.index + " · " + fmt(item._file ? item._file.data.length : item.bytes)
            + (item.method === 8 ? " (nén còn " + fmt(item.packed) + ")" : "") + " · " + item.mediaType + (wrapped ? " · lưu dạng data URI" : "");

        var actions = document.createElement("div");
        actions.className = "embedded-actions";
        var picker = document.createElement("input");
        picker.type = "file";
        picker.hidden = true;
        picker.addEventListener("change", async function () {
            var f = picker.files && picker.files[0];
            if (!f) return;
            var shown = item.label || item.context;
            try {
                var data = new Uint8Array(await f.arrayBuffer());
                // File mới bọc lại đúng dạng entry cũ (Super HTML: chữ data URI — nén được, khác byte mp3/png gốc).
                var stored = B.packFile(item.entry, data);
                var deflated = stored === data && COMPRESSED.test(item.context) ? null : await deflateRaw(stored);
                var html = B.replacePackageEntry(ctx.html(), item.context, stored, deflated);
                ctx.onHtml(html);
                ctx.notice("Đã thay " + shown + " bằng " + f.name + " (" + fmt(data.length) + "). Convert và tải HTML đã sửa sẽ dùng gói mới.", false);
            } catch (e) {
                ctx.notice("Không thay được " + shown + ": " + e.message, true);
            }
        });
        actions.append(
            button("Tải file", function () {
                try { ctx.download(new Blob([fileOf(item).data], { type: item.mediaType }), (item.label || item.context).split("/").pop()); }
                catch (e) { ctx.notice("Không bung được file: " + e.message, true); }
            }),
            button("Chọn file mới → thay", function () { picker.click(); }, "apply"),
            picker
        );
        row.appendChild(actions);
        return row;
    }

    window.BingoPanel = { items: items, embeddedItems: embeddedItems, scripts: scripts, replaceScript: replaceScript, buildRow: buildRow, deflateRaw: deflateRaw };
})();
