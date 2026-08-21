/* Mô hình asset của Cocos Creator: đọc .meta, sinh .meta giữ nguyên UUID, quét tham chiếu.
   Không biết gì về ffmpeg. */

'use strict';
const fs = require('fs');
const path = require('path');

/* Sub-asset id là HẰNG SỐ theo loại, không phải hash ngẫu nhiên.
   Nhờ vậy giữ nguyên uuid gốc là mọi tham chiếu <uuid>@<subid> tự khớp. */
const SUB_TEXTURE = '6c48a';
const SUB_SPRITE_FRAME = 'f9941';
const SUB_TEXTURE_CUBE = 'b47c0';

/** Mọi file trong một cây thư mục, bỏ qua thư mục Cocos sinh ra. */
const SKIP_DIRS = new Set(['library', 'temp', 'build', 'node_modules', '.git', 'profiles', '.creator']);

function walk(dir, out = []) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name.toLowerCase())) walk(p, out);
        } else out.push(p);
    }
    return out;
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

/** Phần mở rộng được coi là media, dùng khi quét file lẻ không có .meta. */
const LOOSE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.mp3', '.wav', '.ogg', '.m4a', '.aac']);

/**
 * Liệt kê asset trong assets/, kèm thông tin cần cho việc quyết định.
 *
 * Mặc định chỉ lấy file CÓ `.meta` — dự án Cocos thật luôn có, và không có `.meta`
 * thì không giữ được UUID. Nhưng giao diện web cho phép thả file lẻ, nên
 * `includeLoose` bật lên sẽ nhận cả file trần: vẫn tối ưu được, chỉ là bản xuất ra
 * không mang UUID nên phải gán lại tay trong Editor.
 */
function scanAssets(projectDir, { includeLoose = false } = {}) {
    const assetsDir = path.join(projectDir, 'assets');
    if (!fs.existsSync(assetsDir)) return null;

    const out = [];
    const claimed = new Set();
    const files = walk(assetsDir);

    for (const file of files) {
        if (!file.endsWith('.meta')) continue;
        const src = file.slice(0, -5);
        if (!fs.existsSync(src)) continue;
        let st;
        try { st = fs.statSync(src); } catch (_) { continue; }
        if (st.isDirectory()) continue;

        const meta = readJson(file);
        if (!meta || !meta.uuid) continue;

        const subImporters = Object.values(meta.subMetas || {}).map(s => s.importer);
        claimed.add(src);
        out.push({
            file: src,
            metaFile: file,
            rel: path.relative(projectDir, src).split(path.sep).join('/'),
            ext: path.extname(src).toLowerCase(),
            size: st.size,
            uuid: meta.uuid,
            importer: meta.importer,
            meta,
            subImporters,
            hasSpriteFrame: subImporters.includes('sprite-frame'),
            inAutoAtlas: fs.existsSync(path.join(path.dirname(src), 'auto-atlas.pac')),
        });
    }

    if (includeLoose) {
        for (const file of files) {
            if (file.endsWith('.meta') || claimed.has(file)) continue;
            const ext = path.extname(file).toLowerCase();
            if (!LOOSE_EXT.has(ext)) continue;
            let st;
            try { st = fs.statSync(file); } catch (_) { continue; }
            if (st.isDirectory()) continue;

            out.push({
                file,
                metaFile: null,          // không có .meta -> không giữ được UUID
                rel: path.relative(projectDir, file).split(path.sep).join('/'),
                ext, size: st.size,
                uuid: null, importer: null, meta: null,
                subImporters: [], hasSpriteFrame: false,
                inAutoAtlas: fs.existsSync(path.join(path.dirname(file), 'auto-atlas.pac')),
            });
        }
    }
    return out;
}

/**
 * Mọi uuid được tham chiếu ở đâu đó trong dự án.
 *
 * QUAN TRỌNG: phải quét cả .meta — material override trong .fbx.meta tham chiếu texture.
 * Bỏ sót nó sẽ báo nhầm asset đang dùng là mồ côi (lỗi đã gặp thật khi làm tay).
 */
function scanReferences(projectDir) {
    const refs = new Set();
    const re = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
    for (const file of walk(path.join(projectDir, 'assets'))) {
        if (!/\.(scene|prefab|mtl|material|anim|meta|ts|json)$/i.test(file)) continue;
        let text;
        try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
        // uuid của chính file .meta đó không tính là "được tham chiếu"
        const selfUuid = file.endsWith('.meta') ? (readJson(file) || {}).uuid : null;
        for (const m of text.matchAll(re)) {
            if (m[0] !== selfUuid) refs.add(m[0]);
        }
    }
    return refs;
}

/**
 * Sinh .meta cho file thay thế, GIỮ NGUYÊN uuid và toàn bộ subMetas.
 *
 * `files` giữ danh sách phần mở rộng đã sinh trong library/ (['.png', '.json']).
 * Để nguyên là trỏ tới file không còn tồn tại. subMetas lồng nhau nhiều tầng —
 * cubemap của skybox lồng tới 7 tầng — nên phải duyệt đệ quy, không chỉ tầng đầu.
 */
function metaForReplacement(oldMeta) {
    const meta = JSON.parse(JSON.stringify(oldMeta));
    (function reset(node) {
        node.imported = false;
        node.files = [];
        for (const sub of Object.values(node.subMetas || {})) reset(sub);
    })(meta);
    return meta;
}

/**
 * Kiểm tra bản .meta sinh ra có giữ đúng danh tính không — dùng để tự xác minh.
 * Duyệt hết mọi tầng: mất một uuid lồng sâu cũng đủ làm gãy tham chiếu.
 */
function metaIdentityMatches(oldMeta, newMeta) {
    const ids = (node, prefix = '') => {
        const out = [prefix + '=' + node.uuid];
        for (const [k, s] of Object.entries(node.subMetas || {}).sort())
            out.push(...ids(s, prefix + '/' + k));
        return out;
    };
    return ids(oldMeta).join('|') === ids(newMeta).join('|');
}

/** Băm nội dung file — dùng để phát hiện hai asset khác tên nhưng trùng byte. */
function contentHash(file) {
    try {
        return require('crypto').createHash('md5').update(fs.readFileSync(file)).digest('hex');
    } catch (_) { return null; }
}

/**
 * uuid nào THỰC SỰ có mặt trong build, kèm dung lượng file đã đóng gói.
 *
 * Quan trọng vì dung lượng nguồn không phải dung lượng xuất xưởng: importer
 * chuyển đổi, atlas packer gộp lại, và bộ lọc phụ thuộc loại bỏ asset mồ côi.
 * Không có bước này thì một file mồ côi 20 MB sẽ chiếm hết mọi phần trăm trong
 * báo cáo trong khi nó không đóng góp một byte nào cho gói cuối.
 */
function scanBuild(buildDir) {
    if (!buildDir || !fs.existsSync(buildDir)) return null;
    const byUuid = new Map();
    for (const file of walk(buildDir)) {
        // tên file trong native/ có dạng <uuid>.<ext> hoặc <uuid>@<sub>.<ext>
        const m = path.basename(file).match(/^([0-9a-f]{8}-[0-9a-f-]{27})/i);
        if (!m) continue;
        let size = 0;
        try { size = fs.statSync(file).size; } catch (_) { continue; }
        const u = m[1].toLowerCase();
        byUuid.set(u, (byUuid.get(u) || 0) + size);
    }
    return byUuid;
}

/**
 * Ảnh atlas do Cocos sinh lúc build. Chúng KHÔNG có file nguồn trong assets/ —
 * packer gộp nhiều sprite rồi mã hoá lại — nên nằm ngoài tầm với của tool này.
 * Nhận ra chúng vì tên là uuid rút gọn, không phải uuid đầy đủ.
 */
function findAtlases(buildDir) {
    if (!buildDir || !fs.existsSync(buildDir)) return [];
    const out = [];
    for (const file of walk(buildDir)) {
        const name = path.basename(file);
        if (!/\.(png|jpg|webp)$/i.test(name)) continue;
        if (/^[0-9a-f]{8}-[0-9a-f-]{27}/i.test(name)) continue;   // asset thường
        try { out.push({ file, name, size: fs.statSync(file).size }); } catch (_) { }
    }
    return out.sort((a, b) => b.size - a.size);
}

module.exports = {
    SUB_TEXTURE, SUB_SPRITE_FRAME, SUB_TEXTURE_CUBE,
    walk, readJson, scanAssets, scanReferences, scanBuild, findAtlases, contentHash,
    metaForReplacement, metaIdentityMatches,
};
