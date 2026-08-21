/* Lớp công cụ media: định vị ffmpeg, đọc header ảnh, mã hoá, đo chất lượng.
   Không phụ thuộc gì ngoài Node built-in. Không biết gì về Cocos. */

'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

/* ------------------------------------------------------------------ ffmpeg */

/**
 * Tìm ffmpeg và ffprobe. PATH của một số môi trường (Cocos Editor chẳng hạn)
 * không đáng tin, nên luôn cho phép chỉ định tay.
 */
function findFFmpeg(explicit) {
    const candidates = [];
    if (explicit) {
        // chấp nhận cả đường dẫn thư mục lẫn đường dẫn tới ffmpeg.exe
        const stat = fs.existsSync(explicit) && fs.statSync(explicit);
        candidates.push(stat && stat.isDirectory() ? explicit : path.dirname(explicit));
    }
    const which = process.platform === 'win32' ? 'where' : 'which';
    try {
        // nuốt stderr: `where` in ra "INFO: Could not find files..." khi không thấy,
        // lẫn vào thông báo lỗi của chính tool thì rối
        const out = cp.execFileSync(which, ['ffmpeg'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const first = out.split(/\r?\n/).find(Boolean);
        if (first) candidates.push(path.dirname(first.trim()));
    } catch (_) { /* không có trong PATH */ }

    const exe = process.platform === 'win32' ? '.exe' : '';
    for (const dir of candidates) {
        const ffmpeg = path.join(dir, 'ffmpeg' + exe);
        const ffprobe = path.join(dir, 'ffprobe' + exe);
        if (fs.existsSync(ffmpeg) && fs.existsSync(ffprobe)) return { ffmpeg, ffprobe, dir };
    }
    return null;
}

/** Chạy một tiến trình, gộp stdout+stderr. ffmpeg ghi phần lớn thông tin ra stderr. */
function run(bin, args) {
    const r = cp.spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return {
        ok: r.status === 0,
        code: r.status,
        out: (r.stdout || '') + (r.stderr || ''),
    };
}

/** Encoder nào có mặt trong bản build này. Thiếu libwebp thì tool vô dụng. */
function checkEncoders(ffmpeg) {
    const r = run(ffmpeg, ['-hide_banner', '-encoders']);
    return {
        webp: /\blibwebp\b/.test(r.out),
        aac: /^\s*A[.\w]*\s+aac\s/m.test(r.out),
    };
}

/* -------------------------------------------------------------- đọc ảnh */

/** Ảnh indexed có thể có alpha qua chunk tRNS — phải quét chunk mới biết. */
function pngHasTrns(buf) {
    let off = 8;
    while (off + 8 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('latin1', off + 4, off + 8);
        if (type === 'tRNS') return true;
        if (type === 'IDAT' || type === 'IEND') return false;
        off += 12 + len;
    }
    return false;
}

/* WebP không mã hoá nổi cạnh dài quá 16383 px. Vượt là ffmpeg lỗi khó hiểu. */
const WEBP_MAX_DIM = 16383;

/**
 * Kích thước + có alpha hay không. Trả null nếu không nhận dạng được.
 * Chỉ đọc header nên rẻ, chạy được trên ảnh rất lớn.
 */
function imageInfo(file) {
    let buf;
    try { buf = fs.readFileSync(file); } catch (_) { return null; }

    // PNG
    if (buf.length > 26 && buf[0] === 0x89 && buf[1] === 0x50) {
        const colorType = buf[25];
        const hasAlpha = colorType === 4 || colorType === 6 || (colorType === 3 && pngHasTrns(buf));
        return {
            format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20),
            colorType, hasAlpha, size: buf.length,
        };
    }
    // JPEG — không bao giờ có alpha
    if (buf.length > 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
        let p = 2;
        while (p < buf.length - 9) {
            if (buf[p] !== 0xFF) { p++; continue; }
            const m = buf[p + 1];
            if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
                return {
                    format: 'jpg', height: buf.readUInt16BE(p + 5), width: buf.readUInt16BE(p + 7),
                    colorType: null, hasAlpha: false, size: buf.length,
                };
            }
            p += 2 + buf.readUInt16BE(p + 2);
        }
    }
    // WebP — đã tối ưu rồi, nhận diện để bỏ qua
    if (buf.length > 16 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
        return { format: 'webp', width: 0, height: 0, colorType: null, hasAlpha: false, size: buf.length };
    }
    return null;
}

/**
 * Header chỉ nói "có kênh alpha", không nói alpha đó CÓ DÙNG hay không.
 * Rất nhiều ảnh xuất từ DCC mang kênh alpha đặc 255 — ép chúng vào lossless
 * là mất phần lớn lợi ích mà chẳng bảo vệ được gì.
 *
 * Ba lớp, đúng bằng những gì đo được chắc chắn:
 *   none   — không có kênh alpha
 *   opaque — có kênh nhưng min = 255, tức không pixel nào trong suốt
 *   used   — có pixel trong suốt hoặc bán trong suốt
 *
 * KHÔNG tách tiếp thành "nhị phân" và "chuyển sắc": phân biệt đó cần histogram,
 * còn min/max thì không nói được (ảnh gradient mượt cũng cho min 0 max 255).
 * Mà tách ra cũng vô ích — cả hai đều buộc lossless như nhau.
 *
 * Đắt hơn đọc header (phải giải nén cả ảnh) nên chỉ gọi khi header báo có alpha.
 */
function alphaProfile(ffmpeg, file, info) {
    if (!info || !info.hasAlpha) return 'none';
    const r = run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file,
        '-vf', 'alphaextract,signalstats,metadata=print:key=lavfi.signalstats.YMIN:file=-',
        '-frames:v', '1', '-f', 'null', '-']);
    const m = r.out.match(/=\s*([0-9.]+)/);
    if (!m) return 'used';                       // đo hụt thì chọn phía an toàn
    return parseFloat(m[1]) >= 255 ? 'opaque' : 'used';
}

/** Kích thước thật của một file ảnh bất kỳ (kể cả WebP). Dùng để xác minh đầu ra. */
function imageDims(ffprobe, file) {
    const r = run(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]);
    const m = r.out.match(/(\d+)\s*,\s*(\d+)/);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/**
 * Do tuong quan giua ba kenh mau — dau hieu nhan biet "ban do du lieu".
 *
 * Nen lossy duoc xay tren gia dinh R, G, B gan giong nhau (ban chat cua anh sang
 * phan xa). Ban do du lieu (metallic/roughness/AO nhoi chung) vi pham gia dinh do.
 * Do tren du an Rush: anh giong anh chup 0.83-0.99, ban do du lieu -0.20..0.28.
 *
 * Tra ve tuong quan THAP NHAT trong ba cap, hoac null neu khong doc duoc.
 */
function channelCorrelation(ffmpeg, file) {
    const r = cp.spawnSync(ffmpeg, ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        { maxBuffer: 512 * 1024 * 1024 });
    if (r.status !== 0 || !r.stdout || r.stdout.length < 48) return null;
    const d = r.stdout;
    const px = Math.floor(d.length / 3);
    const step = Math.max(1, Math.floor(px / 200000)) * 3;   // toi da ~200k mau

    let n = 0;
    const sum = [0, 0, 0];
    for (let i = 0; i + 2 < d.length; i += step) { for (let k = 0; k < 3; k++) sum[k] += d[i + k]; n++; }
    if (n < 16) return 1;
    const mean = sum.map(s => s / n);

    const P = [[0, 1], [0, 2], [1, 2]];
    const sxx = [0, 0, 0], sxy = [0, 0, 0];
    for (let i = 0; i + 2 < d.length; i += step) {
        const v = [d[i] - mean[0], d[i + 1] - mean[1], d[i + 2] - mean[2]];
        for (let k = 0; k < 3; k++) sxx[k] += v[k] * v[k];
        for (let k = 0; k < 3; k++) sxy[k] += v[P[k][0]] * v[P[k][1]];
    }
    let worst = 1;
    for (let k = 0; k < 3; k++) {
        const den = Math.sqrt(sxx[P[k][0]] * sxx[P[k][1]]);
        if (den < 1e-6) continue;                            // kenh phang thi khong noi len gi
        const r2 = sxy[k] / den;
        if (r2 < worst) worst = r2;
    }
    return worst;
}

/* ------------------------------------------------------------ ma hoa anh */

function encodeWebp(ffmpeg, src, dst, { lossless, quality }) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-c:v', 'libwebp',
        '-compression_level', '6'];
    if (lossless) args.push('-lossless', '1');
    else args.push('-lossless', '0', '-quality', String(quality));
    args.push(dst);
    const r = run(ffmpeg, args);
    if (!r.ok || !fs.existsSync(dst)) return null;
    return fs.statSync(dst).size;
}

/**
 * PSNR trung bình giữa hai ảnh. Trả Infinity nếu giống hệt, null nếu không đo được.
 * Đây là cổng chất lượng: chỉ so dung lượng thì không phát hiện được lossy phá ảnh.
 *
 * Với ảnh có alpha phải đo trên KẾT QUẢ HIỂN THỊ, không đo thẳng.
 * Bộ lọc `psnr` của ffmpeg chỉ so các mặt phẳng màu và bỏ qua alpha, trong khi
 * libwebp lossy tự do viết lại RGB ở vùng alpha = 0 (không ai nhìn thấy).
 * Đo thẳng sẽ tính cả phần vô hình đó và cho ra con số thấp giả tạo.
 * Ghép lên nền trước khi đo thì khác biệt vô hình cũng vô hình với thước đo.
 */
function psnr(ffmpeg, a, b) {
    const r = run(ffmpeg, ['-hide_banner', '-i', a, '-i', b, '-lavfi', 'psnr', '-f', 'null', '-']);
    const m = r.out.match(/average:(inf|[0-9.]+)/);
    if (!m) return null;
    return m[1] === 'inf' ? Infinity : parseFloat(m[1]);
}

/** Ghép ảnh lên nền phẳng, xoá alpha. Kích thước phải biết trước để dựng nền. */
function flatten(ffmpeg, src, dst, width, height, bg) {
    const r = run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `color=${bg}:s=${width}x${height}`, '-i', src,
        '-lavfi', '[0:v][1:v]overlay=shortest=1,format=rgb24', '-frames:v', '1', dst]);
    return r.ok && fs.existsSync(dst);
}

/**
 * PSNR cho ảnh CÓ alpha — đo trên kết quả hiển thị chứ không đo thẳng.
 *
 * Bộ lọc `psnr` chỉ so các mặt phẳng màu và bỏ qua alpha, trong khi libwebp lossy
 * tự do viết lại RGB ở vùng alpha = 0 (không ai nhìn thấy). Đo thẳng sẽ tính cả
 * phần vô hình đó và cho ra con số thấp giả tạo.
 *
 * Ghép lên hai nền tương phản rồi lấy giá trị TỆ NHẤT: nếu alpha bị lệch, một
 * trong hai nền sẽ lộ ra ngay, còn sai lệch dưới vùng trong suốt thì cả hai đều bỏ qua.
 */
function psnrVisible(ffmpeg, a, b, width, height, tmpDir) {
    const worst = [];
    for (const bg of ['black', 'white']) {
        const fa = path.join(tmpDir, `_ref_${bg}.png`);
        const fb = path.join(tmpDir, `_dis_${bg}.png`);
        if (!flatten(ffmpeg, a, fa, width, height, bg)) return null;
        if (!flatten(ffmpeg, b, fb, width, height, bg)) return null;
        const v = psnr(ffmpeg, fa, fb);
        try { fs.unlinkSync(fa); fs.unlinkSync(fb); } catch (_) { }
        if (v === null) return null;
        worst.push(v);
    }
    return Math.min(...worst);
}

/* --------------------------------------------------------------- audio */

function probeAudio(ffprobe, file) {
    const r = run(ffprobe, ['-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'format=duration,bit_rate:stream=codec_name,channels,sample_rate',
        '-of', 'default=noprint_wrappers=1', file]);
    if (!r.ok) return null;
    const get = (k) => { const m = r.out.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : null; };
    const num = (k) => { const v = get(k); return v === null || v === 'N/A' ? null : Number(v); };
    return {
        codec: get('codec_name'),
        duration: num('duration'),
        channels: num('channels'),
        sampleRate: num('sample_rate'),
        bitRate: num('bit_rate'),
        size: fs.statSync(file).size,
    };
}

/**
 * Im lặng ở CUỐI file. Nếu để nguyên mà sau này cho loop thì nghe rõ khoảng hụt.
 * Trả về mốc thời gian nên cắt tới, hoặc null nếu không có gì để cắt.
 */
function trailingSilence(ffmpeg, file, duration, noiseDb = -45, minDur = 0.2) {
    const r = run(ffmpeg, ['-hide_banner', '-i', file,
        '-af', `silencedetect=noise=${noiseDb}dB:d=${minDur}`, '-f', 'null', '-']);
    let last = null;
    for (const m of r.out.matchAll(/silence_start:\s*([0-9.]+)/g)) last = parseFloat(m[1]);
    if (last === null || duration === null) return null;
    // chỉ tính là im lặng cuối nếu nó kéo tới hết bài
    const ends = r.out.match(/silence_end:\s*([0-9.]+)/g) || [];
    const lastEnd = ends.length ? parseFloat(ends[ends.length - 1].split(':')[1]) : null;
    const reachesEnd = lastEnd === null || Math.abs(lastEnd - duration) < 0.05;
    if (!reachesEnd || duration - last < 0.1) return null;
    return last;
}

function encodeAac(ffmpeg, src, dst, { bitrate, trimTo, mono = false, limit = 0.79 }) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', src];
    if (trimTo) args.push('-t', String(trimTo));
    // limiter chừa biên độ để SFX chồng lên không vỡ tiếng
    args.push('-af', `alimiter=limit=${limit}:level=false`, '-c:a', 'aac', '-b:a', bitrate + 'k');
    if (mono) args.push('-ac', '1');
    args.push(dst);
    const r = run(ffmpeg, args);
    if (!r.ok || !fs.existsSync(dst)) return null;
    return fs.statSync(dst).size;
}

/**
 * Web Audio giải nén ra float32 PCM — thường là chi phí lớn hơn cả dung lượng tải.
 *
 * Dùng sample rate của AudioContext chứ không phải của file: trình duyệt lấy mẫu lại
 * về tần số phần cứng khi giải nén, nên hạ sample rate của file KHÔNG giảm RAM.
 * 48 kHz là mặc định phổ biến trên di động và là phía bi quan.
 */
function webAudioRam(duration, channels, contextRate = 48000) {
    if (!duration || !channels) return null;
    return duration * contextRate * channels * 4;
}

module.exports = {
    findFFmpeg, run, checkEncoders, WEBP_MAX_DIM,
    imageInfo, alphaProfile, channelCorrelation, imageDims, encodeWebp, psnr, flatten, psnrVisible,
    probeAudio, trailingSilence, encodeAac, webAudioRam,
};
