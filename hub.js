'use strict';

/* Dựng lưới card từ window.TOOLS mà scripts/build-manifest.js sinh ra.
   Thêm tool mới KHÔNG cần đụng vào file này. */

(function () {
    var tools = Array.isArray(window.TOOLS) ? window.TOOLS : null;
    var grid = document.getElementById('grid');
    var empty = document.getElementById('empty');
    var count = document.getElementById('count');
    var search = document.getElementById('search');
    var footer = document.getElementById('footer');

    /* ---------------------------------------------------------- tiện ích */

    function el(tag, cls, text) {
        var node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = text;
        return node;
    }

    /* Bỏ dấu để gõ "chuyen doi" vẫn tìm ra "chuyển đổi". NFD tách được thanh
       điệu và mũ, nhưng đ là một chữ cái riêng chứ không phải d cộng dấu, nên
       phải thay tay. */
    function norm(s) {
        return String(s == null ? '' : s).toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/\u0111/g, 'd');
    }

    function relTime(iso) {
        if (!iso) return '';
        var then = new Date(iso);
        if (isNaN(then.getTime())) return '';
        var days = Math.floor((Date.now() - then.getTime()) / 86400000);
        if (days <= 0) return 'hôm nay';
        if (days === 1) return 'hôm qua';
        if (days < 30) return days + ' ngày trước';
        if (days < 365) return Math.floor(days / 30) + ' tháng trước';
        return Math.floor(days / 365) + ' năm trước';
    }

    function showEmpty(title, detail, code) {
        grid.hidden = true;
        empty.hidden = false;
        empty.textContent = '';
        empty.appendChild(el('h3', null, title));
        var p = el('p', null, detail);
        if (code) {
            p.appendChild(document.createTextNode(' '));
            p.appendChild(el('code', null, code));
        }
        empty.appendChild(p);
    }

    /* ------------------------------------------------------------- card */

    function card(t) {
        var base = t.entry || (t.slug + '/');
        var hasExtra = Array.isArray(t.pages) && t.pages.length > 0;
        var wrap = el('div', 'tool-wrap' + (hasExtra ? ' has-extra' : ''));

        var a = el('a', 'tool-card');
        a.href = base;

        var head = el('div', 'tool-head');
        head.appendChild(el('div', 'brand-mark', t.badge || '??'));
        var names = el('div');
        names.appendChild(el('div', 'tool-name', t.name || t.slug));
        names.appendChild(el('div', 'tool-slug', t.slug + '/'));
        head.appendChild(names);
        a.appendChild(head);

        a.appendChild(el('p', 'tool-desc',
            t.desc || 'Chưa có mô tả — thêm thẻ p vào khối .topbar của tool.'));

        var meta = el('div', 'tool-meta');
        (t.tags || []).forEach(function (tag) { meta.appendChild(el('span', 'chip', tag)); });
        if (t.hasTests) meta.appendChild(el('span', 'chip tests', 'tests'));
        if (t.hasReadme) meta.appendChild(el('span', 'chip', 'readme'));
        var when = relTime(t.updated);
        if (when) meta.appendChild(el('span', 'updated', 'cập nhật ' + when));
        a.appendChild(meta);

        wrap.appendChild(a);

        /* Link trang phụ phải nằm NGOÀI thẻ a của card: a lồng trong a là HTML
           không hợp lệ, trình duyệt sẽ tự tách thẻ ra và làm vỡ layout. */
        if (hasExtra) {
            var extra = el('div', 'tool-extra');
            t.pages.forEach(function (p) {
                var link = el('a', null, p.label || p.file);
                link.href = base + p.file;
                link.title = p.label || p.file;
                extra.appendChild(link);
            });
            wrap.appendChild(extra);
        }
        return wrap;
    }

    /* ------------------------------------------------------------ render */

    function render(list) {
        grid.textContent = '';
        if (!list.length) {
            showEmpty('Không có tool nào khớp', 'Thử từ khoá khác, hoặc xoá ô tìm kiếm.');
            return;
        }
        grid.hidden = false;
        empty.hidden = true;
        list.forEach(function (t) { grid.appendChild(card(t)); });
    }

    /* -------------------------------------------------------------- chạy */

    if (!tools) {
        count.textContent = '';
        showEmpty(
            'Chưa có danh sách tool',
            'File tools-data.js chưa được sinh. Chạy lệnh này ở thư mục gốc rồi tải lại trang:',
            'node scripts/build-manifest.js');
        return;
    }

    if (!tools.length) {
        count.textContent = '0 tool';
        showEmpty(
            'Chưa có tool nào',
            'Tạo một thư mục có index.html dùng khối .topbar quen thuộc, rồi chạy lại',
            'node scripts/build-manifest.js');
        return;
    }

    count.textContent = tools.length + ' tool';
    render(tools);

    search.addEventListener('input', function () {
        var q = norm(search.value).trim();
        if (!q) {
            count.textContent = tools.length + ' tool';
            render(tools);
            return;
        }
        var hit = tools.filter(function (t) {
            return norm(t.name + ' ' + t.desc + ' ' + t.slug + ' ' + (t.tags || []).join(' ')).indexOf(q) !== -1;
        });
        count.textContent = hit.length + '/' + tools.length + ' tool';
        render(hit);
    });

    if (window.TOOLS_BUILT_AT) {
        var built = new Date(window.TOOLS_BUILT_AT);
        footer.textContent = 'Danh sách sinh tự động từ các thư mục trong repo'
            + (isNaN(built.getTime()) ? '' : ' \u00b7 dựng lúc ' + built.toLocaleString('vi-VN'));
    }
})();
