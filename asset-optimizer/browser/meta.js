/* Mô hình asset của Cocos Creator, bản chạy trong trình duyệt.
   Chỉ xử lý văn bản .meta — không đụng gì tới hệ thống file. */

(function (global) {
    'use strict';

    /* Sub-asset id là HẰNG SỐ theo loại, không phải hash ngẫu nhiên.
       Nhờ vậy giữ nguyên uuid gốc là mọi tham chiếu <uuid>@<subid> tự khớp. */
    const SUB_TEXTURE = '6c48a';
    const SUB_SPRITE_FRAME = 'f9941';
    const SUB_TEXTURE_CUBE = 'b47c0';

    const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

    /**
     * Sinh .meta cho file thay thế, GIỮ NGUYÊN uuid và toàn bộ subMetas.
     *
     * `files` giữ danh sách phần mở rộng đã sinh trong library/ (['.png', '.json']).
     * Để nguyên là trỏ tới file không còn tồn tại. subMetas lồng nhiều tầng —
     * cubemap của skybox lồng tới 8 node — nên phải duyệt ĐỆ QUY.
     */
    function forReplacement(oldMeta) {
        const meta = JSON.parse(JSON.stringify(oldMeta));
        (function reset(node) {
            node.imported = false;
            node.files = [];
            for (const sub of Object.values(node.subMetas || {})) reset(sub);
        })(meta);
        return meta;
    }

    /** Mọi uuid ở mọi tầng, dùng để tự xác minh danh tính không đổi. */
    function idsOf(node, prefix = '') {
        const out = [prefix + '=' + node.uuid];
        for (const [k, s] of Object.entries(node.subMetas || {}).sort())
            out.push(...idsOf(s, prefix + '/' + k));
        return out;
    }

    function identityMatches(a, b) {
        return idsOf(a).join('|') === idsOf(b).join('|');
    }

    /** Có subMeta sprite-frame không — quyết định có được dùng lossy hay không. */
    function hasSpriteFrame(meta) {
        for (const s of Object.values((meta && meta.subMetas) || {}))
            if (s.importer === 'sprite-frame') return true;
        return false;
    }

    /**
     * Mọi uuid được nhắc tới trong đống file văn bản kéo lên.
     *
     * QUAN TRỌNG: phải quét cả .meta — material override trong .fbx.meta tham chiếu
     * texture. Bỏ sót nó sẽ báo nhầm asset đang dùng là mồ côi.
     */
    function collectReferences(textFiles) {
        const refs = new Set();
        for (const { name, text } of textFiles) {
            let selfUuid = null;
            if (/\.meta$/i.test(name)) {
                try { selfUuid = JSON.parse(text).uuid; } catch (_) { }
            }
            for (const m of text.matchAll(UUID_RE)) if (m[0] !== selfUuid) refs.add(m[0]);
        }
        return refs;
    }

    global.META = {
        SUB_TEXTURE, SUB_SPRITE_FRAME, SUB_TEXTURE_CUBE,
        forReplacement, idsOf, identityMatches, hasSpriteFrame, collectReferences,
    };
})(window);
