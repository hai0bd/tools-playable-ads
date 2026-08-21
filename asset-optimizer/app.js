/* Asset Optimizer — chạy hoàn toàn trong trình duyệt, mở thẳng index.html là dùng được.
 *
 * Không server, không cài đặt, không gửi gì ra ngoài:
 *   - WebP lossless : canvas.toBlob('image/webp', 1.0)  — đã đo, pixel giống hệt
 *   - WebP lossy    : cùng hàm, quality < 1
 *   - AAC .m4a      : WebCodecs AudioEncoder + muxer tự viết (browser/m4a.js)
 *   - alpha, PSNR   : đọc thẳng pixel, chính xác hơn suy ra từ bộ lọc
 *
 * Giao diện chia TAB theo định dạng. Mọi thứ chung (nhận file, .meta, tham chiếu,
 * build) nằm ngoài tab; mỗi tab chỉ là một mục trong danh bạ TABS ở cuối file —
 * sau này thêm định dạng mới là thêm một mục + một panel HTML, không đụng phần lõi.
 */

'use strict';

const $ = s => document.querySelector(s);
const IMAGE_RE = /\.(png|jpe?g)$/i;
const AUDIO_RE = /\.(mp3|wav|ogg|m4a|aac)$/i;
const MODEL_RE = /\.glb$/i;
const META_RE = /\.meta$/i;
/* Nhận thêm mấy loại này CHỈ để dò tham chiếu, không tối ưu chúng.
   Material trỏ tới texture nằm trong .mtl; thiếu chúng thì texture đang dùng
   sẽ bị báo nhầm là mồ côi. */
const REF_RE = /\.(mtl|material|scene|prefab|anim)$/i;

/* Hau to quy uoc cua DCC cho BAN DO DU LIEU — ba kenh RGB cat ba con so khac nhau
   (metallic, roughness, AO, normal…) chu khong phai mau. Nen lossy duoc xay tren gia
   dinh R≈G≈B nen pha hong chung: do duoc tren Bike_Neon_M, kenh B lech toi 142/255,
   du de roughness 0.80 thanh 0.24 — sai vat lieu chu khong phai nhieu hat.
   KHONG liet ke _D _E _A _C _BC: do la mau that, lossy an toan. */
const DATA_MAP_RE = /_(m|r|n|s|g|h|ao|orm|mra|rma|arm|nrm|normal|metal|metallic|rough|roughness|gloss|spec|specular|height|disp|displacement|mask|occlusion)$/i;

/* Duoi nguong nay coi nhu ba kenh doc lap -> ban do du lieu, du ten dat the nao.
   Do tren du an: anh giong anh chup 0.83–0.99, ban do du lieu −0.20…0.28.
   Lay 0.5 de chua cho cho texture mau ruc ro ma van la mau that. */
const CORR_FLOOR = 0.5;

/* ------------------------------------------------------- trạng thái chung */

let picked = new Map();      // đường dẫn tương đối -> File (mọi tab dùng chung)
let shipped = null;          // uuid có trong build
let refCount = 0;            // số uuid gom được — quyết định có đủ cơ sở kết luận mồ côi
let objectUrls = [];
let viewerRows = [];         // kết quả của tab đang mở viewer

/* ------------------------------------------------------------------ tiện ích */

const KB = n => (n / 1024).toFixed(1) + ' KB';
const fmt = n => n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : KB(n);
const pct = (a, b) => b ? (1 - a / b) * 100 : 0;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = () => new Promise(r => setTimeout(r, 0));
const note = m => { $('#run-note').textContent = m; };

function relPathOf(file) {
    const raw = file.webkitRelativePath || file.name;
    const parts = raw.split('/');
    if (parts.length > 1) parts.shift();                       // bỏ tên thư mục gốc
    if (parts.length > 1 && parts[0].toLowerCase() === 'assets') parts.shift();
    return parts.join('/') || file.name;
}

const isMedia = n => IMAGE_RE.test(n) || AUDIO_RE.test(n) || MODEL_RE.test(n);
const interesting = n => isMedia(n) || META_RE.test(n) || REF_RE.test(n);

function saveBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/* --------------------------------------------------------------- nhận file */

function addFiles(files) {
    for (const f of files) if (interesting(f.name)) picked.set(relPathOf(f), f);
    refreshIntake();
}

/* Kéo cả thư mục cần DataTransferItem; File API thường không đệ quy được.
   Lưu ý: Chrome CHẶN đường này khi trang mở bằng file:// — nút "Thêm thư mục" thì vẫn chạy. */
async function readEntry(entry, prefix, out) {
    if (entry.isFile) {
        const file = await new Promise(r => entry.file(r, () => r(null)));
        if (file && interesting(file.name)) out.push([prefix + file.name, file]);
        return;
    }
    if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
            const batch = await new Promise(r => reader.readEntries(r, () => r([])));
            if (!batch.length) break;
            for (const e of batch) await readEntry(e, prefix + entry.name + '/', out);
        }
    }
}

async function handleDrop(ev) {
    ev.preventDefault();
    $('#drop').classList.remove('dragging');
    const entries = [...(ev.dataTransfer.items || [])]
        .map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);

    if (entries.length) {
        const out = [];
        try {
            for (const e of entries) await readEntry(e, '', out);
        } catch (_) { /* file:// chặn đọc thư mục — rơi xuống nhánh dưới */ }
        if (out.length) {
            for (const [p, f] of out) {
                const parts = p.split('/');
                if (parts.length > 1 && parts[0].toLowerCase() === 'assets') parts.shift();
                picked.set(parts.join('/'), f);
            }
            refreshIntake();
            return;
        }
        if (entries.some(e => e.isDirectory)) {
            note('Trình duyệt chặn đọc thư mục qua kéo thả khi mở bằng file://. Dùng nút "Thêm thư mục…" thay thế.');
        }
    }
    addFiles(ev.dataTransfer.files || []);
}

/**
 * Danh sách file đã nhận, chia về từng tab theo loại.
 * Chọn nhiều lần thì CỘNG DỒN chứ không thay thế — cố ý, vì thường phải gom từ
 * vài thư mục. Mỗi tab liệt kê file của mình và cho xoá từng cái.
 */
function refreshIntake() {
    const media = [...picked.keys()].filter(isMedia);
    const metas = [...picked.keys()].filter(p => META_RE.test(p)).length;
    const refs = picked.size - media.length - metas;
    const total = media.reduce((s, p) => s + picked.get(p).size, 0);

    $('#intake-bar').hidden = picked.size === 0;
    $('#tabs').hidden = media.length === 0;
    $('#intake-count').textContent = `${media.length} file · ${fmt(total)}`;
    $('#intake-extra').textContent =
        (metas ? `${metas} .meta` : 'chưa có .meta — bản xuất ra sẽ phải gán lại tay')
        + (refs ? ` · ${refs} file tham chiếu` : '');

    for (const [id, tab] of Object.entries(TABS)) {
        const mine = media.filter(p => tab.match(p)).sort();
        const badge = $('#badge-' + id);
        badge.hidden = !mine.length;
        badge.textContent = mine.length;
        $('#empty-' + id).hidden = mine.length > 0;
        $('#run-' + id).disabled = !mine.length;

        $('#list-' + id).innerHTML = mine.map(p => {
            const coMeta = picked.has(p + '.meta');
            return `<li>
                <span class="f-name">${esc(p)}</span>
                <span class="f-size">${KB(picked.get(p).size)}</span>
                <span class="f-meta ${coMeta ? 'yes' : ''}">${coMeta ? 'giữ UUID' : 'không .meta'}</span>
                <button class="f-del" data-p="${esc(p)}" title="Bỏ file này" type="button">✕</button>
            </li>`;
        }).join('');
    }

    // panel đang mở phải khớp trạng thái tab
    showTab(activeTab);
}

function removeOne(p) {
    picked.delete(p);
    picked.delete(p + '.meta');
    refreshIntake();
}

/* ------------------------------------------------------------ đọc .meta kèm */

/** Ghép mỗi file media với .meta cùng tên, và gom văn bản để dò tham chiếu. */
async function buildIndex() {
    const metaOf = new Map();
    const texts = [];
    for (const [rel, file] of picked) {
        const isMeta = META_RE.test(rel);
        if (!isMeta && !REF_RE.test(rel)) continue;
        const text = await file.text();
        texts.push({ name: rel, text });
        if (isMeta) { try { metaOf.set(rel.slice(0, -5), JSON.parse(text)); } catch (_) { } }
    }
    return { metaOf, refs: META.collectReferences(texts) };
}

/* ------------------------------------------------------------- xử lý ảnh */

async function planTexture(rel, file, meta, opt) {
    const img = await IMG.load(file);
    if (!img) return { verdict: 'skip', reason: 'không đọc được ảnh' };
    if (img.width > IMG.WEBP_MAX_DIM || img.height > IMG.WEBP_MAX_DIM)
        return { verdict: 'skip', reason: `cạnh > ${IMG.WEBP_MAX_DIM}px, WebP không mã hoá được` };

    const alpha = IMG.alphaProfile(img.data);
    const spriteFrame = meta ? META.hasSpriteFrame(meta) : false;

    /* Hai tầng nhận diện bản đồ dữ liệu, cả hai đều CHẶN lossy trước khi đo PSNR:
       tên file theo quy ước DCC, và độ tương quan kênh cho file đặt tên tự do.
       Cổng PSNR vẫn giữ nguyên làm lưới an toàn cuối. */
    const base = rel.replace(/.[^.]+$/, '').split('/').pop();
    const byName = DATA_MAP_RE.test(base);
    const corr = IMG.channelCorrelation(img.data);
    const byCorr = corr < CORR_FLOOR;
    const dataMap = byName || byCorr;

    const lossyOk = !spriteFrame && alpha === 'opaque' && !dataMap;

    const candidates = [];
    const ll = await IMG.encode(img.canvas, { lossless: true });
    if (ll) candidates.push({ mode: 'lossless', blob: ll, size: ll.size, psnr: Infinity });

    if (lossyOk) {
        const lo = await IMG.encode(img.canvas, { lossless: false, quality: opt.quality });
        if (lo) {
            const dec = await IMG.decodeBlob(lo);
            candidates.push({
                mode: 'q' + opt.quality, blob: lo, size: lo.size,
                psnr: IMG.psnrVisible(img.data, dec.data),
                dims: dec,
            });
        }
    }

    /* Kích thước lệch là hỏng thầm lặng: sprite-frame mang rawWidth/rawHeight đã bake,
       và mọi tính toán UV đều giả định đúng số pixel đó. */
    for (const c of candidates) {
        if (!c.dims) c.dims = await IMG.decodeBlob(c.blob);
        c.dimOk = c.dims.width === img.width && c.dims.height === img.height;
    }

    const viable = candidates.filter(c => c.dimOk
        && pct(c.size, img.size) >= opt.minGain
        && (c.psnr === Infinity || (c.psnr !== null && c.psnr >= opt.psnrFloor)));

    const info = { width: img.width, height: img.height, alpha, format: img.format, corr, dataMap, byName, byCorr };

    if (!viable.length) {
        const best = candidates.sort((a, b) => a.size - b.size)[0];
        return {
            verdict: 'keep', info,
            reason: !candidates.length ? 'mã hoá thất bại'
                : !best.dimOk ? 'kích thước đầu ra lệch'
                    : best.size >= img.size ? 'webp to hơn bản gốc'
                        : pct(best.size, img.size) < opt.minGain ? `tiết kiệm dưới ${opt.minGain}%`
                            : `PSNR ${best.psnr.toFixed(1)} dB dưới ngưỡng`,
        };
    }

    const pick = viable.sort((a, b) => a.size - b.size)[0];

    /* Ghi chú phải nói cái ĐÃ LÀM, không phải cái được phép làm.
       Lossy được cho phép mà cuối cùng vẫn chọn lossless là chuyện thường —
       người đọc cần biết vì sao, nếu không sẽ tưởng tool mâu thuẫn. */
    let why;
    if (spriteFrame) why = 'sprite-frame → buộc lossless';
    else if (alpha === 'used') why = 'có pixel trong suốt → buộc lossless';
    else if (byName) why = 'tên có hậu tố bản đồ dữ liệu → buộc lossless';
    else if (byCorr) why = `ba kênh gần như độc lập (tương quan ${corr.toFixed(2)}) → bản đồ dữ liệu, buộc lossless`;
    else {
        const lossy = candidates.find(c => c.mode !== 'lossless');
        if (pick.mode !== 'lossless') why = 'alpha không dùng → dùng được lossy';
        else if (!lossy) why = 'lossy mã hoá thất bại';
        else if (lossy.psnr !== null && lossy.psnr < opt.psnrFloor)
            why = `lossy chỉ đạt PSNR ${lossy.psnr.toFixed(1)} dB, dưới ngưỡng → lùi về lossless`;
        else why = 'lossless nhỏ hơn cả lossy';
    }

    return {
        verdict: 'convert', info, newExt: '.webp',
        blob: pick.blob, newSize: pick.size, mode: pick.mode,
        psnr: pick.psnr === Infinity ? 'inf' : +pick.psnr.toFixed(1),
        note: why,
    };
}

/* ----------------------------------------------------------- xử lý audio */

/** Im lặng ở CUỐI file — nếu để nguyên mà sau này cho loop thì nghe rõ khoảng hụt. */
function trailingSilence(buf, thresh = 0.0056) {   // ≈ -45 dBFS
    const n = buf.length;
    const ch = [];
    for (let c = 0; c < buf.numberOfChannels; c++) ch.push(buf.getChannelData(c));
    let last = n;
    for (let i = n - 1; i >= 0; i--) {
        let peak = 0;
        for (const d of ch) { const v = Math.abs(d[i]); if (v > peak) peak = v; }
        if (peak > thresh) { last = i + 1; break; }
    }
    const cutSec = (n - last) / buf.sampleRate;
    return cutSec >= 0.2 ? last : n;
}

/** Cắt bớt đuôi và chừa biên độ — bản gốc thường chạm 0 dBFS, không còn chỗ cho SFX. */
function trimAndHeadroom(ctx, buf, endSample, limit = 0.79) {
    const n = endSample;
    const out = ctx.createBuffer(buf.numberOfChannels, n, buf.sampleRate);
    let peak = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
        const s = buf.getChannelData(c);
        for (let i = 0; i < n; i++) { const v = Math.abs(s[i]); if (v > peak) peak = v; }
    }
    const gain = peak > limit ? limit / peak : 1;
    for (let c = 0; c < buf.numberOfChannels; c++) {
        const s = buf.getChannelData(c), d = out.getChannelData(c);
        for (let i = 0; i < n; i++) d[i] = s[i] * gain;
    }
    return { buffer: out, gain };
}

/**
 * Web Audio giải nén ra float32 PCM — thường là chi phí lớn hơn cả dung lượng tải.
 * Dùng sample rate của AudioContext chứ không phải của file: trình duyệt lấy mẫu lại
 * về tần số phần cứng, nên hạ sample rate của file KHÔNG giảm RAM.
 */
const webAudioRam = (dur, ch, rate = 48000) => dur * rate * ch * 4;

async function planAudio(rel, file, meta, opt, onProgress) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    let buf;
    try {
        buf = await ctx.decodeAudioData(await file.arrayBuffer());
    } catch (e) {
        ctx.close();
        return { verdict: 'skip', reason: 'trình duyệt không giải mã được file này' };
    }

    const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase();
    const endSample = trailingSilence(buf);
    const trimmed = (buf.length - endSample) / buf.sampleRate;
    const wantsMono = opt.mono && buf.numberOfChannels > 1;

    /* File đã là AAC thì mã hoá lại là lossy chồng lossy: mất chất mà dung lượng
       gần như không đổi. Chỉ làm khi còn im lặng để cắt hoặc người dùng muốn mono. */
    if ((ext === '.m4a' || ext === '.aac') && !wantsMono && trimmed < 0.2) {
        ctx.close();
        return {
            verdict: 'skip', reason: 'đã là aac — mã hoá lại sẽ mất chất',
            info: { duration: buf.duration, channels: buf.numberOfChannels },
        };
    }

    const { buffer: prepared, gain } = trimAndHeadroom(ctx, buf, endSample);
    let blob;
    try {
        blob = await M4A.encode(prepared, { bitrate: opt.audioBitrate * 1000, mono: opt.mono, onProgress });
    } catch (e) {
        ctx.close();
        return { verdict: 'skip', reason: 'mã hoá AAC lỗi: ' + e.message };
    }

    const newDur = prepared.length / prepared.sampleRate;
    const newCh = opt.mono ? 1 : Math.min(buf.numberOfChannels, 2);
    const info = {
        duration: buf.duration, channels: buf.numberOfChannels,
        ramBefore: webAudioRam(buf.duration, buf.numberOfChannels),
        ramAfter: webAudioRam(newDur, newCh),
    };
    ctx.close();

    if (pct(blob.size, file.size) < opt.minGain)
        return { verdict: 'keep', info, reason: `tiết kiệm dưới ${opt.minGain}%` };

    return {
        verdict: 'convert', info, newExt: '.m4a',
        blob, newSize: blob.size,
        mode: opt.audioBitrate + 'k aac' + (opt.mono ? ' mono' : ''),
        trimmed, gain,
        note: gain < 1 ? `hạ ${(20 * Math.log10(gain)).toFixed(1)} dB để chừa biên độ` : '',
    };
}

/* ----------------------------------------------------------- xử lý model */

/**
 * Rig xuất từ Blender thường mang cả xương ĐIỀU KHIỂN (IK, mechanism, tweak) —
 * chúng không có weight nên không vẽ ra pixel nào, nhưng vẫn tốn chỗ và vẫn được
 * bake animation. Cắt chúng đi là giảm dung lượng mà KHÔNG đánh đổi gì.
 *
 * Khác với texture và audio, ở đây có thể CHỨNG MINH là không hỏng: so world matrix
 * của từng xương có weight giữa hai bản. Vì vậy hàng verdict không dựa vào cảm nhận
 * mà dựa vào sai lệch góc đo được — vượt ngưỡng là bỏ, không giao file.
 */
const ANGLE_FLOOR = 0.01;   // dung sai 0 mà lệch quá mức này thì có bug, không phải làm tròn

async function planModel(rel, file, meta, opt) {
    const src = GLB.parse(await file.arrayBuffer());
    if (!src) return { verdict: 'skip', reason: 'không đọc được — file không phải GLB hợp lệ' };

    const info = GLB.analyze(src);
    if (info.error) return { verdict: 'skip', reason: info.error, info };
    if (!info.skinned) return { verdict: 'skip', reason: 'model tĩnh, không có xương để cắt', info };

    const keepBones = opt.keepBones.split(',').map(s => s.trim()).filter(Boolean).map(s => {
        try { return new RegExp(s); } catch (_) { return null; }
    }).filter(Boolean);

    let pruned;
    try {
        pruned = GLB.prune(src, {
            tolerance: opt.tolerance,
            posTolerance: GLB.diagonal(src.json) * 0.0002,
            keepBones,
        });
    } catch (e) {
        return { verdict: 'skip', reason: 'cắt thất bại: ' + e.message, info };
    }

    const blob = GLB.write(pruned.json, pruned.parts);
    const out = GLB.parse(await blob.arrayBuffer());

    const errs = GLB.structuralCheck(out);
    if (errs.length) return { verdict: 'skip', reason: 'cấu trúc đầu ra sai: ' + errs[0], info };

    const v = GLB.verify(src, out, 20);
    if (v.missing) return { verdict: 'skip', reason: 'xương ' + v.missing + ' bị mất khỏi bản mới', info };

    /* Dung sai 0 nghĩa là đã hứa "chuyển động y hệt". Lệch quá ngưỡng làm tròn thì
       lời hứa đó sai — bỏ file còn hơn giao một bản hỏng mà người dùng không biết. */
    if (opt.tolerance === 0 && v.worst > ANGLE_FLOOR) {
        return {
            verdict: 'skip', info,
            reason: `dung sai 0 nhưng lệch ${v.worst.toFixed(3)}° ở ${v.worstBone} — không an toàn`,
        };
    }

    const full = { ...info, ...pruned.stats, maxAngle: v.worst, worstBone: v.worstBone, verifyRows: v.rows };

    if (pct(blob.size, file.size) < opt.minGain)
        return { verdict: 'keep', info: full, reason: `tiết kiệm dưới ${opt.minGain}%` };

    const bits = [`${pruned.stats.bonesBefore} → ${pruned.stats.bonesAfter} xương`,
                  `${pruned.stats.tracksBefore} → ${pruned.stats.tracksAfter} track`];
    if (pruned.forced.length) bits.push('ép giữ ' + pruned.forced.join(', '));

    return {
        verdict: 'convert', info: full, newExt: '.glb',
        blob, newSize: blob.size,
        mode: opt.tolerance > 0 ? `prune + tỉa ${opt.tolerance}°` : 'prune',
        note: bits.join(' · ') +
            (v.worst <= ANGLE_FLOOR ? ' · chuyển động không đổi' : ` · lệch tối đa ${v.worst.toFixed(2)}°`),
        boneNames: pruned.boneNames,
    };
}

/* ------------------------------------------------------------------ chạy */

async function runTab(id) {
    const tab = TABS[id];
    const btn = $('#run-' + id);
    btn.disabled = true;
    for (const u of objectUrls) URL.revokeObjectURL(u);
    objectUrls = [];
    tab.results = [];

    try {
        const { metaOf, refs } = await buildIndex();
        refCount = refs.size;
        const media = [...picked.keys()].filter(p => tab.match(p)).sort();
        const opt = tab.readOptions();
        let done = 0;

        for (const rel of media) {
            const file = picked.get(rel);
            const meta = metaOf.get(rel) || null;
            const uuid = meta ? meta.uuid : null;
            done++;
            note(`${done}/${media.length} — ${rel}`);
            await sleep();

            const row = {
                rel, file, meta, uuid, kind: id,
                oldSize: file.size,
                used: uuid ? refs.has(uuid) : true,
                inBuild: shipped && uuid ? shipped.has(uuid.toLowerCase()) : null,
            };

            // trong auto-atlas thì packer gộp lại và mã hoá lại lúc build
            if (picked.has(rel.replace(/[^/]+$/, 'auto-atlas.pac'))) {
                tab.results.push({ ...row, verdict: 'skip', reason: 'trong auto-atlas' });
                continue;
            }
            const plan = await tab.plan(rel, file, meta, opt,
                p => note(`${done}/${media.length} — ${rel} — ${Math.round(p * 100)}%`));

            // sinh .meta giữ nguyên uuid, và tự kiểm tra trước khi nhận
            if (plan.verdict === 'convert' && meta) {
                const nm = META.forReplacement(meta);
                if (META.identityMatches(meta, nm)) plan.newMeta = nm;
                else { plan.verdict = 'skip'; plan.reason = 'meta sinh ra lệch danh tính — bỏ qua cho an toàn'; }
            }
            tab.results.push({ ...row, ...plan });
        }

        note('');
        renderTab(id);
    } catch (err) {
        note('Lỗi: ' + err.message);
        console.error(err);
    } finally {
        btn.disabled = false;
    }
}

/* --------------------------------------------------------------- kết quả */

function renderTab(id) {
    const tab = TABS[id];
    const results = tab.results;
    const done = results.filter(r => r.verdict === 'convert');
    const oldTot = done.reduce((s, r) => s + r.oldSize, 0);
    const newTot = done.reduce((s, r) => s + r.newSize, 0);

    $('#empty-state-' + id).hidden = true;
    $('#results-' + id).hidden = false;

    const nOut = done.length + done.filter(r => r.newMeta).length;
    const dl = $('#dl-' + id);
    dl.disabled = !nOut;
    dl.textContent = !nOut ? 'Không có gì để tải'
        : nOut === 1 ? 'Tải file đã tối ưu' : `Tải ${nOut} file (.zip)`;

    const chips = [
        `<span class="chip good">tiết kiệm <b>${fmt(oldTot - newTot)}</b>${oldTot ? ' (-' + Math.round(pct(newTot, oldTot)) + '%)' : ''}</span>`,
        `<span class="chip">đã đổi <b>${done.length}</b>/${results.length}</span>`,
    ];
    /* Tách khoản tiết kiệm THẬT khỏi khoản trên giấy — nếu không, một file mồ côi
       lớn sẽ cho con số đẹp trong khi gói cuối không nhỏ đi một byte. */
    const real = done.filter(r => r.inBuild);
    if (shipped && real.length < done.length) {
        const rs = real.reduce((s, r) => s + (r.oldSize - r.newSize), 0);
        chips.push(`<span class="chip warn">tiết kiệm THẬT <b>${fmt(rs)}</b> — ${real.length}/${done.length} có trong build</span>`);
    }
    $('#sum-' + id).innerHTML = chips.join('');

    const order = { convert: 0, keep: 1, skip: 2 };
    const sorted = [...results].sort((a, b) =>
        (order[a.verdict] - order[b.verdict])
        || ((b.oldSize - (b.newSize || b.oldSize)) - (a.oldSize - (a.newSize || a.oldSize)))
        || (b.oldSize - a.oldSize));

    $('#rows-' + id).innerHTML = sorted.map(r => {
        const conv = r.verdict === 'convert';
        const bits = [];
        if (r.note) bits.push(r.note);
        if (r.trimmed >= 0.2) bits.push(`cắt ${r.trimmed.toFixed(2)}s im lặng cuối`);
        if (r.psnr === 'inf') bits.push('pixel nhìn thấy và alpha nguyên vẹn');
        else if (r.psnr) bits.push(`PSNR ${r.psnr} dB`);
        if (!conv && r.reason) bits.push(r.reason);
        if (r.inBuild === false) bits.push('không có trong build');
        if (conv) bits.push(r.newMeta ? 'giữ UUID' : 'không .meta → gán lại tay');

        const dim = r.info && r.info.width ? `${r.info.width}×${r.info.height}`
            : r.info && r.info.duration ? r.info.duration.toFixed(1) + 's'
                : r.info && r.info.bones ? `${r.info.bones} xương` : '';

        return `<div class="r-row ${conv && id === 'texture' ? 'clickable' : ''}" data-i="${results.indexOf(r)}">
            <div class="r-main">
                <span class="r-name kind-${id}">${esc(r.rel)}</span>
                ${dim ? `<span class="r-dim">${dim}</span>` : ''}
                <span class="r-sizes">${KB(r.oldSize)}${conv ? ` → <b>${KB(r.newSize)}</b>` : ''}</span>
                <span class="r-gain ${conv ? '' : 'na'}">${conv ? '-' + Math.round(pct(r.newSize, r.oldSize)) + '%' : '—'}</span>
                <span class="mode ${conv ? '' : 'skip'}">${conv ? esc(r.mode) : r.verdict}</span>
                ${conv ? `<button class="r-dl" data-i="${results.indexOf(r)}" type="button"
                    title="Tải riêng file này${r.newMeta ? ' (kèm .meta)' : ''}">⬇</button>` : ''}
            </div>
            ${bits.length ? `<div class="r-note">${esc(bits.join(' · '))}</div>` : ''}
        </div>`;
    }).join('');

    const extras = [];
    /* Chỉ báo "mồ côi" khi thật sự có cơ sở để kết luận. Kéo một file vào rồi bảo
       nó không được tham chiếu là vô nghĩa — chẳng có gì để tham chiếu cả. */
    const orphans = refCount >= 5 ? results.filter(r => !r.used) : [];
    if (orphans.length) {
        extras.push(`<div class="extra"><h3>Không thấy tham chiếu</h3>
            <p>Không file .meta, .mtl, .scene hay .prefab nào bạn kéo lên trỏ tới chúng.
            Nếu đã kéo đủ cả thư mục assets thì xoá hẳn còn hơn tối ưu.</p>
            <ul>${orphans.sort((a, b) => b.oldSize - a.oldSize).slice(0, 10)
                .map(r => `<li>${KB(r.oldSize)} — ${esc(r.rel)}</li>`).join('')}</ul></div>`);
    }
    const ram = results.filter(r => r.info && r.info.ramBefore && r.verdict === 'convert');
    if (ram.length) {
        extras.push(`<div class="extra"><h3>RAM khi Web Audio giải nén</h3>
            <p>Trình duyệt giải nén audio ra float32 PCM. Đây thường là chi phí lớn hơn cả
            dung lượng tải, và là thứ làm treo webview máy yếu.</p>
            <ul>${ram.map(r => `<li>${esc(r.rel)} — ${fmt(r.info.ramBefore)} → <b>${fmt(r.info.ramAfter)}</b></li>`).join('')}</ul></div>`);
    }
    if (done.some(r => !r.newMeta)) {
        extras.push(`<div class="extra"><h3>Thiếu .meta</h3>
            <p>Một số file không có .meta đi kèm nên bản xuất ra mang UUID mới. Sau khi thay,
            mọi material và prefab trỏ tới chúng sẽ phải gán lại tay trong Editor.
            Kéo kèm file <code>.meta</code> thì tránh được hoàn toàn.</p></div>`);
    }
    /* Cảnh báo đặt trên trang chứ không nhét vào file trong gói tải về —
       nhét vào đó thì không ai mở, mà đây là chỗ dễ hỏng nhất khi áp dụng.
       Chỉ áp dụng khi ĐỔI ĐUÔI: model xuất ra .glb trùng tên file cũ nên chép đè
       là xong, bảo người ta xoá file rồi chép lại chỉ tổ gây lo. */
    const extChanged = r => r.newExt.toLowerCase() !== r.rel.slice(r.rel.lastIndexOf('.')).toLowerCase();
    const renamed = done.filter(r => r.newMeta && extChanged(r));
    if (renamed.length) {
        extras.push(`<div class="extra danger"><h3>Nhớ xoá file cũ</h3>
            <p>Chép file mới vào mà để lại file cũ thì <code>assets/</code> sẽ có hai
            <code>.meta</code> mang <b>cùng một UUID</b> — Cocos không xử lý được.
            Mỗi file dưới đây thay thế file cùng tên nhưng khác đuôi:</p>
            <ul>${renamed.map(r =>
            `<li>xoá <code>${esc(r.rel)}</code> và <code>${esc(r.rel)}.meta</code></li>`).join('')}</ul></div>`);
    }
    if (done.some(r => !extChanged(r))) {
        extras.push(`<div class="extra"><h3>Chép đè, giữ nguyên tên</h3>
            <p>Model xuất ra trùng tên file gốc nên cứ chép đè, không phải xoá gì.
            Điều này quan trọng hơn vẻ ngoài: Cocos sinh id của mesh, clip và skeleton
            từ <b>tên</b>, nên giữ nguyên tên file và tên bên trong thì mọi tham chiếu
            <code>uuid@subid</code> trong scene và prefab vẫn khớp. Đổi tên là đứt hết.</p></div>`);
    }

    /* Model là loại duy nhất chứng minh được "không hỏng" bằng số, nên phải cho thấy
       con số đó — nếu không thì người dùng chẳng có cơ sở nào để tin. */
    const verified = done.filter(r => r.info && r.info.verifyRows);
    if (verified.length) {
        extras.push(`<div class="extra"><h3>Kiểm chứng chuyển động</h3>
            <p>Với mỗi clip, world matrix của <b>từng xương có weight</b> được tính ở 20 mốc
            thời gian trên cả bản gốc lẫn bản mới rồi so sánh. Mọi vertex đều do world matrix
            của xương ảnh hưởng nó đặt vị trí, nên khớp ở đây là khớp hình dạng.</p>
            <ul>${verified.map(r => `<li>${esc(r.rel)}
                <ul>${r.info.verifyRows.map(v => `<li>${esc(v.clip)} — lệch tối đa
                    <b>${v.maxAngle < 0.001 ? '0°' : v.maxAngle.toFixed(3) + '°'}</b>${
                    v.maxAngle >= 0.01 ? ' (' + esc(v.bone) + ')' : ''}</li>`).join('')}</ul>
            </li>`).join('')}</ul></div>`);
    }

    /* Socket trỏ tới xương bằng TÊN. Xương không có weight bị cắt là socket trỏ vào
       hư không — vật gắn kèm biến mất. Không kiểm hộ được vì scene không nằm ở đây. */
    if (done.some(r => r.kind === 'model')) {
        extras.push(`<div class="extra danger"><h3>Kiểm tra socket trước khi thay</h3>
            <p>Nếu scene có <code>SkeletalAnimation.Socket</code> (gắn vật thể vào xương —
            ví dụ gắn món ăn vào miệng con vật), xương đích <b>có thể đã bị cắt</b> nếu nó
            không làm biến dạng mesh. Mở <code>.scene</code> tìm <code>Socket</code>, lấy tên
            xương ở cuối đường dẫn, rồi điền vào ô <b>Giữ thêm xương</b> và chạy lại.</p></div>`);
    }
    $('#extras-' + id).innerHTML = extras.join('');
}

/* ------------------------------------------------------------------ tải về */

/**
 * Tải riêng một kết quả. Có .meta thì tải cả cặp — hai lượt saveBlob trong cùng
 * một cú bấm; Chrome hỏi quyền "tải nhiều file" đúng một lần rồi thôi.
 * Thiếu .meta mà chỉ tải mỗi file là giao hàng thiếu: chép vào assets/ sẽ mất UUID.
 */
function downloadOne(r) {
    const rel = r.rel.replace(/\.[^.]+$/, r.newExt);
    saveBlob(r.blob, rel.split('/').pop());
    if (r.newMeta) saveBlob(
        new Blob([JSON.stringify(r.newMeta, null, 2)], { type: 'application/json' }),
        rel.split('/').pop() + '.meta');
}

/**
 * Một file thì tải thẳng file đó. Nhiều file mới đóng gói.
 * Zip một file là bắt người dùng giải nén không vì lý do gì.
 */
async function downloadTab(id) {
    const files = [];
    for (const r of TABS[id].results.filter(r => r.verdict === 'convert')) {
        const rel = r.rel.replace(/\.[^.]+$/, r.newExt);
        files.push({ name: rel, blob: r.blob });
        if (r.newMeta) files.push({
            name: rel + '.meta',
            blob: new Blob([JSON.stringify(r.newMeta, null, 2)], { type: 'application/json' }),
        });
    }
    if (!files.length) return;
    if (files.length === 1) {
        saveBlob(files[0].blob, files[0].name.split('/').pop());
        return;
    }
    const entries = [];
    for (const f of files) entries.push({ name: f.name, data: new Uint8Array(await f.blob.arrayBuffer()) });
    saveBlob(ZIP.make(entries), 'optimized-' + id + '.zip');
}

/* --------------------------------------------------------- xem trước/sau */

const ALPHA_VI = { opaque: 'alpha đặc, không dùng', used: 'có pixel trong suốt' };

function openViewer(rows, i) {
    const r = rows[i];
    if (!r || r.verdict !== 'convert') return;
    const uOld = URL.createObjectURL(r.file), uNew = URL.createObjectURL(r.blob);
    objectUrls.push(uOld, uNew);

    $('#viewer-name').textContent = r.rel + '  →  ' + r.rel.replace(/\.[^.]+$/, r.newExt);
    $('#viewer-body').innerHTML = `
        <div class="pane"><h4>Gốc</h4>
            <div class="frame grid"><img src="${uOld}" alt=""></div>
            <div class="meta">${KB(r.oldSize)} · ${r.info.width}×${r.info.height}
                · ${ALPHA_VI[r.info.alpha] || ''}</div></div>
        <div class="pane"><h4>Sau tối ưu</h4>
            <div class="frame grid"><img src="${uNew}" alt=""></div>
            <div class="meta">${KB(r.newSize)} · ${r.mode}
                · ${r.psnr === 'inf' ? 'pixel nhìn thấy và alpha nguyên vẹn' : 'PSNR ' + r.psnr + ' dB'}</div></div>`;
    $('#viewer').hidden = false;
}

/* -------------------------------------------------- danh bạ tab + chuyển tab */

/**
 * Mỗi tab một mục: match (file nào thuộc tab), readOptions (đọc input của panel),
 * plan (thuật toán quyết định). Thêm định dạng mới = thêm mục ở đây + panel HTML
 * cùng bộ id: list-X, empty-X, run-X, dl-X, sum-X, rows-X, extras-X, badge-X.
 */
const TABS = {
    texture: {
        match: p => IMAGE_RE.test(p),
        readOptions: () => ({
            quality: +$('#o-quality').value || 90,
            psnrFloor: +$('#o-psnr').value || 38,
            minGain: +$('#o-mingain-tex').value,
        }),
        plan: (rel, file, meta, opt) => planTexture(rel, file, meta, opt),
        results: [],
    },
    audio: {
        match: p => AUDIO_RE.test(p),
        readOptions: () => ({
            audioBitrate: +$('#o-bitrate').value || 96,
            minGain: +$('#o-mingain-audio').value,
            mono: $('#o-mono').checked,
        }),
        plan: (rel, file, meta, opt, onProgress) => planAudio(rel, file, meta, opt, onProgress),
        results: [],
    },
    model: {
        match: p => MODEL_RE.test(p),
        readOptions: () => ({
            tolerance: Math.max(0, +$('#o-tolerance').value || 0),
            keepBones: $('#o-keepbones').value || '',
            minGain: +$('#o-mingain-model').value,
        }),
        plan: (rel, file, meta, opt) => planModel(rel, file, meta, opt),
        results: [],
    },
};

let activeTab = 'texture';

function showTab(id) {
    activeTab = id;
    document.querySelectorAll('.step').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
    document.querySelectorAll('.tab-panel').forEach(p => {
        p.hidden = p.dataset.tab !== id || $('#tabs').hidden;
    });
}

/* -------------------------------------------------------------- sự kiện */

$('#drop').addEventListener('dragover', e => { e.preventDefault(); $('#drop').classList.add('dragging'); });
$('#drop').addEventListener('dragleave', () => $('#drop').classList.remove('dragging'));
$('#drop').addEventListener('drop', handleDrop);

/* Xoá value sau khi nhận: <input type=file> KHÔNG bắn change nếu lần sau chọn đúng
   file cũ. Không reset thì bỏ một file rồi chọn lại nó sẽ tưởng là tool hỏng. */
const takeFrom = e => { addFiles(e.target.files); e.target.value = ''; };
$('#in-files').addEventListener('change', takeFrom);
$('#in-folder').addEventListener('change', takeFrom);
$('#pick-folder').addEventListener('click', () => $('#in-folder').click());

$('#pick-build').addEventListener('click', () => $('#in-build').click());
$('#in-build').addEventListener('change', e => {
    // chỉ lấy TÊN file, không đọc nội dung — đủ để suy ra uuid nào xuất xưởng
    shipped = new Set();
    for (const f of e.target.files) {
        const m = f.name.match(/([0-9a-f]{8}-[0-9a-f-]{27})/i);
        if (m) shipped.add(m[1].toLowerCase());
    }
    const el = $('#ship-note');
    el.hidden = false;
    el.textContent = `Đã đọc ${e.target.files.length} tên file trong build → ${shipped.size} asset xuất xưởng. `
        + `Kết quả sẽ tách "tiết kiệm THẬT" khỏi file không được đóng gói.`;
    e.target.value = '';
});

$('#clear').addEventListener('click', () => {
    for (const u of objectUrls) URL.revokeObjectURL(u);
    objectUrls = [];
    picked = new Map();
    shipped = null;
    for (const tab of Object.values(TABS)) tab.results = [];
    $('#ship-note').hidden = true;
    document.querySelectorAll('[id^=results-]').forEach(el => { el.hidden = true; });
    document.querySelectorAll('[id^=empty-state-]').forEach(el => { el.hidden = false; });
    note('');
    refreshIntake();
});

$('#tabs').addEventListener('click', e => {
    const b = e.target.closest('.step');
    if (b) showTab(b.dataset.tab);
});

for (const id of Object.keys(TABS)) {
    $('#run-' + id).addEventListener('click', () => runTab(id));
    $('#dl-' + id).addEventListener('click', () => downloadTab(id));
    $('#list-' + id).addEventListener('click', e => {
        const b = e.target.closest('.f-del');
        if (b) removeOne(b.dataset.p);
    });
    $('#rows-' + id).addEventListener('click', e => {
        // nút tải riêng xét TRƯỚC — nó nằm trong dòng clickable, không chặn thì bấm ⬇ cũng mở viewer
        const dl = e.target.closest('.r-dl');
        if (dl) { downloadOne(TABS[id].results[+dl.dataset.i]); return; }
        const row = e.target.closest('.r-row.clickable');
        if (row) { viewerRows = TABS[id].results; openViewer(viewerRows, +row.dataset.i); }
    });
}

$('#viewer-close').addEventListener('click', () => { $('#viewer').hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#viewer').hidden = true; });
document.querySelectorAll('.viewer-tools [data-bg]').forEach(b => {
    b.addEventListener('click', () => {
        document.querySelectorAll('.viewer-body .frame').forEach(f => f.className = 'frame ' + b.dataset.bg);
    });
});

/* --------------------------------------------- kiểm tra khả năng trình duyệt */

(async () => {
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    const webp = await new Promise(r => c.toBlob(b => r(!!b && b.type === 'image/webp'), 'image/webp', 1));
    let aac = false;
    if (typeof AudioEncoder !== 'undefined') {
        try {
            aac = (await AudioEncoder.isConfigSupported({
                codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 96000,
            })).supported;
        } catch (_) { }
    }
    // chỉ lên tiếng khi THIẾU gì đó — đủ cả thì im lặng
    const el = $('#cap-note');
    if (!webp) {
        el.hidden = false;
        el.textContent = 'Trình duyệt này không mã hoá được WebP — dùng Chrome hoặc Edge bản mới.';
    } else if (!aac) {
        el.hidden = false;
        el.textContent = 'Trình duyệt này không mã hoá được AAC nên tab Audio sẽ không chạy — Chrome hoặc Edge bản mới thì làm được.';
    }
})();

refreshIntake();
