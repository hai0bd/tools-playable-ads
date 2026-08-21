/* Phân tích và mã hoá ảnh — chạy hoàn toàn trong trình duyệt, không cần ffmpeg.
 *
 * Đọc thẳng pixel nên chính xác hơn đường ffmpeg: alpha và PSNR là con số đếm
 * được, không phải giá trị thống kê suy ra từ bộ lọc.
 */

(function (global) {
    'use strict';

    /* WebP không mã hoá nổi cạnh dài quá 16383 px. */
    const WEBP_MAX_DIM = 16383;

    /* ------------------------------------------------------------- đọc file */

    /** Định dạng thật, đọc từ vài byte đầu chứ không tin phần mở rộng. */
    async function sniff(file) {
        const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
        if (head[0] === 0x89 && head[1] === 0x50) return 'png';
        if (head[0] === 0xFF && head[1] === 0xD8) return 'jpg';
        const tag = String.fromCharCode(...head.slice(0, 4)) + String.fromCharCode(...head.slice(8, 12));
        if (tag === 'RIFFWEBP') return 'webp';
        return null;
    }

    /**
     * Giải mã ảnh ra canvas + ImageData.
     *
     * Lưu ý đã ĐO được: bước drawImage làm đổi RGB nằm dưới pixel alpha = 0
     * (do nhân alpha rồi chia ngược). Pixel nhìn thấy và kênh alpha thì nguyên vẹn.
     * Vô hình với mắt, và không ảnh hưởng biên cắt sprite-frame vì Cocos chỉ đọc alpha.
     */
    async function load(file) {
        const format = await sniff(file);
        if (!format) return null;
        const bmp = await createImageBitmap(file);
        const canvas = document.createElement('canvas');
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.clearRect(0, 0, bmp.width, bmp.height);
        ctx.drawImage(bmp, 0, 0);
        bmp.close();
        return {
            format, canvas, ctx,
            width: canvas.width, height: canvas.height,
            data: ctx.getImageData(0, 0, canvas.width, canvas.height),
            size: file.size,
        };
    }

    /* ----------------------------------------------------------- phân tích */

    /**
     * Alpha có thật sự được dùng không.
     *
     * Header chỉ nói "có kênh alpha", không nói kênh đó có tác dụng. Rất nhiều ảnh
     * xuất từ DCC mang alpha đặc 255 — ép chúng vào lossless là mất phần lớn lợi ích
     * mà chẳng bảo vệ được gì.
     *
     * Chỉ phân hai lớp có ý nghĩa: alpha đặc thì cho lossy, có pixel trong suốt thì
     * buộc lossless. Không tách tiếp thành "nhị phân" / "chuyển sắc" — cả hai đều
     * dẫn tới cùng một quyết định.
     */
    function alphaProfile(imageData) {
        const d = imageData.data;
        for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return 'used';
        return 'opaque';
    }

    /**
     * Độ tương quan giữa ba kênh màu — dấu hiệu nhận biết "bản đồ dữ liệu".
     *
     * Nén ảnh lossy được xây trên giả định R, G, B gần giống nhau, vì đó là bản chất
     * của ánh sáng phản xạ từ vật thể. Bản đồ dữ liệu (metallic/roughness/AO nhồi chung)
     * vi phạm giả định đó: ba kênh cất ba con số chẳng liên quan gì đến nhau.
     *
     * Đo được trên dự án Rush: ảnh giống ảnh chụp cho tương quan 0.83–0.99 và chịu lossy
     * tốt (PSNR 35 dB); bản đồ dữ liệu cho −0.20 đến 0.28 và hỏng nặng (PSNR 25 dB).
     *
     * Trả về tương quan THẤP NHẤT trong ba cặp. Lấy mẫu thưa khi ảnh lớn — đây là đại
     * lượng thống kê, không cần duyệt hết từng pixel.
     */
    function channelCorrelation(imageData) {
        const d = imageData.data;
        const px = d.length / 4;
        const step = Math.max(1, Math.floor(px / 200000)) * 4;   // tối đa ~200k mẫu

        let n = 0;
        const sum = [0, 0, 0];
        for (let i = 0; i < d.length; i += step) {
            for (let k = 0; k < 3; k++) sum[k] += d[i + k];
            n++;
        }
        if (n < 16) return 1;                                     // quá ít mẫu -> coi như bình thường
        const mean = sum.map(s => s / n);

        const P = [[0, 1], [0, 2], [1, 2]];                       // RG, RB, GB
        const sxx = [0, 0, 0], sxy = [0, 0, 0];
        for (let i = 0; i < d.length; i += step) {
            const v = [d[i] - mean[0], d[i + 1] - mean[1], d[i + 2] - mean[2]];
            for (let k = 0; k < 3; k++) sxx[k] += v[k] * v[k];
            for (let k = 0; k < 3; k++) sxy[k] += v[P[k][0]] * v[P[k][1]];
        }
        let worst = 1;
        for (let k = 0; k < 3; k++) {
            const den = Math.sqrt(sxx[P[k][0]] * sxx[P[k][1]]);
            // kênh phẳng tuyệt đối không nói lên điều gì — bỏ qua thay vì chia cho 0
            if (den < 1e-6) continue;
            const r = sxy[k] / den;
            if (r < worst) worst = r;
        }
        return worst;
    }

    /** Có bao nhiêu màu khác nhau — ảnh ít màu thì lossless thường thắng lossy. */
    function countColors(imageData, cap = 4096) {
        const seen = new Set();
        const d = imageData.data;
        for (let i = 0; i < d.length; i += 4) {
            seen.add((d[i] << 24 | d[i + 1] << 16 | d[i + 2] << 8 | d[i + 3]) >>> 0);
            if (seen.size > cap) return cap + 1;
        }
        return seen.size;
    }

    /* -------------------------------------------------------------- mã hoá */

    /**
     * quality = 1.0 cho ra WebP LOSSLESS trong Chrome — đã đo: pixel giống hệt.
     * Các mức dưới 1.0 là lossy.
     */
    function encode(canvas, { lossless, quality }) {
        return new Promise(r => canvas.toBlob(r, 'image/webp', lossless ? 1.0 : quality / 100));
    }

    /* ------------------------------------------------------- đo chất lượng */

    /**
     * PSNR đo trên KẾT QUẢ HIỂN THỊ, không đo thẳng.
     *
     * So thẳng các kênh màu sẽ tính cả sai lệch ở vùng alpha = 0 — nơi không ai
     * nhìn thấy — và cho ra con số thấp giả tạo. Ghép lên nền rồi mới so thì khác
     * biệt vô hình cũng vô hình với thước đo.
     *
     * Lấy giá trị TỆ NHẤT giữa nền đen và nền trắng: alpha bị lệch thì một trong hai
     * nền lộ ra ngay, còn sai lệch dưới vùng trong suốt thì cả hai đều bỏ qua.
     */
    function psnrVisible(a, b) {
        if (a.width !== b.width || a.height !== b.height) return null;
        let worst = Infinity;
        for (const bg of [0, 255]) {
            let sum = 0, n = 0;
            const x = a.data, y = b.data;
            for (let i = 0; i < x.length; i += 4) {
                const xa = x[i + 3] / 255, ya = y[i + 3] / 255;
                for (let k = 0; k < 3; k++) {
                    const dv = (x[i + k] * xa + bg * (1 - xa)) - (y[i + k] * ya + bg * (1 - ya));
                    sum += dv * dv; n++;
                }
            }
            const psnr = sum === 0 ? Infinity : 10 * Math.log10(65025 / (sum / n));
            if (psnr < worst) worst = psnr;
        }
        return worst;
    }

    /** Kiểm tra hai ảnh có giống nhau từng bit không, tách riêng phần nhìn thấy. */
    function compare(a, b) {
        let anDuoiTrongSuot = 0, nhinThay = 0, alpha = 0;
        const x = a.data, y = b.data;
        for (let i = 0; i < x.length; i += 4) {
            const trong = x[i + 3] === 0 && y[i + 3] === 0;
            for (let k = 0; k < 3; k++) if (x[i + k] !== y[i + k]) trong ? anDuoiTrongSuot++ : nhinThay++;
            if (x[i + 3] !== y[i + 3]) alpha++;
        }
        return { anDuoiTrongSuot, nhinThay, alpha };
    }

    /** Giải mã một Blob đã mã hoá để đối chiếu với bản gốc. */
    async function decodeBlob(blob) {
        const bmp = await createImageBitmap(blob);
        const c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.clearRect(0, 0, bmp.width, bmp.height);
        g.drawImage(bmp, 0, 0);
        bmp.close();
        return { data: g.getImageData(0, 0, c.width, c.height), width: c.width, height: c.height };
    }

    global.IMG = {
        WEBP_MAX_DIM, sniff, load, alphaProfile, channelCorrelation, countColors,
        encode, psnrVisible, compare, decodeBlob,
    };
})(window);
