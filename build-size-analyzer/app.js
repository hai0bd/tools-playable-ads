/* Build Size Analyzer — đọc thư mục build của Cocos Creator ngay trên trình duyệt.
   Không upload đi đâu cả: mọi thứ chạy bằng File API trong máy bạn. */

const SKIP_DIRS = new Set(['library', 'temp', 'node_modules', '.git', 'profiles', '.creator', '.vscode']);

const KIND_LABEL = {
    'texture': 'Texture',
    'mesh/anim': 'Mesh + Animation',
    'data': 'Scene / Shader',
    'engine:core': 'Engine core',
    'engine:physics': 'Bullet physics',
    'engine:spine': 'Spine',
    'engine:dragonbones': 'DragonBones',
    'engine:box2d': 'Box2D',
    'audio': 'Audio',
    'script': 'Script',
    'other': 'Khác',
};
const COLOR = {
    'texture': 'var(--tex)', 'mesh/anim': 'var(--mesh)', 'data': 'var(--data)',
    'engine:core': 'var(--eng)', 'engine:physics': 'var(--eng)', 'engine:spine': 'var(--eng)',
    'engine:dragonbones': 'var(--eng)', 'engine:box2d': 'var(--eng)',
    'audio': 'var(--warning)', 'script': 'var(--eng)', 'other': 'var(--muted)',
};
const BUDGET = 5 * 1024 * 1024;

/** 'kind' = nhóm theo loại dữ liệu (mặc định, luôn đọc được kể cả khi thiếu .meta)
 *  'asset' = nhóm theo asset gốc (chỉ hữu ích khi tra được tên từ assets/) */
const state = { res: null, mode: 'kind', source: 'dir' };

/** Các file lá đang hiện trên cây, để nháy đúp mở được. Dựng lại mỗi lần render cây. */
let openable = [];

const $ = id => document.getElementById(id);
const KB = n => (n / 1024).toFixed(0);
const MB = n => (n / 1048576).toFixed(2);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------------------------------------------------------------- đọc thư mục */

/** Duyệt entry của drag & drop. readEntries() chỉ trả tối đa 100 mục mỗi lần nên phải gọi lặp. */
async function walkEntry(entry, out, prefix = '') {
    if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        out.push({ path: prefix + entry.name, size: file.size, file });
        return;
    }
    if (!entry.isDirectory) return;
    if (SKIP_DIRS.has(entry.name.toLowerCase())) return;

    const reader = entry.createReader();
    const dirPrefix = prefix + entry.name + '/';
    while (true) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walkEntry(child, out, dirPrefix);
    }
}

function fromInput(fileList) {
    const out = [];
    for (const file of fileList) {
        const rel = file.webkitRelativePath || file.name;
        const parts = rel.split('/');
        if (parts.some(p => SKIP_DIRS.has(p.toLowerCase()))) continue;
        out.push({ path: rel, size: file.size, file });
    }
    return out;
}

/* ------------------------------------------------- đọc file playable đóng gói */

/* Bingo gói cả build thành ZIP rồi mã hoá base122 và nhét vào một biến JS.
   base122 nhồi 7 bit vào mỗi ký tự UTF-8, né 6 ký tự không hợp lệ trong chuỗi JS,
   nên chỉ phụ trội ~14% thay vì 33% như base64. */
/* Bang ky tu cam lay tu chinh bo giai ma Bingo nhung trong file HTML:
     var S=7, I=[0,10,13,34,38,92,60];
   Chuan base122 chi co 6 muc; Bingo them 60 ('<') de chuoi khong pha vo the <script>.
   Thieu muc thu 7 thi moi byte '<' trong du lieu nen bi giai sai. */
const B122_ILLEGAL = [0, 10, 13, 34, 38, 92, 60];

function base122Decode(str) {
    const out = [];
    let curByte = 0, bitOfByte = 0;
    const push7 = (b) => {
        b <<= 1;
        curByte |= (b >>> bitOfByte);
        bitOfByte += 7;
        if (bitOfByte >= 8) {
            out.push(curByte & 255);
            bitOfByte -= 8;
            curByte = (b << (7 - bitOfByte)) & 255;
        }
    };
    for (let i = 0; i < str.length; i++) {
        const c = str.codePointAt(i);
        if (c > 0xFFFF) i++;
        if (c > 127) {
            const illegal = (c >>> 8) & 7;
            if (illegal !== 7) push7(B122_ILLEGAL[illegal]);
            push7(c & 127);
        } else push7(c);
    }
    return new Uint8Array(out);
}

/** Lấy nội dung literal của window.__zip="…", gỡ escape của JS. */
function extractZipLiteral(text) {
    const key = 'window.__zip="';
    const s = text.indexOf(key);
    if (s < 0) return null;
    let i = s + key.length, out = '';
    while (i < text.length) {
        const c = text[i];
        if (c === '\\') {
            const n = text[i + 1];
            if (n === 'x') { out += String.fromCharCode(parseInt(text.substr(i + 2, 2), 16)); i += 4; }
            else if (n === 'u') { out += String.fromCharCode(parseInt(text.substr(i + 2, 4), 16)); i += 6; }
            else if (n === 'n') { out += '\n'; i += 2; }
            else if (n === 'r') { out += '\r'; i += 2; }
            else if (n === 't') { out += '\t'; i += 2; }
            else if (n === '0') { out += '\0'; i += 2; }
            else { out += n; i += 2; }
        } else if (c === '"') break;
        else { out += c; i++; }
    }
    return out;
}

/** Đọc central directory của ZIP. Không bung dữ liệu — chỉ lấy mục lục. */
function readZipIndex(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let eocd = -1;
    for (let p = buf.length - 22; p >= 0 && p > buf.length - 70000; p--) {
        if (dv.getUint32(p, true) === 0x06054b50) { eocd = p; break; }
    }
    if (eocd < 0) return null;
    const nEnt = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder('utf-8');
    const out = [];
    for (let e = 0; e < nEnt; e++) {
        if (dv.getUint32(off, true) !== 0x02014b50) break;
        const method = dv.getUint16(off + 10, true);
        const csize = dv.getUint32(off + 20, true);
        const usize = dv.getUint32(off + 24, true);
        const nlen = dv.getUint16(off + 28, true);
        const elen = dv.getUint16(off + 30, true);
        const clen = dv.getUint16(off + 32, true);
        const localOff = dv.getUint32(off + 42, true);
        const name = dec.decode(buf.subarray(off + 46, off + 46 + nlen));
        if (!name.endsWith('/')) out.push({ name, method, csize, usize, localOff });
        off += 46 + nlen + elen + clen;
    }
    return out;
}

/** Bung một entry khi cần (chỉ gọi lúc người dùng nháy đúp). */
async function inflateEntry(zip, ent) {
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const nlen = dv.getUint16(ent.localOff + 26, true);
    const elen = dv.getUint16(ent.localOff + 28, true);
    const start = ent.localOff + 30 + nlen + elen;
    const raw = zip.subarray(start, start + ent.csize);
    if (ent.method === 0) return new Blob([raw]);
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([raw]).stream().pipeThrough(ds);
    return await new Response(stream).blob();
}

/** Đổi file HTML đóng gói thành danh sách entry giống hệt chế độ thư mục. */
async function parsePackage(file, onProgress) {
    const text = await file.text();
    onProgress && onProgress('Đang tách chuỗi base122…');
    const lit = extractZipLiteral(text);
    if (!lit) throw new Error('Không tìm thấy window.__zip trong file. Đây có phải bản Bingo xuất ra không?');

    onProgress && onProgress('Đang giải mã base122…');
    await new Promise(r => setTimeout(r, 0));
    const zip = base122Decode(lit);
    if (!(zip[0] === 0x50 && zip[1] === 0x4B)) throw new Error('Giải mã xong không ra ZIP hợp lệ.');

    onProgress && onProgress('Đang đọc mục lục ZIP…');
    const index = readZipIndex(zip);
    if (!index) throw new Error('Không đọc được mục lục ZIP.');

    // size = dung lượng SAU nén, vì đó mới là chi phí thật trong gói.
    const entries = index.map(ent => ({
        path: ent.name,
        size: ent.csize,
        rawSize: ent.usize,
        getFile: () => inflateEntry(zip, ent),
    }));
    return {
        entries,
        pkg: {
            htmlSize: file.size,
            b122Chars: lit.length,
            zipSize: zip.length,
            overhead: file.size / zip.length - 1,
        },
    };
}

/* ---------------------------------------------------------------- phân tích */

function classify(relPath) {
    const lower = relPath.toLowerCase();
    if (lower.includes('cocos-js/') || lower.includes('/cocos-js')) {
        if (lower.includes('bullet')) return 'engine:physics';
        if (lower.includes('spine')) return 'engine:spine';
        if (lower.includes('dragonbones')) return 'engine:dragonbones';
        if (lower.includes('box2d')) return 'engine:box2d';
        return 'engine:core';
    }
    const ext = (lower.match(/\.[^.\/]+$/) || [''])[0];
    if (['.png', '.jpg', '.jpeg', '.webp', '.astc', '.pvr', '.ktx'].includes(ext)) return 'texture';
    if (ext === '.bin') return 'mesh/anim';
    if (ext === '.json') return 'data';
    if (['.mp3', '.ogg', '.wav', '.m4a'].includes(ext)) return 'audio';
    if (['.js', '.wasm', '.mjs'].includes(ext)) return 'script';
    return 'other';
}

const UUID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(@[^.]+)?/i;
function parseUuid(fileName) {
    const base = fileName.replace(/\.[^.]+$/, '');
    const m = base.match(UUID_RE);
    return m ? { full: m[1] + (m[2] || ''), root: m[1] } : null;
}

/** Đọc mọi .meta trong assets/ để dịch uuid thành tên asset dễ đọc. */
async function buildNameMap(entries, onProgress) {
    const metas = entries.filter(e => e.path.endsWith('.meta') && /(^|\/)assets\//i.test(e.path));
    const map = new Map();
    let done = 0;
    for (const m of metas) {
        try {
            const json = JSON.parse(await m.file.text());
            const owner = m.path.split('/').pop().replace(/\.meta$/, '');
            if (json.uuid) map.set(json.uuid, { name: owner, sub: null });
            for (const key of Object.keys(json.subMetas || {})) {
                const s = json.subMetas[key];
                if (s.uuid) map.set(s.uuid, { name: owner, sub: s.name || s.importer || key });
            }
        } catch (_) { /* .meta hỏng thì bỏ qua */ }
        if (++done % 40 === 0 && onProgress) {
            onProgress(done, metas.length);
            await new Promise(r => setTimeout(r, 0));
        }
    }
    return { map, metaCount: metas.length };
}

/** Gắn kind + tên asset cho từng file. Cây được dựng sau, theo chế độ người dùng chọn. */
function prepare(buildFiles, nameMap) {
    for (const f of buildFiles) {
        f.kind = classify(f.path);
        const name = f.path.split('/').pop();
        const u = parseUuid(name);
        f.uuidRoot = u ? u.root : null;
        const hit = u && (nameMap.get(u.full) || nameMap.get(u.root));
        f.assetName = hit ? hit.name : null;
        f.subName = hit && hit.sub ? hit.sub : null;
    }
    const byKind = {}, rawByKind = {};
    for (const f of buildFiles) {
        byKind[f.kind] = (byKind[f.kind] || 0) + f.size;
        rawByKind[f.kind] = (rawByKind[f.kind] || 0) + (f.rawSize || f.size);
    }
    return {
        total: buildFiles.reduce((s, f) => s + f.size, 0),
        totalRaw: buildFiles.reduce((s, f) => s + (f.rawSize || f.size), 0),
        count: buildFiles.length,
        byKind, rawByKind, files: buildFiles,
    };
}

const groupBy = (list, keyOf) => {
    const m = new Map();
    for (const f of list) {
        const k = keyOf(f);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(f);
    }
    return m;
};
const bySize = (a, b) => b.size - a.size;
const sumSize = list => list.reduce((s, f) => s + f.size, 0);
const dirOf = p => { const i = p.lastIndexOf('/'); return i < 0 ? '/' : p.slice(0, i); };

/** Tên nhóm asset: ưu tiên tên thật từ .meta, không có thì uuid rút gọn, cuối cùng là thư mục. */
const assetKey = f => f.assetName || (f.uuidRoot ? f.uuidRoot.slice(0, 8) + '…' : dirOf(f.path));

/** Lá của cây: một file cụ thể. `src` giữ entry gốc để nháy đúp còn mở được nội dung. */
function leafNode(f, showOwner) {
    const fileName = f.path.split('/').pop();
    const label = showOwner && f.assetName
        ? f.assetName + (f.subName ? ' › ' + f.subName : '')
        : (f.subName || fileName);
    // Ở chế độ file đóng gói, ghi thêm tỉ lệ nén — nó cho biết còn ép được nữa không.
    let detail = label === fileName ? null : fileName;
    if (f.rawSize && f.rawSize !== f.size) {
        const pct = Math.round(f.size / f.rawSize * 100);
        detail = (detail ? detail + '  ' : '') + KB(f.rawSize) + ' KB → ' + pct + '%';
    }
    return { name: label, detail, size: f.size, kind: f.kind, src: f };
}

/**
 * mode 'kind'  : Assets → Texture → (asset) → file   — luôn đọc được, kể cả khi thiếu .meta
 * mode 'asset' : Assets → OnlyBike.fbx → Texture → file — hữu ích khi đã tra được tên asset
 */
function buildTree(files, mode) {
    const engineFiles = files.filter(f => f.kind.startsWith('engine:'));
    const assetFiles = files.filter(f => !f.kind.startsWith('engine:'));

    // Nhánh trong: nhóm theo loại, mỗi loại xổ thẳng ra file
    const kindNode = (kind, list) => ({
        name: KIND_LABEL[kind] || kind, kind, size: sumSize(list), files: list.length,
        children: list.slice().sort(bySize).map(f => leafNode(f, true)),
    });

    // Nhánh trong: nhóm theo loại rồi mới tới asset, dùng khi một loại trải trên nhiều asset
    const kindThenAsset = (kind, list) => {
        const groups = [...groupBy(list, assetKey).entries()];
        if (groups.length === 1) return kindNode(kind, list);
        return {
            name: KIND_LABEL[kind] || kind, kind, size: sumSize(list), files: list.length,
            children: groups.map(([name, arr]) => ({
                name, kind, size: sumSize(arr), files: arr.length,
                children: arr.slice().sort(bySize).map(f => leafNode(f, false)),
            })).sort(bySize),
        };
    };

    // Nhánh trong: một asset, bên dưới chia theo loại
    const assetNode = (name, list) => {
        let children = [...groupBy(list, f => f.kind).entries()]
            .map(([k, arr]) => ({
                name: KIND_LABEL[k] || k, kind: k, size: sumSize(arr), files: arr.length,
                children: arr.slice().sort(bySize).map(f => leafNode(f, false)),
            })).sort(bySize);
        if (children.length === 1) children = children[0].children;  // bỏ tầng thừa
        return { name, size: sumSize(list), files: list.length, children };
    };

    const branch = (label, kind, list, makeChild) => {
        if (!list.length) return null;
        const children = [...makeChild(list)].sort(bySize);
        return { name: label, kind, size: sumSize(list), files: list.length, children };
    };

    const assetsBranch = mode === 'kind'
        ? branch('Assets', 'texture', assetFiles,
            l => [...groupBy(l, f => f.kind).entries()].map(([k, arr]) => kindThenAsset(k, arr)))
        : branch('Assets', 'texture', assetFiles,
            l => [...groupBy(l, assetKey).entries()].map(([n, arr]) => assetNode(n, arr)));

    const engineBranch = branch('Engine', 'engine:core', engineFiles,
        l => [...groupBy(l, f => f.kind).entries()].map(([k, arr]) => kindNode(k, arr)));

    return [assetsBranch, engineBranch].filter(Boolean).sort(bySize);
}

/* ---------------------------------------------------------------- render */

let seq = 0;
function nodeHtml(node, depth, parentSize) {
    const hasKids = node.children && node.children.length;
    const share = parentSize ? (node.size * 100 / parentSize) : 100;
    const color = COLOR[node.kind] || 'var(--accent)';
    const id = 'n' + (++seq);

    // Lá mở xem được: chế độ thư mục có sẵn File, chế độ đóng gói thì bung khi cần.
    const canOpen = !hasKids && node.src && (node.src.file || node.src.getFile);
    const openIdx = canOpen ? openable.push(node.src) - 1 : -1;

    let html = '<button class="row lv' + depth + (hasKids ? '' : ' leaf') +
        (canOpen ? ' openable' : '') + '"' +
        (hasKids ? ' data-target="' + id + '"' : '') +
        (canOpen ? ' data-open="' + openIdx + '" title="Nháy đúp để xem nội dung"' : '') + '>' +
        '<span class="name">' +
        '<span class="caret">' + (hasKids ? '▶' : '') + '</span>' +
        '<span class="dot" style="background:' + color + '"></span>' +
        '<span class="txt">' + esc(node.name) +
        (node.files ? '<em>' + node.files + ' file</em>' : '') +
        (node.detail ? '<em>' + esc(node.detail) + '</em>' : '') +
        '</span></span>' +
        '<span class="mini"><i style="width:' + share.toFixed(1) + '%;background:' + color + '"></i></span>' +
        '<span class="sz">' + KB(node.size) + ' KB<i>' + share.toFixed(0) + '%</i></span>' +
        '</button>';

    if (hasKids) {
        html += '<div class="kids" id="' + id + '">' +
            node.children.map(c => nodeHtml(c, Math.min(depth + 1, 3), node.size)).join('') +
            '</div>';
    }
    return html;
}

/** Vẽ lại riêng phần cây — gọi khi đổi chế độ nhóm, không phải đọc lại file. */
function renderTree() {
    if (!state.res) return;
    const tree = buildTree(state.res.files, state.mode);
    seq = 0;
    openable = [];
    $('tree').innerHTML = tree.map(t => nodeHtml(t, 0, state.res.total)).join('');
    $('tree').querySelectorAll('.row[data-target]').forEach(btn => {
        btn.addEventListener('click', () => {
            const kids = document.getElementById(btn.dataset.target);
            btn.classList.toggle('open', kids.classList.toggle('open'));
        });
    });
    $('tree').querySelectorAll('.row.lv0[data-target]').forEach(btn => btn.click());
}

// Nháy đúp vào một file lá → mở tab xem. Uỷ quyền sự kiện nên không cần gắn lại sau mỗi render.
$('tree').addEventListener('dblclick', e => {
    const row = e.target.closest('.row[data-open]');
    if (!row) return;
    const entry = openable[Number(row.dataset.open)];
    if (entry) openAssetViewer(entry);
});

function render(res, meta) {
    state.res = res;
    const pct = n => (n * 100 / res.total).toFixed(1);
    const engineSize = sumSize(res.files.filter(f => f.kind.startsWith('engine:')));
    const assetSize = res.total - engineSize;
    const tex = res.byKind['texture'] || 0;

    const stats = meta.pkg
        ? [
            { k: 'File HTML', v: MB(meta.pkg.htmlSize), sub: 'thứ ad network nhận' },
            { k: 'ZIP bên trong', v: MB(meta.pkg.zipSize), sub: 'base122 phụ trội +' + (meta.pkg.overhead * 100).toFixed(1) + '%' },
            { k: 'Trước nén', v: MB(res.totalRaw), sub: 'nén còn ' + Math.round(res.total / res.totalRaw * 100) + '%' },
            { k: 'Texture', v: MB(tex), sub: pct(tex) + '% gói' },
        ]
        : [
            { k: 'Tổng build', v: MB(res.total), sub: res.count + ' file' },
            { k: 'Assets', v: MB(assetSize), sub: pct(assetSize) + '% tổng build' },
            { k: 'Engine', v: MB(engineSize), sub: pct(engineSize) + '% tổng build' },
            { k: 'Texture', v: MB(tex), sub: pct(tex) + '% tổng build' },
        ];
    $('stats').innerHTML = stats.map(s =>
        '<div class="stat"><div class="k">' + s.k + '</div>' +
        '<div class="v">' + s.v + ' <small>MB</small></div>' +
        '<div class="sub">' + s.sub + '</div></div>').join('');

    const kinds = Object.entries(res.byKind).sort((a, b) => b[1] - a[1]);
    const maxKind = kinds.length ? kinds[0][1] : 1;

    $('stack').innerHTML = kinds.map(([k, v]) =>
        '<i style="width:' + (v * 100 / res.total).toFixed(2) + '%;background:' + COLOR[k] + '" title="' +
        esc(KIND_LABEL[k] || k) + ' — ' + KB(v) + ' KB"></i>').join('');

    $('legend').innerHTML = kinds.map(([k, v]) =>
        '<div><b style="background:' + COLOR[k] + '"></b>' + esc(KIND_LABEL[k] || k) +
        ' <em>' + KB(v) + ' KB</em></div>').join('');

    $('bars').innerHTML = kinds.map(([k, v]) => {
        const raw = res.rawByKind ? res.rawByKind[k] : 0;
        // Tỉ lệ nén 100% = dữ liệu đã nén sẵn, cắt bao nhiêu byte là mất đúng bấy nhiêu.
        const ratio = (raw && raw !== v) ? '<i title="tỉ lệ nén">' + Math.round(v / raw * 100) + '% nén</i>' : '';
        return '<div class="bar"><div class="lbl">' + esc(KIND_LABEL[k] || k) + '</div>' +
            '<div class="track"><div class="fill" style="width:' + (v * 100 / maxKind).toFixed(1) +
            '%;background:' + COLOR[k] + '"></div></div>' +
            '<div class="num">' + KB(v) + ' KB<i>' + pct(v) + '%</i>' + ratio + '</div></div>';
    }).join('');

    renderTree();

    $('file-count').textContent = res.count + ' file';
    $('summary-name').textContent = meta.rootName;
    $('summary-meta').textContent = res.count + ' file · ' + MB(res.total) + ' MB' +
        (meta.metaCount ? ' · đọc ' + meta.metaCount + ' file .meta' : '');
    $('summary').hidden = false;
    $('clear-btn').hidden = false;

    if (meta.pkg) {
        $('name-notice').innerHTML = 'Số liệu là <b>dung lượng sau nén trong ZIP</b> — chi phí thật của từng file ' +
            'trong gói, không phải kích thước gốc. Cột <code>% nén</code> gần 100% nghĩa là dữ liệu đã nén sẵn ' +
            '(ảnh, âm thanh): cắt bao nhiêu byte ở đó là giảm đúng bấy nhiêu ở file cuối.';
        $('name-notice').hidden = false;
    } else if (meta.metaCount === 0) {
        $('name-notice').innerHTML = 'Không tìm thấy <code>assets/</code> nên tên asset hiển thị dưới dạng uuid rút gọn. ' +
            'Kéo cả thư mục project vào để thấy tên thật.';
        $('name-notice').hidden = false;
    } else {
        $('name-notice').hidden = true;
    }

    if (res.total > BUDGET) {
        $('budget-notice').innerHTML = '<b>Vượt ngân sách playable.</b> Nhiều ad network giới hạn 5 MB, một số chỉ 2 MB. ' +
            'Build hiện tại <b>' + MB(res.total) + ' MB</b> — cần cắt ' + MB(res.total - BUDGET) + ' MB.';
        $('budget-notice').hidden = false;
    } else {
        $('budget-notice').hidden = true;
    }

    $('result').hidden = false;
}

/* ---------------------------------------------------------------- xem asset */

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.svg']);
const TEXT_EXT = new Set(['.json', '.js', '.mjs', '.css', '.html', '.txt', '.xml', '.md',
    '.effect', '.chunk', '.meta', '.ts', '.yaml', '.yml']);

const extOf = name => (String(name).toLowerCase().match(/\.[^.\/]+$/) || [''])[0];
const fmtSize = n => n >= 1048576 ? MB(n) + ' MB' : KB(n) + ' KB';
const isPot = n => n > 0 && (n & (n - 1)) === 0;

/** Hex + ASCII cho file nhị phân — đủ để nhìn magic byte và đoán định dạng. */
function hexDump(buf, limit = 4096) {
    const b = new Uint8Array(buf.slice(0, Math.min(buf.byteLength, limit)));
    const out = [];
    for (let i = 0; i < b.length; i += 16) {
        const row = Array.from(b.subarray(i, i + 16));
        const hex = row.map(x => x.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
        const asc = row.map(x => (x >= 32 && x < 127) ? String.fromCharCode(x) : '.').join('');
        out.push(i.toString(16).padStart(8, '0') + '  ' + hex + '  ' + asc);
    }
    return out.join('\n');
}

/* Khung tab xem. Không nhúng <script> — mọi tương tác gắn từ tab cha qua DOM,
   nên không phải lo escape và cũng chạy được khi mở bằng file://. */
const VIEWER_SHELL = `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><title>__TITLE__</title><style>
*{box-sizing:border-box}
body{margin:0;background:#0b0d10;color:#f3f5f7;
 font:14px/1.5 ui-sans-serif,system-ui,"Segoe UI",sans-serif;
 display:flex;flex-direction:column;min-height:100vh}
header{display:flex;align-items:center;gap:16px;padding:12px 18px;
 border-bottom:1px solid #1c2128;background:#0f1216;position:sticky;top:0;z-index:2}
header .ttl{min-width:0;flex:1}
header strong{display:block;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
header span{display:block;margin-top:2px;color:#8b96a5;font-size:11px;
 font-family:ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
header .acts{display:flex;gap:8px;flex:none}
header button,header a{padding:6px 13px;border:1px solid #1c2128;border-radius:999px;
 background:#0b0d10;color:#8b96a5;font-size:12px;cursor:pointer;text-decoration:none;
 font-family:inherit;transition:color .15s,border-color .15s}
header button:hover,header a:hover{color:#b9f34a;border-color:#b9f34a}
header button.on{color:#111706;background:#b9f34a;border-color:#b9f34a}
main{flex:1;display:flex;align-items:center;justify-content:center;padding:22px;overflow:auto}
main.text,main.hex{align-items:flex-start;justify-content:flex-start}
.loading{color:#8b96a5;font-size:13px}
.imgwrap{max-width:100%;
 background-image:linear-gradient(45deg,#1a1e24 25%,transparent 25%),
 linear-gradient(-45deg,#1a1e24 25%,transparent 25%),
 linear-gradient(45deg,transparent 75%,#1a1e24 75%),
 linear-gradient(-45deg,transparent 75%,#1a1e24 75%);
 background-size:20px 20px;background-position:0 0,0 10px,10px -10px,-10px 0;
 border:1px solid #1c2128;border-radius:10px;overflow:auto}
.imgwrap img{display:block;max-width:100%;height:auto;image-rendering:auto}
.imgwrap.raw{overflow:auto}
.imgwrap.raw img{max-width:none;image-rendering:pixelated}
pre{margin:0;width:100%;font:12px/1.6 ui-mono,ui-monospace,Consolas,monospace;
 white-space:pre;color:#cfd6de;tab-size:2}
.note{color:#8b96a5;font-size:12px;margin-bottom:10px}
.err{color:#ff9d5c;font-size:13px}
.pot{color:#b9f34a}.npot{color:#ff9d5c}
</style></head><body>
<header>
 <div class="ttl"><strong id="v-name">…</strong><span id="v-meta"></span></div>
 <div class="acts"><button id="v-zoom" hidden>1:1</button><a id="v-dl" download>Tải về</a></div>
</header>
<main id="v-stage"><div class="loading">Đang đọc file…</div></main>
</body></html>`;

/**
 * Mở file trong tab mới. Cửa sổ phải được mở NGAY trong sự kiện chuột, nếu chờ
 * đọc file xong mới mở thì trình duyệt coi là popup tự phát và chặn.
 */
async function openAssetViewer(entry) {
    const name = entry.path.split('/').pop();
    const ext = extOf(name);

    // Cửa sổ phải mở NGAY trong sự kiện chuột, nếu chờ bung dữ liệu xong mới mở thì bị chặn popup.
    const w = window.open('', '_blank');
    if (!w) {
        alert('Trình duyệt đã chặn cửa sổ mới. Hãy cho phép popup cho trang này rồi thử lại.');
        return;
    }
    w.document.write(VIEWER_SHELL.replace('__TITLE__', esc(name)));
    w.document.close();

    const doc = w.document;
    const stage = doc.getElementById('v-stage');
    const setMeta = txt => { doc.getElementById('v-meta').textContent = txt; };
    doc.getElementById('v-name').textContent = name;
    setMeta(entry.path + '  ·  ' + fmtSize(entry.size));

    // Chế độ thư mục có File sẵn; chế độ đóng gói phải bung deflate ra trước.
    let file = entry.file;
    if (!file) {
        try { file = await entry.getFile(); }
        catch (err) {
            stage.innerHTML = '<div class="err">Không bung được dữ liệu: ' + esc(err.message) + '</div>';
            return;
        }
        setMeta(entry.path + '  ·  ' + fmtSize(entry.size) + ' nén  ·  ' + fmtSize(file.size) + ' gốc');
    }

    const url = URL.createObjectURL(file);
    const dl = doc.getElementById('v-dl');
    dl.href = url;
    dl.download = name;
    w.addEventListener('unload', () => URL.revokeObjectURL(url));

    if (IMAGE_EXT.has(ext)) {
        showImage(w, doc, stage, url, entry);
        return;
    }

    const asText = TEXT_EXT.has(ext);
    file[asText ? 'text' : 'arrayBuffer']()
        .then(data => {
            if (asText) {
                let body = data;
                if (ext === '.json') {
                    try { body = JSON.stringify(JSON.parse(data), null, 2); } catch (_) { /* để nguyên */ }
                }
                stage.className = 'text';
                stage.innerHTML = '<pre>' + esc(body) + '</pre>';
            } else {
                stage.className = 'hex';
                const shown = Math.min(data.byteLength, 4096);
                stage.innerHTML =
                    '<div style="width:100%">' +
                    '<div class="note">Nhị phân — hiện ' + KB(shown) + ' KB đầu / ' +
                    fmtSize(data.byteLength) + '. Dùng nút Tải về để lấy nguyên file.</div>' +
                    '<pre>' + esc(hexDump(data)) + '</pre></div>';
            }
        })
        .catch(err => { stage.innerHTML = '<div class="err">Không đọc được file: ' + esc(err.message) + '</div>'; });
}

/** Ảnh: nền carô để thấy vùng trong suốt, kèm kích thước thật và cảnh báo NPOT. */
function showImage(w, doc, stage, url, entry) {
    stage.className = '';
    stage.innerHTML = '<div class="imgwrap" id="v-wrap"><img id="v-img" alt=""></div>';
    const wrap = doc.getElementById('v-wrap');
    const img = doc.getElementById('v-img');
    const zoom = doc.getElementById('v-zoom');

    img.onload = () => {
        const iw = img.naturalWidth, ih = img.naturalHeight;
        const pot = isPot(iw) && isPot(ih);
        doc.getElementById('v-meta').innerHTML =
            esc(entry.path) + '  ·  ' + fmtSize(entry.size) + '  ·  ' + iw + '×' + ih + '  ' +
            '<b class="' + (pot ? 'pot' : 'npot') + '">' + (pot ? 'POT' : 'NPOT') + '</b>';

        // Chỉ cho phóng 1:1 khi ảnh thật sự lớn hơn khung, nếu không nút vô nghĩa.
        if (iw > wrap.clientWidth) {
            zoom.hidden = false;
            zoom.addEventListener('click', () => {
                const on = wrap.classList.toggle('raw');
                zoom.classList.toggle('on', on);
                zoom.textContent = on ? 'Vừa khung' : '1:1';
            });
        }
    };
    img.onerror = () => {
        stage.innerHTML = '<div class="err">Không hiển thị được ảnh này. ' +
            'Có thể là định dạng nén GPU (ASTC/PVR/KTX) mà trình duyệt không đọc được — hãy dùng nút Tải về.</div>';
    };
    img.src = url;
}

/* ---------------------------------------------------------------- luồng chính */

async function process(entries, rootName) {
    if (!entries.length) { fail('Thư mục rỗng hoặc không đọc được.'); return; }

    // Nếu kéo cả project: chỉ thống kê phần trong build/, phần assets/ dùng để tra tên.
    const hasBuildDir = entries.some(e => /(^|\/)build\//i.test(e.path));
    const buildFiles = hasBuildDir
        ? entries.filter(e => /(^|\/)build\//i.test(e.path))
        : entries.filter(e => !e.path.endsWith('.meta'));

    if (!buildFiles.length) { fail('Không tìm thấy file build nào trong thư mục này.'); return; }

    busy('Đang đọc .meta để tra tên asset…');
    const { map, metaCount } = await buildNameMap(entries, (d, t) => busy('Đang đọc .meta… ' + d + '/' + t));

    busy('Đang tổng hợp…');
    await new Promise(r => setTimeout(r, 0));
    const res = prepare(buildFiles, map);

    $('busy').hidden = true;
    render(res, { rootName, metaCount });
}

/** Luồng cho file playable đã đóng gói. Không có .meta nên tên asset chỉ là uuid. */
async function processPackage(file) {
    busy('Đang đọc file…');
    await new Promise(r => setTimeout(r, 0));
    let parsed;
    try {
        parsed = await parsePackage(file, t => busy(t));
    } catch (err) {
        fail(err.message);
        return;
    }
    busy('Đang tổng hợp…');
    await new Promise(r => setTimeout(r, 0));
    const res = prepare(parsed.entries, new Map());
    $('busy').hidden = true;
    render(res, { rootName: file.name, metaCount: -1, pkg: parsed.pkg });
}

function busy(text) {
    $('busy-text').textContent = text;
    $('busy').hidden = false;
    $('result').hidden = true;
}
function fail(msg) {
    $('busy').hidden = true;
    $('summary').hidden = false;
    $('summary-name').textContent = msg;
    $('summary-meta').textContent = '';
    const pill = $('summary-pill');
    pill.textContent = 'Lỗi';
    pill.className = 'status-pill error';
}

const dropZone = $('drop-zone');

['dragenter', 'dragover'].forEach(ev => dropZone.addEventListener(ev, e => {
    e.preventDefault(); e.stopPropagation();
    dropZone.classList.add('dragging');
}));
['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, e => {
    e.preventDefault(); e.stopPropagation();
    if (ev === 'dragleave' && dropZone.contains(e.relatedTarget)) return;
    dropZone.classList.remove('dragging');
}));

dropZone.addEventListener('drop', async e => {
    const items = [...e.dataTransfer.items]
        .map(i => i.webkitGetAsEntry && i.webkitGetAsEntry())
        .filter(Boolean);
    if (!items.length) { fail('Trình duyệt không đọc được thư mục này. Thử bấm để chọn thay vì kéo thả.'); return; }

    busy('Đang quét thư mục…');
    const entries = [];
    try {
        for (const it of items) await walkEntry(it, entries);
    } catch (err) {
        // Mở bằng file:// thì Chrome chặn đọc thư mục qua kéo thả (lỗi "malformed URI" /
        // "Data URL exceeded length"). Nút chọn thư mục đi đường khác nên vẫn dùng được.
        const blocked = location.protocol === 'file:';
        fail(blocked
            ? 'Trình duyệt chặn kéo thả thư mục khi mở bằng file://. Hãy BẤM vào ô để chọn thư mục, hoặc chạy serve.bat rồi mở http://localhost:8080'
            : 'Lỗi khi đọc thư mục: ' + err.message);
        return;
    }
    if (!entries.length) {
        fail('Không đọc được file nào. Thử bấm vào ô để chọn thư mục thay vì kéo thả.');
        return;
    }
    await process(entries, items.map(i => i.name).join(', '));
});

$('dir-input').addEventListener('change', async e => {
    if (!e.target.files.length) return;
    busy('Đang quét thư mục…');
    await new Promise(r => setTimeout(r, 0));
    const entries = fromInput(e.target.files);
    const root = (e.target.files[0].webkitRelativePath || '').split('/')[0] || 'Thư mục';
    await process(entries, root);
});

$('mode-switch').addEventListener('click', e => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn || btn.dataset.mode === state.mode) return;
    state.mode = btn.dataset.mode;
    $('mode-switch').querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    renderTree();
});

/* ---------------------------------------------- nguồn: thư mục hay file đóng gói */

const pkgZone = $('pkg-zone');

['dragenter', 'dragover'].forEach(ev => pkgZone.addEventListener(ev, e => {
    e.preventDefault(); e.stopPropagation();
    pkgZone.classList.add('dragging');
}));
['dragleave', 'drop'].forEach(ev => pkgZone.addEventListener(ev, e => {
    e.preventDefault(); e.stopPropagation();
    if (ev === 'dragleave' && pkgZone.contains(e.relatedTarget)) return;
    pkgZone.classList.remove('dragging');
}));

pkgZone.addEventListener('drop', async e => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) { fail('Không nhận được file. Thử bấm để chọn.'); return; }
    await processPackage(f);
});

$('pkg-input').addEventListener('change', async e => {
    if (!e.target.files.length) return;
    await processPackage(e.target.files[0]);
});

$('source-switch').addEventListener('click', e => {
    const btn = e.target.closest('button[data-source]');
    if (!btn || btn.dataset.source === state.source) return;
    state.source = btn.dataset.source;
    $('source-switch').querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    const isPkg = state.source === 'pkg';
    $('drop-zone').hidden = isPkg;
    pkgZone.hidden = !isPkg;
    $('input-title').textContent = isPkg ? 'Chọn file playable đã đóng gói' : 'Chọn thư mục build';
    $('summary').hidden = true;
    $('result').hidden = true;
    $('clear-btn').hidden = true;
    $('name-notice').hidden = true;
    $('budget-notice').hidden = true;
});

$('clear-btn').addEventListener('click', () => {
    $('dir-input').value = '';
    $('pkg-input').value = '';
    $('summary').hidden = true;
    $('clear-btn').hidden = true;
    $('result').hidden = true;
    $('name-notice').hidden = true;
    $('budget-notice').hidden = true;
    $('summary-pill').textContent = 'Đã đọc';
    $('summary-pill').className = 'status-pill success';
});
