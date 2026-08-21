/* Đọc, cắt và ghi lại model GLB — chạy hoàn toàn trong trình duyệt.
 *
 * Bài toán: rig xuất từ Blender thường mang cả xương ĐIỀU KHIỂN (IK, mechanism,
 * tweak) chứ không chỉ xương làm biến dạng mesh. Xương điều khiển không vẽ ra
 * pixel nào nhưng vẫn tốn chỗ, và Blender còn bake animation cho từng kênh của
 * từng xương kể cả xương đứng yên.
 *
 * Đo trên một rig Rigify thật: 791 xương / 137 có weight, 7128 track / 349 thật
 * sự thay đổi giá trị. File 3.25 MB xuống 0.89 MB mà chuyển động không đổi.
 *
 * Cắt xong thì phải CHỨNG MINH là không hỏng, không phải nhìn cho có: hàm verify()
 * tính world matrix của từng xương có weight ở nhiều mốc thời gian trên cả hai bản
 * rồi so. Mọi vertex đều được đặt bởi world matrix của xương ảnh hưởng nó, nên
 * world matrix khớp thì hình dạng khớp.
 */

(function (global) {
    'use strict';

    const COMP_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
    const COMP_ARRAY = {
        5120: Int8Array, 5121: Uint8Array, 5122: Int16Array,
        5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
    };

    const WEIGHT_EPS = 1e-4;   // weight dưới ngưỡng này coi như không chạm vào vertex
    const CONST_EPS = 1e-5;    // track dao động dưới ngưỡng này coi như hằng số

    /* Định dạng nén: dữ liệu hình học nằm sau một tầng giải nén mà module này
       không đọc được. Từ chối thẳng còn hơn ghi ra file hỏng trong im lặng. */
    const UNSUPPORTED = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_mesh_quantization'];

    /* --------------------------------------------------------------- đọc/ghi */

    function parse(buffer) {
        const dv = new DataView(buffer);
        if (buffer.byteLength < 12 || dv.getUint32(0, true) !== 0x46546c67) return null;
        const total = dv.getUint32(8, true);
        let off = 12, json = null, bin = null;
        while (off + 8 <= total) {
            const len = dv.getUint32(off, true);
            const type = String.fromCharCode(
                dv.getUint8(off + 4), dv.getUint8(off + 5), dv.getUint8(off + 6), dv.getUint8(off + 7));
            if (type === 'JSON') {
                json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, off + 8, len)));
            } else if (type.slice(0, 3) === 'BIN') {
                bin = new Uint8Array(buffer, off + 8, len);
            }
            off += 8 + len;
        }
        if (!json) return null;
        return { json, bin, size: total };
    }

    function write(json, parts) {
        let binLen = 0;
        for (const p of parts) binLen += p.byteLength;
        const bin = new Uint8Array(binLen);
        let o = 0;
        for (const p of parts) {
            bin.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), o);
            o += p.byteLength;
        }
        /* Đệm theo BYTE chứ không theo ký tự. Tên node có thể chứa ký tự ngoài ASCII
           (tiếng Việt, dấu gạch dài…) — mỗi cái chiếm 2–4 byte UTF-8 nhưng chỉ tính
           một ký tự, nên đệm theo str.length cho ra chunk lệch khỏi bội số 4 và file
           vi phạm đặc tả GLB. Loader dễ tính vẫn mở được, loader chặt thì không. */
        const raw = new TextEncoder().encode(JSON.stringify(json));
        const jsonPad = (4 - (raw.length % 4)) % 4;
        const jsonBytes = new Uint8Array(raw.length + jsonPad);
        jsonBytes.set(raw);
        jsonBytes.fill(0x20, raw.length);                 // đệm bằng khoảng trắng
        const binPad = (4 - (bin.length % 4)) % 4;

        const total = 12 + 8 + jsonBytes.length + 8 + bin.length + binPad;
        const out = new Uint8Array(total);
        const dv = new DataView(out.buffer);
        dv.setUint32(0, 0x46546c67, true);
        dv.setUint32(4, 2, true);
        dv.setUint32(8, total, true);
        dv.setUint32(12, jsonBytes.length, true);
        out.set([0x4a, 0x53, 0x4f, 0x4e], 16);            // 'JSON'
        out.set(jsonBytes, 20);
        const h = 20 + jsonBytes.length;
        dv.setUint32(h, bin.length + binPad, true);
        out.set([0x42, 0x49, 0x4e, 0x00], h + 4);         // 'BIN\0'
        out.set(bin, h + 8);
        return new Blob([out], { type: 'model/gltf-binary' });
    }

    /** Đọc accessor ra mảng phẳng, đã gỡ interleaving nếu có. */
    function makeReader(json, bin) {
        return function read(idx) {
            const a = json.accessors[idx];
            if (a.sparse) throw new Error('accessor sparse chưa hỗ trợ');
            const n = COMP_COUNT[a.type];
            const C = COMP_ARRAY[a.componentType];
            if (a.bufferView === undefined) return new C(a.count * n);
            const v = json.bufferViews[a.bufferView];
            const base = bin.byteOffset + (v.byteOffset || 0) + (a.byteOffset || 0);
            const tight = n * C.BYTES_PER_ELEMENT;
            if (v.byteStride && v.byteStride !== tight) {
                const out = new C(a.count * n);
                for (let i = 0; i < a.count; i++) {
                    out.set(new C(bin.buffer.slice(base + i * v.byteStride, base + i * v.byteStride + tight)), i * n);
                }
                return out;
            }
            return new C(bin.buffer.slice(base, base + a.count * tight));
        };
    }

    const readView = (json, bin, i) => {
        const v = json.bufferViews[i];
        const base = bin.byteOffset + (v.byteOffset || 0);
        return new Uint8Array(bin.buffer.slice(base, base + v.byteLength));
    };

    /* ------------------------------------------------------------------ toán */

    /* Quaternion phải nội suy bằng slerp. Trung bình cộng từng thành phần cho ra
       hướng gần đúng nhưng TỐC ĐỘ xoay bị méo — chuyển động nhanh sẽ giật. */
    function slerp(out, a, ai, b, bi, t) {
        let ax = a[ai], ay = a[ai + 1], az = a[ai + 2], aw = a[ai + 3];
        let bx = b[bi], by = b[bi + 1], bz = b[bi + 2], bw = b[bi + 3];
        let cos = ax * bx + ay * by + az * bz + aw * bw;
        if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
        let s0, s1;
        if (1 - cos > 1e-6) {
            const om = Math.acos(cos), si = Math.sin(om);
            s0 = Math.sin((1 - t) * om) / si;
            s1 = Math.sin(t * om) / si;
        } else { s0 = 1 - t; s1 = t; }
        out[0] = s0 * ax + s1 * bx; out[1] = s0 * ay + s1 * by;
        out[2] = s0 * az + s1 * bz; out[3] = s0 * aw + s1 * bw;
        const l = Math.hypot(out[0], out[1], out[2], out[3]) || 1;
        out[0] /= l; out[1] /= l; out[2] /= l; out[3] /= l;
        return out;
    }

    function sample(times, values, n, t, interp, isRot) {
        const c = times.length;
        if (!c) return null;
        const stride = interp === 'CUBICSPLINE' ? n * 3 : n;
        const at = i => {
            const b = interp === 'CUBICSPLINE' ? i * stride + n : i * stride;
            return Array.from(values.slice(b, b + n));
        };
        if (t <= times[0]) return at(0);
        if (t >= times[c - 1]) return at(c - 1);
        let hi = 1;
        while (hi < c && times[hi] < t) hi++;
        const lo = hi - 1;
        if (interp === 'STEP') return at(lo);
        const span = times[hi] - times[lo];
        const f = span > 0 ? (t - times[lo]) / span : 0;
        const A = at(lo), B = at(hi);
        if (isRot && n === 4) return slerp([0, 0, 0, 0], A, 0, B, 0, f);
        const o = new Array(n);
        for (let k = 0; k < n; k++) o[k] = A[k] + (B[k] - A[k]) * f;
        return o;
    }

    /** M = T · R · S, lưu theo cột giống glTF. */
    function composeTRS(t, r, s) {
        const x = r[0], y = r[1], z = r[2], w = r[3];
        const x2 = x + x, y2 = y + y, z2 = z + z;
        const xx = x * x2, xy = x * y2, xz = x * z2;
        const yy = y * y2, yz = y * z2, zz = z * z2;
        const wx = w * x2, wy = w * y2, wz = w * z2;
        return [
            (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
            (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
            (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
            t[0], t[1], t[2], 1,
        ];
    }

    function mul(a, b) {
        const o = new Array(16);
        for (let c = 0; c < 4; c++) {
            for (let r = 0; r < 4; r++) {
                let s = 0;
                for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
                o[c * 4 + r] = s;
            }
        }
        return o;
    }

    /**
     * Bỏ bớt keyframe theo SAI SỐ (Douglas–Peucker trên trục thời gian).
     *
     * Khác hẳn "lấy mẫu lại ở 30fps": cách đó rải key đều nhau bất kể chuyển động,
     * nên đoạn đứng yên thừa key còn đoạn vẩy chân thiếu trầm trọng. Đo trên một rig
     * thật: resample 30fps cho sai lệch 121.8° ở bàn chân, decimation cùng dung lượng
     * chỉ 0.32°. Ở đây sai số là THAM SỐ ĐẦU VÀO, không phải kết quả may rủi.
     */
    function decimate(times, values, n, isRot, tol) {
        const c = times.length;
        if (c <= 2 || tol <= 0) return { times, values };

        const err = (i, lo, hi) => {
            const span = times[hi] - times[lo];
            const f = span > 0 ? (times[i] - times[lo]) / span : 0;
            if (isRot) {
                const q = slerp([0, 0, 0, 0], values, lo * 4, values, hi * 4, f);
                const dot = Math.min(1, Math.abs(
                    q[0] * values[i * 4] + q[1] * values[i * 4 + 1] +
                    q[2] * values[i * 4 + 2] + q[3] * values[i * 4 + 3]));
                return 2 * Math.acos(dot);
            }
            let s = 0;
            for (let k = 0; k < n; k++) {
                const li = values[lo * n + k] + (values[hi * n + k] - values[lo * n + k]) * f;
                const d = li - values[i * n + k];
                s += d * d;
            }
            return Math.sqrt(s);
        };

        const keep = new Uint8Array(c);
        keep[0] = keep[c - 1] = 1;
        const stack = [[0, c - 1]];
        while (stack.length) {
            const [lo, hi] = stack.pop();
            if (hi - lo < 2) continue;
            let worst = -1, worstErr = 0;
            for (let i = lo + 1; i < hi; i++) {
                const e = err(i, lo, hi);
                if (e > worstErr) { worstErr = e; worst = i; }
            }
            if (worstErr > tol && worst > 0) {
                keep[worst] = 1;
                stack.push([lo, worst], [worst, hi]);
            }
        }

        const idx = [];
        for (let i = 0; i < c; i++) if (keep[i]) idx.push(i);
        const nt = new Float32Array(idx.length);
        const nv = new Float32Array(idx.length * n);
        idx.forEach((src, i) => {
            nt[i] = times[src];
            for (let k = 0; k < n; k++) nv[i * n + k] = values[src * n + k];
        });
        return { times: nt, values: nv };
    }

    /* -------------------------------------------------------------- phân tích */

    /** Xương nào thật sự làm biến dạng mesh, gom từ MỌI primitive và MỌI bộ JOINTS_n. */
    function usedSlots(json, read) {
        const meshSkin = new Map();
        for (const n of json.nodes || []) {
            if (n.mesh !== undefined && n.skin !== undefined) {
                if (meshSkin.has(n.mesh) && meshSkin.get(n.mesh) !== n.skin) {
                    throw new Error('một mesh dùng bởi hai skin khác nhau — chưa hỗ trợ');
                }
                meshSkin.set(n.mesh, n.skin);
            }
        }
        const bySkin = new Map();
        let maxInfluence = 0;
        (json.meshes || []).forEach((m, mi) => {
            const si = meshSkin.get(mi);
            if (si === undefined) return;
            const set = bySkin.get(si) || new Set();
            for (const pr of m.primitives) {
                let sets = 0;
                for (let s = 0; ; s++) {
                    const j = pr.attributes['JOINTS_' + s], w = pr.attributes['WEIGHTS_' + s];
                    if (j === undefined || w === undefined) break;
                    sets++;
                    const J = read(j), W = read(w);
                    for (let i = 0; i < J.length; i++) if (W[i] > WEIGHT_EPS) set.add(J[i]);
                }
                maxInfluence = Math.max(maxInfluence, sets * 4);
            }
            bySkin.set(si, set);
        });
        return { bySkin, meshSkin, maxInfluence };
    }

    function analyze(g) {
        const { json, bin } = g;
        const bad = (json.extensionsUsed || []).filter(e => UNSUPPORTED.includes(e));
        if (bad.length) return { error: 'dùng ' + bad.join(', ') + ' — dữ liệu đã nén, không đọc được' };
        if (!json.skins || !json.skins.length) {
            return { skinned: false, verts: countVerts(json), prims: countPrims(json) };
        }
        const read = makeReader(json, bin);
        const { bySkin, maxInfluence } = usedSlots(json, read);

        let tracks = 0, constTracks = 0, fps = 0;
        for (const an of json.animations || []) {
            for (const ch of an.channels) {
                tracks++;
                const s = an.samplers[ch.sampler];
                const o = read(s.output);
                const n = COMP_COUNT[json.accessors[s.output].type] || 1;
                let c = true;
                for (let i = n; i < o.length && c; i++) if (Math.abs(o[i] - o[i % n]) > CONST_EPS) c = false;
                if (c) constTracks++;
            }
            for (const s of an.samplers) {
                const t = read(s.input);
                if (t.length > 2) {
                    let mn = Infinity;
                    for (let i = 1; i < t.length; i++) mn = Math.min(mn, t[i] - t[i - 1]);
                    if (mn > 0) fps = Math.max(fps, Math.round(1 / mn));
                }
            }
        }
        return {
            skinned: true,
            bones: json.skins.reduce((s, sk) => s + sk.joints.length, 0),
            usedBones: [...bySkin.values()].reduce((s, x) => s + x.size, 0),
            nodes: json.nodes.length, skins: json.skins.length,
            verts: countVerts(json), prims: countPrims(json),
            clips: (json.animations || []).length,
            tracks, constTracks, fps, maxInfluence,
            embeddedImages: (json.images || []).filter(i => i.bufferView !== undefined).length,
        };
    }

    const countVerts = json => (json.meshes || []).reduce((s, m) => s + m.primitives.reduce((t, pr) =>
        t + (pr.attributes.POSITION !== undefined ? json.accessors[pr.attributes.POSITION].count : 0), 0), 0);
    const countPrims = json => (json.meshes || []).reduce((s, m) => s + m.primitives.length, 0);

    /* ------------------------------------------------------------------ cắt */

    /**
     * @param {object}   g       kết quả parse()
     * @param {object}   opt     { tolerance (độ), posTolerance, keepBones: RegExp[] }
     * @returns {{json, parts, stats, boneNames}}
     */
    function prune(g, opt) {
        const { json, bin } = g;
        const read = makeReader(json, bin);
        const { bySkin, meshSkin } = usedSlots(json, read);

        /* --- B1: node nào phải giữ ---
           Giữ xương có weight là chưa đủ: transform của một xương tính từ transform
           của CHA nó. Bỏ mất một mắt xích trung gian thì con cháu văng đi đâu không
           biết. Vì vậy phải giữ cả chuỗi cha lên tận gốc. */
        const parentOf = {};
        (json.nodes || []).forEach((n, i) => (n.children || []).forEach(c => { parentOf[c] = i; }));
        const keep = new Set();
        const keepUp = i => { let c = i; while (c !== undefined && !keep.has(c)) { keep.add(c); c = parentOf[c]; } };

        for (const [si, slots] of bySkin) for (const s of slots) keepUp(json.skins[si].joints[s]);
        (json.nodes || []).forEach((n, i) => {
            if (n.mesh !== undefined || n.skin !== undefined || n.camera !== undefined) keepUp(i);
        });
        const forced = [];
        if (opt.keepBones && opt.keepBones.length) {
            (json.nodes || []).forEach((n, i) => {
                if (n.name && opt.keepBones.some(re => re.test(n.name))) { forced.push(n.name); keepUp(i); }
            });
        }
        (json.scenes || []).forEach(sc => (sc.nodes || []).forEach(keepUp));

        /* --- B2: đọc và (nếu bật) tỉa keyframe của mọi channel còn sống --- */
        const nAnims = (json.animations || []).length;
        const collected = [];
        (json.animations || []).forEach((anim, ai) => {
            for (const ch of anim.channels) {
                const node = ch.target.node;
                if (node === undefined || !keep.has(node)) continue;
                const s = anim.samplers[ch.sampler];
                const interp0 = s.interpolation || 'LINEAR';
                const isRot = ch.target.path === 'rotation';
                let times = read(s.input);
                let values = read(s.output);
                let n = ch.target.path === 'weights'
                    ? values.length / times.length / (interp0 === 'CUBICSPLINE' ? 3 : 1)
                    : COMP_COUNT[json.accessors[s.output].type];

                if (interp0 === 'CUBICSPLINE') {
                    const nv = new Float32Array(times.length * n);
                    for (let i = 0; i < times.length; i++) {
                        for (let k = 0; k < n; k++) nv[i * n + k] = values[i * n * 3 + n + k];
                    }
                    values = nv;
                }
                if (opt.tolerance > 0 && times.length > 2 && ch.target.path !== 'weights') {
                    const tol = isRot ? (opt.tolerance * Math.PI / 180) : opt.posTolerance;
                    const d = decimate(times, values, n, isRot, tol);
                    times = d.times; values = d.values;
                }
                let isConst = true;
                for (let i = n; i < values.length && isConst; i++) {
                    if (Math.abs(values[i] - values[i % n]) > CONST_EPS) isConst = false;
                }
                collected.push({ ai, node, path: ch.target.path, times, values, n, isConst,
                                 interp: interp0 === 'CUBICSPLINE' ? 'LINEAR' : interp0 });
            }
        });

        /* --- B3: track hằng số — bake vào node hay giữ lại? ---
           Chỉ được bake khi chắc chắn không làm sai clip nào:
             a) giá trị hằng TRÙNG tư thế rest của node  → bỏ hẳn, miễn phí; hoặc
             b) MỌI clip đều có track này và đều hằng số với CÙNG một giá trị.
           Bỏ qua điều kiện này là lỗi thầm lặng: mỗi clip có bind pose riêng thì clip
           xử lý sau ghi đè clip trước, và mọi clip đều chạy sai tư thế. Đã gặp thật —
           một model lệch 0.45° mà nhìn bằng mắt không ra. */
        const REST = { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
        const restOf = (i, path) => {
            const n = json.nodes[i];
            return (path === 'translation' ? n.translation : path === 'rotation' ? n.rotation : n.scale)
                || REST[path] || null;
        };
        const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= CONST_EPS);

        const groups = new Map();
        for (const t of collected) {
            const k = t.node + '|' + t.path;
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push(t);
        }

        const staticOverride = {};
        const live = [];
        for (const list of groups.values()) {
            const { path, node } = list[0];
            const first = Array.from(list[0].values.slice(0, list[0].n));
            const allConst = list.every(t => t.isConst);
            const allSame = list.every(t => same(Array.from(t.values.slice(0, t.n)), first));
            if (path !== 'weights' && allConst && allSame && list.length === nAnims) {
                (staticOverride[node] || (staticOverride[node] = {}))[path] = first;
                continue;
            }
            for (const t of list) {
                if (path !== 'weights' && t.isConst) {
                    const v = Array.from(t.values.slice(0, t.n));
                    if (same(v, restOf(node, path))) continue;
                    const t0 = t.times[0], t1 = t.times[t.times.length - 1];
                    const vals = new Float32Array(t.n * 2);
                    vals.set(v, 0); vals.set(v, t.n);
                    live.push({ ai: t.ai, node, path, n: t.n, interp: 'LINEAR',
                                times: Float32Array.from([t0, t1 > t0 ? t1 : t0 + 1e-3]), values: vals });
                    continue;
                }
                live.push(t);
            }
        }

        /* --- B4: đánh lại chỉ số ---
           Hai KHÔNG GIAN chỉ số khác nhau, rất dễ nhầm: JOINTS_n đánh chỉ số vào
           skin.joints, KHÔNG phải vào nodes. Nhầm thì file vẫn hợp lệ, model vẫn
           hiện, nhưng skin gán sai xương. */
        const keptNodes = [...keep].sort((a, b) => a - b);
        const nodeMap = new Map();
        keptNodes.forEach((old, i) => nodeMap.set(old, i));

        const keptSlots = [], slotMap = [];
        (json.skins || []).forEach((sk, si) => {
            const kept = [];
            sk.joints.forEach((n, slot) => { if (keep.has(n)) kept.push(slot); });
            const m = new Map();
            kept.forEach((s, i) => m.set(s, i));
            keptSlots[si] = kept; slotMap[si] = m;
        });

        const outNodes = keptNodes.map(old => {
            const n = json.nodes[old];
            const o = {};
            if (n.name !== undefined) o.name = n.name;
            const ov = staticOverride[old] || {};
            const T = ov.translation || n.translation;
            const R = ov.rotation || n.rotation;
            const S = ov.scale || n.scale;
            if (n.matrix && !ov.translation && !ov.rotation && !ov.scale) {
                o.matrix = Array.from(n.matrix);
            } else {
                if (T && (T[0] || T[1] || T[2])) o.translation = Array.from(T);
                if (R && !(R[0] === 0 && R[1] === 0 && R[2] === 0 && R[3] === 1)) o.rotation = Array.from(R);
                if (S && (S[0] !== 1 || S[1] !== 1 || S[2] !== 1)) o.scale = Array.from(S);
            }
            const kids = (n.children || []).filter(c => keep.has(c)).map(c => nodeMap.get(c));
            if (kids.length) o.children = kids;
            if (n.mesh !== undefined) o.mesh = n.mesh;
            if (n.skin !== undefined) o.skin = n.skin;
            if (n.camera !== undefined) o.camera = n.camera;
            if (n.weights !== undefined) o.weights = n.weights;
            return o;
        });

        /* --- đóng gói lại phần nhị phân --- */
        const parts = [], accessors = [], bufferViews = [];
        let byteOffset = 0;

        function pushView(arr, target) {
            const pad = (4 - (byteOffset % 4)) % 4;
            if (pad) { parts.push(new Uint8Array(pad)); byteOffset += pad; }
            parts.push(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
            const bv = { buffer: 0, byteOffset, byteLength: arr.byteLength };
            if (target) bv.target = target;
            bufferViews.push(bv);
            byteOffset += arr.byteLength;
            return bufferViews.length - 1;
        }
        function pushAcc(arr, type, comp, o) {
            o = o || {};
            const bvIdx = pushView(arr, o.target);
            const a = { bufferView: bvIdx, componentType: comp, count: arr.length / COMP_COUNT[type], type };
            if (o.min) a.min = o.min;
            if (o.max) a.max = o.max;
            accessors.push(a);
            return accessors.length - 1;
        }

        const outMeshes = (json.meshes || []).map((m, mi) => {
            const si = meshSkin.get(mi);
            const map = si !== undefined ? slotMap[si] : null;
            return {
                name: m.name, weights: m.weights,
                primitives: m.primitives.map(pr => {
                    const attrs = {};
                    for (const name of Object.keys(pr.attributes)) {
                        const ai = pr.attributes[name];
                        const a = json.accessors[ai];
                        const arr = read(ai);
                        if (/^JOINTS_\d+$/.test(name) && map) {
                            const re = new Uint16Array(arr.length);
                            for (let i = 0; i < arr.length; i++) re[i] = map.has(arr[i]) ? map.get(arr[i]) : 0;
                            attrs[name] = pushAcc(re, 'VEC4', 5123, { target: 34962 });
                            continue;
                        }
                        const o = { target: 34962 };
                        if (name === 'POSITION') { o.min = a.min; o.max = a.max; }
                        attrs[name] = pushAcc(arr, a.type, a.componentType, o);
                    }
                    const out = { attributes: attrs };
                    if (pr.indices !== undefined) {
                        out.indices = pushAcc(read(pr.indices), 'SCALAR',
                            json.accessors[pr.indices].componentType, { target: 34963 });
                    }
                    if (pr.material !== undefined) out.material = pr.material;
                    if (pr.mode !== undefined) out.mode = pr.mode;
                    if (pr.targets) {
                        out.targets = pr.targets.map(t => {
                            const nt = {};
                            for (const k of Object.keys(t)) {
                                const a = json.accessors[t[k]];
                                const o = {};
                                if (k === 'POSITION') { o.min = a.min; o.max = a.max; }
                                nt[k] = pushAcc(read(t[k]), a.type, a.componentType, o);
                            }
                            return nt;
                        });
                    }
                    return out;
                }),
            };
        });

        const outSkins = (json.skins || []).map((sk, si) => {
            const kept = keptSlots[si];
            const o = { joints: kept.map(s => nodeMap.get(sk.joints[s])) };
            /* Giữ nguyên TÊN skin, mesh, clip và material — Cocos sinh sub-asset id từ
               tên chứ không phải chỉ số, nên đổi tên là mọi tham chiếu uuid@subid đứt. */
            if (sk.name) o.name = sk.name;
            if (sk.skeleton !== undefined && keep.has(sk.skeleton)) o.skeleton = nodeMap.get(sk.skeleton);
            if (sk.inverseBindMatrices !== undefined) {
                const src = read(sk.inverseBindMatrices);
                const dst = new Float32Array(kept.length * 16);
                kept.forEach((s, i) => dst.set(src.subarray(s * 16, s * 16 + 16), i * 16));
                o.inverseBindMatrices = pushAcc(dst, 'MAT4', 5126);
            }
            return o;
        });

        const outImages = (json.images || []).map(im => {
            if (im.bufferView === undefined) return Object.assign({}, im);
            const o = { mimeType: im.mimeType, bufferView: pushView(readView(json, bin, im.bufferView)) };
            if (im.name) o.name = im.name;
            return o;
        });

        const outAnims = (json.animations || []).map(a => ({ name: a.name, channels: [], samplers: [] }));
        for (const t of live) {
            const anim = outAnims[t.ai];
            const i = pushAcc(Float32Array.from(t.times), 'SCALAR', 5126,
                { min: [t.times[0]], max: [t.times[t.times.length - 1]] });
            const type = t.n === 4 ? 'VEC4' : t.n === 3 ? 'VEC3' : 'SCALAR';
            const o = pushAcc(Float32Array.from(t.values), type, 5126);
            anim.samplers.push({ input: i, output: o, interpolation: t.interp });
            anim.channels.push({ sampler: anim.samplers.length - 1, target: { node: nodeMap.get(t.node), path: t.path } });
        }

        const out = {
            asset: { version: '2.0', generator: 'Asset Optimizer — deform-bone prune' },
            scene: json.scene || 0,
            scenes: (json.scenes || []).map(sc => ({
                name: sc.name,
                nodes: (sc.nodes || []).filter(n => keep.has(n)).map(n => nodeMap.get(n)),
            })),
            nodes: outNodes,
            accessors, bufferViews,
            buffers: [{ byteLength: byteOffset }],
        };
        if (outMeshes.length) out.meshes = outMeshes;
        if (outSkins.length) out.skins = outSkins;
        if (json.materials) out.materials = json.materials;
        if (outImages.length) out.images = outImages;
        if (json.textures) out.textures = json.textures;
        if (json.samplers) out.samplers = json.samplers;
        if (json.cameras) out.cameras = json.cameras;
        if (json.extensionsUsed) out.extensionsUsed = json.extensionsUsed;
        if (json.extensionsRequired) out.extensionsRequired = json.extensionsRequired;
        const anims = outAnims.filter(a => a.channels.length);
        if (anims.length) out.animations = anims;

        return {
            json: out, parts, forced,
            stats: {
                nodesBefore: json.nodes.length, nodesAfter: outNodes.length,
                bonesBefore: (json.skins || []).reduce((s, sk) => s + sk.joints.length, 0),
                bonesAfter: outSkins.reduce((s, sk) => s + sk.joints.length, 0),
                tracksBefore: (json.animations || []).reduce((s, a) => s + a.channels.length, 0),
                tracksAfter: anims.reduce((s, a) => s + a.channels.length, 0),
            },
            boneNames: outSkins.length ? outSkins[0].joints.map(i => outNodes[i].name) : [],
        };
    }

    /* -------------------------------------------------------------- kiểm chứng */

    /** Dựng một "rig chạy được": hỏi được world matrix của mọi node ở thời điểm bất kỳ. */
    function loadRig(g) {
        const { json, bin } = g;
        const read = makeReader(json, bin);
        const tracks = (json.animations || []).map(anim => {
            const byNode = new Map();
            for (const ch of anim.channels) {
                if (ch.target.path === 'weights') continue;
                const s = anim.samplers[ch.sampler];
                const e = byNode.get(ch.target.node) || {};
                e[ch.target.path] = {
                    times: read(s.input), values: read(s.output),
                    n: COMP_COUNT[json.accessors[s.output].type],
                    interp: s.interpolation || 'LINEAR',
                };
                byNode.set(ch.target.node, e);
            }
            return { name: anim.name, byNode };
        });
        const roots = (json.scenes[json.scene || 0].nodes) || [];
        const nameOf = json.nodes.map(n => n.name);

        function world(animName, t) {
            const anim = tracks.find(a => a.name === animName);
            const out = new Array(json.nodes.length).fill(null);
            const walk = (i, pm) => {
                const n = json.nodes[i];
                const tr = anim && anim.byNode.get(i);
                let T = n.translation || [0, 0, 0];
                let R = n.rotation || [0, 0, 0, 1];
                let S = n.scale || [1, 1, 1];
                if (tr) {
                    if (tr.translation) T = sample(tr.translation.times, tr.translation.values, 3, t, tr.translation.interp, false);
                    if (tr.rotation) R = sample(tr.rotation.times, tr.rotation.values, 4, t, tr.rotation.interp, true);
                    if (tr.scale) S = sample(tr.scale.times, tr.scale.values, 3, t, tr.scale.interp, false);
                }
                const local = n.matrix && !tr ? Array.from(n.matrix) : composeTRS(T, R, S);
                const w = pm ? mul(pm, local) : local;
                out[i] = w;
                (n.children || []).forEach(c => walk(c, w));
            };
            roots.forEach(r => walk(r, null));
            return out;
        }

        const byName = new Map();
        nameOf.forEach((nm, i) => { if (nm !== undefined && !byName.has(nm)) byName.set(nm, i); });

        const deform = new Set();
        const { bySkin } = usedSlots(json, read);
        for (const [si, slots] of bySkin) for (const s of slots) deform.add(nameOf[json.skins[si].joints[s]]);

        const clips = (json.animations || []).map(a => {
            let d = 0;
            for (const s of a.samplers) { const t = read(s.input); d = Math.max(d, t[t.length - 1]); }
            return { name: a.name, duration: d };
        });

        return { world, byName, deform: [...deform], clips };
    }

    /**
     * So bản gốc với bản đã cắt: sai lệch GÓC của từng xương có weight, tính bằng độ.
     * Chọn đơn vị độ vì nó tương ứng trực tiếp với thứ nhìn thấy trên màn hình —
     * "lệch 0.3 độ" thì hiểu ngay, "lệch 4e-3 phần tử ma trận" thì không.
     */
    function verify(srcG, outG, samples) {
        const A = loadRig(srcG), B = loadRig(outG);
        const rows = [];
        let worst = 0, worstBone = '', worstClip = '';
        for (const clip of A.clips) {
            let mx = 0, bone = '';
            for (let k = 0; k < samples; k++) {
                const t = clip.duration * (samples > 1 ? k / (samples - 1) : 0);
                const wa = A.world(clip.name, t), wb = B.world(clip.name, t);
                for (const bn of A.deform) {
                    const ia = A.byName.get(bn), ib = B.byName.get(bn);
                    if (ia === undefined) continue;
                    if (ib === undefined) return { missing: bn };
                    const ma = wa[ia], mb = wb[ib];
                    if (!ma || !mb) continue;
                    const nrm = (m, c) => {
                        const l = Math.hypot(m[c], m[c + 1], m[c + 2]) || 1;
                        return [m[c] / l, m[c + 1] / l, m[c + 2] / l];
                    };
                    const ya = nrm(ma, 4), yb = nrm(mb, 4);
                    const dot = Math.max(-1, Math.min(1, ya[0] * yb[0] + ya[1] * yb[1] + ya[2] * yb[2]));
                    const ang = Math.acos(dot) * 180 / Math.PI;
                    if (ang > mx) { mx = ang; bone = bn; }
                }
            }
            rows.push({ clip: clip.name, duration: clip.duration, maxAngle: mx, bone });
            if (mx > worst) { worst = mx; worstBone = bone; worstClip = clip.name; }
        }
        return { rows, worst, worstBone, worstClip, bones: A.deform.length };
    }

    /** Kiểm tra tính hợp lệ cấu trúc — bắt lỗi đánh lại chỉ số trước khi giao file. */
    function structuralCheck(g) {
        const { json, bin } = g;
        const read = makeReader(json, bin);
        const errs = [];
        (json.skins || []).forEach((sk, si) => {
            sk.joints.forEach(n => { if (n >= json.nodes.length) errs.push('skin ' + si + ' trỏ node không tồn tại'); });
            if (sk.inverseBindMatrices !== undefined && read(sk.inverseBindMatrices).length !== sk.joints.length * 16)
                errs.push('skin ' + si + ': inverseBindMatrices không khớp số xương');
        });
        (json.meshes || []).forEach((m, mi) => {
            const holder = json.nodes.find(n => n.mesh === mi && n.skin !== undefined);
            if (!holder) return;
            const nJ = json.skins[holder.skin].joints.length;
            m.primitives.forEach(pr => {
                for (let s = 0; ; s++) {
                    const j = pr.attributes['JOINTS_' + s];
                    if (j === undefined) break;
                    const J = read(j);
                    for (let i = 0; i < J.length; i++) {
                        if (J[i] >= nJ) { errs.push('JOINTS_' + s + ' vượt phạm vi xương'); break; }
                    }
                }
            });
        });
        const seen = new Set();
        json.nodes.forEach((n, i) => (n.children || []).forEach(c => {
            if (c >= json.nodes.length) errs.push('node ' + i + ' có con không tồn tại');
            if (seen.has(c)) errs.push('node ' + c + ' có nhiều hơn một cha');
            seen.add(c);
        }));
        const maxEnd = json.bufferViews.reduce((m, v) => Math.max(m, (v.byteOffset || 0) + v.byteLength), 0);
        if (bin && maxEnd > bin.length) errs.push('bufferView vượt ngoài khối BIN');
        return errs;
    }

    /** Đường chéo bounding box — dùng làm mốc cho dung sai vị trí. */
    function diagonal(json) {
        const pos = (json.meshes || [])[0] && json.meshes[0].primitives[0].attributes.POSITION;
        if (pos === undefined) return 1;
        const a = json.accessors[pos];
        if (!a.min || !a.max) return 1;
        return Math.hypot(...a.max.map((v, i) => v - a.min[i])) || 1;
    }

    global.GLB = { parse, write, analyze, prune, verify, structuralCheck, diagonal, UNSUPPORTED };
})(window);
