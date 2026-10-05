'use strict';
// Collects warnings/notes during recovery and writes RECOVERY_REPORT.md into the recovered project.

class Report {
  constructor() {
    this.warnings = [];
    this.notes = [];
    this.facts = {};
  }
  warn(msg) { if (!this.warnings.includes(msg)) this.warnings.push(msg); }
  note(msg) { if (!this.notes.includes(msg)) this.notes.push(msg); }
  set(key, value) { this.facts[key] = value; }
}

function mdTable(rows) {
  if (!rows.length) return '';
  const head = Object.keys(rows[0]);
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${head.map((h) => String(r[h] ?? '')).join(' | ')} |`)].join('\n');
}

function renderReport(report) {
  const f = report.facts;
  const lines = [];
  lines.push(`# Báo cáo khôi phục project — ${f.projectName || ''}`);
  lines.push('');
  lines.push(`Tạo bởi Build Recover lúc ${new Date().toISOString().replace('T', ' ').slice(0, 19)} từ \`${f.source}\` (${f.kind}).`);
  lines.push('');
  lines.push('## Thông tin bản build');
  lines.push('');
  lines.push(mdTable([
    { Mục: 'Phiên bản engine của build', 'Giá trị': f.engineVersion || '?' },
    { Mục: 'Mở project bằng Cocos Creator', 'Giá trị': f.creatorVersion || '?' },
    { Mục: 'Scene khởi động', 'Giá trị': f.launchScene || '?' },
    { Mục: 'Design resolution', 'Giá trị': f.designResolution || '?' },
    { Mục: 'Bundle', 'Giá trị': (f.bundles || []).join(', ') },
    { Mục: 'Kênh super-html', 'Giá trị': f.channel || '-' },
  ]));
  lines.push('');
  lines.push('## Đã khôi phục');
  lines.push('');
  lines.push(mdTable(Object.entries(f.stats || {}).map(([k, v]) => ({ Loại: k, 'Số lượng': v }))));
  lines.push('');
  if (f.scripts) {
    lines.push('## Script');
    lines.push('');
    lines.push(`- ${f.scripts.total} script được dịch ngược từ JavaScript đã biên dịch${f.scripts.deobfuscated ? ` (đã khử obfuscation ${f.scripts.deobfuscated} chuỗi)` : ''}.`);
    if (f.scripts.fromReference) lines.push(`- ${f.scripts.fromReference} script lấy nguyên bản từ project tham chiếu (cùng uuid).`);
    lines.push('- Logic, tên class, tên hàm, tên thuộc tính và `@property` được giữ nguyên; tên biến cục bộ/tham số là tên đã bị minify, comment gốc không còn.');
    lines.push('');
  }
  if (f.verification) {
    lines.push('## Tự kiểm tra');
    lines.push('');
    for (const v of f.verification) lines.push(`- ${v}`);
    lines.push('');
  }
  lines.push('## Suy đoán (không có trong build)');
  lines.push('');
  lines.push('- Cấu trúc thư mục: build không lưu đường dẫn asset (trừ scene và bundle có `paths`). Ảnh được xếp theo màn hình/prefab sử dụng chúng, script đặt trong `assets/Scripts`.');
  lines.push('- Asset không được scene nào dùng thì không có trong build nên không khôi phục được.');
  lines.push('- Ảnh là bản đã nén trong build. Nếu còn file thiết kế gốc, có thể thay file ảnh (giữ nguyên file `.meta`).');
  lines.push('');
  if (report.notes.length) {
    lines.push('## Ghi chú');
    lines.push('');
    for (const n of report.notes) lines.push(`- ${n}`);
    lines.push('');
  }
  if (report.warnings.length) {
    lines.push('## Cảnh báo');
    lines.push('');
    for (const w of report.warnings) lines.push(`- ${w}`);
    lines.push('');
  }
  if (f.nextSteps && f.nextSteps.length) {
    lines.push('## Bước tiếp theo');
    lines.push('');
    f.nextSteps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = { Report, renderReport };
