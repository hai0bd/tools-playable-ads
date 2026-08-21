(function () {
    "use strict";

    var core = window.PlayableConverter;
    var state = { mode: "saygames", file: null, originalHtml: "", html: "", analysis: null, embeddedData: [], embeddedExpanded: false, kindFilter: "all", results: [] };

    var elements = {
        steps: document.getElementById("steps"),
        stepButtons: Array.from(document.querySelectorAll(".step")),
        panels: Array.from(document.querySelectorAll(".step-panel")),
        buildSelect: document.getElementById("build-select"),
        fileInput: document.getElementById("file-input"),
        dropZone: document.getElementById("drop-zone"),
        clearFile: document.getElementById("clear-file"),
        fileSummary: document.getElementById("file-summary"),
        fileName: document.getElementById("file-name"),
        fileMeta: document.getElementById("file-meta"),
        analysis: document.getElementById("analysis"),
        analysisBuild: document.getElementById("analysis-build"),
        analysisNetwork: document.getElementById("analysis-network"),
        analysisEnd: document.getElementById("analysis-end"),
        analysisMouse: document.getElementById("analysis-mouse"),
        modeWarning: document.getElementById("mode-warning"),
        embeddedCard: document.getElementById("embedded-card"),
        embeddedSummary: document.getElementById("embedded-summary"),
        embeddedKinds: document.getElementById("embedded-kinds"),
        embeddedList: document.getElementById("embedded-list"),
        embeddedNotice: document.getElementById("embedded-notice"),
        toggleEmbedded: document.getElementById("toggle-embedded"),
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
        if (elements.fileInput.files[0]) loadFile(elements.fileInput.files[0]);
    });
    elements.clearFile.addEventListener("click", clearFile);
    elements.convertButton.addEventListener("click", runConversion);
    elements.toggleTargets.addEventListener("click", toggleTargets);
    elements.targetInputs.forEach(function (input) { input.addEventListener("change", updateControls); });
    elements.saveAll.addEventListener("click", downloadAllZip);
    elements.toggleEmbedded.addEventListener("click", toggleEmbeddedData);
    elements.resetEmbedded.addEventListener("click", resetEmbeddedData);
    elements.downloadEdited.addEventListener("click", downloadEditedHtml);

    ["dragenter", "dragover"].forEach(function (eventName) {
        elements.dropZone.addEventListener(eventName, function (event) {
            event.preventDefault();
            elements.dropZone.classList.add("dragging");
        });
    });
    ["dragleave", "drop"].forEach(function (eventName) {
        elements.dropZone.addEventListener(eventName, function (event) {
            event.preventDefault();
            elements.dropZone.classList.remove("dragging");
        });
    });
    elements.dropZone.addEventListener("drop", function (event) {
        var file = event.dataTransfer.files[0];
        if (file) loadFile(file);
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

    async function loadFile(file) {
        if (!/\.html?$/i.test(file.name)) {
            showModeWarning("Vui lòng chọn file HTML.");
            return;
        }
        try {
            var html = await file.text();
            state.file = file;
            if (elements.projectName) elements.projectName.value = baseName(file.name);
            state.originalHtml = html;
            state.html = html;
            state.analysis = core.analyze(html, file.name);
            state.embeddedData = core.extractEmbeddedData(html);
            if (window.MeshPanel) MeshPanel.load(state.html, file.name);
            if (window.ScriptPanel) ScriptPanel.load(state.html, file.name);
            state.embeddedExpanded = false;
            state.kindFilter = "all";
            elements.embeddedNotice.hidden = true;
            state.results = [];
            if (["saygames", "cocos-old", "luna", "super-html", "setup-config"].indexOf(state.analysis.build) >= 0) setMode(state.analysis.build, false);
            renderFile();
            renderResults();
            updateModeWarning();
            updateControls();
            showWorkspace(true);
            setStep("output");
        } catch (error) {
            showModeWarning("Không đọc được file: " + error.message);
        }
    }

    function clearFile() {
        state.file = null;
        state.originalHtml = "";
        state.html = "";
        state.analysis = null;
        state.embeddedData = [];
        state.embeddedExpanded = false;
        state.results = [];
        if (window.MeshPanel) MeshPanel.clear();
        if (window.ScriptPanel) ScriptPanel.clear();
        elements.fileInput.value = "";
        elements.dropZone.hidden = false;
        elements.fileSummary.hidden = true;
        elements.analysis.hidden = true;
        elements.clearFile.hidden = true;
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
            elements.analysisEnd.textContent = "game_end · " + (info.superHtmlVersion === "old" ? "bản cũ" : info.superHtmlVersion === "new" ? "bản mới" : "chưa rõ version");
        } else {
            elements.analysisEnd.textContent = "Chưa nhận diện";
        }
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
        // Chỉ hiện tab có asset, để file ít loại không bị rối vì tab rỗng.
        ["all"].concat(core.ASSET_KINDS).filter(function (k) { return counts[k]; })
            .forEach(function (kind) {
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
        if (state.kindFilter === "model") state.kindFilter = "all";
        var visibleData = state.embeddedData.filter(function (item) { return item.kind !== "model"; });
        elements.embeddedList.innerHTML = "";
        var base64Count = visibleData.filter(function (item) { return item.encoding === "base64"; }).length;
        var base122Count = visibleData.filter(function (item) { return item.encoding === "base122"; }).length;
        elements.embeddedSummary.innerHTML = "";
        elements.embeddedSummary.appendChild(makeCountPill("Base64", base64Count));
        elements.embeddedSummary.appendChild(makeCountPill("Base122", base122Count));
        elements.resetEmbedded.disabled = state.html === state.originalHtml;
        var collapsed = !state.embeddedExpanded;
        elements.embeddedCard.classList.toggle("is-collapsed", collapsed);
        elements.toggleEmbedded.textContent = collapsed ? "Mở chi tiết" : "Thu gọn";
        elements.toggleEmbedded.disabled = !visibleData.length;
        elements.toggleEmbedded.setAttribute("aria-expanded", String(!collapsed));
        if (elements.embeddedKinds) elements.embeddedKinds.hidden = collapsed || !visibleData.length;
        if (collapsed) return;

        if (!visibleData.length) {
            var empty = document.createElement("p");
            empty.className = "embedded-empty";
            empty.textContent = "Không tìm thấy payload Base64 hoặc Base122 có dấu hiệu rõ ràng trong file.";
            elements.embeddedList.appendChild(empty);
            return;
        }

        renderKindTabs(visibleData);
        var danhSach = state.kindFilter && state.kindFilter !== "all"
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
            var row = document.createElement("article");
            row.className = "embedded-item";

            var header = document.createElement("div");
            header.className = "embedded-item-header";
            var title = document.createElement("div");
            var badge = document.createElement("span");
            badge.className = "encoding-badge " + item.encoding;
            badge.textContent = item.encoding.toUpperCase();
            var context = document.createElement("strong");
            context.textContent = item.context;
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
                        textarea.value = await fileToBase122(base122File.files[0]);
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

    function fileToBase122(file) {
        return file.arrayBuffer().then(function (buffer) { return core.encodeBase122Bytes(buffer); });
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
        var contextName = String(item.context || "").replace(/\\/g, "/").split("/").pop();
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
            state.embeddedData = core.extractEmbeddedData(state.html);
            state.results = [];
            renderFile();
            renderResults();
            showEmbeddedNotice("Đã thay " + id + ". File convert tiếp theo sẽ dùng dữ liệu mới.", false);
            if (window.MeshPanel) MeshPanel.load(state.html, state.file.name);
        if (window.ScriptPanel) ScriptPanel.load(state.html, state.file.name);
        } catch (error) {
            showEmbeddedNotice(error.message, true);
        }
    }

    function toggleEmbeddedData() {
        state.embeddedExpanded = !state.embeddedExpanded;
        renderEmbeddedData();
    }

    function resetEmbeddedData() {
        if (!state.file) return;
        state.html = state.originalHtml;
        state.analysis = core.analyze(state.html, state.file.name);
        state.embeddedData = core.extractEmbeddedData(state.html);
        state.results = [];
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
        state.embeddedData = core.extractEmbeddedData(newHtml);
        state.results = [];
        var name = state.file ? state.file.name : "playable.html";
        if (source !== "mesh" && window.MeshPanel) MeshPanel.load(state.html, name);
        if (source !== "scripts" && window.ScriptPanel) ScriptPanel.load(state.html, name);
        renderFile();
        renderResults();
        showEmbeddedNotice(source === "scripts"
            ? "Đã áp dụng thay đổi script vào playable. Convert & đóng .zip sẽ dùng bản mới."
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

    function runConversion() {
        var originalText = elements.convertButton.querySelector("span").textContent;
        elements.convertButton.disabled = true;
        elements.convertButton.querySelector("span").textContent = "Đang convert…";
        elements.saveNote.hidden = true;
        window.setTimeout(function () {
            try {
                state.results = core.convertAll(state.html, state.mode, getTargets(), {
                    androidUrl: elements.androidUrl.value,
                    iosUrl: elements.iosUrl.value
                });
                renderResults();
            } catch (error) {
                state.results = [];
                renderResults();
                showModeWarning("Convert thất bại: " + error.message);
            } finally {
                elements.convertButton.querySelector("span").textContent = originalText;
                updateControls();
            }
        }, 40);
    }

    function renderResults() {
        elements.resultList.innerHTML = "";
        elements.emptyState.hidden = state.results.length > 0;
        elements.saveAll.hidden = state.results.length === 0;
        state.results.forEach(function (result) {
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
            path.textContent = projectName() + "/" + artifactName(result) + " · " + formatBytes(result.bytes);
            var flags = document.createElement("div");
            flags.className = "result-flags";
            flags.appendChild(makeFlag(result.errors.length ? result.errors.length + " lỗi" : "JS OK", result.errors.length ? "bad" : "good"));
            flags.appendChild(makeFlag(result.warnings.length ? result.warnings.length + " cảnh báo" : "Adapter OK", result.warnings.length ? "warn" : "good"));
            result.errors.slice(0, 1).forEach(function (message) { flags.appendChild(makeFlag(message, "bad")); });
            result.warnings.slice(0, 1).forEach(function (message) { flags.appendChild(makeFlag(message, "warn")); });
            copy.append(title, path, flags);

            var button = document.createElement("button");
            button.className = "download-button";
            var isZip = ZIP_NETWORKS[result.target];
            button.textContent = isZip ? "Tải .zip" : "Tải HTML";
            button.addEventListener("click", function () { (isZip ? downloadResultZip : downloadResult)(result); });
            item.append(logo, copy, button);
            elements.resultList.appendChild(item);
        });
    }

    function makeFlag(text, type) {
        var flag = document.createElement("span");
        flag.className = "flag " + type;
        flag.textContent = text;
        flag.title = text;
        return flag;
    }

    function downloadResult(result) {
        downloadHtml(result.html, result.target + ".html");
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

    function projectName() {
        var typed = elements.projectName ? sanitizeName(elements.projectName.value) : "";
        if (typed) return typed;
        if (state.file) return sanitizeName(baseName(state.file.name)) || "playable";
        return "playable";
    }

    function artifactName(result) {
        return result.target + (ZIP_NETWORKS[result.target] ? ".zip" : ".html");
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

    function downloadResultZip(result) {
        buildNetworkZip(result).then(function (bytes) {
            downloadBlob(new Blob([bytes], { type: "application/zip" }), result.target + ".zip");
        }, function (error) {
            showModeWarning("Không tạo được zip: " + error.message);
        });
    }

    // Gộp mọi mạng đã convert thành 1 file <tên>.zip: mraid-network -> <target>.html,
    // Google/Mintegral -> <target>.zip lồng (store, vì đã nén rồi). Chạy trên mọi trình duyệt.
    async function downloadAllZip() {
        if (!state.results.length) return;
        try {
            var files = [];
            for (var i = 0; i < state.results.length; i++) {
                var result = state.results[i];
                if (ZIP_NETWORKS[result.target]) {
                    files.push({ name: result.target + ".zip", bytes: await buildNetworkZip(result), tryDeflate: false });
                } else {
                    files.push({ name: result.target + ".html", bytes: core.utf8Bytes(result.html), tryDeflate: true });
                }
            }
            downloadBlob(await buildZip(files), projectName() + ".zip");
            elements.saveNote.textContent = "Đã tải " + projectName() + ".zip (" + files.length + " mạng).";
            elements.saveNote.hidden = false;
        } catch (error) {
            elements.saveNote.textContent = "Không tạo được zip: " + error.message;
            elements.saveNote.hidden = false;
        }
    }

    function buildLabel(build) {
        return ({ "saygames": "SayGames", "cocos-old": "Cocos build cũ", "luna": "Luna", "super-html": "Super HTML", "setup-config": "setupConfig", "unknown": "Không xác định" })[build] || build;
    }

    function networkLabel(network) {
        return ({ applovin: "AppLovin", mintegral: "Mintegral", unity: "Unity", google: "Google", pangle: "Pangle", unknown: "Không xác định" })[network] || network;
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
        return (bytes / 1024 / 1024).toFixed(2) + " MB";
    }

    setMode("saygames", false);
    updateControls();
    if (window.MeshPanel) MeshPanel.init({ onApply: function (h) { adoptEditedHtml(h, "mesh"); } });
    if (window.ScriptPanel) ScriptPanel.init({ onApply: function (h) { adoptEditedHtml(h, "scripts"); } });
})();
