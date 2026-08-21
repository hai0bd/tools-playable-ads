/* Ghi file .zip trong trình duyệt, không cần thư viện.
   Dùng method 0 (store) vì mọi thứ đi qua đây đều là WebP hoặc AAC — đã nén sẵn. */

(function (global) {
    'use strict';

    const CRC_TABLE = (() => {
        const t = new Int32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            t[i] = c;
        }
        return t;
    })();

    function crc32(buf) {
        let c = -1;
        for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ -1) >>> 0;
    }

    /** Giờ theo định dạng MS-DOS mà ZIP dùng — độ phân giải 2 giây, gốc năm 1980. */
    function dosTime(d) {
        return {
            time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31),
            day: (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31),
        };
    }

    /** entries: [{name, data: Uint8Array}] -> Blob */
    function make(entries, when = new Date()) {
        const { time, day } = dosTime(when);
        const enc = new TextEncoder();
        const parts = [], central = [];
        let offset = 0;

        for (const e of entries) {
            const name = enc.encode(e.name.split('\\').join('/'));
            const data = e.data instanceof Uint8Array ? e.data : new Uint8Array(e.data);
            const crc = crc32(data);

            const lh = new DataView(new ArrayBuffer(30));
            lh.setUint32(0, 0x04034b50, true);
            lh.setUint16(4, 20, true);
            lh.setUint16(6, 0x0800, true);   // cờ: tên file UTF-8
            lh.setUint16(8, 0, true);        // method 0 = store
            lh.setUint16(10, time, true);
            lh.setUint16(12, day, true);
            lh.setUint32(14, crc, true);
            lh.setUint32(18, data.length, true);
            lh.setUint32(22, data.length, true);
            lh.setUint16(26, name.length, true);
            parts.push(new Uint8Array(lh.buffer), name, data);

            const ch = new DataView(new ArrayBuffer(46));
            ch.setUint32(0, 0x02014b50, true);
            ch.setUint16(4, 20, true);
            ch.setUint16(6, 20, true);
            ch.setUint16(8, 0x0800, true);
            ch.setUint16(10, 0, true);
            ch.setUint16(12, time, true);
            ch.setUint16(14, day, true);
            ch.setUint32(16, crc, true);
            ch.setUint32(20, data.length, true);
            ch.setUint32(24, data.length, true);
            ch.setUint16(28, name.length, true);
            ch.setUint32(42, offset, true);
            central.push(new Uint8Array(ch.buffer), name);

            offset += 30 + name.length + data.length;
        }

        const cdSize = central.reduce((s, p) => s + p.length, 0);
        const eocd = new DataView(new ArrayBuffer(22));
        eocd.setUint32(0, 0x06054b50, true);
        eocd.setUint16(8, entries.length, true);
        eocd.setUint16(10, entries.length, true);
        eocd.setUint32(12, cdSize, true);
        eocd.setUint32(16, offset, true);

        return new Blob([...parts, ...central, new Uint8Array(eocd.buffer)], { type: 'application/zip' });
    }

    global.ZIP = { make, crc32 };
})(window);
