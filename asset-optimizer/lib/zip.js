/* Bộ ghi ZIP tối giản, không phụ thuộc package nào.
 *
 * Dùng method 0 (store, không nén) vì mọi thứ đi qua đây đều là WebP hoặc AAC —
 * đã nén sẵn, DEFLATE thêm chỉ tốn CPU mà giảm được 0-2%.
 */

'use strict';

/* Bảng CRC32 chuẩn ZIP, dựng sẵn một lần. */
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
function dosTime(date) {
    const time = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() / 2) & 31);
    const day = (((date.getFullYear() - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
    return { time, day };
}

/**
 * Đóng gói danh sách {name, data} thành một Buffer ZIP.
 * `name` dùng dấu / và là đường dẫn tương đối trong gói.
 */
function makeZip(entries, when = new Date()) {
    const { time, day } = dosTime(when);
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const e of entries) {
        const name = Buffer.from(e.name.split('\\').join('/'), 'utf8');
        const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
        const crc = crc32(data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);          // cần version 2.0 để đọc
        local.writeUInt16LE(0x0800, 6);      // cờ: tên file mã hoá UTF-8
        local.writeUInt16LE(0, 8);           // method 0 = store
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(day, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        locals.push(local, name, data);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt16LE(time, 12);
        central.writeUInt16LE(day, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(0, 38);        // thuộc tính ngoài
        central.writeUInt32LE(offset, 42);   // vị trí local header tương ứng
        centrals.push(central, name);

        offset += local.length + name.length + data.length;
    }

    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);

    return Buffer.concat([...locals, cd, eocd]);
}

module.exports = { makeZip, crc32 };
