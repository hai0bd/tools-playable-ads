(function () {
    "use strict";

    var core = window.PlayableConverter;
    var state = { mode: "saygames", file: null, originalHtml: "", html: "", analysis: null, embeddedData: [], kindFilter: "image", inlineReport: null, docs: [], active: -1, bundleName: "playables" };
    // Nhiều file: state.docs giữ từng file; các trường file/originalHtml/html/inlineReport/mode ở trên là
    // BẢN LÀM VIỆC của file đang chọn (docs[active]) — syncActive() chép ngược lại trước khi đổi file hay
    // convert. Tab Asset nhúng / Mesh 3D / Scripts luôn sửa file đang chọn; tab Xuất chạy cho mọi file.
    var KNOWN_BUILDS = ["saygames", "cocos-old", "luna", "super-html", "setup-config", "bingo", "threejs", "playsmart", "mindworks", "onesoft"];

    var elements = {
        steps: document.getElementById("steps"),
        stepButtons: Array.from(document.querySelectorAll(".step")),
        panels: Array.from(document.querySelectorAll(".step-panel")),
        buildSelect: document.getElementById("build-select"),
        fileInput: document.getElementById("file-input"),
        dropZone: document.getElementById("drop-zone"),
        clearFile: document.getElementById("clear-file"),
        fileTabs: document.getElementById("file-tabs"),
        fileTabList: document.getElementById("file-tab-list"),
        fileSummary: document.getElementById("file-summary"),
        fileName: document.getElementById("file-name"),
        fileMeta: document.getElementById("file-meta"),
        analysis: document.getElementById("analysis"),
        analysisBuild: document.getElementById("analysis-build"),
        analysisNetwork: document.getElementById("analysis-network"),
        analysisEnd: document.getElementById("analysis-end"),
        analysisMouse: document.getElementById("analysis-mouse"),
        modeWarning: document.getElementById("mode-warning"),
        remoteNotice: document.getElementById("remote-notice"),
        remoteTitle: document.getElementById("remote-title"),
        remoteDetail: document.getElementById("remote-detail"),
        inlineRemote: document.getElementById("inline-remote"),
        useInnerDoc: document.getElementById("use-inner-doc"),
        embeddedCard: document.getElementById("embedded-card"),
        embeddedSummary: document.getElementById("embedded-summary"),
        embeddedKinds: document.getElementById("embedded-kinds"),
        embeddedList: document.getElementById("embedded-list"),
        embeddedNotice: document.getElementById("embedded-notice"),
        resetEmbedded: document.getElementById("reset-embedded"),
        downloadEdited: document.getElementById("download-edited"),
        toggleTargets: document.getElementById("toggle-targets"),
        targetInputs: Array.from(document.querySelectorAll('input[name="target"]')),
        androidUrl: document.getElementById("android-url"),
        iosUrl: document.getElementById("ios-url"),
        convertButton: document.getElementById("convert-button"),
        emptyState: document.getElementById("empty-state"),
        resultList: document.getElementById("result-list"),
        saveAll: document.getElementById("save-all"),
        saveNote: document.getElementById("save-note"),
        projectName: document.getElementById("project-name")
    };

    elements.stepButtons.forEach(function (btn) {
        btn.addEventListener("click", function () { setStep(btn.dataset.step); });
    });
    if (elements.buildSelect) elements.buildSelect.addEventListener("change", function () { setMode(elements.buildSelect.value, true); });
    elements.fileInput.addEventListener("change", function () {
        if (elements.fileInput.files.length) loadFiles(elements.fileInput.files);
    });
    elements.clearFile.addEventListener("click", clearFile);
    elements.convertButton.addEventListener("click", runConversion);
    elements.toggleTargets.addEventListener("click", toggleTargets);
    elements.targetInputs.forEach(function (input) { input.addEventListener("change", updateControls); });
    elements.saveAll.addEventListener("click", downloadAllZip);
    // Ô "Tên (zip)" ở đầu: một file thì là tên zip của chính file đó; nhiều file thì là tên zip gộp chứa
    // zip của từng biến thể (tên từng biến thể đặt ở hàng đầu mỗi nhóm kết quả).
    elements.projectName.addEventListener("input", function () {
        if (state.docs.length === 1) { state.docs[0].name = elements.projectName.value; renderResults(); }
        else state.bundleName = elements.projectName.value;
    });
    elements.resetEmbedded.addEventListener("click", resetEmbeddedData);
    elements.downloadEdited.addEventListener("click", downloadEditedHtml);
    if (elements.inlineRemote) elements.inlineRemote.addEventListener("click", inlineRemoteRefs);
    if (elements.useInnerDoc) elements.useInnerDoc.addEventListener("click", useInnerDocument);

    // Cả trang nhận kéo thả HTML, kể cả khi đã có file (thả thêm biến thể mà không phải bấm "Thêm file").
    // Ô thả model của tab Mesh 3D (.mesh-drop) tự xử lý phần của nó nên bỏ qua ở đây.
    function isFileDrag(event) {
        var types = event.dataTransfer && event.dataTransfer.types;
        if (!types || Array.prototype.indexOf.call(types, "Files") < 0) return false;
        return !(event.target && event.target.closest && event.target.closest(".mesh-drop"));
    }
    function setDragging(on) {
        elements.dropZone.classList.toggle("dragging", on);
    }
    ["dragenter", "dragover"].forEach(function (eventName) {
        window.addEventListener(eventName, function (event) {
            if (!isFileDrag(event)) return setDragging(false);
            event.preventDefault();
            setDragging(true);
        });
    });
    // relatedTarget rỗng = con trỏ rời hẳn cửa sổ; dragleave giữa các phần tử con thì bỏ qua để khỏi nháy.
    window.addEventListener("dragleave", function (event) { if (!event.relatedTarget) setDragging(false); });
    window.addEventListener("drop", function (event) {
        setDragging(false);
        if (!isFileDrag(event)) return;
        event.preventDefault();
        if (event.dataTransfer.files.length) loadFiles(event.dataTransfer.files);
    });

    function setMode(mode, manual) {
        state.mode = mode;
        if (elements.buildSelect) elements.buildSelect.value = mode;
        if (manual) updateModeWarning();
        updateControls();
    }

    // Chuyển bước (tab ngang): hiện đúng 1 panel, ẩn còn lại.
    function setStep(step) {
        state.step = step;
        elements.stepButtons.forEach(function (btn) { btn.classList.toggle("active", btn.dataset.step === step); });
        elements.panels.forEach(function (panel) { panel.hidden = panel.dataset.step !== step; });
    }

    // Hiện/ẩn khu làm việc (thanh tab + panel) tùy đã nạp file hay chưa.
    function showWorkspace(on) {
        elements.steps.hidden = !on;
        if (!on) elements.panels.forEach(function (panel) { panel.hidden = true; });
    }

    // Nạp thêm file vào danh sách (chọn nhiều file, hoặc bấm "Thêm file" sau đó). File vừa thêm đầu tiên
    // thành file đang chọn.
    async function loadFiles(fileList) {
        var files = Array.from(fileList).filter(function (file) { return /\.html?$/i.test(file.name); });
        elements.fileInput.value = "";
        if (!files.length) {
            showModeWarning("Vui lòng chọn file HTML.");
            return;
        }
        var firstNew = state.docs.length;
        try {
            for (var i = 0; i < files.length; i++) {
                var html = await files[i].text();
                var build = core.analyze(html, files[i].name).build;
                state.docs.push({
                    file: files[i], name: uniqueDocName(baseName(files[i].name)),
                    originalHtml: html, html: html, inlineReport: null, results: [],
                    mode: KNOWN_BUILDS.indexOf(build) >= 0 ? build : state.mode
                });
            }
        } catch (error) {
            showModeWarning("Không đọc được file: " + error.message);
        }
        if (state.docs.length === firstNew) return;
        activate(firstNew);
        showWorkspace(true);
        setStep("output");
    }

    function uniqueDocName(base) {
        var clean = sanitizeName(base) || "playable", name = clean, n = 1;
        while (state.docs.some(function (doc) { return doc.name === name; })) name = clean + " (" + (++n) + ")";
        return name;
    }

    function cur() { return state.docs[state.active]; }

    function syncActive() {
        var doc = cur();
        if (!doc) return;
        doc.html = state.html;
        doc.originalHtml = state.originalHtml;
        doc.inlineReport = state.inlineReport;
        doc.mode = state.mode;
    }

    // Đổi file đang chọn. Thay đổi đã "Áp dụng" được giữ theo từng file; nội dung đang gõ dở trong
    // panel Mesh/Scripts mà chưa áp dụng thì mất, vì hai panel đó chỉ ôm một HTML.
    function activate(index, skipSync) {
        if (!skipSync) syncActive();
        state.active = index;
        var doc = cur();
        state.file = doc.file;
        state.inlineReport = doc.inlineReport;
        openHtml(doc.originalHtml, doc.html, doc.mode);
    }

    // Dùng chung cho lúc vừa nhúng xong tham chiếu từ xa và lúc đổi sang tài liệu trong iframe: HTML đổi
    // thì build, asset và script bên trong đều đổi theo nên phải phân tích lại từ đầu.
    function applyHtml(html) {
        cur().results = [];
        openHtml(html, html, null);
    }

    function openHtml(originalHtml, html, mode) {
        var name = state.file ? state.file.name : "";
        state.originalHtml = originalHtml;
        state.html = html;
        state.analysis = core.analyze(html, name);
        state.embeddedData = extractEmbedded(html);
        if (window.MeshPanel) MeshPanel.load(state.html, name);
        if (window.ScriptPanel) ScriptPanel.load(state.html, name);
        state.kindFilter = "image";
        elements.embeddedNotice.hidden = true;
        if (mode) setMode(mode, false);
        else if (KNOWN_BUILDS.indexOf(state.analysis.build) >= 0) setMode(state.analysis.build, false);
        renderFile();
        renderResults();
        updateModeWarning();
        updateRemoteNotice();
        updateControls();
    }

    /* ── Nhúng tham chiếu từ xa ──────────────────────────────────────────────
     * File tải từ SocialPeta thường chỉ là cái vỏ vài KB: game nằm sau <script src>
     * trên CDN, đôi khi sau cả <iframe>. Chưa nhúng thì detectBuild() không có gì để
     * đọc nên trả "unknown" với MỌI kiểu build, và tab Asset/Scripts cũng trống trơn.
     * Nhúng xong thì 7 kiểu build hiện có nhận ra ngay, không phải sửa gì trong chúng.
     */
    function updateRemoteNotice() {
        if (!elements.remoteNotice) return;
        if (!window.InlineCore || !state.html) { elements.remoteNotice.hidden = true; return; }
        var pending = InlineCore.countPending(state.html);
        if (!pending && !state.inlineReport) { elements.remoteNotice.hidden = true; return; }

        elements.remoteNotice.hidden = false;
        elements.inlineRemote.hidden = pending === 0;
        elements.inlineRemote.disabled = false;
        elements.inlineRemote.textContent = "Nhúng vào file";

        var inner = state.inlineReport && state.inlineReport.documents.length ? state.inlineReport.documents[0] : null;
        if (elements.useInnerDoc) {
            elements.useInnerDoc.hidden = !inner;
            if (inner) elements.useInnerDoc.textContent = "Dùng " + inner.label + " · " + formatBytes(inner.html.length);
        }

        if (pending) {
            elements.remoteTitle.textContent = "File còn " + pending + " tham chiếu từ xa";
            elements.remoteDetail.textContent = "Bản tải về từ SocialPeta thường chỉ là vỏ. Nhúng vào thì mới nhận ra kiểu build và đọc được asset bên trong.";
            return;
        }
        var report = state.inlineReport;
        elements.remoteTitle.textContent = "Đã nhúng " + report.stats.inlined + " tham chiếu · " + formatBytes(report.stats.bytes);
        elements.remoteDetail.textContent = describeInlineResult(report);
    }

    // Hai dạng creative mà game thật KHÔNG nằm ở tài liệu gốc:
    //   - MW_PLFRAME (Mintegral): game trong iframe; trong srcdoc code đã bị HTML-escape nên
    //     regex của convert() không khớp gì.
    //   - VIDEO_PLAYABLE_ENDCARD_V1 (AppLovin): game là URL trong JSON #ad-context.
    // Cả hai đều phải làm việc trên chính tài liệu con thì convert mới sửa được code.
    function useInnerDocument() {
        var inner = state.inlineReport && state.inlineReport.documents[0];
        if (!inner) return;
        state.inlineReport = null;
        applyHtml(inner.html);
        showModeWarning("Đã chuyển sang " + inner.label + " (" + inner.url + "). Lớp vỏ của mạng nguồn đã bị bỏ lại.");
    }

    function describeInlineResult(report) {
        var parts = [];
        if (report.stats.kept) parts.push(report.stats.kept + " thẻ SDK giữ nguyên cho bước convert");
        if (report.stats.failed) parts.push(report.stats.failed + " file tải lỗi (thẻ được giữ nguyên)");
        if (report.stats.skipped) parts.push(report.stats.skipped + " tham chiếu bỏ qua");
        if (report.remaining.length) parts.push(report.remaining.length + " ảnh/audio từ xa chưa xử lý");
        if (report.warnings.length) parts.push(report.warnings.length + " cảnh báo — xem Console");
        return parts.length ? parts.join(" · ") : "Không còn tham chiếu ra ngoài.";
    }

    /* credentials omit: chỉ đọc file tĩnh trên CDN, không gửi kèm cookie của người dùng.
     *
     * referrerPolicy no-referrer: CDN của Zingfront lọc theo DANH SÁCH TRẮNG REFERER. Đã đo trên
     * cùng một URL:
     *      không Referer                  → 200
     *      Referer: http://localhost:8000/ → 200   (localhost nằm trong danh sách trắng)
     *      Referer: https://…github.io/    → 403
     *      Origin:  https://…github.io     → 200   (Origin KHÔNG bị xét)
     * Nên chạy ở máy thì trót lọt, đưa tool lên GitHub Pages là 403 hàng loạt. Bỏ Referer đi là
     * hết, mà CORS vẫn qua vì CDN trả Access-Control-Allow-Origin: * bất kể Origin nào.
     */
    function fetchRemoteText(url) {
        return fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" }).then(function (response) {
            if (!response.ok) throw new Error("HTTP " + response.status);
            return response.text();
        }, function () {
            // fetch() chỉ reject khi lỗi mạng hoặc CORS. Host chặn CORS (play.rayjump.com là
            // một ví dụ thật) thì trình duyệt không cho ĐỌC nội dung — nhưng thẻ <script src>
            // thì không bị chặn, nên file vẫn chạy khi online, chỉ là chưa self-contained.
            throw new Error("CORS chặn hoặc mất mạng — giữ nguyên thẻ, file vẫn chạy khi online nhưng chưa self-contained");
        });
    }

    async function inlineRemoteRefs() {
        elements.inlineRemote.disabled = true;
        elements.inlineRemote.textContent = "Đang tải…";
        try {
            var report = await InlineCore.inline(state.html, {
                fetchText: fetchRemoteText,
                // Không hiện mẫu số: iframe lồng nhau sinh thêm tham chiếu nên tổng chỉ biết khi xong.
                onProgress: function (p) { elements.inlineRemote.textContent = "Đang tải " + p.done + " file…"; }
            });
            report.warnings.forEach(function (w) { console.warn("[inline] " + w); });
            report.errors.forEach(function (e) { console.error("[inline] " + e); });
            state.inlineReport = report;
            applyHtml(report.html);
        } catch (error) {
            state.inlineReport = null;
            updateRemoteNotice();
            showModeWarning("Nhúng thất bại: " + error.message);
        }
    }

    // Bỏ một file bất kỳ (nút × trên tab). File đang chọn thì đi đường clearFile để nạp file kế bên.
    function removeDoc(index) {
        if (index === state.active) return clearFile();
        state.docs.splice(index, 1);
        if (index < state.active) state.active--;
        renderFileTabs();
        renderResults();
        updateControls();
    }

    // Bỏ file đang chọn; còn file khác thì chuyển sang file kế bên, hết thì về màn hình thả file.
    function clearFile() {
        state.docs.splice(state.active, 1);
        if (state.docs.length) {
            activate(Math.min(state.active, state.docs.length - 1), true);
            return;
        }
        state.active = -1;
        state.file = null;
        state.inlineReport = null;
        if (elements.remoteNotice) elements.remoteNotice.hidden = true;
        state.originalHtml = "";
        state.html = "";
        state.analysis = null;
        state.embeddedData = [];
        if (window.MeshPanel) MeshPanel.clear();
        if (window.ScriptPanel) ScriptPanel.clear();
        elements.fileInput.value = "";
        elements.dropZone.hidden = false;
        elements.fileSummary.hidden = true;
        elements.analysis.hidden = true;
        elements.clearFile.hidden = true;
        elements.fileTabs.hidden = true;
        elements.modeWarning.hidden = true;
        elements.embeddedNotice.hidden = true;
        elements.embeddedCard.hidden = true;
        elements.embeddedList.innerHTML = "";
        showWorkspace(false);
        renderResults();
        updateControls();
    }

    function renderFile() {
        var info = state.analysis;
        elements.dropZone.hidden = true;
        elements.fileSummary.hidden = false;
        elements.analysis.hidden = false;
        elements.clearFile.hidden = false;
        elements.fileName.textContent = state.file.name;
        renderFileTabs();
        renderEmbeddedData();
        elements.fileMeta.textContent = formatBytes(info.bytes) + " · " + info.scripts + " scripts";
        elements.analysisBuild.textContent = buildLabel(info.build);
        elements.analysisNetwork.textContent = networkLabel(info.sourceNetwork);
        elements.analysisMouse.textContent = info.mouseSupport ? "Có" : "Cần kiểm tra";
        if (info.build === "saygames") {
            elements.analysisEnd.textContent = info.stageQueueLength ? "Stage queue · " + info.stageQueueLength : "UI end screen";
        } else if (info.build === "cocos-old") {
            elements.analysisEnd.textContent = info.gameManagers.length ? "EndGame · " + info.gameManagers.length + " module" : "Runtime component scan";
        } else if (info.build === "luna") {
            elements.analysisEnd.textContent = "luna:ended";
        } else if (info.build === "super-html") {
            var zipped = state.embeddedData.filter(function (item) { return item.source === "bingo-zip"; }).length;
            elements.analysisEnd.textContent = "game_end · " + (info.superHtmlVersion === "old" ? "bản cũ" : info.superHtmlVersion === "new" ? "bản mới" : "chưa rõ version") + (zipped ? " · " + zipped + " file trong gói" : "");
        } else if (info.build === "bingo") {
            var packed = state.embeddedData.filter(function (item) { return item.source === "bingo-zip"; }).length;
            elements.analysisEnd.textContent = "PlayableSDK.game_end · " + (packed ? packed + " file trong gói " + info.zipEncoding : "không đọc được gói");
        } else if (info.build === "threejs") {
            elements.analysisEnd.textContent = "api.playableFinished" + (info.avkProduct ? " · " + info.avkProduct : "");
        } else if (info.build === "playsmart") {
            elements.analysisEnd.textContent = "ps.gameEnd → window.gameEnd";
        } else if (info.build === "mindworks") {
            elements.analysisEnd.textContent = "gameEndHandle → window.gameEnd";
        } else if (info.build === "onesoft") {
            elements.analysisEnd.textContent = "Config.onEndGame → window.gameEnd" + (info.onesoftVersion ? " · bản " + info.onesoftVersion : "");
        } else {
            elements.analysisEnd.textContent = "Chưa nhận diện";
        }
    }

    function renderFileTabs() {
        if (document.activeElement !== elements.projectName) elements.projectName.value = state.docs.length === 1 ? state.docs[0].name : state.bundleName;
        elements.fileTabs.hidden = state.docs.length < 2;
        elements.fileTabList.innerHTML = "";
        if (state.docs.length < 2) return;
        state.docs.forEach(function (doc, index) {
            var edited = index === state.active ? state.html !== state.originalHtml : doc.html !== doc.originalHtml;
            var tab = document.createElement("div");
            tab.className = "file-tab" + (index === state.active ? " active" : "");
            var name = document.createElement("button");
            name.type = "button";
            name.className = "file-tab-name";
            name.textContent = doc.name + (edited ? " •" : "");
            name.title = doc.file.name + (edited ? " · đã sửa" : "");
            name.addEventListener("click", function () { if (index !== state.active) activate(index); });
            var close = document.createElement("button");
            close.type = "button";
            close.className = "file-tab-close";
            close.textContent = "×";
            close.title = "Xóa " + doc.file.name;
            close.setAttribute("aria-label", close.title);
            close.addEventListener("click", function () { removeDoc(index); });
            tab.append(name, close);
            elements.fileTabList.appendChild(tab);
        });
    }

    function updateModeWarning() {
        if (!state.analysis) return;
        if (state.analysis.build === "unknown") {
            showModeWarning("Không tự nhận diện được build. Hãy chọn đúng tab và kiểm tra kết quả kỹ.");
        } else if (state.analysis.build !== state.mode) {
            showModeWarning("File được nhận diện là " + buildLabel(state.analysis.build) + ", khác tab đang chọn.");
        } else {
            elements.modeWarning.hidden = true;
        }
    }

    function showModeWarning(message) {
        elements.modeWarning.textContent = message;
        elements.modeWarning.hidden = false;
    }

    var KIND_LABELS = {
        all: "Tất cả", image: "Ảnh", audio: "Âm thanh",
        font: "Font", model: "Model", data: "Dữ liệu", other: "Khác"
    };

    function renderKindTabs(data) {
        var bar = elements.embeddedKinds;
        if (!bar) return;
        bar.innerHTML = "";
        var counts = { all: data.length };
        data.forEach(function (item) {
            counts[item.kind] = (counts[item.kind] || 0) + 1;
        });
        // Chỉ hiện tab có asset, để file ít loại không bị rối vì tab rỗng. "Tất cả" đứng cuối: nó dựng
        // mọi dòng cùng lúc nên là tab nặng nhất, còn ảnh là thứ được thay nhiều nhất.
        var kinds = core.ASSET_KINDS.concat("all").filter(function (k) { return counts[k]; });
        if (kinds.indexOf(state.kindFilter) < 0) state.kindFilter = kinds[0];
        kinds.forEach(function (kind) {
                var btn = document.createElement("button");
                btn.type = "button";
                btn.className = "kind-tab" + (state.kindFilter === kind ? " active" : "");
                btn.textContent = KIND_LABELS[kind] + " (" + counts[kind] + ")";
                btn.addEventListener("click", function () {
                    state.kindFilter = kind;
                    renderEmbeddedData();
                });
                bar.appendChild(btn);
            });
    }

    function renderEmbeddedData() {
        // Ẩn kind "model" khỏi tab Asset nhúng — mesh đã thay ở tab Mesh 3D (tránh lặp).
        var visibleData = state.embeddedData.filter(function (item) { return item.kind !== "model"; });
        elements.embeddedList.innerHTML = "";
        var base64Count = visibleData.filter(function (item) { return item.encoding === "base64"; }).length;
        var base122Count = visibleData.filter(function (item) { return item.encoding === "base122"; }).length;
        elements.embeddedSummary.innerHTML = "";
        elements.embeddedSummary.appendChild(makeCountPill("Base64", base64Count));
        elements.embeddedSummary.appendChild(makeCountPill("Base122", base122Count));
        var zipCount = visibleData.filter(function (item) { return item.source === "bingo-zip"; }).length;
        if (zipCount) elements.embeddedSummary.appendChild(makeCountPill("File trong gói ZIP", zipCount));
        var brotliCount = visibleData.filter(function (item) { return item.source === "luna-brotli"; }).length;
        if (brotliCount) elements.embeddedSummary.appendChild(makeCountPill("Nén Brotli (Luna)", brotliCount));
        elements.resetEmbedded.disabled = state.html === state.originalHtml;
        if (elements.embeddedKinds) elements.embeddedKinds.hidden = !visibleData.length;

        if (!visibleData.length) {
            var empty = document.createElement("p");
            empty.className = "embedded-empty";
            empty.textContent = "Không tìm thấy payload Base64 hoặc Base122 có dấu hiệu rõ ràng trong file.";
            elements.embeddedList.appendChild(empty);
            return;
        }

        renderKindTabs(visibleData);
        var danhSach = state.kindFilter !== "all"
            ? visibleData.filter(function (item) { return item.kind === state.kindFilter; })
            : visibleData;

        if (!danhSach.length) {
            var trong = document.createElement("p");
            trong.className = "embedded-empty";
            trong.textContent = "Không có asset nào thuộc nhóm này.";
            elements.embeddedList.appendChild(trong);
            return;
        }

        danhSach.forEach(function (item) {
            // Build Bingo: từng file trong gói ZIP có UI riêng (xem / tải / thay) ở bingo-panel.js.
            if (item.source === "bingo-zip" && window.BingoPanel) {
                elements.embeddedList.appendChild(BingoPanel.buildRow(item, panelRowContext("bingo")));
                return;
            }
            // Build Luna: sound (và asset khác) nén Brotli — luna-panel.js giải nén để nghe / tải / thay.
            if (item.source === "luna-brotli" && window.LunaPanel) {
                elements.embeddedList.appendChild(LunaPanel.buildRow(item, panelRowContext("luna")));
                return;
            }
            var row = document.createElement("article");
            row.className = "embedded-item";

            var header = document.createElement("div");
            header.className = "embedded-item-header";
            var title = document.createElement("div");
            var badge = document.createElement("span");
            badge.className = "encoding-badge " + item.encoding;
            badge.textContent = item.encoding.toUpperCase();
            var context = document.createElement("strong");
            context.textContent = item.label || item.context;
            title.append(badge, context);
            var meta = document.createElement("span");
            meta.className = "embedded-meta";
            meta.textContent = "#" + item.index + " · dòng " + item.line + " · " + formatBytes(item.bytes);
            header.append(title, meta);

            var preview = document.createElement("code");
            preview.className = "payload-preview";
            var readablePayload = item.encoding === "base122" ? visibleString(item.payload) : item.payload;
            preview.textContent = item.encoding === "base122" ? previewText(readablePayload) : item.preview;
            preview.title = readablePayload;

            var view = buildEmbeddedView(item);
            var visual = document.createElement("div");
            visual.className = "embedded-visual";
            if (view.canPreview) {
                var image = document.createElement("img");
                image.className = "embedded-image";
                image.alt = "Preview " + item.context;
                image.loading = "lazy";
                image.src = view.fullValue;
                var imageFallback = document.createElement("span");
                imageFallback.className = "image-fallback";
                imageFallback.textContent = "Không hiển thị được ảnh — dùng URL đầy đủ bên dưới để mở trực tiếp.";
                imageFallback.hidden = true;
                image.addEventListener("error", function () {
                    image.hidden = true;
                    imageFallback.hidden = false;
                });
                visual.append(image, imageFallback);
            } else if (view.canPreviewAudio) {
                var audio = document.createElement("audio");
                audio.className = "embedded-audio";
                audio.controls = true;
                audio.preload = "metadata";
                audio.src = view.fullValue;
                var audioFallback = document.createElement("span");
                audioFallback.className = "image-fallback";
                audioFallback.textContent = "Không phát được audio — dùng URL đầy đủ bên dưới để tải/nghe.";
                audioFallback.hidden = true;
                audio.addEventListener("error", function () { audio.hidden = true; audioFallback.hidden = false; });
                visual.append(audio, audioFallback);
            }

            var fullLabel = document.createElement("label");
            fullLabel.className = "embedded-full-label";
            fullLabel.textContent = item.encoding === "base64" ? "URL đầy đủ" : "URL / chuỗi đầy đủ";
            var fullValue = document.createElement("textarea");
            fullValue.className = "embedded-full-value";
            fullValue.rows = 3;
            fullValue.readOnly = true;
            fullValue.spellcheck = false;
            fullValue.value = view.fullValue;
            fullValue.setAttribute("aria-label", fullLabel.textContent + " của " + item.id);
            fullLabel.appendChild(fullValue);

            var rawBase122Label = null;
            if (item.encoding === "base122") {
                rawBase122Label = document.createElement("label");
                rawBase122Label.className = "embedded-full-label embedded-raw-label";
                rawBase122Label.textContent = "Payload Base122 gốc đầy đủ (escaped để nhìn rõ)";
                var rawBase122Value = document.createElement("textarea");
                rawBase122Value.className = "embedded-full-value";
                rawBase122Value.rows = 3;
                rawBase122Value.readOnly = true;
                rawBase122Value.spellcheck = false;
                rawBase122Value.value = visibleString(item.payload);
                rawBase122Value.setAttribute("aria-label", "Payload Base122 gốc của " + item.id);
                rawBase122Label.appendChild(rawBase122Value);
            }

            var textarea = document.createElement("textarea");
            textarea.className = "replacement-input";
            textarea.rows = 3;
            textarea.spellcheck = false;
            textarea.placeholder = "Dán " + item.encoding.toUpperCase() + " mới (có thể dán cả data URI)…";
            textarea.setAttribute("aria-label", "Dữ liệu thay thế cho " + item.id);

            var actions = document.createElement("div");
            actions.className = "embedded-actions";
            var replacementFile = document.createElement("input");
            replacementFile.type = "file";
            replacementFile.accept = ".txt,.base64,.base122,text/plain";
            replacementFile.hidden = true;
            replacementFile.addEventListener("change", async function () {
                if (!replacementFile.files[0]) return;
                textarea.value = (await replacementFile.files[0].text()).replace(/^\uFEFF/, "").trim();
            });
            var actionButtons = [
                makeEmbeddedButton("Sao chép payload", function () { copyPayload(item.payload, "payload"); }),
                makeEmbeddedButton("Sao chép URL đầy đủ", function () { copyPayload(view.fullValue, "URL / chuỗi đầy đủ"); })
            ];
            if (item.encoding === "base64") {
                var binaryFile = document.createElement("input");
                binaryFile.type = "file";
                binaryFile.accept = view.mediaType === "application/zip" ? ".zip,application/zip" : "*/*";
                binaryFile.hidden = true;
                binaryFile.addEventListener("change", async function () {
                    if (!binaryFile.files[0]) return;
                    try {
                        textarea.value = await fileToBase64(binaryFile.files[0]);
                        showEmbeddedNotice("Đã mã hóa " + binaryFile.files[0].name + " thành Base64. Bấm Thay thế để áp dụng.", false);
                    } catch (error) {
                        showEmbeddedNotice("Không mã hóa được file: " + error.message, true);
                    }
                });
                actionButtons.push(makeEmbeddedButton(
                    view.mediaType === "application/zip" ? "Chọn ZIP mới → Base64" : "Chọn file → Base64",
                    function () { binaryFile.click(); }
                ));
                actionButtons.push(makeEmbeddedButton(
                    view.mediaType === "application/zip" ? "Tải ZIP giải mã" : "Tải file giải mã",
                    function () { downloadDecodedBase64(item, view.mediaType); }
                ));
                actionButtons.push(binaryFile);
            } else if (item.encoding === "base122") {
                var base122File = document.createElement("input");
                base122File.type = "file";
                base122File.accept = view.mediaType === "application/zip" ? ".zip,application/zip" : "*/*";
                base122File.hidden = true;
                base122File.addEventListener("change", async function () {
                    if (!base122File.files[0]) return;
                    try {
                        textarea.value = await fileToBase122(base122File.files[0], item);
                        showEmbeddedNotice("Đã mã hóa " + base122File.files[0].name + " thành Base122. Bấm Thay thế để áp dụng.", false);
                    } catch (error) {
                        showEmbeddedNotice("Không mã hóa được file: " + error.message, true);
                    }
                });
                actionButtons.push(makeEmbeddedButton(
                    view.mediaType === "application/zip" ? "Chọn ZIP mới → Base122" : "Chọn file → Base122",
                    function () { base122File.click(); }
                ));
                actionButtons.push(makeEmbeddedButton(
                    view.mediaType === "application/zip" ? "Tải ZIP giải mã" : "Tải file giải mã",
                    function () { downloadDecodedBase122(item, view.mediaType); }
                ));
                actionButtons.push(base122File);
            }
            actionButtons.push(
                makeEmbeddedButton("Đọc từ file text", function () { replacementFile.click(); }),
                makeEmbeddedButton("Thay thế", function () { applyEmbeddedReplacement(item.id, textarea.value); }, "apply"),
                replacementFile
            );
            actionButtons.forEach(function (button) { actions.appendChild(button); });
            row.append(header, preview, visual, fullLabel);
            if (rawBase122Label) row.appendChild(rawBase122Label);
            row.append(textarea, actions);
            elements.embeddedList.appendChild(row);
        });
    }

    function buildEmbeddedView(item) {
        var mediaType = item.mediaType || (item.encoding === "base64" ? inferBase64MediaType(item.payload) : "");
        var fullValue = item.fullValue || item.payload;
        if (item.encoding === "base64" && item.source !== "data-uri") {
            fullValue = "data:" + (mediaType || "application/octet-stream") + ";base64," + item.payload;
        } else if (item.encoding === "base122") {
            try {
                var decoded = core.decodeBase122Bytes(item.payload);
                mediaType = mediaType || inferBytesMediaType(decoded);
                fullValue = "data:" + (mediaType || "application/octet-stream") + ";base64," + core.encodeBase64Bytes(decoded);
            } catch (error) {
                fullValue = item.fullValue || item.payload;
            }
        }
        var enc = item.encoding === "base64" || item.encoding === "base122";
        return {
            fullValue: fullValue,
            mediaType: mediaType || "application/octet-stream",
            canPreview: enc && /^image\//i.test(mediaType),
            canPreviewAudio: enc && /^audio\//i.test(mediaType)
        };
    }

    function visibleString(value) {
        try {
            return JSON.stringify(String(value == null ? "" : value));
        } catch (error) {
            return String(value == null ? "" : value);
        }
    }

    function previewText(value) {
        value = String(value || "");
        if (value.length <= 72) return value;
        return value.slice(0, 48) + "..." + value.slice(-20);
    }

    function inferBase64MediaType(payload) {
        try {
            var normalized = String(payload || "").replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
            while (normalized.length % 4) normalized += "=";
            var binary = window.atob(normalized.slice(0, 280));
            var bytes = [];
            for (var i = 0; i < Math.min(binary.length, 16); i++) bytes.push(binary.charCodeAt(i));
            if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
            if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
            if (binary.slice(0, 4) === "GIF8") return "image/gif";
            if (binary.slice(0, 4) === "RIFF" && binary.slice(8, 12) === "WEBP") return "image/webp";
            if (binary.slice(0, 4) === "PK\x03\x04" || binary.slice(0, 4) === "PK\x05\x06") return "application/zip";
            if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return "image/x-icon";
            if (/^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(binary)) return "image/svg+xml";
            if (binary.slice(0, 3) === "ID3") return "audio/mpeg";
            if (binary.slice(0, 4) === "OggS") return "audio/ogg";
            if (binary.slice(0, 4) === "RIFF" && binary.slice(8, 12) === "WAVE") return "audio/wav";
            if (binary.slice(0, 4) === "fLaC") return "audio/flac";
            if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "audio/mpeg";
        } catch (error) { }
        return "";
    }

    function inferBytesMediaType(bytes) {
        bytes = bytes || [];
        var head = "";
        for (var i = 0; i < Math.min(bytes.length, 96); i++) head += String.fromCharCode(bytes[i]);
        if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
        if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
        if (head.slice(0, 4) === "GIF8") return "image/gif";
        if (head.slice(0, 4) === "RIFF" && head.slice(8, 12) === "WEBP") return "image/webp";
        if (head.slice(0, 4) === "PK\x03\x04" || head.slice(0, 4) === "PK\x05\x06") return "application/zip";
        if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return "image/x-icon";
        if (/^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(head)) return "image/svg+xml";
        if (head.slice(0, 3) === "ID3") return "audio/mpeg";
        if (head.slice(0, 4) === "OggS") return "audio/ogg";
        if (head.slice(0, 4) === "RIFF" && head.slice(8, 12) === "WAVE") return "audio/wav";
        if (head.slice(0, 4) === "fLaC") return "audio/flac";
        if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "audio/mpeg";
        return "";
    }

    function fileToBase64(file) {
        return file.arrayBuffer().then(function (buffer) { return core.encodeBase64Bytes(buffer); });
    }

    // item.base122Standard: ảnh Luna cần bảng base122 CHUẨN (6 ký tự né). Mã bằng bảng 7 phần tử
    // của repo thì bộ giải của Luna tra trượt và playable đứng ở màn loading — đã đo.
    function fileToBase122(file, item) {
        var options = item && item.base122Standard ? { standard: true } : undefined;
        return file.arrayBuffer().then(function (buffer) { return core.encodeBase122Bytes(buffer, options); });
    }

    function downloadDecodedBase64(item, mediaType) {
        try {
            var bytes = core.decodeBase64Bytes(item.payload);
            downloadBlob(new Blob([bytes], { type: mediaType || "application/octet-stream" }), decodedFilename(item, mediaType));
        } catch (error) {
            showEmbeddedNotice("Không giải mã được Base64: " + error.message, true);
        }
    }

    function downloadDecodedBase122(item, mediaType) {
        try {
            var bytes = core.decodeBase122Bytes(item.payload);
            downloadBlob(new Blob([bytes], { type: mediaType || "application/octet-stream" }), decodedFilename(item, mediaType));
        } catch (error) {
            showEmbeddedNotice("Không giải mã được Base122: " + error.message, true);
        }
    }

    function decodedFilename(item, mediaType) {
        if (mediaType === "application/zip") return "window.zip";
        var extensions = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "image/x-icon": "ico" };
        var contextName = String(item.label || item.context || "").replace(/\\/g, "/").split("/").pop();
        if (/^[^<>:"/\\|?*]+\.[A-Za-z0-9]{1,8}$/.test(contextName)) return contextName;
        return "embedded-" + item.id + "." + (extensions[mediaType] || "bin");
    }

    function makeCountPill(label, count) {
        var pill = document.createElement("span");
        pill.textContent = label + " · " + count;
        return pill;
    }

    function makeEmbeddedButton(label, handler, type) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "embedded-button" + (type ? " " + type : "");
        button.textContent = label;
        button.addEventListener("click", handler);
        return button;
    }

    function applyEmbeddedReplacement(id, replacement) {
        try {
            state.html = core.replaceEmbeddedData(state.html, id, replacement);
            state.analysis = core.analyze(state.html, state.file.name);
            state.embeddedData = extractEmbedded(state.html);
            cur().results = [];
            renderFile();
            renderResults();
            showEmbeddedNotice("Đã thay " + id + ". File convert tiếp theo sẽ dùng dữ liệu mới.", false);
            if (window.MeshPanel) MeshPanel.load(state.html, state.file.name);
        if (window.ScriptPanel) ScriptPanel.load(state.html, state.file.name);
        } catch (error) {
            showEmbeddedNotice(error.message, true);
        }
    }

    // Build Bingo / Super HTML: tab Asset nhúng liệt kê từng file trong gói ZIP (window.__zip) và gắn tên
    // dễ đọc lấy từ config.json của Cocos — cách gộp nằm ở BingoPanel.embeddedItems.
    // Build Luna: ảnh được gắn tên thật từ bundle.json, sound nén Brotli nối thêm — LunaPanel.embeddedItems.
    function extractEmbedded(html) {
        var items = core.extractEmbeddedData(html);
        if (window.BingoPanel) items = BingoPanel.embeddedItems(html, items);
        if (window.LunaPanel) items = LunaPanel.embeddedItems(html, items);
        return items;
    }

    function panelRowContext(source) {
        return {
            html: function () { return state.html; },
            onHtml: function (newHtml) { adoptEditedHtml(newHtml, source); },
            notice: showEmbeddedNotice,
            download: downloadBlob
        };
    }

    function resetEmbeddedData() {
        if (!state.file) return;
        state.html = state.originalHtml;
        state.analysis = core.analyze(state.html, state.file.name);
        state.embeddedData = extractEmbedded(state.html);
        cur().results = [];
        renderFile();
        renderResults();
        showEmbeddedNotice("Đã khôi phục toàn bộ payload từ file gốc.", false);
        if (window.MeshPanel) MeshPanel.load(state.html, state.file.name);
        if (window.ScriptPanel) ScriptPanel.load(state.html, state.file.name);
    }

    function showEmbeddedNotice(message, isError) {
        elements.embeddedNotice.textContent = message;
        elements.embeddedNotice.classList.toggle("error", !!isError);
        elements.embeddedNotice.hidden = false;
    }

    // Nhận HTML đã sửa từ một panel (mesh/scripts) → đưa vào state.html cho convert/zip.
    // Panel GỬI tự làm mới; panel CÒN LẠI phải nạp lại, nếu không nó vẫn ôm HTML cũ và
    // lần "Áp dụng" sau sẽ ghi đè, làm mất thay đổi của panel kia.
    function adoptEditedHtml(newHtml, source) {
        state.html = newHtml;
        state.analysis = core.analyze(newHtml, state.file ? state.file.name : "playable.html");
        state.embeddedData = extractEmbedded(newHtml);
        cur().results = [];
        var name = state.file ? state.file.name : "playable.html";
        if (source !== "mesh" && window.MeshPanel) MeshPanel.load(state.html, name);
        if (source !== "scripts" && window.ScriptPanel) ScriptPanel.load(state.html, name);
        renderFile();
        renderResults();
        showEmbeddedNotice(source === "scripts"
            ? "Đã áp dụng thay đổi script vào playable. Convert & đóng .zip sẽ dùng bản mới."
            : source === "bingo"
                ? "Đã ghi gói ZIP mới vào playable. Convert & đóng .zip sẽ dùng bản mới."
                : source === "luna"
                    ? "Đã nén lại asset Luna vào playable. Convert & đóng .zip sẽ dùng bản mới."
                    : "Đã áp dụng thay đổi mesh/texture vào playable. Convert & đóng .zip sẽ dùng bản mới.", false);
    }

    async function copyPayload(payload, label) {
        try {
            await navigator.clipboard.writeText(payload);
            showEmbeddedNotice("Đã sao chép " + (label || "dữ liệu") + " vào clipboard.", false);
        } catch (error) {
            try {
                fallbackCopy(payload);
                showEmbeddedNotice("Đã sao chép " + (label || "dữ liệu") + " vào clipboard.", false);
            } catch (fallbackError) {
                showEmbeddedNotice("Không sao chép tự động được. Hãy chọn nội dung trong ô URL và nhấn Ctrl+C.", true);
            }
        }
    }

    function fallbackCopy(value) {
        var field = document.createElement("textarea");
        field.value = value;
        field.setAttribute("readonly", "");
        field.style.position = "fixed";
        field.style.left = "-9999px";
        document.body.appendChild(field);
        field.select();
        var copied = document.execCommand("copy");
        field.remove();
        if (!copied) throw new Error("Copy command was rejected");
    }

    function downloadEditedHtml() {
        if (!state.file) return;
        var name = state.file.name.replace(/(\.html?)$/i, "-edited$1");
        downloadHtml(state.html, name);
    }

    function updateControls() {
        elements.targetInputs.forEach(function (input) {
            var builds = input.dataset.builds ? input.dataset.builds.split(",") : [];
            input.disabled = builds.length > 0 && builds.indexOf(state.mode) < 0;
        });
        var selected = getTargets();
        elements.convertButton.querySelector("span").textContent = state.docs.length > 1 ? "Convert " + state.docs.length + " playable" : "Convert playable";
        var available = elements.targetInputs.filter(function (input) { return !input.disabled; });
        elements.convertButton.disabled = !state.html || !selected.length;
        elements.toggleTargets.textContent = selected.length === available.length ? "Bỏ chọn tất cả" : "Chọn tất cả";
    }

    function toggleTargets() {
        var available = elements.targetInputs.filter(function (input) { return !input.disabled; });
        var allSelected = getTargets().length === available.length;
        available.forEach(function (input) { input.checked = !allSelected; });
        updateControls();
    }

    function getTargets() {
        return elements.targetInputs.filter(function (input) { return input.checked && !input.disabled; }).map(function (input) { return input.value; });
    }

    // Mạng đích bị giới hạn theo kiểu build (data-builds, ví dụ Pangle) thì bỏ qua cho file không hợp.
    function targetsFor(mode) {
        return elements.targetInputs.filter(function (input) {
            var builds = input.dataset.builds ? input.dataset.builds.split(",") : [];
            return input.checked && (!builds.length || builds.indexOf(mode) >= 0);
        }).map(function (input) { return input.value; });
    }

    // Convert MỌI file trong danh sách, mỗi file theo kiểu build của chính nó; mạng đích và Store URL dùng chung.
    function runConversion() {
        syncActive();
        elements.convertButton.disabled = true;
        elements.convertButton.querySelector("span").textContent = "Đang convert…";
        elements.saveNote.hidden = true;
        window.setTimeout(function () {
            var failed = [];
            state.docs.forEach(function (doc) {
                try {
                    doc.results = core.convertAll(doc.html, doc.mode, targetsFor(doc.mode), {
                        androidUrl: elements.androidUrl.value,
                        iosUrl: elements.iosUrl.value
                    });
                } catch (error) {
                    doc.results = [];
                    failed.push(doc.file.name + ": " + error.message);
                }
            });
            renderResults();
            if (failed.length) showModeWarning("Convert thất bại — " + failed.join(" · "));
            updateControls();
        }, 40);
    }

    function hasResults() { return state.docs.some(function (doc) { return doc.results.length; }); }

    function renderResults() {
        elements.resultList.innerHTML = "";
        elements.emptyState.hidden = hasResults();
        elements.saveAll.hidden = !hasResults();
        state.docs.forEach(function (doc) {
            if (!doc.results.length) return;
            if (state.docs.length > 1) elements.resultList.appendChild(buildResultGroup(doc));
            doc.results.forEach(function (result) { elements.resultList.appendChild(buildResultItem(doc, result)); });
        });
    }

    // Đầu mỗi biến thể: ô đặt tên (tên file zip, đồng thời là tiền tố của từng file bên trong) và nút tải
    // zip riêng của biến thể đó. Gõ tới đâu doc.name đổi tới đó; rời ô mới vẽ lại để không mất con trỏ.
    function buildResultGroup(doc) {
        var group = document.createElement("div");
        group.className = "result-group";
        var label = document.createElement("label");
        label.textContent = "Tên zip";
        label.title = "Nguồn: " + doc.file.name;
        var input = document.createElement("input");
        input.type = "text";
        input.value = doc.name;
        input.spellcheck = false;
        input.autocomplete = "off";
        input.addEventListener("input", function () { doc.name = input.value; });
        input.addEventListener("change", function () { renderResults(); renderFileTabs(); });
        label.appendChild(input);
        var button = document.createElement("button");
        button.type = "button";
        button.className = "secondary-button";
        button.textContent = "Tải .zip";
        button.addEventListener("click", function () { downloadDocZip(doc).then(function (name) { showSaved(name); }, showZipError); });
        group.append(label, button);
        return group;
    }

    function buildResultItem(doc, result) {
        var item = document.createElement("article");
        item.className = "result-item";

        var logo = document.createElement("div");
        logo.className = "result-logo";
        logo.textContent = result.label.slice(0, 1).toUpperCase();

        var copy = document.createElement("div");
        copy.className = "result-copy";
        var title = document.createElement("strong");
        title.textContent = result.label;
        var path = document.createElement("span");
        path.textContent = (state.docs.length > 1 ? bundleName() + ".zip / " : "") + docName(doc) + ".zip / " + artifactName(doc, result) + " · " + formatBytes(result.bytes);
        var flags = document.createElement("div");
        flags.className = "result-flags";
        // Hiện ĐỦ mọi lỗi và cảnh báo. Trước đây chỉ lấy cái đầu tiên, nên thẻ ghi "3 cảnh báo"
        // mà người dùng đọc được đúng một cái và không biết hai cái kia ở đâu.
        var errorFlag = makeFlag(result.errors.length ? result.errors.length + " lỗi" : "JS OK", result.errors.length ? "bad" : "good");
        if (result.errors.length) errorFlag.title = result.errors.join("\n");
        flags.appendChild(errorFlag);
        var warnFlag = makeFlag(result.warnings.length ? result.warnings.length + " cảnh báo" : "Adapter OK", result.warnings.length ? "warn" : "good");
        if (result.warnings.length) warnFlag.title = result.warnings.join("\n");
        flags.appendChild(warnFlag);
        result.errors.forEach(function (message) { flags.appendChild(makeFlag(message, "bad")); });
        result.warnings.forEach(function (message) { flags.appendChild(makeFlag(message, "warn")); });
        (result.notes || []).forEach(function (message) { flags.appendChild(makeFlag(message, "good")); });
        copy.append(title, path, flags);

        var button = document.createElement("button");
        button.className = "download-button";
        var isZip = ZIP_NETWORKS[result.target];
        button.textContent = isZip ? "Tải .zip" : "Tải HTML";
        button.addEventListener("click", function () { (isZip ? downloadResultZip : downloadResult)(result, artifactName(doc, result)); });
        item.append(logo, copy, button);
        return item;
    }

    function makeFlag(text, type) {
        var flag = document.createElement("span");
        flag.className = "flag " + type;
        flag.textContent = text;
        flag.title = text;
        return flag;
    }

    function downloadResult(result, filename) {
        downloadHtml(result.html, filename);
    }

    function downloadHtml(html, filename) {
        var blob = new Blob([html], { type: "text/html;charset=utf-8" });
        downloadBlob(blob, filename);
    }

    function downloadBlob(blob, filename) {
        var url = URL.createObjectURL(blob);
        var anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    // Mạng cần đóng .zip (portal yêu cầu upload zip có index.html ở gốc).
    var ZIP_NETWORKS = { google: true, mintegral: true };

    function sanitizeName(value) {
        return String(value || "").replace(/[\/\\:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim();
    }

    function baseName(name) {
        return String(name || "").replace(/\.html?$/i, "");
    }

    function docName(doc) {
        return sanitizeName(doc.name) || "playable";
    }

    function bundleName() {
        return sanitizeName(state.bundleName) || "playables";
    }

    // Mỗi biến thể một zip <tên>.zip, bên trong từng mạng là <tên>_<mạng>.
    function artifactName(doc, result) {
        return docName(doc) + "_" + result.target + (ZIP_NETWORKS[result.target] ? ".zip" : ".html");
    }

    // Nén DEFLATE thô bằng CompressionStream sẵn có của trình duyệt.
    // Trả null nếu không hỗ trợ -> assembleZip tự chuyển sang store (không nén).
    async function deflateRaw(bytes) {
        if (typeof CompressionStream !== "function") return null;
        try {
            var cs = new CompressionStream("deflate-raw");
            var done = new Response(cs.readable).arrayBuffer(); // bắt đầu tiêu thụ trước khi ghi (tránh deadlock)
            var writer = cs.writable.getWriter();
            writer.write(bytes);
            writer.close();
            return new Uint8Array(await done);
        } catch (error) {
            return null;
        }
    }

    // files = [{ name, bytes:Uint8Array, tryDeflate:bool }] -> Blob .zip
    async function buildZip(files) {
        var entries = [];
        for (var i = 0; i < files.length; i++) {
            var f = files[i];
            var deflated = f.tryDeflate ? await deflateRaw(f.bytes) : null;
            entries.push({ name: f.name, data: f.bytes, deflated: deflated });
        }
        return new Blob([core.assembleZip(entries, new Date())], { type: "application/zip" });
    }

    // Zip chứa đúng 1 file index.html cho Google/Mintegral (upload thẳng lên portal). Trả Uint8Array.
    async function buildNetworkZip(result) {
        var htmlBytes = core.utf8Bytes(result.html);
        var deflated = await deflateRaw(htmlBytes);
        return core.assembleZip([{ name: "index.html", data: htmlBytes, deflated: deflated }], new Date());
    }

    function downloadResultZip(result, filename) {
        buildNetworkZip(result).then(function (bytes) {
            downloadBlob(new Blob([bytes], { type: "application/zip" }), filename);
        }, function (error) {
            showModeWarning("Không tạo được zip: " + error.message);
        });
    }

    // Zip của MỘT biến thể: mraid-network -> <tên>_<mạng>.html, Google/Mintegral -> <tên>_<mạng>.zip lồng
    // (store, vì đã nén rồi).
    async function buildDocZip(doc) {
        var files = [];
        for (var i = 0; i < doc.results.length; i++) {
            var result = doc.results[i];
            if (ZIP_NETWORKS[result.target]) {
                files.push({ name: artifactName(doc, result), bytes: await buildNetworkZip(result), tryDeflate: false });
            } else {
                files.push({ name: artifactName(doc, result), bytes: core.utf8Bytes(result.html), tryDeflate: true });
            }
        }
        return buildZip(files);
    }

    async function downloadDocZip(doc) {
        downloadBlob(await buildDocZip(doc), docName(doc) + ".zip");
        return docName(doc) + ".zip";
    }

    // Một file: tải thẳng zip của file đó. Nhiều file: một zip gộp chứa <tên biến thể>.zip của từng biến
    // thể (store, vì bên trong đã nén).
    async function downloadAllZip() {
        var docs = state.docs.filter(function (doc) { return doc.results.length; });
        if (!docs.length) return;
        try {
            if (state.docs.length === 1) return showSaved(await downloadDocZip(docs[0]));
            var files = [];
            for (var d = 0; d < docs.length; d++) {
                files.push({ name: docName(docs[d]) + ".zip", bytes: new Uint8Array(await (await buildDocZip(docs[d])).arrayBuffer()), tryDeflate: false });
            }
            downloadBlob(await buildZip(files), bundleName() + ".zip");
            showSaved(bundleName() + ".zip", docs.length + " biến thể");
        } catch (error) {
            showZipError(error);
        }
    }

    function showSaved(name, detail) {
        elements.saveNote.textContent = "Đã tải " + name + (detail ? " (" + detail + ")" : "") + ".";
        elements.saveNote.hidden = false;
    }

    function showZipError(error) {
        elements.saveNote.textContent = "Không tạo được zip: " + error.message;
        elements.saveNote.hidden = false;
    }

    function buildLabel(build) {
        return ({ "saygames": "SayGames", "cocos-old": "Cocos build cũ", "luna": "Luna", "super-html": "Super HTML", "setup-config": "setupConfig", "bingo": "Bingo", "threejs": "Three.js (AVK)", "playsmart": "PlaySmart / QICI", "mindworks": "MindWorks / Mintegral", "onesoft": "ONESOFT", "unknown": "Không xác định" })[build] || build;
    }

    function networkLabel(network) {
        return ({ applovin: "AppLovin", mintegral: "Mintegral", unity: "Unity", google: "Google", pangle: "Pangle", ironsource: "ironSource", facebook: "Facebook", vungle: "Vungle / Liftoff", moloco: "Moloco", chartboost: "Chartboost", unknown: "Không xác định" })[network] || network;
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
        return (bytes / 1024 / 1024).toFixed(2) + " MB";
    }

    setMode("saygames", false);
    updateControls();
    if (window.MeshPanel) MeshPanel.init({ onApply: function (h) { adoptEditedHtml(h, "mesh"); } });
    // Script ngoài window.__res / thẻ <script>: file trong gói ZIP (Bingo) và payload nén Brotli (Luna).
    if (window.ScriptPanel) ScriptPanel.init({
        onApply: function (h) { adoptEditedHtml(h, "scripts"); },
        extraScripts: function (html) {
            var list = [];
            if (window.BingoPanel) list = list.concat(BingoPanel.scripts(html));
            if (window.LunaPanel) list = list.concat(LunaPanel.scripts(html));
            return list;
        },
        replaceExtra: function (html, script, text) {
            if (script.source === "luna" && window.LunaPanel) return LunaPanel.replaceScript(html, script, text);
            if (window.BingoPanel) return BingoPanel.replaceScript(html, script, text);
            throw new Error("Không có module ghi lại cho script " + script.name);
        }
    });
})();
