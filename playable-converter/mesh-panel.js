// mesh-panel.js — UI thay mesh 3D + texture, nhúng trong playable-converter.
// IIFE riêng, xuất window.MeshPanel; dùng window.MeshReplacer (mesh-core.js) làm core.
// Cầu nối: MeshPanel.load(html) nạp từ state.html của converter; nút "Áp dụng vào
// playable" gọi opts.onApply(newHtml) để converter đưa vào pipeline convert/zip.
// Port từ playable-mesh-replacer/app.js — chỉ đổi entry (load thay file.text) và
// exit (onApply thay download). Preview 3D là rasterizer phần mềm trên canvas 2D.
(function () {
    "use strict";
    var core = window.MeshReplacer;
    if (!core) return; // mesh-core.js chưa nạp -> bỏ qua, converter vẫn chạy bình thường

    var opts = {};
    var state = {
        analysis: null,
        fileName: "",
        selected: -1,        // mesh index
        oldBounds: null,     // bbox mesh đang chọn {mn,mx}
        oldPos: null,        // mọi đỉnh mesh cũ (đầu vào auto-orient)
        newModel: null,      // geometry model mới (raw, đã bake node transform) {pos,nrm,uv,idx}
        newModelName: "",
        modelRot: [1, 0, 0, 0, 1, 0, 0, 0, 1], // ma trận xoay áp lên model mới (auto + tay)
        _autoAligned: false,
        selectedTexKey: null,
        newTexDataUri: null,
        anglesOld: { x: 0.5, y: 0.6 },
        anglesNew: { x: 0.5, y: 0.6 }
    };

    var el = {};
    function $(id) { return document.getElementById(id); }
    ["mesh-body", "mesh-empty", "mesh-filter", "mesh-grid", "replace-empty", "replace-body", "sel-title", "deselect",
        "viewer-old", "viewer-new", "info-old", "info-new", "model-drop", "model-input", "model-warning",
        "orient-controls", "auto-orient", "rot-x", "rot-y", "rot-z", "rot-reset", "orient-info",
        "fit-controls", "fit-size", "fit-stretch", "fit-info", "uv-match",
        "apply-button", "apply-note"
    ].forEach(function (id) { el[id] = $(id); });
    if (!el["mesh-body"]) return; // HTML mesh panel chưa nhúng -> bỏ qua

    // ───────────────────────── previewer 3D (rasterizer 2D-canvas) ─────────────────────────
    function rot(p, ax, ay) {
        var cy = Math.cos(ay), sy = Math.sin(ay);
        var x = p[0] * cy + p[2] * sy, z = -p[0] * sy + p[2] * cy;
        var cx = Math.cos(ax), sx = Math.sin(ax);
        var y = p[1] * cx - z * sx, z2 = p[1] * sx + z * cx;
        return [x, y, z2];
    }
    function meshTriangles(geometry) {
        var tris = [];
        for (var pi = 0; pi < geometry.prims.length; pi++) {
            var prim = geometry.prims[pi], b = geometry.bundles[prim.bundle];
            for (var i = 0; i + 2 < prim.idx.length; i += 3) {
                var a = b.pos[prim.idx[i]], c = b.pos[prim.idx[i + 1]], d = b.pos[prim.idx[i + 2]];
                if (a && c && d) tris.push([a, c, d]);
            }
        }
        return tris;
    }
    function modelTriangles(model) {
        var tris = [];
        for (var i = 0; i + 2 < model.idx.length; i += 3) {
            var a = model.pos[model.idx[i]], c = model.pos[model.idx[i + 1]], d = model.pos[model.idx[i + 2]];
            if (a && c && d) tris.push([a, c, d]);
        }
        return tris;
    }
    function trisBounds(tris) {
        var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        for (var i = 0; i < tris.length; i++) for (var j = 0; j < 3; j++) for (var k = 0; k < 3; k++) {
            var v = tris[i][j][k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v;
        }
        return { mn: mn, mx: mx };
    }
    // Ô UV mà mesh cũ đang dùng (để tùy chọn khớp UV model mới vào đó).
    function uvBoxOf(geometry) {
        var uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity, n = 0;
        geometry.bundles.forEach(function (b) {
            (b.uv || []).forEach(function (uv) { n++; if (uv[0] < uMin) uMin = uv[0]; if (uv[0] > uMax) uMax = uv[0]; if (uv[1] < vMin) vMin = uv[1]; if (uv[1] > vMax) vMax = uv[1]; });
        });
        return n ? { umin: uMin, umax: uMax, vmin: vMin, vmax: vMax } : null;
    }
    function drawMesh(canvas, tris, angles) {
        var ctx = canvas.getContext("2d");
        var W = canvas.width, H = canvas.height;
        ctx.clearRect(0, 0, W, H);
        if (!tris || !tris.length) return;
        var bb = trisBounds(tris);
        var cen = [(bb.mn[0] + bb.mx[0]) / 2, (bb.mn[1] + bb.mx[1]) / 2, (bb.mn[2] + bb.mx[2]) / 2];
        var size = Math.max(bb.mx[0] - bb.mn[0], bb.mx[1] - bb.mn[1], bb.mx[2] - bb.mn[2]) || 1;
        var S = (Math.min(W, H) * 0.42) / (size / 2);
        var light = [0.4, 0.5, 0.75]; var ll = Math.hypot(light[0], light[1], light[2]);
        light = [light[0] / ll, light[1] / ll, light[2] / ll];

        var faces = [];
        for (var i = 0; i < tris.length; i++) {
            var t = tris[i], p = [];
            for (var j = 0; j < 3; j++) {
                var q = rot([(t[j][0] - cen[0]), (t[j][1] - cen[1]), (t[j][2] - cen[2])], angles.x, angles.y);
                p.push(q);
            }
            var ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1], uz = p[1][2] - p[0][2];
            var vx = p[2][0] - p[0][0], vy = p[2][1] - p[0][1], vz = p[2][2] - p[0][2];
            var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            var nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
            var depth = (p[0][2] + p[1][2] + p[2][2]) / 3;
            faces.push({ p: p, n: [nx, ny, nz], depth: depth });
        }
        faces.sort(function (a, b) { return a.depth - b.depth; });
        var cx = W / 2, cy = H / 2;
        for (var f = 0; f < faces.length; f++) {
            var fc = faces[f];
            var shade = 0.28 + 0.72 * Math.max(0, Math.abs(fc.n[0] * light[0] + fc.n[1] * light[1] + fc.n[2] * light[2]));
            var r = Math.round(120 * shade + 40), g = Math.round(150 * shade + 40), bl = Math.round(190 * shade + 30);
            ctx.fillStyle = "rgb(" + r + "," + g + "," + bl + ")";
            ctx.strokeStyle = "rgba(0,0,0,0.12)";
            ctx.beginPath();
            ctx.moveTo(cx + fc.p[0][0] * S, cy - fc.p[0][1] * S);
            ctx.lineTo(cx + fc.p[1][0] * S, cy - fc.p[1][1] * S);
            ctx.lineTo(cx + fc.p[2][0] * S, cy - fc.p[2][1] * S);
            ctx.closePath();
            ctx.fill(); ctx.stroke();
        }
    }
    function attachDrag(canvas, angles, getTris) {
        var dragging = false, lx = 0, ly = 0;
        function down(e) { dragging = true; var pt = point(e); lx = pt.x; ly = pt.y; e.preventDefault(); }
        function move(e) {
            if (!dragging) return;
            var pt = point(e);
            angles.y += (pt.x - lx) * 0.01; angles.x += (pt.y - ly) * 0.01;
            angles.x = Math.max(-1.5, Math.min(1.5, angles.x));
            lx = pt.x; ly = pt.y;
            var tris = getTris(); if (tris) drawMesh(canvas, tris, angles);
        }
        function up() { dragging = false; }
        function point(e) { var r = canvas.getBoundingClientRect(); var t = e.touches ? e.touches[0] : e; return { x: t.clientX - r.left, y: t.clientY - r.top }; }
        canvas.addEventListener("mousedown", down); window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
        canvas.addEventListener("touchstart", down, { passive: false }); canvas.addEventListener("touchmove", move, { passive: false }); canvas.addEventListener("touchend", up);
    }

    // ───────────────────────── render mesh grid ─────────────────────────
    function renderMeshGrid() {
        var grid = el["mesh-grid"]; grid.innerHTML = "";
        var filter = (el["mesh-filter"].value || "").toLowerCase();
        state.analysis.meshes.forEach(function (mesh) {
            var label = "#" + mesh.index + " " + (mesh.binUuid || "");
            if (filter && label.toLowerCase().indexOf(filter) < 0) return;
            var cell = document.createElement("div");
            cell.className = "mesh-cell" + (mesh.index === state.selected ? " selected" : "") + (mesh._edited ? " edited" : "");
            cell.setAttribute("data-index", mesh.index);
            var canvas = document.createElement("canvas");
            canvas.width = 128; canvas.height = 128;
            cell.appendChild(canvas);
            var name = document.createElement("div"); name.className = "cell-name"; name.textContent = "#" + mesh.index;
            var meta = document.createElement("div"); meta.className = "cell-meta"; meta.textContent = mesh.verts + "v · " + mesh.tris + "t" + (mesh.submeshes > 1 ? " · " + mesh.submeshes + "sub" : "");
            cell.appendChild(name); cell.appendChild(meta);
            cell.addEventListener("click", function () { selectMesh(mesh.index); });
            grid.appendChild(cell);
            try { drawMesh(canvas, meshTriangles(mesh.geometry), { x: 0.5, y: 0.6 }); } catch (e) {}
        });
    }

    // ───────────────────────── select mesh ─────────────────────────
    function showReplaceEmpty() { el["replace-empty"].hidden = false; el["replace-body"].hidden = true; }
    function selectMesh(index) {
        state.selected = index; state.newModel = null; state.newModelName = "";
        state.selectedTexKey = null; state.newTexDataUri = null;
        var mesh = state.analysis.meshes[index];
        state.oldBounds = trisBounds(meshTriangles(mesh.geometry));
        state.oldPos = []; mesh.geometry.bundles.forEach(function (b) { b.pos.forEach(function (p) { state.oldPos.push(p); }); });
        state.oldUvBox = uvBoxOf(mesh.geometry);
        state.modelRot = [1, 0, 0, 0, 1, 0, 0, 0, 1]; state._autoAligned = false;
        el["replace-empty"].hidden = true; el["replace-body"].hidden = false;
        el["sel-title"].textContent = "Mesh #" + index;
        el["info-old"].textContent = mesh.verts + " đỉnh · " + mesh.tris + " tam giác" + (mesh.submeshes > 1 ? " · " + mesh.submeshes + " submesh/material" : "") + (mesh.binUuid ? " · " + mesh.binUuid.slice(0, 8) : "");
        el["info-new"].textContent = "chưa có";
        el["model-warning"].hidden = true; el["fit-controls"].hidden = true; el["fit-info"].textContent = "";
        el["orient-controls"].hidden = true; el["orient-info"].textContent = "";
        el["apply-note"].hidden = true;
        state.anglesOld.x = 0.5; state.anglesOld.y = 0.6; state.anglesNew.x = 0.5; state.anglesNew.y = 0.6;
        drawMesh(el["viewer-old"], meshTriangles(mesh.geometry), state.anglesOld);
        var ctx = el["viewer-new"].getContext("2d"); ctx.clearRect(0, 0, el["viewer-new"].width, el["viewer-new"].height);
        updateApplyState();
        Array.prototype.forEach.call(el["mesh-grid"].children, function (c) {
            c.classList.toggle("selected", +c.getAttribute("data-index") === index);
        });
    }

    // ───────────────────────── load model mới ─────────────────────────
    async function loadNewModel(file) {
        try {
            var buf = await file.arrayBuffer();
            var model = core.loadModel(buf, file.name);
            if (!model.pos.length) throw new Error("Model rỗng (0 đỉnh).");
            state.newModel = model; state.newModelName = file.name;
            el["orient-controls"].hidden = false; el["fit-controls"].hidden = false;
            state.anglesNew.x = 0.5; state.anglesNew.y = 0.6;
            computeAutoOrient();
            refreshNewPreview();
        } catch (err) {
            state.newModel = null; el["orient-controls"].hidden = true; el["fit-controls"].hidden = true;
            el["model-warning"].textContent = "Lỗi đọc model: " + err.message; el["model-warning"].hidden = false;
            el["info-new"].textContent = "lỗi";
            updateApplyState();
        }
    }
    function isIdent(m) { for (var i = 0; i < 9; i++) if (Math.abs(m[i] - [1, 0, 0, 0, 1, 0, 0, 0, 1][i]) > 1e-9) return false; return true; }
    function computeAutoOrient() {
        state.modelRot = [1, 0, 0, 0, 1, 0, 0, 0, 1]; state._autoAligned = false;
        if (el["auto-orient"].checked && state.newModel && state.oldPos) {
            var r = core.autoOrientRotation(state.newModel.pos, state.oldPos);
            if (r.aligned) { state.modelRot = r.mat; state._autoAligned = true; }
        }
    }
    function getEffectiveModel() {
        if (!state.newModel) return null;
        var m = isIdent(state.modelRot) ? state.newModel : core.rotateModel(state.newModel, state.modelRot);
        var eff = (!el["fit-size"].checked || !state.oldBounds) ? { model: m, scale: null } : core.fitModelToBounds(m, state.oldBounds.mn, state.oldBounds.mx, el["fit-stretch"].checked);
        if (el["uv-match"] && el["uv-match"].checked && state.oldUvBox) eff = { model: core.remapModelUV(eff.model, state.oldUvBox), scale: eff.scale };
        return eff;
    }
    function sizeStr(b) { return [b.mx[0] - b.mn[0], b.mx[1] - b.mn[1], b.mx[2] - b.mn[2]].map(function (v) { return v.toPrecision(3); }).join(" × "); }
    function maxExtentB(b) { return Math.max(b.mx[0] - b.mn[0], b.mx[1] - b.mn[1], b.mx[2] - b.mn[2]); }
    function refreshNewPreview() {
        var eff = getEffectiveModel();
        if (!eff) return;
        var m = eff.model;
        var nParts = (m.parts && m.parts.length) || 1;
        var subs = (state.selected >= 0 && state.analysis) ? state.analysis.meshes[state.selected].submeshes : 1;
        el["fit-stretch"].disabled = !el["fit-size"].checked;
        el["info-new"].textContent = m.pos.length + " đỉnh · " + (m.idx.length / 3) + " tam giác" + (nParts > 1 ? " · " + nParts + " part" : "");
        drawMesh(el["viewer-new"], modelTriangles(m), state.anglesNew);
        el["model-warning"].hidden = true;
        if (state.newModel.pos.length > 65535) {
            el["model-warning"].innerHTML = "⚠ " + state.newModel.pos.length + " đỉnh > 65535 (index 16-bit) — không thay được.";
            el["model-warning"].hidden = false;
        } else if (subs > 1 && nParts !== subs) {
            // Mesh cũ đa-material nhưng model mới không cùng số part → fallback dồn submesh 0.
            el["model-warning"].innerHTML = "⚠ Mesh cũ có " + subs + " submesh (" + subs + " material). Model mới có " + nParts +
                " part → sẽ dồn toàn bộ vào material đầu, " + (subs - 1) + " material còn lại để trống. Nên export model có " + subs + " material để khớp.";
            el["model-warning"].hidden = false;
        }
        if (el["fit-size"].checked && eff.scale) {
            var s = eff.scale, nb = trisBounds(modelTriangles(m));
            var uniform = Math.abs(s[0] - s[1]) < 1e-9 && Math.abs(s[1] - s[2]) < 1e-9;
            el["fit-info"].textContent = "Đã " + (uniform ? "scale ×" + s[0].toPrecision(3) : "scale [" + s.map(function (x) { return x.toPrecision(3); }).join(", ") + "]") + " → khớp kích thước mesh cũ (" + sizeStr(nb) + ").";
        } else if (state.oldBounds) {
            var ratio = maxExtentB(trisBounds(modelTriangles(state.newModel))) / (maxExtentB(state.oldBounds) || 1);
            el["fit-info"].textContent = (ratio > 3 || ratio < 0.34)
                ? "⚠ Model đang " + ratio.toPrecision(2) + "× so với mesh cũ (giữ nguyên kích thước gốc)."
                : "Giữ nguyên kích thước gốc của model.";
        }
        if (state._autoAligned) el["orient-info"].textContent = "✓ Đã tự xoay khớp hướng mesh cũ (trục mỏng).";
        else if (!isIdent(state.modelRot)) el["orient-info"].textContent = "Đã xoay tay.";
        else if (el["auto-orient"].checked) el["orient-info"].textContent = "Model không dẹt rõ → không tự xoay. Dùng nút xoay tay nếu cần.";
        else el["orient-info"].textContent = "";
        updateApplyState();
    }

    function formatBytes(n) { if (n < 1024) return n + " B"; if (n < 1048576) return (n / 1024).toFixed(1) + " KB"; return (n / 1048576).toFixed(2) + " MB"; }

    // ───────────────────────── apply → đẩy HTML về converter ─────────────────────────
    function updateApplyState() {
        var hasMeshChange = !!state.newModel && state.newModel.pos.length <= 65535;
        el["apply-button"].disabled = !hasMeshChange;
    }
    function applyEdit() {
        var analysis = state.analysis, changes = [];
        try {
            var eff = getEffectiveModel();
            if (eff && eff.model.pos.length <= 65535) {
                var mm = core.applyMeshReplacement(analysis, state.selected, eff.model);
                analysis.meshes[state.selected]._edited = true;
                changes.push("mesh #" + state.selected + (mm.submeshes > 1 ? " (" + mm.submeshes + " submesh" + (mm.replaceMode !== "1-1" ? ", fallback " + mm.replaceMode : "") + ")" : ""));
            }
            if (!changes.length) return;
            var out = core.serialize(analysis);
            el["apply-note"].className = "save-note";
            el["apply-note"].textContent = "Đã áp dụng " + changes.join(" + ") + " vào playable (" + (out.length / 1048576).toFixed(2) + " MB). Convert & đóng .zip sẽ dùng bản mới. Có thể thay tiếp mesh khác.";
            el["apply-note"].hidden = false;
            // preview old = mesh mới, reset model mới, render lại grid (cho phép thay tiếp)
            drawMesh(el["viewer-old"], meshTriangles(analysis.meshes[state.selected].geometry), state.anglesOld);
            state.oldBounds = trisBounds(meshTriangles(analysis.meshes[state.selected].geometry));
            state.newModel = null; el["info-new"].textContent = "chưa có";
            el["fit-controls"].hidden = true; el["fit-info"].textContent = "";
            el["orient-controls"].hidden = true; el["orient-info"].textContent = "";
            state.modelRot = [1, 0, 0, 0, 1, 0, 0, 0, 1]; state._autoAligned = false;
            var nctx = el["viewer-new"].getContext("2d"); nctx.clearRect(0, 0, el["viewer-new"].width, el["viewer-new"].height);
            updateApplyState();
            renderMeshGrid();
            // đẩy HTML đã sửa về app chủ (converter) -> vào state.html cho convert/zip
            if (opts.onApply) opts.onApply(out);
        } catch (err) {
            el["apply-note"].className = "save-note error";
            el["apply-note"].textContent = "Không áp dụng được: " + err.message;
            el["apply-note"].hidden = false;
        }
    }

    // ───────────────────────── wiring ─────────────────────────
    function wireDrop(zone, input, handler) {
        ["dragenter", "dragover"].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add("dragging"); }); });
        ["dragleave", "drop"].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove("dragging"); }); });
        zone.addEventListener("drop", function (e) { var f = e.dataTransfer.files[0]; if (f) handler(f); });
        input.addEventListener("change", function () { if (input.files[0]) handler(input.files[0]); });
    }
    wireDrop(el["model-drop"], el["model-input"], function (f) { if (state.selected >= 0) loadNewModel(f); });
    el["deselect"].addEventListener("click", function () { state.selected = -1; showReplaceEmpty(); renderMeshGrid(); });
    el["mesh-filter"].addEventListener("input", function () { if (state.analysis) renderMeshGrid(); });
    el["apply-button"].addEventListener("click", applyEdit);
    el["fit-size"].addEventListener("change", function () { if (state.newModel) refreshNewPreview(); });
    el["fit-stretch"].addEventListener("change", function () { if (state.newModel) refreshNewPreview(); });
    el["uv-match"].addEventListener("change", function () { if (state.newModel) refreshNewPreview(); });
    el["auto-orient"].addEventListener("change", function () { if (state.newModel) { computeAutoOrient(); refreshNewPreview(); } });
    function manualRot(axis) { state.modelRot = core.mat3mul(core.rot90mat(axis, 1), state.modelRot); state._autoAligned = false; refreshNewPreview(); }
    el["rot-x"].addEventListener("click", function () { if (state.newModel) manualRot(0); });
    el["rot-y"].addEventListener("click", function () { if (state.newModel) manualRot(1); });
    el["rot-z"].addEventListener("click", function () { if (state.newModel) manualRot(2); });
    el["rot-reset"].addEventListener("click", function () { if (state.newModel) { state.modelRot = [1, 0, 0, 0, 1, 0, 0, 0, 1]; state._autoAligned = false; el["auto-orient"].checked = false; refreshNewPreview(); } });
    attachDrag(el["viewer-old"], state.anglesOld, function () { return state.selected >= 0 && state.analysis ? meshTriangles(state.analysis.meshes[state.selected].geometry) : null; });
    attachDrag(el["viewer-new"], state.anglesNew, function () { var e = getEffectiveModel(); return e ? modelTriangles(e.model) : null; });

    // ───────────────────────── interface cho converter ─────────────────────────
    // Không có mesh (hoặc không phải playable Cocos) -> hiện note, ẩn nội dung.
    function showMeshEmpty() {
        state.analysis = null; state.selected = -1; state.newModel = null;
        state.selectedTexKey = null; state.newTexDataUri = null;
        if (el["mesh-body"]) el["mesh-body"].hidden = true;
        if (el["mesh-empty"]) el["mesh-empty"].hidden = false;
    }
    function load(html, name) {
        var analysis;
        try { analysis = core.analyzePlayable(html); }
        catch (err) { showMeshEmpty(); return false; }
        if (!analysis || !analysis.meshes || !analysis.meshes.length) { showMeshEmpty(); return false; }
        state.analysis = analysis; state.fileName = name || ""; state.selected = -1;
        state.newModel = null; state.selectedTexKey = null; state.newTexDataUri = null;
        el["mesh-empty"].hidden = true;
        el["mesh-body"].hidden = false;
        renderMeshGrid();
        showReplaceEmpty();
        el["apply-note"].hidden = true;
        return true;
    }
    function clear() { showMeshEmpty(); showReplaceEmpty(); }

    window.MeshPanel = {
        init: function (o) { opts = o || {}; },
        load: load,
        clear: clear
    };
})();
