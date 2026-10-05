/* app.js — giao diện Build Recover: hàng đợi job, worker song song, ghi kết quả.
 *
 * Mỗi job chạy trong một Web Worker riêng (lõi khôi phục là code đồng bộ nặng — Babel, giải nén,
 * dựng project — chạy trên luồng chính là đơ trang). Worker tạo từ Blob ghép mã nguồn
 * RecoverCoreFactory + BuildRecoverWorker, nên chạy cả khi mở bằng file://.
 *
 * Kết quả: thư mục trên đĩa (File System Access API, handle lưu trong IndexedDB để lần sau khỏi
 * chọn lại) hoặc file .zip tải về.
 */
(function () {
    'use strict';

    var $ = function (id) { return document.getElementById(id); };
    var HAS_FS = typeof window.showDirectoryPicker === 'function';
    var CPU = navigator.hardwareConcurrency || 4;
    var CHANNELS = ['google', 'applovin', 'unity', 'mintegral', 'ironsource', 'pangle', 'facebook', 'tiktok', 'moloco', 'liftoff', 'vungle', 'adcolony', 'chartboost', 'snapchat'];
    var STAT_LABELS = {
        scenes: 'scene', prefabs: 'prefab', images: 'ảnh', scripts: 'script', animations: 'animation', audio: 'âm thanh',
        audios: 'âm thanh', 'audio-clip': 'âm thanh', materials: 'material', 'physics-material': 'physics material', models: 'model 3D', spine: 'Spine', dragonbones: 'DragonBones',
        ttfFonts: 'font', bitmapFonts: 'bitmap font', particles: 'particle', tiledMaps: 'tiled map', json: 'json',
        text: 'text', spriteAtlases: 'atlas', autoAtlasFrames: 'sprite từ auto-atlas', dragonbonesAtlas: 'atlas DragonBones', cubeMaps: 'cube map',
        textureCubes: 'texture cube', customEffects: 'effect',
        // Unity (Luna)
        textures: 'texture', sprites: 'sprite', spriteSheets: 'texture nhiều sprite', textAssets: 'text', physicsMaterials: 'physics material',
        standInShaders: 'shader thay thế', meshes: 'mesh', animationClips: 'animation clip', animatorControllers: 'animator',
        scriptableObjects: 'ScriptableObject', components: 'component', monoBehaviours: 'MonoBehaviour', gameObjects: 'GameObject'
    };
    var STATUS_TEXT = { queued: 'Chờ', reading: 'Đọc file', running: 'Đang chạy', saving: 'Đang lưu', done: 'Xong', failed: 'Lỗi', unsupported: 'Không hỗ trợ', cancelled: 'Đã huỷ' };

    // ------------------------------------------------------------------ lưu trữ nhỏ
    var store = {
        get: function (k, d) { try { var v = localStorage.getItem('build-recover:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
        set: function (k, v) { try { localStorage.setItem('build-recover:' + k, JSON.stringify(v)); } catch (e) { /* chế độ riêng tư */ } }
    };
    var idb = (function () {
        var dbp = null;
        function open() {
            if (!dbp) dbp = new Promise(function (res, rej) {
                var r = indexedDB.open('build-recover', 1);
                r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
                r.onsuccess = function () { res(r.result); };
                r.onerror = function () { rej(r.error); };
            });
            return dbp;
        }
        function tx(mode, fn) {
            return open().then(function (db) {
                return new Promise(function (res, rej) {
                    var t = db.transaction('kv', mode), req = fn(t.objectStore('kv'));
                    t.oncomplete = function () { res(req && req.result); };
                    t.onerror = function () { rej(t.error); };
                });
            });
        }
        return {
            get: function (k) { return tx('readonly', function (s) { return s.get(k); }).catch(function () { return null; }); },
            set: function (k, v) { return tx('readwrite', function (s) { return s.put(v, k); }).catch(function () { }); },
            del: function (k) { return tx('readwrite', function (s) { return s.delete(k); }).catch(function () { }); }
        };
    })();

    var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
    var settings = {
        concurrency: clamp(+store.get('concurrency', Math.max(1, Math.min(4, CPU - 2))) || 2, 1, 8),
        noScripts: !!store.get('noScripts', false)
    };

    // ------------------------------------------------------------------ tiện ích
    function fmtBytes(n) {
        if (n < 1024) return n + ' B';
        if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
        return (n / 1048576).toFixed(1) + ' MB';
    }
    function fmtTime(ms) { return ms < 60000 ? (ms / 1000).toFixed(1) + ' s' : Math.floor(ms / 60000) + ' ph ' + Math.round((ms % 60000) / 1000) + ' s'; }
    function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function channelOf(s) { s = String(s).toLowerCase(); for (var i = 0; i < CHANNELS.length; i++) if (s.indexOf(CHANNELS[i]) >= 0) return CHANNELS[i]; return ''; }
    function channelRank(s) { var c = channelOf(s); return c ? CHANNELS.indexOf(c) : 99; }
    function download(blob, name) {
        var a = el('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    }

    // ------------------------------------------------------------------ cây thư mục (3 nguồn, 1 giao diện)
    /* node = { name, path, dir: bool, list(): Promise<node[]>, file(): Promise<File> }
       nguồn: FileSystemDirectoryHandle (Quét thư mục), FileSystemEntry (kéo-thả), FileList (webkitdirectory). */
    function handleNode(h, path) {
        return {
            name: h.name, path: path, dir: h.kind === 'directory', handle: h,
            list: async function () {
                var out = [];
                for await (var c of h.values()) out.push(handleNode(c, path ? path + '/' + c.name : c.name));
                return out;
            },
            file: function () { return h.getFile(); }
        };
    }
    function entryNode(e, path) {
        return {
            name: e.name, path: path, dir: e.isDirectory, entry: e,
            list: function () {
                return new Promise(function (res, rej) {
                    var reader = e.createReader(), out = [];
                    (function more() {
                        reader.readEntries(function (batch) {
                            if (!batch.length) return res(out.map(function (c) { return entryNode(c, path ? path + '/' + c.name : c.name); }));
                            out = out.concat(Array.prototype.slice.call(batch));
                            more();
                        }, rej);
                    })();
                });
            },
            file: function () { return new Promise(function (res, rej) { e.file(res, rej); }); }
        };
    }
    function fileListRoot(files) {
        // webkitRelativePath = "<thư mục chọn>/a/b.png" → dựng cây
        var root = { name: '', children: new Map() };
        Array.prototype.forEach.call(files, function (item) {
            var f = item.file || item, parts = (item.rel || f.webkitRelativePath || f.name).split('/'), cur = root;
            for (var i = 0; i < parts.length - 1; i++) {
                if (!cur.children.has(parts[i])) cur.children.set(parts[i], { name: parts[i], children: new Map() });
                cur = cur.children.get(parts[i]);
            }
            cur.children.set(parts[parts.length - 1], { name: parts[parts.length - 1], file: f });
        });
        function wrap(n, path) {
            return {
                name: n.name, path: path, dir: !n.file,
                list: function () { return Promise.resolve(Array.from(n.children.values()).map(function (c) { return wrap(c, path ? path + '/' + c.name : c.name); })); },
                file: function () { return Promise.resolve(n.file); }
            };
        }
        var top = Array.from(root.children.values());
        return top.length === 1 && !top[0].file ? wrap(top[0], top[0].name) : wrap(root, '');
    }
    async function collectFiles(node, prefix, out) {
        out = out || [];
        var kids = await node.list();
        for (var i = 0; i < kids.length; i++) {
            var k = kids[i], rel = prefix ? prefix + '/' + k.name : k.name;
            if (k.dir) await collectFiles(k, rel, out);
            else out.push({ rel: rel, file: await k.file() });
        }
        return out;
    }
    // web-mobile (index.html + src/) hoặc ruột zip super-html giải nén (index.js/application.js + src/)
    function isBuildFolder(kids) {
        return kids.some(function (k) { return !k.dir && /^(index\.html|index\.js|application\.js)$/.test(k.name); }) &&
            kids.some(function (k) { return k.dir && k.name === 'src'; });
    }

    // ------------------------------------------------------------------ nhận diện file html
    var LUNA_RE = /LunaCompilerV|Luna\.Unity\.|LunaUnity\.|window\._compressedAssets|decompressArrayBuffer\(/;
    var COCOS_RE = /__zip\s*=|__res\s*=|super_html|Cocos Creator|cocos-js|_CCSettings/;
    async function sniff(file) {
        if (/\.zip$/i.test(file.name)) return { kind: 'zip', title: '' };
        var head = await file.slice(0, 65536).text();
        var tail = file.size > 131072 ? await file.slice(file.size - 65536).text() : '';
        var title = ((head.match(/<title>([^<]*)<\/title>/i) || [])[1] || '').trim().replace(/^Cocos Creator\s*\|\s*/i, '');
        var text = head + tail;
        if (LUNA_RE.test(text)) return { kind: 'luna', title: title };
        if (COCOS_RE.test(text)) return { kind: 'cocos', title: title };
        return { kind: 'html', title: title };
    }

    // ------------------------------------------------------------------ job
    var jobs = [], nextId = 1;
    /* source: { type: 'file', file } | { type: 'node', node } (thư mục build) | { type: 'handle', node } (file từ quét) */
    function addJob(source, opts) {
        opts = opts || {};
        var job = {
            id: nextId++, source: source, label: opts.label || source.name || 'build', path: opts.path || '',
            kind: opts.kind || '', status: 'queued', pct: 0, msg: '', addedAt: Date.now()
        };
        jobs.push(job);
        renderJob(job);
        pump();
        return job;
    }

    async function readInputs(job) {
        var src = job.source;
        if (src.type === 'file' || src.type === 'handle') {
            var file = src.type === 'file' ? src.file : await src.node.file();
            var name = file.name.replace(/[\\/:*?"<>|]/g, '_');
            return { entry: name, inputs: [{ path: name, data: await file.arrayBuffer() }] };
        }
        // thư mục build web-mobile: đọc hết file bên trong
        var root = src.node.name || 'build';
        var files = await collectFiles(src.node, '');
        var inputs = [];
        for (var i = 0; i < files.length; i++) {
            if (/(^|\/)(node_modules|\.git)(\/|$)/.test(files[i].rel)) continue;
            inputs.push({ path: root + '/' + files[i].rel, data: await files[i].file.arrayBuffer() });
        }
        return { entry: root, inputs: inputs };
    }

    // ------------------------------------------------------------------ worker pool
    var workerUrl = null, pool = [];
    function workerSource() {
        if (!workerUrl) {
            if (typeof RecoverCoreFactory !== 'function') throw new Error('Thiếu dist/recover-core.js — chạy "node scripts/bundle.js".');
            var src = RecoverCoreFactory.toString() + '\n' + BuildRecoverWorker.toString() + '\nBuildRecoverWorker(RecoverCoreFactory());\n';
            workerUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        }
        return workerUrl;
    }
    function takeWorker() {
        var w = pool.filter(function (p) { return !p.job; })[0];
        if (w) return w;
        w = { worker: new Worker(workerSource()), job: null };
        pool.push(w);
        return w;
    }
    function dropWorker(w) {
        try { w.worker.terminate(); } catch (e) { /* đã chết */ }
        pool = pool.filter(function (p) { return p !== w; });
    }
    var running = function () { return jobs.filter(function (j) { return j.status === 'reading' || j.status === 'running'; }).length; };

    function outputBlocked() { return outDir && outPerm !== 'granted'; }

    function pump() {
        renderCounters();
        if (outputBlocked()) return;
        while (running() < settings.concurrency) {
            var job = jobs.filter(function (j) { return j.status === 'queued'; })[0];
            if (!job) break;
            start(job);
        }
    }

    async function start(job) {
        job.status = 'reading'; job.pct = 1; job.msg = 'Đọc file…'; job.error = null; job.startedAt = Date.now();
        renderJob(job);
        var payload;
        try {
            payload = await readInputs(job);
        } catch (e) {
            return finish(job, 'failed', 'Không đọc được đầu vào: ' + e.message);
        }
        if (job.status !== 'reading') return;          // bị huỷ trong lúc đọc
        var refs = [];
        try { refs = await readRefs(); } catch (e) { /* bỏ qua tham chiếu hỏng */ }
        var w;
        try { w = takeWorker(); } catch (e) { return finish(job, 'failed', e.message); }
        w.job = job; job.worker = w;
        job.status = 'running'; job.msg = 'Khởi động…';
        renderJob(job);
        var zipMode = !outDir;
        w.worker.onmessage = function (e) {
            var m = e.data;
            if (w.job !== job) return;
            if (m.type === 'progress') { job.pct = m.pct; job.msg = m.msg; scheduleRender(job); return; }
            w.job = null; job.worker = null;
            if (m.type === 'error') { finish(job, m.unsupported ? 'unsupported' : 'failed', m.message, m.stack); pump(); return; }
            job.summary = m.summary; job.report = m.report;
            if (m.zip) {
                job.zip = new Blob([m.zip], { type: 'application/zip' });
                job.savedTo = null;
                finish(job, 'done');
            } else {
                job.status = 'saving'; job.pct = 99; job.msg = 'Ghi ' + m.files.length + ' file ra đĩa…';
                renderJob(job);
                saveToFolder(job, m.files).then(function () { finish(job, 'done'); }, function (err) {
                    job.pendingFiles = m.files;
                    finish(job, 'failed', 'Không ghi được vào thư mục: ' + err.message + '\nBấm "Thử ghi lại" sau khi cấp quyền, hoặc tải .zip.');
                });
            }
            pump();
        };
        w.worker.onerror = function (e) {
            if (w.job !== job) return;
            e.preventDefault();
            dropWorker(w);
            job.worker = null;
            finish(job, 'failed', 'Worker lỗi: ' + (e.message || 'không rõ') + ' (có thể thiếu bộ nhớ với bản build quá lớn)');
            pump();
        };
        var transfer = payload.inputs.map(function (f) { return f.data; }).concat(refs.map(function (f) { return f.data; }));
        w.worker.postMessage({ type: 'run', entry: payload.entry, source: job.path || job.label, inputs: payload.inputs, refs: refs, noScripts: settings.noScripts, zip: zipMode }, transfer);
    }

    function finish(job, status, error, stack) {
        job.status = status; job.error = error || null; job.stack = stack || null; job.endedAt = Date.now();
        job.pct = status === 'done' ? 100 : job.pct;
        renderJob(job);
        renderCounters();
    }

    function cancel(job) {
        if (job.worker) { dropWorker(job.worker); job.worker = null; }
        if (job.status === 'queued' || job.status === 'reading' || job.status === 'running') finish(job, 'cancelled');
        pump();
    }
    function retry(job) {
        job.status = 'queued'; job.pct = 0; job.msg = ''; job.error = null; job.summary = null; job.report = null; job.zip = null; job.savedTo = null;
        renderJob(job);
        pump();
    }
    function removeJob(job) {
        if (job.worker) cancel(job);
        jobs = jobs.filter(function (j) { return j !== job; });
        var node = document.querySelector('[data-job="' + job.id + '"]');
        if (node) node.remove();
        renderCounters();
    }

    // ------------------------------------------------------------------ thư mục đích
    var outDir = null, outPerm = 'none', claimChain = Promise.resolve();
    async function restoreOutDir() {
        if (!HAS_FS) return renderOut();
        var h = await idb.get('outDir');
        if (h && h.kind === 'directory') {
            outDir = h;
            try { outPerm = await h.queryPermission({ mode: 'readwrite' }); } catch (e) { outPerm = 'prompt'; }
        }
        renderOut();
    }
    async function pickOutDir() {
        try {
            var h = await window.showDirectoryPicker({ id: 'build-recover-out', mode: 'readwrite' });
            outDir = h; outPerm = 'granted';
            idb.set('outDir', h);
            renderOut(); pump();
        } catch (e) { if (e.name !== 'AbortError') alert('Không mở được thư mục: ' + e.message); }
    }
    async function grantOut() {
        try { outPerm = await outDir.requestPermission({ mode: 'readwrite' }); } catch (e) { outPerm = 'denied'; }
        renderOut();
        if (outPerm === 'granted') {
            jobs.filter(function (j) { return j.pendingFiles; }).forEach(function (j) { retrySave(j); });
            pump();
        }
    }
    function useZip() { outDir = null; outPerm = 'none'; idb.del('outDir'); renderOut(); pump(); }

    /* Tên thư mục project chưa tồn tại: name, name_2, name_3… Chạy nối tiếp (claimChain) để hai job
       xong cùng lúc không chọn trùng một tên. */
    function claimDir(parent, name) {
        var p = claimChain.then(async function () {
            for (var k = 1; k < 1000; k++) {
                var n = k === 1 ? name : name + '_' + k;
                try { await parent.getDirectoryHandle(n); continue; } catch (e) {
                    if (e.name === 'TypeMismatchError') continue;       // có file trùng tên
                    if (e.name !== 'NotFoundError') throw e;
                }
                return { name: n, handle: await parent.getDirectoryHandle(n, { create: true }) };
            }
            throw new Error('Không tìm được tên thư mục trống cho ' + name);
        });
        claimChain = p.catch(function () { });
        return p;
    }
    async function saveToFolder(job, files) {
        var claimed = await claimDir(outDir, job.summary.outName);
        var cache = new Map([['', claimed.handle]]);
        async function dirOf(rel) {
            var i = rel.lastIndexOf('/');
            if (i < 0) return claimed.handle;
            var p = rel.slice(0, i);
            if (cache.has(p)) return cache.get(p);
            var parent = await dirOf(p);
            var h = await parent.getDirectoryHandle(p.slice(p.lastIndexOf('/') + 1), { create: true });
            cache.set(p, h);
            return h;
        }
        for (var n = 0; n < files.length; n++) {
            var rel = files[n][0];
            var d = await dirOf(rel);
            var fh = await d.getFileHandle(rel.slice(rel.lastIndexOf('/') + 1), { create: true });
            var w = await fh.createWritable();
            await w.write(files[n][1]);
            await w.close();
            if (n % 25 === 0) { job.msg = 'Ghi file ' + (n + 1) + '/' + files.length + '…'; scheduleRender(job); }
        }
        job.savedTo = outDir.name + '/' + claimed.name;
        job.pendingFiles = null;
    }
    function retrySave(job) {
        var files = job.pendingFiles;
        job.status = 'saving'; job.error = null; renderJob(job);
        saveToFolder(job, files).then(function () { finish(job, 'done'); }, function (err) {
            finish(job, 'failed', 'Không ghi được vào thư mục: ' + err.message);
        });
    }
    // ------------------------------------------------------------------ project tham chiếu
    var refs = [];   // [{ name, files: [{ rel, file }] }]
    /* items: FileList của webkitdirectory, hoặc [{ rel, file }]. Chỉ giữ .ts + .ts.meta — đủ để lõi
       khớp script theo uuid, khỏi đọc cả project (library/, temp/ có thể cả GB). */
    function addRefFolder(items) {
        var files = Array.prototype.map.call(items, function (it) {
            return { rel: it.rel || it.webkitRelativePath || it.name, file: it.file || it };
        }).filter(function (f) {
            return /\.ts(\.meta)?$/.test(f.rel) && !/(^|\/)(node_modules|library|temp|build|\.git)\//.test(f.rel);
        });
        if (!files.length) { alert('Thư mục này không có script .ts nào.'); return; }
        refs.push({ name: files[0].rel.split('/')[0] || 'project', files: files });
        renderRefs();
    }
    async function readRefs() {
        var out = [];
        for (var i = 0; i < refs.length; i++) {
            for (var k = 0; k < refs[i].files.length; k++) {
                var f = refs[i].files[k];
                out.push({ path: i + '/' + f.rel, data: await f.file.arrayBuffer() });
            }
        }
        return out;
    }

    // ------------------------------------------------------------------ nhận đầu vào
    async function addFromNode(node) {
        if (!node.dir) {
            var f = await node.file();
            if (!/\.(html?|zip)$/i.test(f.name)) return 0;
            var s = await sniff(f);
            addJob({ type: 'file', file: f, name: f.name }, { label: s.title || f.name, path: node.path || f.name, kind: s.kind });
            return 1;
        }
        var kids = await node.list();
        if (isBuildFolder(kids)) {
            addJob({ type: 'node', node: node, name: node.name }, { label: node.name, path: node.path || node.name, kind: 'folder' });
            return 1;
        }
        // thư mục chứa nhiều build → quét rồi cho chọn
        openScan(node);
        return 0;
    }

    async function onDrop(e) {
        e.preventDefault();
        document.body.classList.remove('dragging');
        var items = e.dataTransfer.items, nodes = [];
        // phải lấy entry NGAY trong sự kiện drop — sau await là DataTransfer bị vô hiệu
        if (items && items.length && items[0].webkitGetAsEntry) {
            for (var i = 0; i < items.length; i++) {
                var entry = items[i].webkitGetAsEntry && items[i].webkitGetAsEntry();
                if (entry) nodes.push(entryNode(entry, entry.name));
            }
        }
        if (!nodes.length) {
            Array.prototype.forEach.call(e.dataTransfer.files, function (f) {
                if (/\.(html?|zip)$/i.test(f.name)) addJob({ type: 'file', file: f, name: f.name }, { label: f.name, path: f.name });
            });
            return;
        }
        for (var k = 0; k < nodes.length; k++) {
            try { await addFromNode(nodes[k]); } catch (err) {
                alert('Không đọc được "' + nodes[k].name + '": ' + err.message + (location.protocol === 'file:' ? '\n\nTrang mở bằng file:// — Chrome chặn đọc thư mục kéo-thả. Chạy serve.bat ở thư mục gốc rồi mở http://localhost:8000/build-recover/, hoặc dùng nút "Chọn thư mục build…".' : ''));
            }
        }
    }

    // ------------------------------------------------------------------ quét thư mục
    var scan = { token: 0, items: [], root: null };
    async function scanTree(root, onProgress, token) {
        var found = [], dirs = 0;
        async function walk(node, depth) {
            if (depth > 9 || token !== scan.token) return;
            var kids;
            try { kids = await node.list(); } catch (e) { return; }
            dirs++;
            if (dirs % 10 === 0) onProgress(dirs, found.length, node.path);
            if (isBuildFolder(kids)) { found.push({ node: node, kind: 'folder', path: node.path, parent: parentOf(node.path) }); return; }
            for (var i = 0; i < kids.length; i++) {
                var k = kids[i];
                if (!k.dir && /\.(html?|zip)$/i.test(k.name)) found.push({ node: k, kind: /\.zip$/i.test(k.name) ? 'zip' : 'html', path: k.path, parent: node.path });
            }
            var sub = kids.filter(function (k) { return k.dir && !/^(node_modules|\.git|library|temp|recovered|_out)$/i.test(k.name); });
            // đi song song từng nhóm nhỏ: ổ NAS chịu được, lại nhanh hơn tuần tự nhiều
            for (var j = 0; j < sub.length; j += 6) {
                await Promise.all(sub.slice(j, j + 6).map(function (s) { return walk(s, depth + 1); }));
            }
        }
        await walk(root, 0);
        return found;
    }
    function parentOf(p) { var i = String(p).lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
    function baseOf(p) { return String(p).slice(String(p).lastIndexOf('/') + 1); }

    /* Các bản khác kênh của cùng một phiên bản (…/v3/applovin/index.html, …/v3/google/index.html)
       chung một payload → gom theo thư mục phiên bản, đề xuất bản html theo thứ tự kênh ưa thích. */
    async function groupFound(found, root) {
        var rootName = root.name || 'build', rootPath = root.path || '';
        var relOf = function (p) { return rootPath && p.indexOf(rootPath + '/') === 0 ? p.slice(rootPath.length + 1) : p === rootPath ? '' : p; };
        var groups = new Map();
        found.forEach(function (f) {
            var parent = f.parent, pb = baseOf(parent);
            var key = channelOf(pb) && pb.length <= 14 ? parentOf(parent) : parent;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(f);
        });
        var out = [];
        for (var entry of groups) {
            var key = entry[0], list = entry[1];
            list.sort(function (a, b) {
                return (a.kind === 'html' ? 0 : a.kind === 'folder' ? 1 : 2) - (b.kind === 'html' ? 0 : b.kind === 'folder' ? 1 : 2) ||
                    channelRank(a.path) - channelRank(b.path);
            });
            var best = list[0], info = { kind: best.kind, title: '' }, size = 0, mtime = 0;
            if (best.kind !== 'folder') {
                try {
                    var file = await best.node.file();
                    size = file.size; mtime = file.lastModified;
                    info = await sniff(file);
                } catch (e) { /* file không đọc được: vẫn liệt kê */ }
            }
            var rel = relOf(key) || rootName;
            out.push({
                best: best, rel: rel, file: relOf(best.path), group: rel.split('/')[0] || rel, version: baseOf(key) || rootName,
                title: info.title, kind: info.kind === 'html' && best.kind === 'folder' ? 'folder' : info.kind,
                size: size, mtime: mtime, channel: channelOf(best.path), variants: list.length,
                checked: info.kind !== 'html' && info.kind !== 'other'
            });
        }
        out.sort(function (a, b) { return a.group.localeCompare(b.group) || b.mtime - a.mtime; });
        return out;
    }

    async function openScan(node) {
        var token = ++scan.token;
        scan.items = []; scan.root = node;
        $('scan-title').textContent = 'Đang quét ' + (node.name || 'thư mục') + '…';
        $('scan-status').textContent = 'Đang liệt kê thư mục…';
        $('scan-list').innerHTML = '';
        $('scan-add').disabled = true;
        $('scan-filter').value = '';
        var dlg = $('scan-dialog');
        if (!dlg.open) dlg.showModal();
        var t0 = Date.now();
        var found = await scanTree(node, function (dirs, n, cur) {
            if (token === scan.token) $('scan-status').textContent = 'Đã xem ' + dirs + ' thư mục, thấy ' + n + ' file — ' + cur;
        }, token);
        if (token !== scan.token) return;
        $('scan-status').textContent = 'Đang đọc tiêu đề ' + found.length + ' file…';
        scan.items = await groupFound(found, node);
        if (token !== scan.token) return;
        $('scan-title').textContent = node.name || 'Kết quả quét';
        var cocos = scan.items.filter(function (i) { return i.kind === 'cocos' || i.kind === 'zip' || i.kind === 'folder'; }).length;
        var luna = scan.items.filter(function (i) { return i.kind === 'luna'; }).length;
        $('scan-status').textContent = scan.items.length
            ? scan.items.length + ' phiên bản (' + found.length + ' file) trong ' + fmtTime(Date.now() - t0) + ' — ' + cocos + ' Cocos' + (luna ? ', ' + luna + ' Luna' : '') + '. Mỗi phiên bản chọn sẵn một bản theo kênh ưa thích.'
            : 'Không tìm thấy file build nào (.html, .zip hoặc thư mục web-mobile).';
        renderScan();
    }

    function renderScan() {
        var list = $('scan-list'), filter = $('scan-filter').value.trim().toLowerCase();
        list.innerHTML = '';
        var lastGroup = null, shown = 0;
        scan.items.forEach(function (it, idx) {
            if (filter && (it.rel + ' ' + it.title).toLowerCase().indexOf(filter) < 0) return;
            if (it.group !== lastGroup) { list.appendChild(el('div', 'scan-group', it.group)); lastGroup = it.group; }
            var row = el('label', 'scan-item');
            var cb = el('input'); cb.type = 'checkbox'; cb.checked = it.checked;
            cb.addEventListener('change', function () { it.checked = cb.checked; updateScanButton(); });
            var copy = el('div');
            copy.appendChild(el('strong', null, it.title || it.version));
            copy.appendChild(el('span', null, it.file + (it.variants > 1 ? ' · ' + (it.variants - 1) + ' bản khác cùng phiên bản' : '')));
            var meta = el('div', 'scan-meta');
            var kindText = { cocos: 'Cocos', luna: 'Luna', zip: 'zip', folder: 'web-mobile', html: 'html?' }[it.kind] || it.kind;
            meta.appendChild(el('span', 'kind' + (it.kind === 'luna' ? ' luna' : it.kind === 'html' ? ' other' : ''), kindText));
            if (it.size) meta.appendChild(el('span', 'chip', fmtBytes(it.size)));
            row.appendChild(cb); row.appendChild(copy); row.appendChild(meta);
            row.dataset.idx = idx;
            list.appendChild(row);
            shown++;
        });
        if (!shown && scan.items.length) list.appendChild(el('div', 'scan-empty', 'Không có mục nào khớp bộ lọc.'));
        updateScanButton();
    }
    function updateScanButton() {
        var n = scan.items.filter(function (i) { return i.checked; }).length;
        $('scan-add').disabled = !n;
        $('scan-add').firstChild.textContent = n ? 'Thêm ' + n + ' việc' : 'Thêm việc';
    }
    function addScanned() {
        scan.items.filter(function (i) { return i.checked; }).forEach(function (it) {
            var b = it.best;
            var label = it.title || it.version;
            if (b.kind === 'folder') addJob({ type: 'node', node: b.node, name: b.node.name }, { label: label, path: it.rel, kind: 'folder' });
            else addJob({ type: 'handle', node: b.node, name: b.node.name }, { label: label, path: it.file, kind: it.kind });
        });
        $('scan-dialog').close();
    }

    // ------------------------------------------------------------------ hiển thị
    var pendingRender = new Set(), rafId = 0;
    function scheduleRender(job) {
        pendingRender.add(job);
        if (!rafId) rafId = requestAnimationFrame(function () {
            rafId = 0;
            pendingRender.forEach(renderJob);
            pendingRender.clear();
        });
    }

    function renderJob(job) {
        var box = $('jobs');
        var node = box.querySelector('[data-job="' + job.id + '"]');
        if (!node) {
            node = el('article', 'job');
            node.dataset.job = job.id;
            node.innerHTML = '<div class="file-icon"></div><div class="job-main">' +
                '<div class="job-title"><strong></strong><span class="status-pill"></span></div>' +
                '<div class="job-source"></div><div class="progress"><div></div></div><div class="job-stage"></div>' +
                '<div class="job-error" hidden></div><div class="chips"></div><div class="job-actions"></div></div>';
            box.insertBefore(node, box.firstChild);
        }
        var luna = job.kind === 'luna' || (job.summary && job.summary.engine === 'unity');
        node.className = 'job ' + job.status + (luna ? ' luna' : '') + (job.status === 'reading' ? ' running' : '');
        node.querySelector('.file-icon').textContent = luna ? 'LUNA' : { zip: 'ZIP', folder: 'DIR' }[job.kind] || 'HTML';
        node.querySelector('.job-title strong').textContent = job.summary ? job.summary.outName : job.label;
        var pill = node.querySelector('.status-pill');
        pill.className = 'status-pill ' + job.status;
        pill.textContent = STATUS_TEXT[job.status] || job.status;
        node.querySelector('.job-source').textContent = job.path || job.label;
        node.querySelector('.progress > div').style.width = (job.pct || 0) + '%';
        var stage = '';
        if (job.status === 'running' || job.status === 'reading' || job.status === 'saving') stage = (job.msg || '') + ' · ' + Math.round(job.pct || 0) + '%';
        else if (job.status === 'done') {
            var s = job.summary;
            stage = (s.engine === 'unity' ? 'Unity ' + (s.engineVersion || '?') : 'Cocos Creator ' + (s.creatorVersion || '?')) + ' · ' + s.fileCount + ' file, ' + fmtBytes(s.bytes) + ' · ' + fmtTime(job.endedAt - job.startedAt);
        } else if (job.status === 'queued') stage = outputBlocked() ? 'Chờ cấp quyền ghi thư mục đích' : 'Chờ tới lượt';
        node.querySelector('.job-stage').textContent = stage;
        var err = node.querySelector('.job-error');
        err.hidden = !job.error;
        err.textContent = job.error || '';
        if (job.stack && job.status === 'failed') err.title = job.stack;

        var chips = node.querySelector('.chips');
        chips.innerHTML = '';
        if (job.summary) {
            var st = job.summary.stats || {};
            Object.keys(st).forEach(function (k) {
                if (!st[k]) return;
                var c = el('span', 'chip');
                c.innerHTML = '<b>' + st[k] + '</b> ' + esc(STAT_LABELS[k] || k);
                chips.appendChild(c);
            });
            var nw = (job.summary.warnings || []).length;
            if (nw) {
                var wc = el('span', 'chip warn', '⚠ ' + nw + ' cảnh báo');
                wc.title = 'Xem báo cáo';
                wc.addEventListener('click', function () { showReport(job); });
                chips.appendChild(wc);
            }
            var req = (job.summary.facts && job.summary.facts.requires) || [];
            if (req.length) {
                var rc = el('span', 'chip todo', 'Cần import: ' + req.join(', '));
                rc.title = 'Project mở được ngay, nhưng các phần này phải import tay (thiếu thì component báo Missing Script) — xem Báo cáo';
                rc.addEventListener('click', function () { showReport(job); });
                chips.appendChild(rc);
            }
            if (job.savedTo) chips.appendChild(el('span', 'chip saved', '✓ Đã lưu: ' + job.savedTo));
        }

        var act = node.querySelector('.job-actions');
        act.innerHTML = '';
        function btn(text, fn, cls) {
            var b = el('button', 'secondary-button' + (cls ? ' ' + cls : ''), text);
            b.type = 'button';
            b.addEventListener('click', fn);
            act.appendChild(b);
        }
        if (job.zip) btn('Tải .zip', function () { job.downloaded = true; download(job.zip, job.summary.outName + '.zip'); renderJob(job); }, job.downloaded ? '' : 'accent');
        if (job.report) btn('Báo cáo', function () { showReport(job); });
        if (job.pendingFiles && outDir) btn('Thử ghi lại', function () { if (outPerm !== 'granted') grantOut(); else retrySave(job); });
        if (job.status === 'queued' || job.status === 'reading' || job.status === 'running') btn('Huỷ', function () { cancel(job); }, 'danger');
        if (job.status === 'failed' || job.status === 'cancelled' || job.status === 'unsupported' || job.status === 'done') btn(job.status === 'done' ? 'Chạy lại' : 'Thử lại', function () { retry(job); });
        if (job.status !== 'running' && job.status !== 'reading' && job.status !== 'saving') btn('Xoá', function () { removeJob(job); });
        $('empty').hidden = jobs.length > 0;
        renderCounters();
    }

    function renderCounters() {
        var c = { queued: 0, running: 0, done: 0, failed: 0 };
        jobs.forEach(function (j) {
            if (j.status === 'queued') c.queued++;
            else if (j.status === 'reading' || j.status === 'running' || j.status === 'saving') c.running++;
            else if (j.status === 'done') c.done++;
            else if (j.status === 'failed' || j.status === 'unsupported') c.failed++;
        });
        var box = $('counters');
        box.innerHTML = '';
        [['running', 'đang chạy'], ['queued', 'chờ'], ['done', 'xong'], ['failed', 'lỗi']].forEach(function (p) {
            if (!c[p[0]]) return;
            var s = el('span', 'counter');
            s.innerHTML = '<b>' + c[p[0]] + '</b> ' + p[1];
            box.appendChild(s);
        });
        $('clear-done').hidden = !jobs.some(function (j) { return j.status === 'done' || j.status === 'cancelled'; });
        var notice = $('jobs-notice');
        var waiting = c.queued > 0 && outputBlocked();
        notice.hidden = !waiting;
        notice.textContent = waiting ? 'Trình duyệt cần bạn cho phép ghi lại vào thư mục "' + outDir.name + '" — bấm "Cấp quyền ghi" ở ô Kết quả để bắt đầu.' : '';
        $('empty').hidden = jobs.length > 0;
    }

    function renderOut() {
        var icon = $('out-icon'), name = $('out-name'), detail = $('out-detail'), warn = $('out-warning');
        $('pick-out').hidden = !HAS_FS;
        $('pick-out').textContent = outDir ? 'Đổi thư mục…' : 'Chọn thư mục…';
        $('use-zip').hidden = !outDir;
        $('grant-out').hidden = !(outDir && outPerm !== 'granted');
        warn.hidden = true;
        if (outDir) {
            icon.textContent = 'DIR';
            name.textContent = outDir.name;
            detail.textContent = outPerm === 'granted' ? 'Mỗi project một thư mục con bên trong' : 'Cần cấp lại quyền ghi (trình duyệt hỏi mỗi phiên làm việc)';
        } else {
            icon.textContent = 'ZIP';
            name.textContent = 'Tải về dạng .zip';
            detail.textContent = HAS_FS ? 'Mỗi project một file .zip — "Chọn thư mục…" để ghi thẳng ra đĩa' : 'Mỗi project một file .zip';
            if (!HAS_FS) { warn.hidden = false; warn.textContent = 'Trình duyệt này không ghi thẳng ra thư mục được (cần Chrome hoặc Edge) — kết quả sẽ là file .zip.'; }
        }
        renderCounters();
    }

    function renderRefs() {
        var box = $('ref-list');
        box.innerHTML = '';
        refs.forEach(function (r, i) {
            var row = el('div', 'ref-item');
            row.appendChild(el('span', null, r.name));
            row.appendChild(el('small', null, r.files.filter(function (f) { return /\.ts$/.test(f.rel); }).length + ' script'));
            var b = el('button', 'text-button', 'Bỏ');
            b.type = 'button';
            b.addEventListener('click', function () { refs.splice(i, 1); renderRefs(); });
            row.appendChild(b);
            box.appendChild(row);
        });
    }

    // ------------------------------------------------------------------ báo cáo (markdown tối giản)
    function inline(s) {
        return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    }
    function renderMarkdown(md) {
        var lines = md.split('\n'), html = [], i = 0;
        while (i < lines.length) {
            var line = lines[i];
            var h = line.match(/^(#{1,3})\s+(.*)$/);
            if (h) { html.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'); i++; continue; }
            if (/^\|/.test(line)) {
                var rows = [];
                while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
                var cells = function (r) { return r.replace(/^\||\|$/g, '').split('|').map(function (c) { return c.trim(); }); };
                var t = '<table><thead><tr>' + cells(rows[0]).map(function (c) { return '<th>' + inline(c) + '</th>'; }).join('') + '</tr></thead><tbody>';
                rows.slice(2).forEach(function (r) { t += '<tr>' + cells(r).map(function (c) { return '<td>' + inline(c) + '</td>'; }).join('') + '</tr>'; });
                html.push(t + '</tbody></table>');
                continue;
            }
            if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
                var ordered = /^\s*\d+\./.test(line), items = [];
                while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i]))) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''));
                html.push((ordered ? '<ol>' : '<ul>') + items.map(function (x) { return '<li>' + inline(x) + '</li>'; }).join('') + (ordered ? '</ol>' : '</ul>'));
                continue;
            }
            if (line.trim()) html.push('<p>' + inline(line) + '</p>');
            i++;
        }
        return html.join('\n');
    }
    var reportJob = null;
    function showReport(job) {
        reportJob = job;
        $('report-title').textContent = job.summary ? job.summary.outName : job.label;
        $('report-body').innerHTML = renderMarkdown(job.report || '');
        $('report-dialog').showModal();
    }

    // ------------------------------------------------------------------ gắn sự kiện
    function bind() {
        $('file-input').addEventListener('change', function (e) {
            Array.prototype.forEach.call(e.target.files, function (f) {
                sniff(f).then(function (s) {
                    addJob({ type: 'file', file: f, name: f.name }, { label: s.title || f.name, path: f.name, kind: s.kind });
                });
            });
            e.target.value = '';
        });
        $('pick-folder').addEventListener('click', function () { $('folder-input').click(); });
        $('folder-input').addEventListener('change', function (e) {
            if (e.target.files.length) addFromNode(fileListRoot(e.target.files)).catch(function (err) { alert(err.message); });
            e.target.value = '';
        });
        $('scan-folder').addEventListener('click', async function () {
            if (!HAS_FS) { $('folder-input').click(); return; }
            try {
                var h = await window.showDirectoryPicker({ id: 'build-recover-scan', mode: 'read' });
                openScan(handleNode(h, h.name));
            } catch (e) { if (e.name !== 'AbortError') alert('Không mở được thư mục: ' + e.message); }
        });
        $('pick-out').addEventListener('click', pickOutDir);
        $('grant-out').addEventListener('click', grantOut);
        $('use-zip').addEventListener('click', useZip);

        var conc = $('concurrency');
        conc.value = settings.concurrency;
        conc.addEventListener('change', function () {
            settings.concurrency = clamp(Math.round(+conc.value) || 1, 1, 8);
            conc.value = settings.concurrency;
            store.set('concurrency', settings.concurrency);
            pump();
        });
        var ns = $('no-scripts');
        ns.checked = settings.noScripts;
        ns.addEventListener('change', function () { settings.noScripts = ns.checked; store.set('noScripts', ns.checked); });
        $('pick-ref').addEventListener('click', function () { $('ref-input').click(); });
        $('ref-input').addEventListener('change', function (e) { if (e.target.files.length) addRefFolder(e.target.files); e.target.value = ''; });

        $('clear-done').addEventListener('click', function () {
            jobs.filter(function (j) { return j.status === 'done' || j.status === 'cancelled'; }).forEach(removeJob);
        });

        $('scan-filter').addEventListener('input', renderScan);
        $('scan-all').addEventListener('click', function () { scan.items.forEach(function (i) { i.checked = true; }); renderScan(); });
        $('scan-none').addEventListener('click', function () { scan.items.forEach(function (i) { i.checked = false; }); renderScan(); });
        $('scan-add').addEventListener('click', addScanned);
        $('scan-dialog').addEventListener('close', function () { scan.token++; });
        $('report-download').addEventListener('click', function () {
            if (reportJob) download(new Blob([reportJob.report || ''], { type: 'text/markdown' }), 'RECOVERY_REPORT_' + (reportJob.summary ? reportJob.summary.outName : 'build') + '.md');
        });
        document.querySelectorAll('[data-close]').forEach(function (b) {
            b.addEventListener('click', function () { b.closest('dialog').close(); });
        });

        // kéo-thả: cả trang là vùng thả
        var depth = 0;
        window.addEventListener('dragenter', function (e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0) { depth++; document.body.classList.add('dragging'); } });
        window.addEventListener('dragleave', function () { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
        window.addEventListener('dragover', function (e) { e.preventDefault(); });
        window.addEventListener('drop', function (e) { depth = 0; onDrop(e); });

        window.addEventListener('beforeunload', function (e) {
            if (jobs.some(function (j) { return j.status === 'running' || j.status === 'reading' || j.status === 'saving' || (j.zip && !j.downloaded); })) { e.preventDefault(); e.returnValue = ''; }
        });
    }

    bind();
    renderOut();
    renderCounters();
    restoreOutDir();

    // cửa sau cho kiểm thử tự động (tests/browser-harness): không dùng trong giao diện
    window.BuildRecoverApp = {
        jobs: function () { return jobs; },
        settings: settings,
        addFile: function (f) { return addJob({ type: 'file', file: f, name: f.name }, { label: f.name, path: f.name }); },
        /** [{ rel: 'thư mục/a/b.html', file }] — như chọn bằng webkitdirectory */
        addTree: function (items) { return addFromNode(fileListRoot(items)); },
        /** thư mục đích bất kỳ có API FileSystemDirectoryHandle (vd. OPFS) */
        addRefs: function (items) { addRefFolder(items); },
        setOutDir: function (h) { outDir = h; outPerm = 'granted'; renderOut(); pump(); }
    };
})();
