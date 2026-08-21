/* Giao diện Asset Optimizer.
   Mọi việc nặng nằm ở server; phía này chỉ nhận file, gửi lên, và trình bày kết quả. */

'use strict';

const $ = s => document.querySelector(s);
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
const AUDIO_RE = /\.(mp3|wav|ogg|m4a|aac)$/i;
const META_RE = /\.meta$/i;

let session = null;
let picked = new Map();     // đường dẫn tương đối -> File
let shipNames = null;       // tên file trong build, chỉ tên
let lastRun = null;

/* ------------------------------------------------------------------ tiện ích */

const KB = n => (n / 1024).toFixed(1) + ' KB';
const fmt = n => n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : KB(n);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Đường dẫn tương đối của một File, bỏ tên thư mục gốc mà trình duyệt thêm vào. */
function relPathOf(file) {
    const raw = file.webkitRelativePath || file.name;
    const parts = raw.split('/');
    // kéo thư mục "assets" vào thì bỏ luôn tầng đó cho đường dẫn khỏi lồng thừa
    if (parts.length > 1 && parts[0].toLowerCase() === 'assets') parts.shift();
    else if (parts.length > 1) parts.shift();
    return parts.join('/') || file.name;
}

function interesting(name) {
    return IMAGE_RE.test(name) || AUDIO_RE.test(name) || META_RE.test(name);
}

/* --------------------------------------------------------------- nhận file */

function addFiles(files) {
    let added = 0;
    for (const f of files) {
        if (!interesting(f.name)) continue;
        picked.set(relPathOf(f), f);
        added++;
    }
    if (added) refreshIntake();
    return added;
}

function refreshIntake() {
    const media = [...picked.entries()].filter(([p]) => !META_RE.test(p));
    const metas = picked.size - media.length;
    const total = media.reduce((s, [, f]) => s + f.size, 0);

    $('#intake').hidden = picked.size === 0;
    $('#options-card').hidden = media.length === 0;
    $('#intake-count').textContent =
        `${media.length} file media` + (metas ? ` · ${metas} file .meta` : ' · chưa có .meta');
    $('#intake-size').textContent = fmt(total)
        + (metas ? '' : ' — không có .meta thì bản xuất ra sẽ không giữ được UUID');
}

/* Kéo thư mục cần đọc qua DataTransferItem, File API thường không đệ quy được. */
async function readEntry(entry, prefix, out) {
    if (entry.isFile) {
        const file = await new Promise(res => entry.file(res, () => res(null)));
        if (file && interesting(file.name)) out.push([prefix + file.name, file]);
        return;
    }
    if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
            const batch = await new Promise(res => reader.readEntries(res, () => res([])));
            if (!batch.length) break;
            for (const e of batch) await readEntry(e, prefix + entry.name + '/', out);
        }
    }
}

async function handleDrop(ev) {
    ev.preventDefault();
    $('#drop').classList.remove('over');
    const items = [...(ev.dataTransfer.items || [])];
    const entries = items.map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);

    if (entries.length) {
        const out = [];
        for (const e of entries) await readEntry(e, '', out);
        for (const [p, f] of out) {
            const parts = p.split('/');
            if (parts.length > 1 && parts[0].toLowerCase() === 'assets') parts.shift();
            picked.set(parts.join('/'), f);
        }
        refreshIntake();
    } else {
        addFiles(ev.dataTransfer.files || []);
    }
}

/* ------------------------------------------------------------------- chạy */

async function ensureSession() {
    if (session) return session;
    const r = await fetch('/api/session', { method: 'POST' }).then(r => r.json());
    session = r.id;
    return session;
}

async function run() {
    const btn = $('#run');
    btn.disabled = true;
    const note = $('#run-note');

    try {
        // phiên mới mỗi lần chạy để kết quả cũ không lẫn vào
        session = null;
        await ensureSession();

        let done = 0;
        for (const [rel, file] of picked) {
            note.textContent = `đang gửi ${++done}/${picked.size}…`;
            const buf = await file.arrayBuffer();
            await fetch('/api/upload?session=' + session + '&path=' + encodeURIComponent(rel),
                { method: 'POST', body: buf });
        }

        if (shipNames) {
            await fetch('/api/shipped?session=' + session,
                { method: 'POST', body: JSON.stringify(shipNames) });
        }

        note.textContent = 'đang mã hoá… (ảnh lớn có thể mất một lúc)';
        const body = {
            session,
            quality: +$('#o-quality').value,
            audioBitrate: +$('#o-bitrate').value,
            psnrFloor: +$('#o-psnr').value,
            minGain: +$('#o-mingain').value,
            mono: $('#o-mono').checked,
            all: $('#o-all').checked,
        };
        const res = await fetch('/api/run', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }).then(r => r.json());

        if (res.error) { note.textContent = 'Lỗi: ' + res.error; return; }
        lastRun = res;
        render(res);
        note.textContent = '';
    } catch (err) {
        note.textContent = 'Lỗi: ' + err.message;
    } finally {
        btn.disabled = false;
    }
}

/* --------------------------------------------------------------- kết quả */

function render(res) {
    const rows = res.rows || [];
    const done = rows.filter(r => r.verdict === 'convert');
    const oldTot = done.reduce((s, r) => s + r.oldSize, 0);
    const newTot = done.reduce((s, r) => s + r.newSize, 0);

    $('#results-card').hidden = false;
    $('#download').disabled = done.length === 0;

    /* Nếu có thông tin build thì tách khoản tiết kiệm thật ra khỏi khoản trên giấy.
       Không tách thì một file mồ côi lớn sẽ cho con số đẹp mà gói cuối không đổi. */
    const real = done.filter(r => r.inBuild);
    const chips = [
        `<div class="chip good">Tiết kiệm <b>${fmt(oldTot - newTot)}</b>
            ${oldTot ? '(-' + Math.round((1 - newTot / oldTot) * 100) + '%)' : ''}</div>`,
        `<div class="chip">Đã đổi <b>${done.length}</b> / ${rows.length} file</div>`,
    ];
    if (res.hasShipInfo && real.length < done.length) {
        const realSave = real.reduce((s, r) => s + (r.oldSize - r.newSize), 0);
        chips.push(`<div class="chip warn">Tiết kiệm THẬT <b>${fmt(realSave)}</b>
            — ${real.length}/${done.length} file có trong build</div>`);
    }
    $('#summary').innerHTML = chips.join('');

    const order = { convert: 0, keep: 1, skip: 2 };
    rows.sort((a, b) => (order[a.verdict] - order[b.verdict]) || (b.oldSize - a.oldSize));

    $('#results tbody').innerHTML = rows.map(r => {
        const isConv = r.verdict === 'convert';
        const bits = [];
        if (r.note) bits.push(r.note);
        if (r.trimmed) bits.push(`cắt ${r.trimmed.toFixed(2)}s im lặng`);
        if (r.psnr && r.psnr !== 'inf') bits.push(`PSNR ${r.psnr} dB`);
        if (r.psnr === 'inf') bits.push('giữ nguyên từng pixel');
        if (!isConv && r.reason) bits.push(r.reason);
        if (r.inBuild === false) bits.push('không có trong build');
        if (isConv) bits.push(r.hasMeta ? 'giữ UUID' : 'không .meta → phải gán lại tay');

        const dim = r.width ? ` <span class="note">${r.width}×${r.height}</span>` : '';
        return `<tr class="${isConv && r.kind === 'texture' ? 'clickable' : ''}"
                    data-rel="${esc(r.rel)}" data-out="${esc(r.outRel || '')}">
            <td><span class="name kind-${r.kind}">${esc(r.rel)}</span>${dim}</td>
            <td class="num">${KB(r.oldSize)}</td>
            <td class="num">${isConv ? KB(r.newSize) : '<span class="skip">—</span>'}</td>
            <td class="num">${isConv
                ? `<span class="gain">-${Math.round((1 - r.newSize / r.oldSize) * 100)}%</span>`
                : '<span class="skip">—</span>'}</td>
            <td>${isConv ? `<span class="mode">${esc(r.mode)}</span>`
                : `<span class="skip">${r.verdict}</span>`}</td>
            <td><span class="note">${esc(bits.join(', '))}</span></td>
        </tr>`;
    }).join('');

    /* --- những thứ không nằm trong bảng nhưng đáng biết --- */
    const extras = [];
    if ((res.dupGroups || []).length) {
        extras.push(`<div class="extra"><h3>Trùng byte</h3>
            <p class="muted">Các file này giống hệt nhau. Gộp lại là cắt dung lượng mà không mất gì.</p>
            <ul>${res.dupGroups.map(g => '<li>' + g.map(esc).join(' ≡ ') + '</li>').join('')}</ul></div>`);
    }
    const orphans = rows.filter(r => !r.used);
    if (orphans.length) {
        const sorted = orphans.sort((a, b) => b.oldSize - a.oldSize).slice(0, 10);
        extras.push(`<div class="extra"><h3>Không thấy tham chiếu</h3>
            <p class="muted">Không file .meta, .mtl, .scene hay .prefab nào bạn kéo lên trỏ tới
            chúng. Nếu bạn kéo đủ cả thư mục assets thì xoá hẳn còn hơn tối ưu.</p>
            <ul>${sorted.map(r => `<li>${KB(r.oldSize)} — ${esc(r.rel)}</li>`).join('')}
            ${orphans.length > 10 ? `<li>… còn ${orphans.length - 10} file</li>` : ''}</ul></div>`);
    }
    const ram = done.filter(r => r.ramBefore);
    if (ram.length) {
        extras.push(`<div class="extra"><h3>RAM khi Web Audio giải nén</h3>
            <p class="muted">Trình duyệt giải nén audio ra float32 PCM. Đây thường là chi phí lớn
            hơn cả dung lượng tải, và là thứ làm treo webview máy yếu.</p>
            <ul>${ram.map(r => `<li>${esc(r.rel)} — ${fmt(r.ramBefore)} → <b>${fmt(r.ramAfter)}</b></li>`).join('')}</ul></div>`);
    }
    $('#extras').innerHTML = extras.join('');
}

/* --------------------------------------------------------- xem trước/sau */

function openViewer(rel, outRel) {
    const q = p => '/api/file?session=' + session + '&path=' + encodeURIComponent(p);
    $('#viewer-name').textContent = rel + '  →  ' + outRel;
    $('#viewer-body').innerHTML = `
        <div class="pane"><h4>Gốc</h4>
            <div class="frame grid"><img src="${q(rel)}" alt=""></div>
            <div class="meta" id="m-old"></div></div>
        <div class="pane"><h4>Sau tối ưu</h4>
            <div class="frame grid"><img src="${q(outRel) + '&which=new'}" alt=""></div>
            <div class="meta" id="m-new"></div></div>`;
    $('#viewer').hidden = false;

    const ALPHA_VI = { none: 'không có alpha', opaque: 'alpha đặc, không dùng', used: 'có pixel trong suốt' };
    const row = (lastRun.rows || []).find(r => r.rel === rel);
    if (row) {
        $('#m-old').textContent = `${KB(row.oldSize)} · ${row.width}×${row.height}`
            + (row.alpha ? ` · ${ALPHA_VI[row.alpha] || row.alpha}` : '');
        $('#m-new').textContent = `${KB(row.newSize)} · ${row.mode}`
            + (row.psnr === 'inf' ? ' · giữ nguyên từng pixel' : row.psnr ? ` · PSNR ${row.psnr} dB` : '');
    }
}

/* -------------------------------------------------------------- gắn sự kiện */

$('#drop').addEventListener('dragover', e => { e.preventDefault(); $('#drop').classList.add('over'); });
$('#drop').addEventListener('dragleave', () => $('#drop').classList.remove('over'));
$('#drop').addEventListener('drop', handleDrop);

$('#pick-files').addEventListener('click', () => $('#in-files').click());
$('#pick-folder').addEventListener('click', () => $('#in-folder').click());
$('#in-files').addEventListener('change', e => addFiles(e.target.files));
$('#in-folder').addEventListener('change', e => addFiles(e.target.files));

$('#pick-build').addEventListener('click', e => { e.preventDefault(); $('#in-build').click(); });
$('#in-build').addEventListener('change', e => {
    // chỉ lấy TÊN file, không đọc nội dung — đủ để suy ra uuid nào xuất xưởng
    shipNames = [...e.target.files].map(f => f.name);
    $('#ship-info').textContent = `đã đọc ${shipNames.length} tên file trong build`;
});

$('#clear').addEventListener('click', () => {
    picked = new Map(); shipNames = null; session = null; lastRun = null;
    $('#ship-info').textContent = '';
    $('#results-card').hidden = true;
    refreshIntake();
});

$('#run').addEventListener('click', run);

$('#download').addEventListener('click', () => {
    if (session) location.href = '/api/zip?session=' + session;
});

$('#results').addEventListener('click', e => {
    const tr = e.target.closest('tr.clickable');
    if (tr) openViewer(tr.dataset.rel, tr.dataset.out);
});

$('#viewer-close').addEventListener('click', () => { $('#viewer').hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#viewer').hidden = true; });

document.querySelectorAll('.viewer-tools [data-bg]').forEach(b => {
    b.addEventListener('click', () => {
        document.querySelectorAll('.viewer-body .frame').forEach(f => {
            f.className = 'frame ' + b.dataset.bg;
        });
    });
});

/* trạng thái ffmpeg — báo sớm còn hơn để người dùng chạy rồi mới lỗi */
fetch('/api/status').then(r => r.json()).then(s => {
    const el = $('#tool-status');
    if (!s.ffmpeg) {
        el.className = 'tool-status bad';
        el.textContent = 'không thấy ffmpeg — không tối ưu được';
    } else if (!s.webp || !s.aac) {
        el.className = 'tool-status bad';
        el.textContent = 'ffmpeg thiếu ' + (!s.webp ? 'libwebp' : 'encoder aac');
    } else {
        el.className = 'tool-status ok';
        el.textContent = 'ffmpeg sẵn sàng';
    }
}).catch(() => { });
