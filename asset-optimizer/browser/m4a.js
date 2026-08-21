/* Mã hoá AAC-LC và đóng gói .m4a — chạy hoàn toàn trong trình duyệt.
 *
 * WebCodecs `AudioEncoder` cho ra KHUNG AAC thô, không phải file. Muốn thành .m4a
 * phải tự dựng container MP4. Đó là lý do file này tồn tại.
 *
 * Cách khác là MediaRecorder với 'audio/mp4' — cho ra file hoàn chỉnh, không cần
 * muxer, nhưng nó ghi theo THỜI GIAN THẬT: bài 48 giây mất đúng 48 giây để mã hoá.
 * Tự viết muxer thì xong trong chớp mắt.
 */

(function (global) {
    'use strict';

    /* --------------------------------------------------------- dựng box MP4 */

    const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    const u16 = n => [(n >>> 8) & 255, n & 255];
    const str = s => [...s].map(c => c.charCodeAt(0));

    /** Mỗi box MP4 là: [4 byte độ dài][4 byte tên][nội dung]. Lồng nhau tuỳ ý. */
    function box(type, ...parts) {
        const body = [];
        for (const p of parts) {
            if (p instanceof Uint8Array) body.push(...p);
            else if (Array.isArray(p)) body.push(...p);
            else throw new Error('phần không hợp lệ trong box ' + type);
        }
        return new Uint8Array([...u32(body.length + 8), ...str(type), ...body]);
    }

    /**
     * esds — nơi khai báo "đây là AAC-LC, cấu hình giải mã như sau".
     * `asc` (AudioSpecificConfig) lấy thẳng từ WebCodecs, không tự bịa.
     */
    function esds(asc, bitrate) {
        /* Ba lớp descriptor lồng nhau, mỗi lớp là [tag][độ dài][nội dung].
           Độ dài phải khớp CHÍNH XÁC nội dung: bộ giải mã thường bỏ qua phần thừa
           nên file vẫn phát, nhưng ffprobe sẽ không đọc ra profile. */
        const dec = [0x05, asc.length, ...asc];          // DecoderSpecificInfo
        const cfgBody = [
            0x40,                                        // objectTypeIndication: MPEG-4 audio
            0x15,                                        // streamType 5 (audio) << 2 | upStream 0 | reserved 1
            0, 0, 0,                                     // bufferSizeDB — đúng 3 byte, không hơn
            ...u32(bitrate),                             // maxBitrate
            ...u32(bitrate),                             // avgBitrate
            ...dec,
        ];
        const cfg = [0x04, cfgBody.length, ...cfgBody];
        const sl = [0x06, 1, 2];                         // SLConfigDescriptor: predefined = MP4
        const esBody = [0, 0, 0, ...cfg, ...sl];         // ES_ID (2 byte) + cờ (1 byte)
        return box('esds', [0, 0, 0, 0], [0x03, esBody.length, ...esBody]);
    }

    function mp4aBox(channels, sampleRate, asc, bitrate) {
        return box('mp4a',
            [0, 0, 0, 0, 0, 0], u16(1),          // reserved + data reference index
            [0, 0, 0, 0, 0, 0, 0, 0],
            u16(channels), u16(16), [0, 0, 0, 0],
            u16(sampleRate), [0, 0],             // sample rate ở dạng 16.16 fixed point
            esds(asc, bitrate));
    }

    /**
     * Ghép các khung AAC thành file .m4a hoàn chỉnh.
     * `frames` là mảng Uint8Array, mỗi phần tử là một khung 1024 mẫu.
     */
    function mux(frames, { sampleRate, channels, asc, bitrate = 128000, samplesPerFrame = 1024 }) {
        const totalSamples = frames.length * samplesPerFrame;
        const sizes = frames.map(f => f.length);
        const mdatSize = sizes.reduce((a, b) => a + b, 0);

        const stbl = box('stbl',
            box('stsd', [0, 0, 0, 0], u32(1), mp4aBox(channels, sampleRate, asc, bitrate)),
            box('stts', [0, 0, 0, 0], u32(1), u32(frames.length), u32(samplesPerFrame)),
            box('stsc', [0, 0, 0, 0], u32(1), u32(1), u32(frames.length), u32(1)),
            box('stsz', [0, 0, 0, 0], u32(0), u32(frames.length), sizes.flatMap(u32)),
            box('stco', [0, 0, 0, 0], u32(1), u32(0)));   // vá lại sau khi biết vị trí mdat

        const moov = box('moov',
            box('mvhd', [0, 0, 0, 0], u32(0), u32(0), u32(sampleRate), u32(totalSamples),
                u32(0x00010000), u16(0x0100), [0, 0], u32(0), u32(0),
                ...[0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(u32),
                u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(2)),
            box('trak',
                box('tkhd', [0, 0, 0, 7],            // flags 7 = bật + hiện trong phim
                    u32(0), u32(0), u32(1), u32(0), u32(totalSamples),
                    u32(0), u32(0), u16(0), u16(0), u16(0x0100), u16(0),
                    ...[0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(u32),
                    u32(0), u32(0)),
                box('mdia',
                    box('mdhd', [0, 0, 0, 0], u32(0), u32(0), u32(sampleRate), u32(totalSamples),
                        u16(0x55C4), u16(0)),        // 0x55C4 = mã ngôn ngữ "und"
                    box('hdlr', [0, 0, 0, 0], u32(0), str('soun'),
                        u32(0), u32(0), u32(0), [0]),
                    box('minf',
                        box('smhd', [0, 0, 0, 0], u16(0), u16(0)),
                        box('dinf', box('dref', [0, 0, 0, 0], u32(1),
                            box('url ', [0, 0, 0, 1]))),
                        stbl))));

        const ftyp = box('ftyp', str('M4A '), u32(512), str('M4A '), str('mp42'), str('isom'));

        /* stco phải trỏ tới vị trí THẬT của dữ liệu trong file. Chỉ biết được sau khi
           đã dựng xong ftyp và moov, nên dựng trước rồi vá số vào sau. */
        const mdatStart = ftyp.length + moov.length + 8;
        const stcoAt = findStco(moov);
        if (stcoAt < 0) throw new Error('không tìm thấy stco để vá');
        moov.set(u32(mdatStart), stcoAt);

        const out = new Uint8Array(ftyp.length + moov.length + 8 + mdatSize);
        let p = 0;
        out.set(ftyp, p); p += ftyp.length;
        out.set(moov, p); p += moov.length;
        out.set(u32(mdatSize + 8), p); p += 4;
        out.set(str('mdat'), p); p += 4;
        for (const f of frames) { out.set(f, p); p += f.length; }
        return out;
    }

    /** Vị trí của ô "chunk offset" đầu tiên bên trong box stco. */
    function findStco(buf) {
        for (let i = 0; i < buf.length - 4; i++) {
            if (buf[i] === 0x73 && buf[i + 1] === 0x74 && buf[i + 2] === 0x63 && buf[i + 3] === 0x6F)
                return i + 4 + 4 + 4;   // 'stco' + version/flags + entry count
        }
        return -1;
    }

    /* ----------------------------------------------------------- mã hoá AAC */

    /**
     * AudioBuffer -> Blob .m4a.
     * `onProgress` nhận số từ 0 đến 1 để giao diện báo tiến độ.
     */
    async function encode(audioBuffer, { bitrate = 96000, mono = false, onProgress } = {}) {
        if (typeof AudioEncoder === 'undefined') throw new Error('trình duyệt không có WebCodecs AudioEncoder');

        const channels = mono ? 1 : Math.min(audioBuffer.numberOfChannels, 2);
        const sampleRate = audioBuffer.sampleRate;
        const frames = [];
        let asc = null;

        const encoder = new AudioEncoder({
            output: (chunk, meta) => {
                if (meta && meta.decoderConfig && meta.decoderConfig.description && !asc) {
                    asc = new Uint8Array(meta.decoderConfig.description);
                }
                const b = new Uint8Array(chunk.byteLength);
                chunk.copyTo(b);
                frames.push(b);
            },
            error: e => { throw e; },
        });
        encoder.configure({ codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels, bitrate });

        // trộn về mono bằng cách lấy trung bình, giữ nguyên năng lượng cảm nhận
        const src = [];
        for (let c = 0; c < audioBuffer.numberOfChannels; c++) src.push(audioBuffer.getChannelData(c));
        const total = audioBuffer.length;
        const CHUNK = 4096;

        for (let start = 0; start < total; start += CHUNK) {
            const n = Math.min(CHUNK, total - start);
            // WebCodecs muốn dữ liệu phẳng theo kênh (planar f32)
            const data = new Float32Array(n * channels);
            for (let c = 0; c < channels; c++) {
                const dst = data.subarray(c * n, (c + 1) * n);
                if (mono && src.length > 1) {
                    for (let i = 0; i < n; i++) {
                        let s = 0;
                        for (let k = 0; k < src.length; k++) s += src[k][start + i];
                        dst[i] = s / src.length;
                    }
                } else {
                    dst.set(src[Math.min(c, src.length - 1)].subarray(start, start + n));
                }
            }
            encoder.encode(new AudioData({
                format: 'f32-planar', sampleRate, numberOfFrames: n,
                numberOfChannels: channels, timestamp: Math.round(start / sampleRate * 1e6), data,
            }));
            if (onProgress) onProgress(start / total);
            // nhường luồng để giao diện không đứng hình
            if ((start / CHUNK) % 32 === 0) await new Promise(r => setTimeout(r, 0));
        }

        await encoder.flush();
        encoder.close();
        if (onProgress) onProgress(1);

        if (!frames.length) throw new Error('không mã hoá được khung nào');
        if (!asc) throw new Error('không lấy được AudioSpecificConfig từ encoder');

        return new Blob([mux(frames, { sampleRate, channels, asc, bitrate })], { type: 'audio/mp4' });
    }

    global.M4A = { encode, mux };
})(window);
