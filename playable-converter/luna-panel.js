// luna-panel.js — phần UI cho asset nén Brotli của build Luna trong playable-converter.
// Logic thuần (quét payload, giải/nén Brotli, bundle.json, mesh) nằm ở luna-core.js; file này chỉ dựng DOM:
//   - tab "Asset nhúng": ảnh Luna được gắn tên thật từ bundle.json; sound (nén Brotli) mỗi file một dòng —
//     nghe thử, tải về, chọn file mới để thay;
//   - tab "Scripts": code game (Bridge.NET) và các bundle.json qua hook extraScripts/replaceExtra.
// Item nén mang source "luna-brotli". Tab Mesh 3D dùng thẳng LunaCore.meshBackend (xem mesh-panel.js).
// Cùng khuôn với bingo-panel.js: IIFE riêng, xuất window.LunaPanel; thiếu core thì bỏ qua.
(function () {
    "use strict";
    var L = window.LunaCore;
    if (!L) return;

    function fmt(n) {
        if (n < 1024) return n + " B";
        if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
        return (n / 1048576).toFixed(2) + " MB";
    }

    /* Danh sách cho tab Asset nhúng (list = kết quả extractEmbeddedData của converter): ảnh vẫn là item của
       converter (thay được bằng dòng sẵn có), chỉ gắn nhãn; asset nén Brotli nối thêm ở cuối. */
    function embeddedItems(html, list) {
        if (!L.isLuna(html)) return list;
        try {
            var labels = L.imageLabels(html);
            list.forEach(function (item) { if (labels[item.start]) item.label = labels[item.start]; });
        } catch (e) { }
        var extra = [];
        try {
            extra = L.assets(html).map(function (a, i) {
                return {
                    id: "luna-" + (i + 1), index: i + 1, line: 0,
                    encoding: a.base122 ? "base122" : "base64", source: "luna-brotli",
                    payload: "", preview: "", fullValue: "",
                    context: a.key, label: a.label, bytes: 0, mediaType: a.mediaType, kind: a.kind,
                    key: a.key, count: a.count
                };
            });
        } catch (e) { }
        return list.concat(extra);
    }

    function fileOf(item, html) {
        if (!item._data) item._data = L.readAsset(html, item.key);
        return item._data;
    }
    function blobUrlOf(item, html) {
        if (!item._url) item._url = URL.createObjectURL(new Blob([fileOf(item, html)], { type: item.mediaType }));
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
        badge.className = "encoding-badge brotli";
        badge.textContent = "BROTLI · " + item.encoding.toUpperCase();
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
            var data = fileOf(item, ctx.html());
            if (/^audio\//.test(item.mediaType)) {
                var audio = document.createElement("audio");
                audio.className = "embedded-audio";
                audio.controls = true;
                audio.preload = "metadata";
                audio.src = blobUrlOf(item, ctx.html());
                visual.appendChild(audio);
            } else if (/^image\//.test(item.mediaType)) {
                var img = document.createElement("img");
                img.className = "embedded-image";
                img.alt = item.context;
                img.src = blobUrlOf(item, ctx.html());
                visual.appendChild(img);
            }
            meta.textContent = "#" + item.index + " · " + fmt(data.length) + " · " + item.mediaType + (item.count > 1 ? " · nhúng " + item.count + " lần" : "");
        } catch (e) {
            var fail = document.createElement("span");
            fail.className = "image-fallback";
            fail.textContent = "Không giải nén được: " + e.message;
            visual.appendChild(fail);
        }
        row.appendChild(visual);

        var actions = document.createElement("div");
        actions.className = "embedded-actions";
        var picker = document.createElement("input");
        picker.type = "file";
        picker.hidden = true;
        picker.accept = /^audio\//.test(item.mediaType) ? "audio/*" : "*/*";
        picker.addEventListener("change", async function () {
            var f = picker.files && picker.files[0];
            if (!f) return;
            var shown = item.label || item.context;
            try {
                var bytes = new Uint8Array(await f.arrayBuffer());
                var html = L.writePayload(ctx.html(), item.key, bytes);
                ctx.onHtml(html);
                ctx.notice("Đã thay " + shown + " bằng " + f.name + " (" + fmt(bytes.length) + "). Convert và tải HTML đã sửa sẽ dùng bản mới.", false);
            } catch (e) {
                ctx.notice("Không thay được " + shown + ": " + e.message, true);
            }
        });
        actions.append(
            button("Tải file", function () {
                try { ctx.download(new Blob([fileOf(item, ctx.html())], { type: item.mediaType }), item.context.split("/").pop()); }
                catch (e) { ctx.notice("Không giải nén được: " + e.message, true); }
            }),
            button("Chọn file mới → thay", function () { picker.click(); }, "apply"),
            picker
        );
        row.appendChild(actions);
        return row;
    }

    function scripts(html) { try { return L.scripts(html); } catch (e) { return []; } }
    function replaceScript(html, script, newText) { return L.replaceText(html, script.key, newText); }

    window.LunaPanel = { embeddedItems: embeddedItems, buildRow: buildRow, scripts: scripts, replaceScript: replaceScript };
})();
