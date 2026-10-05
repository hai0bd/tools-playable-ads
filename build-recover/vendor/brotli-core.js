/*
 * brotli-core.js — giải & nén Brotli (RFC 7932) bằng JS thuần, không phụ thuộc gì.
 * ------------------------------------------------------------------------------------
 * UMD → chạy cả browser (panel) lẫn Node (tests).
 * Global: window.BrotliCore   |   Node: require("./brotli-core")
 *
 * Vì sao phải tự viết: Luna nén âm thanh, JSON bundle, data.blob (mesh…) và cả code game bằng
 * Brotli, mà trình duyệt KHÔNG có Brotli cho JS dùng — Chrome 152 vẫn báo "Unsupported
 * compression format" cho cả CompressionStream lẫn DecompressionStream("brotli"). Chỉ có
 * gzip/deflate. Muốn đọc asset Luna thì phải giải được, muốn ghi lại thì phải nén được
 * đúng định dạng mà bộ giải nhúng sẵn trong playable (makeBrotliDecodeStr) đọc hiểu.
 *
 *   decompress(bytes)        → Uint8Array   (đủ RFC 7932, kể cả context map & block switch)
 *   compress(bytes, opts)    → Uint8Array   (LZ77 + Huffman, 1 block type / meta-block)
 *
 * Bộ nén không cố bằng brotli -q11 của Luna: chỉ dùng cho asset người dùng vừa sửa, còn asset
 * không đụng tới giữ nguyên payload gốc từng byte.
 *
 * Static dictionary: RFC có từ điển 122 KB. Bộ nén ở đây không bao giờ dùng nó. Bộ giải chỉ
 * cần tới khi dữ liệu có tham chiếu từ điển — gặp thì báo lỗi rõ ràng thay vì ra rác.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    root.BrotliCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    // ───────────────────────── bảng hằng của RFC 7932 ─────────────────────────
    var CODE_LENGTH_ORDER = [1, 2, 3, 4, 0, 5, 17, 6, 16, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    // Mã cố định để đọc độ dài của "code length code" (§3.5): tra 4 bit kế tiếp.
    var CL_PREFIX_LEN = [2, 2, 2, 3, 2, 2, 2, 4, 2, 2, 2, 3, 2, 2, 2, 4];
    var CL_PREFIX_VAL = [0, 4, 3, 2, 0, 4, 3, 1, 0, 4, 3, 2, 0, 4, 3, 5];

    var BLOCK_LEN_BASE = [1, 5, 9, 13, 17, 25, 33, 41, 49, 65, 81, 97, 113, 145, 177, 209, 241, 305, 369, 497, 753, 1265, 2289, 4337, 8433, 16625];
    var BLOCK_LEN_BITS = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 7, 8, 9, 10, 11, 12, 13, 24];

    var INSERT_BASE = [0, 1, 2, 3, 4, 5, 6, 8, 10, 14, 18, 26, 34, 50, 66, 98, 130, 194, 322, 578, 1090, 2114, 6210, 22594];
    var INSERT_BITS = [0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 10, 12, 14, 24];
    var COPY_BASE = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 18, 22, 30, 38, 54, 70, 102, 134, 198, 326, 582, 1094, 2118];
    var COPY_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 10, 24];

    // Ô lệnh insert&copy (§5): theo cmd >> 6 → [offset mã insert, offset mã copy]. Ô 0 và 1
    // ngầm hiểu distance code 0 (dùng lại khoảng cách gần nhất).
    var CELL_INSERT = [0, 0, 0, 0, 8, 8, 0, 16, 8, 16, 16];
    var CELL_COPY = [0, 8, 0, 8, 0, 8, 16, 0, 16, 8, 16];

    // Ngữ cảnh literal (§7.1) cho chế độ UTF8 và Signed.
    var LUT0 = [
        0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 4, 0, 0, 4, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        8, 12, 16, 12, 12, 20, 12, 16, 24, 28, 12, 12, 32, 12, 36, 12,
        44, 44, 44, 44, 44, 44, 44, 44, 44, 44, 32, 32, 24, 40, 28, 12,
        12, 48, 52, 52, 52, 48, 52, 52, 52, 48, 52, 52, 52, 52, 52, 48,
        52, 52, 52, 52, 52, 48, 52, 52, 52, 52, 52, 24, 12, 28, 12, 12,
        12, 56, 60, 60, 60, 56, 60, 60, 60, 56, 60, 60, 60, 60, 60, 56,
        60, 60, 60, 60, 60, 56, 60, 60, 60, 60, 60, 24, 12, 28, 12, 0
    ];
    var LUT1 = [
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
        2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1,
        1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
        2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1,
        1, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
        3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 1, 1, 1, 1, 0
    ];
    (function () {
        // Nửa trên (128..255): Lut0 xen kẽ 0,1 (80..BF) rồi 2,3 (C0..FF). Lut1 là 0 tới hết
        // DF, chỉ E0..FF mới là 2 — ranh giới ở E0 chứ không ở C0; đã đối chiếu với zlib trên
        // bundle.json Luna có chữ Nhật/Trung (nhầm ranh giới là lệch ngay sau ký tự 2 byte).
        for (var i = 128; i < 256; i++) {
            LUT0[i] = (i < 192 ? 0 : 2) + (i & 1);
            LUT1[i] = i < 224 ? 0 : 2;
        }
    })();
    var LUT2 = new Array(256);
    (function () {
        for (var i = 0; i < 256; i++) {
            LUT2[i] = i === 0 ? 0 : i < 16 ? 1 : i < 64 ? 2 : i < 128 ? 3 : i < 192 ? 4 : i < 240 ? 5 : i < 255 ? 6 : 7;
        }
    })();

    function contextId(mode, p1, p2) {
        switch (mode) {
            case 0: return p1 & 0x3f;                  // LSB6
            case 1: return p1 >> 2;                    // MSB6
            case 2: return LUT0[p1] | LUT1[p2];        // UTF8
            default: return (LUT2[p1] << 3) | LUT2[p2]; // Signed
        }
    }

    // ───────────────────────── đọc bit (LSB trước) ─────────────────────────
    function BitReader(data) {
        this.data = data;
        this.pos = 0;     // byte kế tiếp sẽ nạp
        this.buf = 0;     // bit chưa dùng, bit thấp là bit đọc trước
        this.cnt = 0;     // số bit trong buf
    }
    BitReader.prototype.fill = function (n) {
        while (this.cnt < n) {
            if (this.pos > this.data.length + 4) throw new Error("Brotli: dữ liệu bị cụt");
            var b = this.pos < this.data.length ? this.data[this.pos] : 0;
            this.pos++;
            this.buf = (this.buf | (b << this.cnt)) >>> 0;
            this.cnt += 8;
        }
    };
    BitReader.prototype.read = function (n) {
        if (n === 0) return 0;
        this.fill(n);
        var v = n === 32 ? this.buf : (this.buf & ((1 << n) - 1)) >>> 0;
        this.buf = n === 32 ? 0 : this.buf >>> n;
        this.cnt -= n;
        return v;
    };
    // Bỏ phần bit lẻ tới ranh giới byte (trước khối không nén / metadata).
    BitReader.prototype.alignToByte = function () {
        var drop = this.cnt & 7;
        if (drop) this.read(drop);
    };
    BitReader.prototype.readByteAligned = function () {
        if (this.cnt >= 8) return this.read(8);
        if (this.pos >= this.data.length) throw new Error("Brotli: dữ liệu bị cụt");
        return this.data[this.pos++];
    };

    // ───────────────────────── mã tiền tố (Huffman chuẩn tắc) ─────────────────────────
    // Mã Brotli giống Deflate: gán chuẩn tắc theo (độ dài, giá trị symbol), bit đầu của mã được
    // ghi trước. Bảng nhanh 8 bit cho mã ngắn, mã dài hơn đọc từng bit kiểu puff.
    var FAST_BITS = 8;

    function buildHuffman(lengths, alphabetSize) {
        var count = new Int32Array(16), used = 0, last = -1;
        for (var s = 0; s < alphabetSize; s++) {
            if (lengths[s]) { count[lengths[s]]++; used++; last = s; }
        }
        if (used === 0) throw new Error("Brotli: mã tiền tố rỗng");
        // 1 symbol duy nhất → đọc 0 bit (mã đơn giản NSYM=1, hoặc code-length code chỉ có 1 mã).
        if (used === 1) return { single: last };
        var offs = new Int32Array(16);
        for (var len = 1; len < 16; len++) offs[len] = offs[len - 1] + count[len - 1];
        var symbols = new Int32Array(used);
        var order = offs.slice();
        for (s = 0; s < alphabetSize; s++) if (lengths[s]) symbols[order[lengths[s]]++] = s;
        // Bảng nhanh: chỉ mục là FAST_BITS bit kế tiếp (LSB = bit đọc trước).
        var table = new Int32Array(1 << FAST_BITS).fill(-1);
        var code = 0, k = 0;
        for (len = 1; len < 16; len++) {
            for (var i = 0; i < count[len]; i++, k++) {
                if (len <= FAST_BITS) {
                    var rev = 0;
                    for (var b = 0; b < len; b++) rev |= ((code >> b) & 1) << (len - 1 - b);
                    for (var fill = rev; fill < (1 << FAST_BITS); fill += (1 << len)) table[fill] = (len << 16) | symbols[k];
                }
                code++;
            }
            code <<= 1;
        }
        return { single: -1, count: count, symbols: symbols, table: table };
    }

    function readSymbol(br, h) {
        if (h.single >= 0) return h.single;
        br.fill(15);
        var e = h.table[br.buf & ((1 << FAST_BITS) - 1)];
        if (e >= 0) {
            var n = e >>> 16;
            br.buf >>>= n;
            br.cnt -= n;
            return e & 0xffff;
        }
        // Mã dài hơn FAST_BITS: giải chuẩn tắc từng bit (thuật toán của puff).
        var code = 0, first = 0, index = 0, bits = br.buf;
        for (var len = 1; len < 16; len++) {
            code |= bits & 1;
            bits >>>= 1;
            var c = h.count[len];
            if (code - first < c) {
                br.buf >>>= len;
                br.cnt -= len;
                return h.symbols[index + code - first];
            }
            index += c;
            first += c;
            first <<= 1;
            code <<= 1;
        }
        throw new Error("Brotli: mã tiền tố không hợp lệ");
    }

    function alphabetBits(size) {
        var bits = 0;
        while ((1 << bits) < size) bits++;
        return bits;
    }

    // §3.4 & §3.5 — đọc một mã tiền tố (dạng đơn giản hoặc phức hợp).
    function readPrefixCode(br, alphabetSize) {
        var lengths = new Uint8Array(alphabetSize);
        var hskip = br.read(2);
        if (hskip === 1) {
            var nsym = br.read(2) + 1, bits = alphabetBits(alphabetSize), syms = [];
            for (var i = 0; i < nsym; i++) {
                var sym = br.read(bits);
                if (sym >= alphabetSize) throw new Error("Brotli: symbol vượt bảng chữ cái");
                if (syms.indexOf(sym) >= 0) throw new Error("Brotli: symbol lặp trong mã đơn giản");
                syms.push(sym);
            }
            if (nsym === 1) { return { single: syms[0] }; }
            if (nsym === 2) { lengths[syms[0]] = 1; lengths[syms[1]] = 1; }
            else if (nsym === 3) { lengths[syms[0]] = 1; lengths[syms[1]] = 2; lengths[syms[2]] = 2; }
            else if (br.read(1) === 0) { lengths[syms[0]] = 2; lengths[syms[1]] = 2; lengths[syms[2]] = 2; lengths[syms[3]] = 2; }
            else { lengths[syms[0]] = 1; lengths[syms[1]] = 2; lengths[syms[2]] = 3; lengths[syms[3]] = 3; }
            return buildHuffman(lengths, alphabetSize);
        }

        var clLengths = new Uint8Array(18), space = 32, numCodes = 0;
        for (var j = hskip; j < 18; j++) {
            br.fill(4);
            var peek = br.buf & 15;
            var v = CL_PREFIX_VAL[peek];
            br.read(CL_PREFIX_LEN[peek]);
            clLengths[CODE_LENGTH_ORDER[j]] = v;
            if (v !== 0) {
                space -= 32 >> v;
                numCodes++;
                if (space <= 0) break;
            }
        }
        if (!(numCodes === 1 || space === 0)) throw new Error("Brotli: code length code không đầy đủ");
        var clCode = buildHuffman(clLengths, 18);

        var symbol = 0, prevLen = 8, repeat = 0, repeatLen = 0;
        space = 32768;
        while (symbol < alphabetSize && space > 0) {
            var p = readSymbol(br, clCode);
            if (p < 16) {
                repeat = 0;
                lengths[symbol++] = p;
                if (p !== 0) { prevLen = p; space -= 32768 >> p; }
            } else {
                var extraBits = p === 16 ? 2 : 3;
                var newLen = p === 16 ? prevLen : 0;
                if (repeatLen !== newLen) { repeat = 0; repeatLen = newLen; }
                var oldRepeat = repeat;
                if (repeat > 0) { repeat -= 2; repeat <<= extraBits; }
                repeat += br.read(extraBits) + 3;
                var delta = repeat - oldRepeat;
                if (symbol + delta > alphabetSize) throw new Error("Brotli: lặp độ dài mã vượt bảng chữ cái");
                for (var r = 0; r < delta; r++) lengths[symbol++] = newLen;
                if (newLen !== 0) space -= delta * (32768 >> newLen);
            }
        }
        if (space !== 0) throw new Error("Brotli: mã tiền tố không đầy đủ");
        return buildHuffman(lengths, alphabetSize);
    }

    // §9.2 — số block type, số cây, v.v. (1..256).
    function readVarLen8(br) {
        if (br.read(1) === 0) return 1;
        var n = br.read(3);
        if (n === 0) return 2;
        return (1 << n) + br.read(n) + 1;
    }

    function readBlockLength(br, h) {
        var code = readSymbol(br, h);
        return BLOCK_LEN_BASE[code] + br.read(BLOCK_LEN_BITS[code]);
    }

    // §7.3 — context map (có RLE số 0 và biến đổi move-to-front ngược).
    function readContextMap(br, size, numTrees) {
        var map = new Uint8Array(size);
        if (numTrees < 2) return map;
        var rleMax = br.read(1) ? br.read(4) + 1 : 0;
        var h = readPrefixCode(br, numTrees + rleMax);
        for (var i = 0; i < size;) {
            var code = readSymbol(br, h);
            if (code === 0) map[i++] = 0;
            else if (code <= rleMax) {
                var run = (1 << code) + br.read(code);
                if (i + run > size) throw new Error("Brotli: context map tràn");
                while (run--) map[i++] = 0;
            } else map[i++] = code - rleMax;
        }
        if (br.read(1)) {
            // Inverse move-to-front.
            var mtf = [];
            for (var k = 0; k < 256; k++) mtf.push(k);
            for (i = 0; i < size; i++) {
                var idx = map[i], value = mtf[idx];
                map[i] = value;
                if (idx) { mtf.splice(idx, 1); mtf.unshift(value); }
            }
        }
        return map;
    }

    // ───────────────────────── giải nén ─────────────────────────
    function decompress(input) {
        return decompressTraced(input, null);
    }

    // Giải nén và ghi lại cấu trúc stream (vị trí bit từng meta-block, WBITS, vòng distance
    // cuối) — append() cần những thứ này để nối thêm dữ liệu mà không đụng vào phần gốc.
    function scan(input) {
        var trace = { blocks: [] };
        var bytes = decompressTraced(input, trace);
        trace.data = bytes;
        return trace;
    }

    function decompressTraced(input, trace) {
        var state = { out: null, pos: 0 };
        try {
            return decompressInto(input, state, trace);
        } catch (error) {
            // Giữ phần đã giải được để chẩn đoán (test so với zlib tìm byte lệch đầu tiên).
            error.partial = state.out ? state.out.slice(0, state.pos) : null;
            throw error;
        }
    }

    function decompressInto(input, state, trace) {
        var data = input instanceof Uint8Array ? input : new Uint8Array(input);
        var br = new BitReader(data);
        var bitPos = function () { return br.pos * 8 - br.cnt; };

        // Stream header: WBITS (§9.1).
        var wbits;
        if (br.read(1) === 0) wbits = 16;
        else {
            var n = br.read(3);
            if (n !== 0) wbits = 17 + n;
            else {
                var m = br.read(3);
                if (m === 1) throw new Error("Brotli: large window không được hỗ trợ");
                wbits = m !== 0 ? 8 + m : 17;
            }
        }
        var maxBackward = (1 << wbits) - 16;
        if (trace) trace.wbits = wbits;

        var out = new Uint8Array(Math.max(1024, data.length * 4)), pos = 0;
        function ensure(extra) {
            if (pos + extra <= out.length) return;
            var size = out.length * 2;
            while (size < pos + extra) size *= 2;
            var bigger = new Uint8Array(size);
            bigger.set(out.subarray(0, pos));
            out = bigger;
        }

        var dist = [16, 15, 11, 4], distIdx = 3; // dist[distIdx & 3] là khoảng cách gần nhất
        var isLast = 0, block = null;
        try {
            while (!isLast) {
                if (block) block.end = bitPos();
                block = trace ? { start: bitPos() } : null;
                if (block) trace.blocks.push(block);
                isLast = br.read(1);
                if (isLast && br.read(1)) { if (block) block.empty = true; break; } // ISLASTEMPTY
                var nibbles = br.read(2);
                if (nibbles === 3) {
                    // Khối metadata: bỏ qua.
                    if (br.read(1) !== 0) throw new Error("Brotli: bit dự trữ khác 0");
                    var skipBytes = br.read(2), skipLen = 0;
                    for (var sb = 0; sb < skipBytes; sb++) skipLen |= br.read(8) << (8 * sb);
                    if (skipBytes) skipLen++;
                    br.alignToByte();
                    for (var sk = 0; sk < skipLen; sk++) br.readByteAligned();
                    if (block) block.metadata = true;
                    continue;
                }
                nibbles += 4;
                var mlen = 0;
                for (var nb = 0; nb < nibbles; nb++) mlen |= br.read(4) << (4 * nb);
                mlen = (mlen >>> 0) + 1;
                if (block) { block.last = !!isLast; block.nibbles = nibbles; block.mlen = mlen; block.body = bitPos(); }
                if (!isLast && br.read(1)) {
                    // Khối không nén.
                    br.alignToByte();
                    ensure(mlen);
                    for (var u = 0; u < mlen; u++) out[pos++] = br.readByteAligned();
                    continue;
                }
                ensure(mlen);

                // 3 loại block: 0 = literal, 1 = insert&copy, 2 = distance.
                var nTypes = [], typeTrees = [], countTrees = [], blockLen = [], blockType = [0, 0, 0];
                var typeRing = [[1, 0], [1, 0], [1, 0]];
                for (var c = 0; c < 3; c++) {
                    nTypes[c] = readVarLen8(br);
                    if (nTypes[c] >= 2) {
                        typeTrees[c] = readPrefixCode(br, nTypes[c] + 2);
                        countTrees[c] = readPrefixCode(br, 26);
                        blockLen[c] = readBlockLength(br, countTrees[c]);
                    } else blockLen[c] = 1 << 28;
                }
                var npostfix = br.read(2);
                var ndirect = br.read(4) << npostfix;
                var postfixMask = (1 << npostfix) - 1;
                var modes = new Uint8Array(nTypes[0]);
                for (var cm = 0; cm < nTypes[0]; cm++) modes[cm] = br.read(2);
                var nTreesL = readVarLen8(br);
                var cmapL = readContextMap(br, nTypes[0] << 6, nTreesL);
                var nTreesD = readVarLen8(br);
                var cmapD = readContextMap(br, nTypes[2] << 2, nTreesD);
                var litTrees = [], cmdTrees = [], distTrees = [];
                for (var t = 0; t < nTreesL; t++) litTrees.push(readPrefixCode(br, 256));
                for (t = 0; t < nTypes[1]; t++) cmdTrees.push(readPrefixCode(br, 704));
                var distAlphabet = 16 + ndirect + (48 << npostfix);
                for (t = 0; t < nTreesD; t++) distTrees.push(readPrefixCode(br, distAlphabet));

                var switchBlock = function (cat) {
                    var code = readSymbol(br, typeTrees[cat]), ring = typeRing[cat], type;
                    if (code === 0) type = ring[0];
                    else if (code === 1) type = ring[1] + 1;
                    else type = code - 2;
                    if (type >= nTypes[cat]) type -= nTypes[cat];
                    ring[0] = ring[1];
                    ring[1] = type;
                    blockType[cat] = type;
                    blockLen[cat] = readBlockLength(br, countTrees[cat]);
                };

                var remaining = mlen;
                while (remaining > 0) {
                    if (blockLen[1] === 0) switchBlock(1);
                    blockLen[1]--;
                    var cmd = readSymbol(br, cmdTrees[blockType[1]]);
                    var cell = cmd >> 6;
                    var insCode = CELL_INSERT[cell] + ((cmd >> 3) & 7);
                    var copyCode = CELL_COPY[cell] + (cmd & 7);
                    var insertLen = INSERT_BASE[insCode] + br.read(INSERT_BITS[insCode]);
                    var copyLen = COPY_BASE[copyCode] + br.read(COPY_BITS[copyCode]);
                    if (insertLen > remaining) throw new Error("Brotli: insert vượt độ dài meta-block");

                    for (var li = 0; li < insertLen; li++) {
                        if (blockLen[0] === 0) switchBlock(0);
                        blockLen[0]--;
                        var p1 = pos > 0 ? out[pos - 1] : 0, p2 = pos > 1 ? out[pos - 2] : 0;
                        var tree = litTrees[cmapL[(blockType[0] << 6) + contextId(modes[blockType[0]], p1, p2)]];
                        out[pos++] = readSymbol(br, tree);
                    }
                    remaining -= insertLen;
                    if (remaining <= 0) break;

                    var distance, distCode;
                    if (cell < 2) { distCode = 0; distance = dist[distIdx & 3]; }
                    else {
                        if (blockLen[2] === 0) switchBlock(2);
                        blockLen[2]--;
                        var dctx = copyLen > 4 ? 3 : copyLen - 2;
                        distCode = readSymbol(br, distTrees[cmapD[(blockType[2] << 2) + dctx]]);
                        if (distCode < 4) {
                            // 0..3: khoảng cách thứ 1..4 gần nhất.
                            distance = dist[(distIdx - distCode) & 3];
                        } else if (distCode < 16) {
                            // 4..9 lấy gốc là khoảng cách gần nhất, 10..15 là khoảng cách thứ hai;
                            // lệch lần lượt −1, +1, −2, +2, −3, +3.
                            var k2 = distCode < 10 ? distCode - 4 : distCode - 10;
                            var base = dist[(distIdx - (distCode < 10 ? 0 : 1)) & 3];
                            var delta2 = (k2 >> 1) + 1;
                            distance = (k2 & 1) ? base + delta2 : base - delta2;
                            if (distance <= 0) throw new Error("Brotli: khoảng cách không hợp lệ");
                        } else if (distCode < 16 + ndirect) {
                            distance = distCode - 15;
                        } else {
                            var x = distCode - ndirect - 16;
                            var ndistbits = 1 + (x >> (npostfix + 1));
                            var hcode = x >> npostfix;
                            var lcode = x & postfixMask;
                            var offset = ((2 + (hcode & 1)) << ndistbits) - 4;
                            distance = ((offset + br.read(ndistbits)) << npostfix) + lcode + ndirect + 1;
                        }
                    }

                    var maxDistance = pos < maxBackward ? pos : maxBackward;
                    if (distance > maxDistance) {
                        // Khoảng cách vượt cửa sổ = tham chiếu static dictionary (từ 4..24 byte).
                        throw new Error("Brotli: dữ liệu dùng static dictionary (chưa hỗ trợ)");
                    }
                    if (distCode !== 0) { distIdx++; dist[distIdx & 3] = distance; }
                    if (copyLen > remaining) throw new Error("Brotli: copy vượt độ dài meta-block");
                    var from = pos - distance;
                    for (var ci = 0; ci < copyLen; ci++) out[pos + ci] = out[from + ci];
                    pos += copyLen;
                    remaining -= copyLen;
                }
            }
        } catch (error) {
            // Phần đã giải tới ĐÚNG lúc lỗi — lưu ở đầu mỗi lệnh thì lệch nhịp ngay lệnh đầu sẽ ra mảng
            // rỗng, và "rỗng khớp tiền tố" từng khiến test coi một bảng Lut sai là "dữ liệu dùng dictionary".
            state.out = out;
            state.pos = pos;
            throw error;
        }
        if (block) block.end = bitPos();
        if (trace) trace.ring = { ring: [dist[(distIdx - 3) & 3], dist[(distIdx - 2) & 3], dist[(distIdx - 1) & 3], dist[distIdx & 3]], idx: 3 };
        return out.slice(0, pos);
    }

    // ═════════════════════════ NÉN ═════════════════════════
    // Dạng stream sinh ra (đơn giản nhưng hợp lệ với mọi bộ giải Brotli):
    //   - mỗi meta-block: 1 block type cho cả 3 loại, NPOSTFIX = NDIRECT = 0, 1 cây literal,
    //     1 cây distance; meta-block không lợi thì ghi dạng không nén.
    //   - meta-block cuối luôn là khối rỗng ISLAST+ISLASTEMPTY, nhờ vậy khối dữ liệu nào
    //     cũng được phép ghi không nén (RFC cấm khối không nén mang cờ ISLAST).
    //   - không bao giờ tham chiếu static dictionary.

    function BitWriter(capacity) {
        this.buf = new Uint8Array(Math.max(64, capacity | 0));
        this.len = 0;
        this.acc = 0;
        this.n = 0;
    }
    BitWriter.prototype.push = function (byte) {
        if (this.len === this.buf.length) {
            var bigger = new Uint8Array(this.buf.length * 2);
            bigger.set(this.buf);
            this.buf = bigger;
        }
        this.buf[this.len++] = byte;
    };
    BitWriter.prototype.write = function (nbits, value) {
        if (nbits > 24) {
            this.write(16, value & 0xffff);
            this.write(nbits - 16, Math.floor(value / 65536));
            return;
        }
        this.acc = (this.acc | (value << this.n)) >>> 0;
        this.n += nbits;
        while (this.n >= 8) {
            this.push(this.acc & 255);
            this.acc >>>= 8;
            this.n -= 8;
        }
    };
    BitWriter.prototype.align = function () {
        if (this.n > 0) { this.push(this.acc & 255); this.acc = 0; this.n = 0; }
    };
    BitWriter.prototype.finish = function () {
        this.align();
        return this.buf.slice(0, this.len);
    };

    // ── độ dài mã Huffman giới hạn maxBits (cách của encoder Brotli: tăng dần sàn tần suất
    //    tới khi cây đủ nông) ──
    function huffmanLengths(freqs, maxBits) {
        var n = freqs.length, lengths = new Uint8Array(n), syms = [];
        for (var i = 0; i < n; i++) if (freqs[i] > 0) syms.push(i);
        if (syms.length === 0) return lengths;
        if (syms.length === 1) { lengths[syms[0]] = 1; return lengths; }
        for (var floor = 1; ; floor *= 2) {
            var depth = treeDepths(syms.map(function (s) { return Math.max(freqs[s], floor); }));
            var max = 0;
            for (var k = 0; k < depth.length; k++) if (depth[k] > max) max = depth[k];
            if (max <= maxBits) {
                for (k = 0; k < syms.length; k++) lengths[syms[k]] = depth[k];
                return lengths;
            }
        }
    }

    // Độ sâu lá của cây Huffman (hai hàng đợi trên danh sách lá đã sắp xếp).
    function treeDepths(weights) {
        var m = weights.length;
        var order = weights.map(function (w, i) { return i; }).sort(function (a, b) { return weights[a] - weights[b] || a - b; });
        var nodeW = [], parent = [];
        for (var i = 0; i < m; i++) { nodeW.push(weights[order[i]]); parent.push(-1); }
        var leafQ = 0, innerQ = m;
        function pick() {
            if (leafQ < m && (innerQ >= nodeW.length || nodeW[leafQ] <= nodeW[innerQ])) return leafQ++;
            return innerQ++;
        }
        for (var made = 0; made < m - 1; made++) {
            var a = pick(), b = pick(), id = nodeW.length;
            nodeW.push(nodeW[a] + nodeW[b]);
            parent.push(-1);
            parent[a] = id;
            parent[b] = id;
        }
        var depthOfNode = new Int32Array(nodeW.length);
        for (var j = nodeW.length - 2; j >= 0; j--) depthOfNode[j] = depthOfNode[parent[j]] + 1;
        var depths = new Array(m);
        for (i = 0; i < m; i++) depths[order[i]] = depthOfNode[i];
        return depths;
    }

    // Mã chuẩn tắc, đảo bit để ghi LSB trước (bộ giải đọc bit đầu của mã trước tiên).
    function canonicalCodes(lengths) {
        var count = new Int32Array(16), next = new Int32Array(16), codes = new Int32Array(lengths.length);
        for (var i = 0; i < lengths.length; i++) if (lengths[i]) count[lengths[i]]++;
        var code = 0;
        for (var len = 1; len < 16; len++) { code = (code + count[len - 1]) << 1; next[len] = code; }
        for (i = 0; i < lengths.length; i++) {
            var l = lengths[i];
            if (!l) continue;
            var c = next[l]++, rev = 0;
            for (var b = 0; b < l; b++) rev |= ((c >> b) & 1) << (l - 1 - b);
            codes[i] = rev;
        }
        return codes;
    }

    // RLE độ dài mã với ký hiệu 16/17 — chép theo BrotliWriteHuffmanTree (lặp liên tiếp
    // được bộ giải cộng dồn nên phải tách đúng kiểu này).
    function rleCodeLengths(lengths) {
        var tokens = [], extras = [];
        var end = lengths.length;
        while (end > 0 && lengths[end - 1] === 0) end--;
        var prev = 8;
        for (var i = 0; i < end;) {
            var value = lengths[i], reps = 1;
            while (i + reps < end && lengths[i + reps] === value) reps++;
            if (value === 0) writeZeros(reps);
            else { writeRepeats(prev, value, reps); prev = value; }
            i += reps;
        }
        return { tokens: tokens, extras: extras };

        function emit(t, e) { tokens.push(t); extras.push(e); }
        function writeRun(code, bits, reps) {
            var start = tokens.length;
            reps -= 3;
            for (;;) {
                emit(code, reps & ((1 << bits) - 1));
                reps >>= bits;
                if (reps === 0) break;
                reps--;
            }
            reverseTail(start);
        }
        function reverseTail(start) {
            for (var a = start, b = tokens.length - 1; a < b; a++, b--) {
                var t = tokens[a]; tokens[a] = tokens[b]; tokens[b] = t;
                var e = extras[a]; extras[a] = extras[b]; extras[b] = e;
            }
        }
        function writeRepeats(previous, v, reps) {
            if (previous !== v) { emit(v, 0); reps--; }
            if (reps === 7) { emit(v, 0); reps--; }
            if (reps < 3) { for (var r = 0; r < reps; r++) emit(v, 0); }
            else writeRun(16, 2, reps);
        }
        function writeZeros(reps) {
            if (reps === 11) { emit(0, 0); reps--; }
            if (reps < 3) { for (var r = 0; r < reps; r++) emit(0, 0); }
            else writeRun(17, 3, reps);
        }
    }

    // Mã cố định cho độ dài của code-length code: giá trị 0..5 → [số bit, bit ghi].
    var CL_LEN_WRITE = [[2, 0], [4, 7], [3, 3], [2, 2], [2, 1], [4, 15]];

    // Ghi 1 mã tiền tố; trả về { lengths, codes } THỰC SỰ dùng khi ghi symbol (mã đơn giản
    // có thể gán lại độ dài so với lengths truyền vào).
    function storePrefixCode(bw, freqs, alphabetSize, maxBits) {
        var used = [];
        for (var i = 0; i < alphabetSize; i++) if (freqs[i] > 0) used.push(i);
        var bits = alphabetBits(alphabetSize);
        var lengths = new Uint8Array(alphabetSize);

        if (used.length <= 4) {
            if (used.length === 0) used = [0];
            used.sort(function (a, b) { return freqs[b] - freqs[a] || a - b; });
            var nsym = used.length, shape;
            if (nsym === 1) shape = [0];
            else if (nsym === 2) shape = [1, 1];
            else if (nsym === 3) shape = [1, 2, 2];
            else {
                var costFlat = 2 * (freqs[used[0]] + freqs[used[1]] + freqs[used[2]] + freqs[used[3]]);
                var costSkew = freqs[used[0]] + 2 * freqs[used[1]] + 3 * (freqs[used[2]] + freqs[used[3]]);
                shape = costSkew < costFlat ? [1, 2, 3, 3] : [2, 2, 2, 2];
            }
            bw.write(2, 1);
            bw.write(2, nsym - 1);
            for (var s = 0; s < nsym; s++) bw.write(bits, used[s]);
            if (nsym === 4) bw.write(1, shape[0] === 1 ? 1 : 0);
            for (s = 0; s < nsym; s++) lengths[used[s]] = shape[s];
            return { lengths: lengths, codes: canonicalCodes(lengths), single: nsym === 1 };
        }

        lengths = huffmanLengths(freqs.length === alphabetSize ? freqs : freqs.slice(0, alphabetSize), maxBits);
        var rle = rleCodeLengths(lengths);
        var clFreq = new Int32Array(18);
        for (var t = 0; t < rle.tokens.length; t++) clFreq[rle.tokens[t]]++;
        var clLengths = huffmanLengths(clFreq, 5);
        var distinct = 0;
        for (t = 0; t < 18; t++) if (clFreq[t]) distinct++;

        // Độ dài code-length code theo thứ tự lưu, bỏ số 0 ở đầu (HSKIP 2/3) và ở cuối.
        var toStore = 18;
        if (distinct > 1) while (toStore > 0 && clLengths[CODE_LENGTH_ORDER[toStore - 1]] === 0) toStore--;
        var skip = 0;
        if (clLengths[CODE_LENGTH_ORDER[0]] === 0 && clLengths[CODE_LENGTH_ORDER[1]] === 0) {
            skip = clLengths[CODE_LENGTH_ORDER[2]] === 0 ? 3 : 2;
        }
        bw.write(2, skip);
        for (var k = skip; k < toStore; k++) {
            var w = CL_LEN_WRITE[clLengths[CODE_LENGTH_ORDER[k]]];
            bw.write(w[0], w[1]);
        }
        // Chỉ 1 loại ký hiệu độ dài → bộ giải coi mã đó dài 0 bit.
        var clCodes = canonicalCodes(clLengths);
        for (t = 0; t < rle.tokens.length; t++) {
            var tok = rle.tokens[t];
            if (distinct > 1) bw.write(clLengths[tok], clCodes[tok]);
            if (tok === 16) bw.write(2, rle.extras[t]);
            else if (tok === 17) bw.write(3, rle.extras[t]);
        }
        return { lengths: lengths, codes: canonicalCodes(lengths), single: false };
    }

    function writeSymbol(bw, code, sym) {
        if (code.single) return;
        bw.write(code.lengths[sym], code.codes[sym]);
    }

    function lengthCode(value, bases) {
        var i = bases.length - 1;
        while (bases[i] > value) i--;
        return i;
    }

    // Ô lệnh (§5) cho distance tường minh: [insert>>3][copy>>3].
    var CELL_BASE = [[128, 192, 384], [256, 320, 512], [448, 576, 640]];

    function commandSymbol(insCode, copyCode, implicitZero) {
        var low = ((insCode & 7) << 3) | (copyCode & 7);
        if (implicitZero && insCode < 8 && copyCode < 16) return (copyCode < 8 ? 0 : 64) | low;
        return CELL_BASE[insCode >> 3][copyCode >> 3] | low;
    }

    // Khoảng cách tường minh (NPOSTFIX = NDIRECT = 0).
    function distanceCode(d) {
        var dd = d + 3, log = 31 - Math.clz32(dd), nbits = log - 1, prefix = (dd >> nbits) & 1;
        return { code: 16 + 2 * (nbits - 1) + prefix, nbits: nbits, extra: dd - ((2 + prefix) << nbits) };
    }

    // Tìm mã khoảng cách ngắn (0..15) theo vòng 4 khoảng cách gần nhất, -1 nếu không có.
    function shortDistanceCode(ring, idx, d) {
        var last = ring[idx & 3], second = ring[(idx - 1) & 3];
        if (d === last) return 0;
        if (d === second) return 1;
        if (d === ring[(idx - 2) & 3]) return 2;
        if (d === ring[(idx - 3) & 3]) return 3;
        var diff = d - last;
        if (diff >= -3 && diff <= 3 && diff !== 0) return 4 + ((Math.abs(diff) - 1) << 1) + (diff > 0 ? 1 : 0);
        diff = d - second;
        if (diff >= -3 && diff <= 3 && diff !== 0) return 10 + ((Math.abs(diff) - 1) << 1) + (diff > 0 ? 1 : 0);
        return -1;
    }

    // ── LZ77: hash chain trên 4 byte, lazy matching 1 bước ──
    // data[0, start) là lịch sử đã có trong stream (chỉ để tham chiếu), lệnh sinh cho [start, n).
    function findCommands(data, start, maxDistance, chainDepth, ringState) {
        var n = data.length, HASH_BITS = 17, head = new Int32Array(1 << HASH_BITS).fill(-1);
        var prev = new Int32Array(n);
        var commands = [], litStart = start, i = start;
        var MAX_INSERT = 1 << 16; // insert-only phải là lệnh cuối của meta-block → chặn độ dài
        var MAX_COPY = 1 << 20;
        var NICE = 258;
        var ring = ringState.ring.slice(), ringIdx = ringState.idx;
        for (var h0 = Math.max(0, start - maxDistance); h0 < start; h0++) insert(h0);

        function hashAt(p) {
            return Math.imul(data[p] | (data[p + 1] << 8) | (data[p + 2] << 16) | (data[p + 3] << 24), 0x1e35a7bd) >>> (32 - HASH_BITS);
        }
        function insert(p) {
            if (p + 4 > n) return;
            var h = hashAt(p);
            prev[p] = head[h];
            head[h] = p;
        }
        function matchLength(a, b, limit) {
            var l = 0;
            while (l < limit && data[a + l] === data[b + l]) l++;
            return l;
        }
        // Độ dài tối thiểu đáng mã hoá theo độ xa (distance xa tốn nhiều extra bit).
        function worth(len, dist) {
            return len >= (dist < 1024 ? 4 : dist < 65536 ? 5 : 6);
        }
        function best(p) {
            var limit = Math.min(n - p, MAX_COPY), bestLen = 0, bestDist = 0;
            if (limit < 4) return null;
            // Khoảng cách gần nhất trước: rẻ nhất để mã hoá.
            for (var r = 0; r < 4; r++) {
                var d = ring[(ringIdx - r) & 3];
                if (d > p || d > maxDistance) continue;
                var l = matchLength(p - d, p, limit);
                if (l >= 4 && l > bestLen) { bestLen = l; bestDist = d; }
            }
            var h = hashAt(p), cand = head[h], depth = chainDepth;
            while (cand >= 0 && depth-- > 0) {
                var dist = p - cand;
                if (dist > maxDistance) break;
                if (data[cand + bestLen] === data[p + bestLen]) {
                    var len = matchLength(cand, p, limit);
                    if (len > bestLen && worth(len, dist)) {
                        bestLen = len; bestDist = dist;
                        if (len >= NICE) break;
                    }
                }
                cand = prev[cand];
            }
            return bestLen >= 4 ? { len: bestLen, dist: bestDist } : null;
        }
        function flushInsertOnly(upTo) {
            commands.push({ ins: upTo - litStart, copy: 0, dist: 0 });
            litStart = upTo;
        }

        while (i + 4 <= n) {
            if (i - litStart >= MAX_INSERT) flushInsertOnly(i);
            var m = best(i);
            if (!m) { insert(i); i++; continue; }
            if (m.len < 32 && i + 5 <= n) {
                insert(i);
                var m2 = best(i + 1);
                if (m2 && m2.len > m.len + 1) { i++; continue; }
                for (var q = i + 1; q < i + m.len; q++) insert(q);
            } else {
                for (q = i; q < i + m.len; q++) insert(q);
            }
            commands.push({ ins: i - litStart, copy: m.len, dist: m.dist });
            var code = shortDistanceCode(ring, ringIdx, m.dist);
            if (code !== 0) { ringIdx++; ring[ringIdx & 3] = m.dist; }
            i += m.len;
            litStart = i;
        }
        if (litStart < n) {
            while (n - litStart > MAX_INSERT) flushInsertOnly(litStart + MAX_INSERT);
            flushInsertOnly(n);
        }
        return commands;
    }

    function writeMetaBlockHeader(bw, mlen, uncompressed) {
        bw.write(1, 0); // ISLAST = 0 (khối cuối luôn là khối rỗng riêng)
        var nibbles = mlen - 1 < (1 << 16) ? 4 : mlen - 1 < (1 << 20) ? 5 : 6;
        bw.write(2, nibbles - 4);
        bw.write(nibbles * 4, mlen - 1);
        bw.write(1, uncompressed ? 1 : 0);
    }

    // Ghi 1 meta-block từ các lệnh [from, to). Trả về ring distance mới (khối không nén
    // không đổi ring của bộ giải).
    function writeMetaBlock(bw, data, commands, from, to, start, mlen, ringState) {
        var ring = ringState.ring.slice(), ringIdx = ringState.idx;
        var litFreq = new Int32Array(256), cmdFreq = new Int32Array(704), distFreq = new Int32Array(64);
        var planned = [], p = start;
        for (var c = from; c < to; c++) {
            var cmd = commands[c];
            var insCode = lengthCode(cmd.ins, INSERT_BASE);
            var copyCode = cmd.copy ? lengthCode(cmd.copy, COPY_BASE) : 0;
            var dcode = -1, dinfo = null, sym;
            if (cmd.copy) {
                var short = shortDistanceCode(ring, ringIdx, cmd.dist);
                if (short >= 0) dcode = short;
                else { dinfo = distanceCode(cmd.dist); dcode = dinfo.code; }
                sym = commandSymbol(insCode, copyCode, dcode === 0);
                if (sym >= 128) distFreq[dcode]++;
                if (dcode !== 0) { ringIdx++; ring[ringIdx & 3] = cmd.dist; }
            } else {
                sym = commandSymbol(insCode, 0, true);
            }
            cmdFreq[sym]++;
            for (var k = 0; k < cmd.ins; k++) litFreq[data[p + k]]++;
            p += cmd.ins + cmd.copy;
            planned.push({ sym: sym, insCode: insCode, copyCode: copyCode, dcode: dcode, dinfo: dinfo });
        }

        // Ước lượng cỡ khối nén (chưa tính phần header cây) so với ghi thô.
        var est = estimateBits(litFreq, 15) + estimateBits(cmdFreq, 15) + estimateBits(distFreq, 15) + 2400;
        for (c = 0; c < planned.length; c++) {
            est += INSERT_BITS[planned[c].insCode] + COPY_BITS[planned[c].copyCode] + (planned[c].dinfo ? planned[c].dinfo.nbits : 0);
        }
        if (est >= mlen * 8) {
            writeMetaBlockHeader(bw, mlen, true);
            bw.align();
            for (var u = 0; u < mlen; u++) bw.push(data[start + u]);
            return ringState;
        }

        writeMetaBlockHeader(bw, mlen, false);
        bw.write(1, 0); bw.write(1, 0); bw.write(1, 0); // NBLTYPES L/I/D = 1
        bw.write(2, 0); bw.write(4, 0);                // NPOSTFIX, NDIRECT
        bw.write(2, 0);                                // context mode (1 cây nên không quan trọng)
        bw.write(1, 0); bw.write(1, 0);                // NTREESL = NTREESD = 1
        var litCode = storePrefixCode(bw, litFreq, 256, 15);
        var cmdCode = storePrefixCode(bw, cmdFreq, 704, 15);
        var distCode = storePrefixCode(bw, distFreq, 64, 15);

        p = start;
        for (c = from; c < to; c++) {
            var pl = planned[c - from], cm = commands[c];
            writeSymbol(bw, cmdCode, pl.sym);
            bw.write(INSERT_BITS[pl.insCode], cm.ins - INSERT_BASE[pl.insCode]);
            bw.write(COPY_BITS[pl.copyCode], cm.copy ? cm.copy - COPY_BASE[pl.copyCode] : 0);
            for (k = 0; k < cm.ins; k++) writeSymbol(bw, litCode, data[p + k]);
            if (cm.copy && pl.sym >= 128) {
                writeSymbol(bw, distCode, pl.dcode);
                if (pl.dinfo) bw.write(pl.dinfo.nbits, pl.dinfo.extra);
            }
            p += cm.ins + cm.copy;
        }
        return { ring: ring, idx: ringIdx };
    }

    function estimateBits(freqs, maxBits) {
        var lengths = huffmanLengths(freqs, maxBits), bits = 0;
        for (var i = 0; i < freqs.length; i++) bits += freqs[i] * lengths[i];
        return bits;
    }

    function chainDepthOf(options) {
        var quality = options && options.quality ? Math.max(1, Math.min(9, options.quality)) : 6;
        return [0, 4, 8, 16, 24, 32, 48, 64, 128, 256][quality];
    }

    // Mã hoá data[start, n) thành các meta-block (không có khối kết thúc).
    function encodeRange(bw, data, start, maxDistance, chainDepth, ringState) {
        if (start >= data.length) return ringState;
        var commands = findCommands(data, start, maxDistance, chainDepth, ringState);
        var BLOCK = 1 << 18;
        var from = 0, blockStart = start, size = 0;
        for (var c = 0; c < commands.length; c++) {
            size += commands[c].ins + commands[c].copy;
            // Lệnh chỉ-insert chỉ được đứng cuối meta-block.
            if (size >= BLOCK || commands[c].copy === 0 || c === commands.length - 1) {
                ringState = writeMetaBlock(bw, data, commands, from, c + 1, blockStart, size, ringState);
                from = c + 1;
                blockStart += size;
                size = 0;
            }
        }
        return ringState;
    }

    function writeTerminator(bw) {
        bw.write(1, 1); // ISLAST
        bw.write(1, 1); // ISLASTEMPTY
    }

    /**
     * Nén Brotli. options.quality 1..9 (mặc định 6) chỉ đổi độ sâu tìm kiếm LZ77.
     */
    function compress(input, options) {
        var data = input instanceof Uint8Array ? input : new Uint8Array(input);
        var bw = new BitWriter((data.length >> 1) + 1024);

        var lgwin = 16;
        while (lgwin < 24 && (1 << lgwin) - 16 < data.length) lgwin++;
        if (lgwin === 16) bw.write(1, 0);
        else if (lgwin === 17) bw.write(7, 1);
        else bw.write(4, ((lgwin - 17) << 1) | 1);

        encodeRange(bw, data, 0, (1 << lgwin) - 16, chainDepthOf(options), { ring: [16, 15, 11, 4], idx: 3 });
        writeTerminator(bw);
        return bw.finish();
    }

    // Chép nguyên văn các bit [from, to) của một stream khác.
    function copyBits(bw, src, from, to) {
        for (var bit = from; bit < to;) {
            var n = Math.min(16, to - bit), byte = bit >> 3;
            var v = ((src[byte] | (src[byte + 1] << 8) | (src[byte + 2] << 16)) >>> (bit & 7)) & ((1 << n) - 1);
            bw.write(n, v);
            bit += n;
        }
    }

    /**
     * Nối thêm `extra` vào cuối một stream Brotli có sẵn: giải(kết quả) = giải(original) + extra.
     *
     * Phần gốc được chép NGUYÊN BIT — chỉ header của meta-block cuối viết lại (bỏ cờ ISLAST),
     * rồi thêm meta-block mới và khối kết thúc. Nhờ vậy sửa một mesh trong data.blob của Luna
     * chỉ tốn đúng phần dữ liệu mới, thay vì nén lại cả blob bằng bộ nén kém hơn brotli -q11
     * (đo trên blob thật: 542 KB gốc → 720 KB nếu nén lại toàn bộ).
     */
    function append(original, extra, options) {
        var orig = original instanceof Uint8Array ? original : new Uint8Array(original);
        var add = extra instanceof Uint8Array ? extra : new Uint8Array(extra);
        var info = scan(orig);
        if (!add.length) return orig.slice();
        var last = info.blocks[info.blocks.length - 1];
        var bw = new BitWriter(orig.length + (add.length >> 1) + 1024);
        copyBits(bw, orig, 0, last.start);
        if (!last.empty) {
            // ISLAST=1 thì không có bit ISUNCOMPRESSED; viết lại header dạng khối thường.
            bw.write(1, 0);
            bw.write(2, last.nibbles - 4);
            bw.write(last.nibbles * 4, last.mlen - 1);
            bw.write(1, 0);
            copyBits(bw, orig, last.body, last.end);
        }
        var history = info.data, combined = new Uint8Array(history.length + add.length);
        combined.set(history);
        combined.set(add, history.length);
        encodeRange(bw, combined, history.length, (1 << info.wbits) - 16, chainDepthOf(options), info.ring);
        writeTerminator(bw);
        return bw.finish();
    }

    return {
        decompress: decompress,
        compress: compress,
        append: append,
        scan: scan,
        _internal: {
            LUT0: LUT0, LUT1: LUT1, LUT2: LUT2,
            INSERT_BASE: INSERT_BASE, INSERT_BITS: INSERT_BITS, COPY_BASE: COPY_BASE, COPY_BITS: COPY_BITS,
            BLOCK_LEN_BASE: BLOCK_LEN_BASE, BLOCK_LEN_BITS: BLOCK_LEN_BITS, CODE_LENGTH_ORDER: CODE_LENGTH_ORDER
        }
    };
});
