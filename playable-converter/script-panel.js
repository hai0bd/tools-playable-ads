// script-panel.js — UI xem & chỉnh sửa file .js bên trong playable, nhúng trong playable-converter.
// IIFE riêng, xuất window.ScriptPanel; dùng window.ScriptCore (script-core.js) làm core.
// Cầu nối: ScriptPanel.load(html) nạp từ state.html của converter; nút "Áp dụng vào
// playable" gọi opts.onApply(newHtml) để converter đưa vào pipeline convert/zip.
// Cùng khuôn với mesh-panel.js.
(function () {
    "use strict";
    var core = window.ScriptCore;
    if (!core) return; // script-core.js chưa nạp -> converter vẫn chạy bình thường

    var opts = {};
    var state = {
        html: "",
        fileName: "",
        list: [],
        sel: -1,        // index trong state.list
        filter: "",
        bigWarned: false
    };

    var el = {};
    function $(id) { return document.getElementById(id); }
    ["script-body", "script-empty", "script-filter", "script-list",
        "editor-empty", "editor-body", "sc-title", "sc-kind", "sc-meta",
        "sc-format", "sc-revert", "sc-editor", "sc-warning", "sc-apply", "sc-note"
    ].forEach(function (id) { el[id] = $(id); });
    if (!el["script-body"]) return; // HTML panel chưa nhúng -> bỏ qua

    var KIND_LABEL = { game: "code game", config: "config", data: "json", boot: "boot", settings: "settings", inline: "inline", internal: "internal", engine: "engine", other: "khác" };
    var MAX_FMT = 800 * 1024;   // trên ngưỡng này không định dạng lại (quá chậm)
    var BIG = 400 * 1024;       // trên ngưỡng này cảnh báo editor chậm

    function fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(2) + " MB" : (n / 1024).toFixed(1) + " KB"; }

    // ───────────────────────── trạng thái rỗng ─────────────────────────
    function showEmpty(msg) {
        el["script-empty"].hidden = false;
        el["script-body"].hidden = true;
        var p = el["script-empty"].querySelector("p");
        if (p && msg) p.textContent = msg;
    }
    function showEditorEmpty() {
        el["editor-empty"].hidden = false;
        el["editor-body"].hidden = true;
    }

    // ───────────────────────── nạp / quét lại ─────────────────────────
    function load(html, fileName) {
        state.html = html || "";
        state.fileName = fileName || "";
        state.sel = -1;
        state.bigWarned = false;
        if (el["sc-note"]) el["sc-note"].hidden = true;
        rescan();
    }
    function rescan() {
        try { state.list = core.listScripts(state.html); }
        catch (e) { state.list = []; }
        if (!state.list.length) { showEmpty("Playable này không có file .js nào để sửa."); return; }
        el["script-empty"].hidden = true;
        el["script-body"].hidden = false;
        renderList();
        if (state.sel >= state.list.length) state.sel = -1;
        if (state.sel < 0) showEditorEmpty(); else openScript(state.sel, true);
    }
    function clear() { state.html = ""; state.list = []; state.sel = -1; showEmpty("Chưa nạp file playable."); showEditorEmpty(); }

    // ───────────────────────── danh sách ─────────────────────────
    function renderList() {
        var q = state.filter.trim().toLowerCase();
        el["script-list"].innerHTML = "";
        state.list.forEach(function (s, i) {
            if (q && s.name.toLowerCase().indexOf(q) < 0 && s.kind.indexOf(q) < 0) return;
            var row = document.createElement("button");
            row.type = "button";
            row.className = "script-row" + (i === state.sel ? " active" : "");
            var nm = document.createElement("span"); nm.className = "script-name"; nm.textContent = s.name;
            var kd = document.createElement("span"); kd.className = "script-kind " + s.kind; kd.textContent = KIND_LABEL[s.kind] || s.kind;
            var sz = document.createElement("span"); sz.className = "script-size"; sz.textContent = fmtSize(s.size);
            row.appendChild(nm); row.appendChild(kd); row.appendChild(sz);
            row.addEventListener("click", function () { openScript(i); });
            el["script-list"].appendChild(row);
        });
        if (!el["script-list"].children.length) {
            var none = document.createElement("p");
            none.className = "script-none";
            none.textContent = "Không có script khớp bộ lọc.";
            el["script-list"].appendChild(none);
        }
    }

    // ───────────────────────── mở 1 script ─────────────────────────
    function openScript(i, keepNote) {
        state.sel = i;
        var s = state.list[i];
        el["editor-empty"].hidden = true;
        el["editor-body"].hidden = false;
        el["sc-title"].textContent = s.name;
        el["sc-kind"].textContent = KIND_LABEL[s.kind] || s.kind;
        el["sc-kind"].className = "script-kind " + s.kind;
        el["sc-meta"].textContent = fmtSize(s.size) + " · " + (s.source === "res" ? "trong window.__res" : "thẻ <script> inline");
        el["sc-editor"].value = s.text;
        el["sc-format"].disabled = s.size > MAX_FMT;
        el["sc-warning"].hidden = true;
        if (!keepNote) el["sc-note"].hidden = true;
        if (s.size > BIG) {
            el["sc-warning"].textContent = "File lớn (" + fmtSize(s.size) + ") — thao tác trong ô soạn thảo có thể chậm. Nên sửa đoạn nhỏ hoặc dùng editor ngoài.";
            el["sc-warning"].hidden = false;
        }
        updateApplyState();
        renderList();
    }

    function currentScript() { return state.sel >= 0 ? state.list[state.sel] : null; }
    function isDirty() { var s = currentScript(); return !!s && el["sc-editor"].value !== s.text; }
    function updateApplyState() {
        el["sc-apply"].disabled = !isDirty();
        el["sc-revert"].hidden = !isDirty();
    }

    // ───────────────────────── hành động ─────────────────────────
    el["sc-editor"].addEventListener("input", updateApplyState);

    el["sc-revert"].addEventListener("click", function () {
        var s = currentScript(); if (!s) return;
        el["sc-editor"].value = s.text;
        updateApplyState();
    });

    el["sc-format"].addEventListener("click", function () {
        var s = currentScript(); if (!s) return;
        var text = el["sc-editor"].value, out;
        if (text.length > MAX_FMT) { el["sc-warning"].textContent = "File quá lớn để định dạng lại."; el["sc-warning"].hidden = false; return; }
        if (core.isJSON && core.isJSON(s.name)) {
            // JSON (config/metadata) → format bằng JSON chuẩn, KHÔNG dùng beautify JS.
            try { out = JSON.stringify(JSON.parse(text), null, 2); }
            catch (e) { el["sc-warning"].textContent = "JSON không hợp lệ, không định dạng được: " + e.message; el["sc-warning"].hidden = false; return; }
        } else {
            out = core.beautifyJS(text, MAX_FMT);
            if (out == null) { el["sc-warning"].textContent = "File quá lớn để định dạng lại."; el["sc-warning"].hidden = false; return; }
        }
        el["sc-warning"].hidden = true;
        el["sc-editor"].value = out;
        updateApplyState();
    });

    el["sc-apply"].addEventListener("click", function () {
        var s = currentScript(); if (!s) return;
        try {
            var out = core.replaceScript(state.html, s.id, el["sc-editor"].value);
            state.html = out;
            var before = s.size, after = el["sc-editor"].value.length;
            el["sc-note"].className = "save-note";
            el["sc-note"].textContent = "Đã áp dụng vào " + s.name + " (" + fmtSize(before) + " → " + fmtSize(after) + "). Convert & đóng .zip sẽ dùng bản mới.";
            el["sc-note"].hidden = false;
            rescan();                       // offset đã đổi → quét lại
            if (opts.onApply) opts.onApply(out);
        } catch (err) {
            el["sc-note"].className = "save-note error";
            el["sc-note"].textContent = "Không áp dụng được: " + err.message;
            el["sc-note"].hidden = false;
        }
    });

    if (el["script-filter"]) el["script-filter"].addEventListener("input", function (e) {
        state.filter = e.target.value || "";
        renderList();
    });

    window.ScriptPanel = {
        init: function (o) { opts = o || {}; },
        load: load,
        clear: clear
    };
})();
