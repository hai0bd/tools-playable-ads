#!/usr/bin/env node
/* Asset Optimizer — tối ưu texture và audio cho dự án Cocos Creator.
 *
 * Chỉ XUẤT ra thư mục riêng, không bao giờ đụng vào assets/.
 * Mỗi file sinh ra kèm .meta giữ nguyên UUID gốc, nên khi áp dụng thì
 * mọi tham chiếu trong material/scene/prefab tự khớp, không phải vá gì.
 *
 *   node optimize.js <project-dir> [options]
 */

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const M = require('./lib/media');
const C = require('./lib/cocos');

/* ---------------------------------------------------------------- tham số */

const DEFAULTS = {
    quality: 90,        // WebP lossy — đo được PSNR 42-65 dB trên ảnh RGB
    audioBitrate: 96,   // AAC-LC kbps
    psnrFloor: 38,      // dưới ngưỡng này coi như lossy phá ảnh
    minGain: 5,         // tiết kiệm dưới % này thì không đáng đổi định dạng
};

function parseArgs(argv) {
    const o = {
        ...DEFAULTS, project: null, out: null, ffmpeg: null, build: null,
        textures: true, audio: true, reportOnly: false, mono: false, all: false,
    };
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const val = () => argv[++i];
        if (a === '--out') o.out = val();
        else if (a === '--ffmpeg') o.ffmpeg = val();
        else if (a === '--build') o.build = val();
        else if (a === '--quality') o.quality = Number(val());
        else if (a === '--audio-bitrate') o.audioBitrate = Number(val());
        else if (a === '--psnr-floor') o.psnrFloor = Number(val());
        else if (a === '--min-gain') o.minGain = Number(val());
        else if (a === '--textures') { o.textures = true; o.audio = false; }
        else if (a === '--audio') { o.audio = true; o.textures = false; }
        else if (a === '--mono') o.mono = true;
        else if (a === '--all') o.all = true;
        else if (a === '--report-only') o.reportOnly = true;
        else if (a === '-h' || a === '--help') o.help = true;
        else if (a.startsWith('--')) { o.unknown = a; }
        else rest.push(a);
    }
    o.project = rest[0] || null;
    if (!o.build) {
        // build mặc định của Cocos; có thì dùng luôn, không có thì thôi
        const guess = o.project && path.join(path.resolve(o.project), 'build', 'web-mobile');
        if (guess && fs.existsSync(guess)) o.build = guess;
    }
    return o;
}

const USAGE = `
Asset Optimizer — tối ưu texture và audio cho Cocos Creator

  node optimize.js <project-dir> [options]

  --out <dir>           thư mục xuất, mặc định <project>/_optimized
  --build <dir>         thư mục build để biết asset nào thật sự xuất xưởng
                        (tự dò <project>/build/web-mobile nếu có)
  --all                 xử lý cả asset không có trong build (mặc định: bỏ qua)
  --textures            chỉ xử lý texture
  --audio               chỉ xử lý audio
  --quality <n>         chất lượng WebP lossy, mặc định ${DEFAULTS.quality}
  --audio-bitrate <n>   AAC kbps, mặc định ${DEFAULTS.audioBitrate}
  --mono                trộn audio về 1 kênh — giảm nửa RAM giải nén
  --psnr-floor <db>     cổng chất lượng ảnh, mặc định ${DEFAULTS.psnrFloor}
  --min-gain <pct>      bỏ qua nếu tiết kiệm dưới ngưỡng, mặc định ${DEFAULTS.minGain}
  --ffmpeg <path>       đường dẫn ffmpeg nếu không có trong PATH
  --report-only         chỉ đo, không ghi file nào

Không sửa gì trong assets/. Kết quả nằm ở thư mục xuất kèm hướng dẫn áp dụng.
`;

/* ---------------------------------------------------------------- tiện ích */

const KB = n => (n / 1024).toFixed(1);
const pct = (a, b) => b ? ((1 - a / b) * 100) : 0;
const fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : KB(n) + ' KB';
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

/* ------------------------------------------------------------- xử lý ảnh */

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg']);

/* Hau to quy uoc cua DCC cho BAN DO DU LIEU — ba kenh RGB cat ba con so khac nhau
   chu khong phai mau. Nen lossy gia dinh R~G~B nen pha hong chung.
   KHONG liet ke _D _E _A _C _BC: do la mau that, lossy an toan. */
const DATA_MAP_RE = /_(m|r|n|s|g|h|ao|orm|mra|rma|arm|nrm|normal|metal|metallic|rough|roughness|gloss|spec|specular|height|disp|displacement|mask|occlusion)$/i;

/* Duoi nguong nay coi nhu ba kenh doc lap -> ban do du lieu, du ten dat the nao. */
const CORR_FLOOR = 0.5;

/**
 * Quyết định định dạng cho một texture.
 *
 * Các luật rút từ đo đạc thực tế:
 *  - sprite-frame: .meta chứa biên cắt và đỉnh mesh đã bake. Lossy đổi alpha ở mép
 *    -> Cocos tính biên cắt khác -> sprite lệch. Chỉ được dùng lossless.
 *  - alpha thật sự dùng: libwebp luôn lưu alpha lossless, nên với ảnh nhiều vùng
 *    trong suốt bật lossy hầu như không giảm thêm byte (đo được cùng dung lượng ở
 *    neon_arrow) mà lại thêm rủi ro. Không đáng đổi.
 *  - alpha ĐẶC (toàn 255): header báo có alpha nhưng không dùng — vẫn cho lossy.
 *    Đây là trường hợp rất phổ biến với ảnh xuất từ DCC.
 *  - kết quả to hơn bản gốc: giữ nguyên. Header WebP làm file nhỏ phình ra.
 */
function planTexture(asset, tools, opt, tmpDir) {
    const info = M.imageInfo(asset.file);
    if (!info) return { verdict: 'skip', reason: 'không đọc được header' };
    if (info.format === 'webp') return { verdict: 'skip', reason: 'đã là webp' };
    if (info.width > M.WEBP_MAX_DIM || info.height > M.WEBP_MAX_DIM) {
        return { verdict: 'skip', info, reason: `cạnh > ${M.WEBP_MAX_DIM}px, WebP không mã hoá được` };
    }

    const base = path.basename(asset.file, path.extname(asset.file));
    const uniq = Buffer.from(asset.rel).toString('hex').slice(-12);

    const alpha = M.alphaProfile(tools.ffmpeg, asset.file, info);
    const alphaMatters = alpha === 'used';

    /* Hai tang nhan dien ban do du lieu, ca hai CHAN lossy truoc khi do PSNR:
       ten file theo quy uoc DCC, va do tuong quan kenh cho file dat ten tu do.
       Cong PSNR van giu nguyen lam luoi an toan cuoi. */
    const stem = path.basename(asset.file, path.extname(asset.file));
    const byName = DATA_MAP_RE.test(stem);
    const corr = M.channelCorrelation(tools.ffmpeg, asset.file);
    const byCorr = corr !== null && corr < CORR_FLOOR;
    const dataMap = byName || byCorr;

    const lossyOk = !asset.hasSpriteFrame && !alphaMatters && !dataMap;

    const candidates = [];

    const ll = path.join(tmpDir, `${base}_${uniq}_ll.webp`);
    const llSize = M.encodeWebp(tools.ffmpeg, asset.file, ll, { lossless: true });
    if (llSize) candidates.push({ mode: 'lossless', file: ll, size: llSize, psnr: Infinity });

    if (lossyOk) {
        const lo = path.join(tmpDir, `${base}_${uniq}_q${opt.quality}.webp`);
        const loSize = M.encodeWebp(tools.ffmpeg, asset.file, lo, { lossless: false, quality: opt.quality });
        if (loSize) {
            // alpha 'opaque' vẫn là kênh alpha -> phải đo trên kết quả hiển thị
            const p = info.hasAlpha
                ? M.psnrVisible(tools.ffmpeg, asset.file, lo, info.width, info.height, tmpDir)
                : M.psnr(tools.ffmpeg, asset.file, lo);
            candidates.push({ mode: 'q' + opt.quality, file: lo, size: loSize, psnr: p });
        }
    }

    /* Kích thước lệch là hỏng thầm lặng: sprite-frame mang rawWidth/rawHeight đã bake,
       và mọi tính toán UV đều giả định đúng số pixel đó. Loại thẳng bản sai. */
    for (const c of candidates) {
        const d = M.imageDims(tools.ffprobe, c.file);
        c.dimOk = !!d && d.width === info.width && d.height === info.height;
    }

    const viable = candidates.filter(c => c.dimOk
        && pct(c.size, info.size) >= opt.minGain
        && (c.psnr === Infinity || (c.psnr !== null && c.psnr >= opt.psnrFloor)));

    if (!viable.length) {
        const best = candidates.sort((a, b) => a.size - b.size)[0];
        return {
            verdict: 'keep', info, alpha,
            reason: !candidates.length ? 'mã hoá thất bại'
                : !best.dimOk ? 'kích thước đầu ra lệch'
                    : best.size >= info.size ? 'webp to hơn bản gốc'
                        : pct(best.size, info.size) < opt.minGain ? `tiết kiệm dưới ${opt.minGain}%`
                            : `PSNR ${best.psnr === null ? '?' : best.psnr.toFixed(1)} dB dưới ngưỡng`,
        };
    }

    const pick = viable.sort((a, b) => a.size - b.size)[0];
    return {
        verdict: 'convert', info, pick, alpha,
        newExt: '.webp',
        note: asset.hasSpriteFrame ? 'sprite-frame → buộc lossless'
            : alpha === 'used' ? 'có pixel trong suốt → buộc lossless'
                : byName ? 'tên có hậu tố bản đồ dữ liệu → buộc lossless'
                    : byCorr ? `ba kênh gần như độc lập (tương quan ${corr.toFixed(2)}) → buộc lossless`
                        : alpha === 'opaque' ? 'alpha không dùng → cho lossy' : '',
    };
}

/* ------------------------------------------------------------ xử lý audio */

const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac']);

function planAudio(asset, tools, opt, tmpDir) {
    const probe = M.probeAudio(tools.ffprobe, asset.file);
    if (!probe) return { verdict: 'skip', reason: 'không đọc được' };

    /* File đã là AAC ở bitrate mong muốn thì mã hoá lại chỉ tổ mất chất:
       lossy -> lossy là tổn thất chồng tổn thất, mà dung lượng gần như không đổi.
       Vẫn cho chạy nếu còn im lặng để cắt hoặc người dùng muốn ép về mono. */
    if (probe.codec === 'aac') {
        const kbps = probe.bitRate ? probe.bitRate / 1000 : null;
        const alreadyLean = kbps === null || kbps <= opt.audioBitrate * 1.15;
        const wantsMono = opt.mono && probe.channels > 1;
        const silence = M.trailingSilence(tools.ffmpeg, asset.file, probe.duration);
        if (alreadyLean && !wantsMono && !silence) {
            return {
                verdict: 'skip', probe,
                reason: `đã là aac ${kbps ? kbps.toFixed(0) + 'k' : ''} — mã hoá lại sẽ mất chất`,
            };
        }
    }

    const base = path.basename(asset.file, path.extname(asset.file));
    const uniq = Buffer.from(asset.rel).toString('hex').slice(-12);
    const dst = path.join(tmpDir, `${base}_${uniq}.m4a`);

    const trimTo = M.trailingSilence(tools.ffmpeg, asset.file, probe.duration);
    const size = M.encodeAac(tools.ffmpeg, asset.file, dst,
        { bitrate: opt.audioBitrate, trimTo, mono: opt.mono });
    if (!size) return { verdict: 'skip', reason: 'mã hoá thất bại' };

    const newDuration = trimTo || probe.duration;
    const newChannels = opt.mono ? 1 : probe.channels;
    const ramBefore = M.webAudioRam(probe.duration, probe.channels);
    const ramAfter = M.webAudioRam(newDuration, newChannels);

    if (pct(size, probe.size) < opt.minGain) {
        return { verdict: 'keep', probe, reason: `tiết kiệm dưới ${opt.minGain}%` };
    }
    return {
        verdict: 'convert', probe, newExt: '.m4a',
        pick: { mode: opt.audioBitrate + 'k aac' + (opt.mono ? ' mono' : ''), file: dst, size },
        trimmed: trimTo ? probe.duration - trimTo : 0,
        newDuration, ramBefore, ramAfter,
    };
}

/* ------------------------------------------------------------------ chính */

function main() {
    const opt = parseArgs(process.argv.slice(2));
    if (opt.help || !opt.project) { console.log(USAGE); process.exit(opt.project ? 0 : 1); }
    if (opt.unknown) { console.error('Tham số không nhận ra: ' + opt.unknown + '\n' + USAGE); process.exit(1); }

    const project = path.resolve(opt.project);
    if (!fs.existsSync(path.join(project, 'assets'))) {
        console.error(`Không thấy ${path.join(project, 'assets')} — đây có phải thư mục gốc dự án Cocos không?`);
        process.exit(1);
    }

    const tools = M.findFFmpeg(opt.ffmpeg);
    if (!tools) {
        console.error('Không tìm thấy ffmpeg và ffprobe.\n'
            + '  • Cài ffmpeg rồi thêm vào PATH, hoặc\n'
            + '  • Chạy lại với --ffmpeg "D:/đường/dẫn/tới/thư-mục-chứa-ffmpeg"');
        process.exit(1);
    }
    const enc = M.checkEncoders(tools.ffmpeg);
    if (opt.textures && !enc.webp) {
        console.error('Bản ffmpeg này không có libwebp — không mã hoá được WebP.\n'
            + '  Dùng bản build đầy đủ (gyan.dev full_build hoặc tương đương).');
        process.exit(1);
    }
    if (opt.audio && !enc.aac) {
        console.error('Bản ffmpeg này không có encoder aac.');
        process.exit(1);
    }

    const outDir = path.resolve(opt.out || path.join(project, '_optimized'));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assetopt-'));

    console.log('Dự án : ' + project);
    console.log('ffmpeg: ' + tools.dir);
    console.log('Xuất  : ' + (opt.reportOnly ? '(report-only, không ghi gì)' : outDir));
    console.log('');

    const assets = C.scanAssets(project);
    const refs = C.scanReferences(project);
    const shipped = C.scanBuild(opt.build);
    if (shipped) console.log('Build  : ' + opt.build + `  (${shipped.size} asset xuất xưởng)\n`);
    else console.log('Build  : không có — chỉ đo được dung lượng nguồn\n');

    /* Đụng tên: foo.png và foo.jpg cùng ra foo.webp, hoặc foo.webp đã tồn tại sẵn.
       Phát hiện trước khi mã hoá còn hơn để ghi đè âm thầm. */
    const claimed = new Map();
    for (const a of assets) {
        if (!IMAGE_EXT.has(a.ext) && !AUDIO_EXT.has(a.ext)) continue;
        const target = a.rel.replace(/\.[^.]+$/, IMAGE_EXT.has(a.ext) ? '.webp' : '.m4a');
        if (!claimed.has(target)) claimed.set(target, []);
        claimed.get(target).push(a.rel);
    }
    // file đã mang đúng tên đích cũng tính là chiếm chỗ
    for (const a of assets) if (claimed.has(a.rel) && !claimed.get(a.rel).includes(a.rel)) claimed.get(a.rel).push(a.rel);

    const rows = [];
    for (const a of assets) {
        const isImage = IMAGE_EXT.has(a.ext);
        const isAudio = AUDIO_EXT.has(a.ext);
        if (!(isImage && opt.textures) && !(isAudio && opt.audio)) continue;

        const used = refs.has(a.uuid);
        const shipSize = shipped ? (shipped.get(a.uuid.toLowerCase()) || 0) : null;
        const base = { a, kind: isImage ? 'texture' : 'audio', used, shipSize };

        /* Xét auto-atlas TRƯỚC: sprite trong atlas cũng "không có trong build" vì đã bị
           gộp vào một ảnh chung, nhưng đó là chuyện bình thường chứ không phải asset thừa.
           Báo nhầm lý do sẽ khiến người dùng tưởng tham chiếu bị gãy. */
        if (a.inAutoAtlas) {
            rows.push({ ...base, verdict: 'skip', reason: 'trong auto-atlas' });
            continue;
        }
        // asset không có trong build thì tối ưu nó không đổi được một byte nào của gói
        if (shipped && !shipSize && !opt.all) {
            rows.push({ ...base, verdict: 'skip', reason: used ? 'không có trong build' : 'không dùng, không có trong build' });
            continue;
        }
        const target = a.rel.replace(/\.[^.]+$/, isImage ? '.webp' : '.m4a');
        if ((claimed.get(target) || []).length > 1) {
            rows.push({ ...base, verdict: 'skip', reason: 'đụng tên: ' + claimed.get(target).join(', ') });
            continue;
        }

        const plan = isImage ? planTexture(a, tools, opt, tmpDir) : planAudio(a, tools, opt, tmpDir);
        rows.push({ ...base, ...plan });
    }

    const dups = findDuplicates(rows);
    const atlases = C.findAtlases(opt.build);
    writeOutput(rows, project, outDir, opt);
    report(rows, dups, atlases, opt);

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { }
}

/**
 * Hai asset khác tên nhưng trùng từng byte. Cả hai đều được đóng gói, nên gộp lại
 * là cắt thẳng dung lượng mà không đụng gì tới chất lượng — rẻ hơn mọi thao tác nén.
 */
function findDuplicates(rows) {
    const byHash = new Map();
    for (const r of rows) {
        const h = C.contentHash(r.a.file);
        if (!h) continue;
        if (!byHash.has(h)) byHash.set(h, []);
        byHash.get(h).push(r);
    }
    return [...byHash.values()].filter(g => g.length > 1);
}

/* ------------------------------------------------------------- ghi kết quả */

function writeOutput(rows, project, outDir, opt) {
    const convert = rows.filter(r => r.verdict === 'convert');
    if (opt.reportOnly || !convert.length) return;

    const deletes = [];
    for (const r of convert) {
        const relNew = r.a.rel.replace(/\.[^.]+$/, r.newExt);
        const dst = path.join(outDir, relNew);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(r.pick.file, dst);

        const meta = C.metaForReplacement(r.a.meta);
        if (!C.metaIdentityMatches(r.a.meta, meta)) {
            throw new Error('meta sinh ra lệch danh tính: ' + r.a.rel);
        }
        fs.writeFileSync(dst + '.meta', JSON.stringify(meta, null, 2));

        deletes.push(r.a.rel, r.a.rel + '.meta');
        r.outRel = relNew;
    }

    fs.writeFileSync(path.join(outDir, 'DELETE-LIST.txt'),
        '# File cũ PHẢI xoá khi áp dụng.\n'
        + '# Nếu để lại, assets/ sẽ có hai .meta mang cùng một UUID — Cocos không xử lý được.\n\n'
        + deletes.join('\n') + '\n');

    fs.writeFileSync(path.join(outDir, 'APPLY.md'), applyDoc(project, outDir, convert.length, deletes.length));
}

function applyDoc(project, outDir, nFiles, nDeletes) {
    const p = project.split(path.sep).join('/');
    const o = outDir.split(path.sep).join('/');
    return `# Cách áp dụng

${nFiles} file đã tối ưu. Áp dụng gồm **hai bước** — thiếu bước xoá sẽ tạo UUID trùng.

## 1. Sao lưu

\`\`\`bash
cp -r "${p}/assets" "${p}/assets.backup"
\`\`\`

## 2. Chép file mới rồi xoá file cũ

\`\`\`bash
cp -r "${o}/assets/." "${p}/assets/"
cd "${p}" && while read -r f; do [ -n "$f" ] && [ "\${f#\\#}" = "$f" ] && rm -f "$f"; done < "${o}/DELETE-LIST.txt"
\`\`\`

${nDeletes} đường dẫn cần xoá được liệt kê trong \`DELETE-LIST.txt\`.

## 3. Mở lại Cocos Editor

Editor sẽ import các file mới. UUID giữ nguyên nên mọi tham chiếu trong material,
scene và prefab tự khớp — không phải gán lại gì.

Kiểm tra sau khi import:

\`\`\`bash
node -e "const fs=require('fs'),p=require('path');let n=0;(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const q=p.join(d,e.name);if(e.isDirectory()){w(q);continue}if(!e.name.endsWith('.meta'))continue;const j=JSON.parse(fs.readFileSync(q,'utf8'));if(j.imported===false)n++}})('${p}/assets');console.log(n?n+' asset chua import xong':'tat ca da import')"
\`\`\`

## Lùi lại

\`\`\`bash
rm -rf "${p}/assets" && mv "${p}/assets.backup" "${p}/assets"
\`\`\`
`;
}

/* ---------------------------------------------------------------- báo cáo */

function report(rows, dups, atlases, opt) {
    const groups = [['texture', 'TEXTURE'], ['audio', 'AUDIO']];
    let totOld = 0, totNew = 0;
    const lines = [];

    for (const [kind, title] of groups) {
        const all = rows.filter(r => r.kind === kind);
        const list = all.filter(r => r.verdict !== 'skip');
        const skipped = all.filter(r => r.verdict === 'skip');
        if (!all.length) continue;
        lines.push('', `=== ${title} (${list.length} file xét, ${skipped.length} bỏ qua) ===`, '');
        lines.push('  ' + pad('file', 32) + padL('trước', 10) + padL('sau', 10)
            + padL('giảm', 8) + '  ' + pad('cách làm', 14) + 'ghi chú');

        list.sort((a, b) => b.a.size - a.a.size);
        for (const r of list) {
            const old = r.a.size;
            const neu = r.verdict === 'convert' ? r.pick.size : old;
            // chỉ cộng file thật sự được xét — file bỏ qua không thuộc phạm vi tiết kiệm
            totOld += old; totNew += neu;
            const name = r.a.rel.replace(/^assets\//, '');
            const bits = [];
            if (r.verdict === 'convert') {
                if (r.note) bits.push(r.note);
                if (r.trimmed) bits.push(`cắt ${r.trimmed.toFixed(2)}s im lặng`);
                if (r.pick.psnr !== undefined && r.pick.psnr !== Infinity && r.pick.psnr !== null)
                    bits.push(`PSNR ${r.pick.psnr.toFixed(1)} dB`);
            } else if (r.reason) bits.push(r.reason);
            const note = bits.join(', ');
            lines.push('  ' + pad(name.length > 31 ? '…' + name.slice(-30) : name, 32)
                + padL(KB(old), 10) + padL(r.verdict === 'convert' ? KB(neu) : '—', 10)
                + padL(r.verdict === 'convert' ? '-' + pct(neu, old).toFixed(0) + '%' : '—', 8)
                + '  ' + pad(r.verdict === 'convert' ? r.pick.mode : r.verdict, 14) + note);
        }

        if (skipped.length) {
            const byReason = new Map();
            for (const r of skipped) {
                const k = r.reason || 'không rõ';
                byReason.set(k, (byReason.get(k) || 0) + 1);
            }
            lines.push('', '  Bỏ qua: ' + [...byReason].map(([k, n]) => `${n} ${k}`).join(' · '));
        }
    }

    const audio = rows.filter(r => r.kind === 'audio' && r.verdict === 'convert');
    if (audio.length) {
        lines.push('', '  RAM khi Web Audio giải nén:');
        for (const r of audio) {
            if (!r.ramBefore) continue;
            lines.push('    ' + pad(path.basename(r.a.rel), 30)
                + fmtSize(r.ramBefore) + '  ->  ' + fmtSize(r.ramAfter));
        }
    }

    if (atlases.length) {
        const tot = atlases.reduce((s, a) => s + a.size, 0);
        lines.push('', '  Atlas do build sinh — NGOÀI tầm với của tool (không có file nguồn):');
        for (const a of atlases.slice(0, 5))
            lines.push('    ' + padL(KB(a.size), 9) + ' KB  ' + a.name);
        if (atlases.length > 5) lines.push(`    … còn ${atlases.length - 5} file`);
        lines.push('    Tổng ' + fmtSize(tot) + '. Muốn nhỏ hơn thì chỉnh chất lượng trong'
            + ' auto-atlas.pac,');
        lines.push('    hoặc tắt packing để từng sprite được tối ưu riêng.');
    }

    if (dups.length) {
        lines.push('', '  Trùng byte — gộp lại là cắt dung lượng mà không mất gì:');
        for (const g of dups) {
            lines.push('    ' + KB(g[0].a.size) + ' KB × ' + g.length + '   '
                + g.map(r => r.a.rel.replace(/^assets\//, '')).join('  ≡  '));
        }
    }

    const unused = rows.filter(r => !r.used);
    if (unused.length) {
        lines.push('', `  ${unused.length} file không thấy tham chiếu — xoá hẳn còn hơn tối ưu:`);
        for (const r of unused.sort((a, b) => b.a.size - a.a.size).slice(0, 8))
            lines.push('    ' + padL(KB(r.a.size), 9) + ' KB  ' + r.a.rel);
        if (unused.length > 8) lines.push(`    … còn ${unused.length - 8} file`);
    }

    lines.push('', '  ' + '-'.repeat(76));
    lines.push('  TỔNG: ' + fmtSize(totOld) + '  ->  ' + fmtSize(totNew)
        + '   (-' + pct(totNew, totOld).toFixed(0) + '%, tiết kiệm ' + fmtSize(totOld - totNew) + ')');

    /* Tách khoản tiết kiệm THẬT ra khỏi khoản tiết kiệm trên giấy.
       Nếu không tách, một file mồ côi 19.6 MB sẽ cho con số "-97%" trong khi
       gói cuối không nhỏ đi một byte nào — đúng kiểu nói dối bằng cách bỏ sót. */
    const done = rows.filter(r => r.verdict === 'convert');
    const real = done.filter(r => r.shipSize);
    if (done.length && real.length < done.length) {
        const realSave = real.reduce((s, r) => s + (r.a.size - r.pick.size), 0);
        const totSave = totOld - totNew;
        lines.push('');
        lines.push('  ⚠ Trong đó chỉ ' + fmtSize(realSave) + ' là tiết kiệm THẬT ('
            + real.length + '/' + done.length + ' file có trong build).');
        lines.push('    ' + fmtSize(totSave - realSave) + ' còn lại nằm ở file không xuất xưởng —'
            + ' tối ưu chúng không đổi được');
        lines.push('    một byte nào của gói cuối. Xoá hẳn thì hơn.');
    } else if (real.length) {
        const shipTot = real.reduce((s, r) => s + r.shipSize, 0);
        lines.push('  Các file này đang chiếm ' + fmtSize(shipTot) + ' trong build hiện tại.');
    }
    lines.push('  Ảnh và âm thanh đã nén sẵn nên gzip không giảm thêm — mỗi byte cắt ở đây');
    lines.push('  là một byte thẳng vào gói cuối (≈ ×1.14 sau khi Bingo mã hoá base122).');

    const text = lines.join('\n');
    console.log(text);

    if (!opt.reportOnly) {
        const outDir = path.resolve(opt.out || path.join(path.resolve(opt.project), '_optimized'));
        if (fs.existsSync(outDir)) fs.writeFileSync(path.join(outDir, 'report.txt'), text + '\n');
        console.log('\n  Xem ' + path.join(outDir, 'APPLY.md') + ' để biết cách áp dụng.');
    }
}

/* Chỉ chạy khi được gọi thẳng. Khi bị `require` (server web) thì chỉ xuất hàm ra,
   nhờ vậy hai giao diện dùng chung đúng một bộ luật đã kiểm chứng. */
if (require.main === module) main();

module.exports = { DEFAULTS, IMAGE_EXT, AUDIO_EXT, planTexture, planAudio, findDuplicates };
