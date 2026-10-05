/* worker.js — chạy MỘT job khôi phục trong Web Worker.
 *
 * Trang chính không nạp file này bằng new Worker('worker.js'): nó ghép mã nguồn của
 * RecoverCoreFactory (dist/recover-core.js) với hàm dưới đây thành một Blob rồi tạo worker từ
 * Blob đó — cách duy nhất chạy được cả khi mở index.html bằng file://.
 *
 * Giao thức:
 *   vào  { type: 'run', entry, inputs: [{ path, data }], refs: [{ path, data }], noScripts, zip }
 *   ra   { type: 'progress', pct, msg }
 *        { type: 'done', summary, report, files: [[đường dẫn, ArrayBuffer]] | zip: ArrayBuffer }
 *        { type: 'error', message, unsupported }
 * Mỗi job bắt đầu bằng vfs.reset(): worker được dùng lại cho job sau mà không lẫn file.
 */
function BuildRecoverWorker(core) {
    'use strict';

    function copyOut(bytes) {
        // Buffer của lõi có thể là view vào một vùng nhớ lớn hơn → chép ra ArrayBuffer riêng để transfer
        return Uint8Array.prototype.slice.call(bytes).buffer;
    }

    self.onmessage = async function (e) {
        var job = e.data;
        if (!job || job.type !== 'run') return;
        try {
            core.vfs.reset();
            job.inputs.forEach(function (f) { core.vfs.put('/in/' + f.path, new Uint8Array(f.data)); });
            (job.refs || []).forEach(function (f) { core.vfs.put('/ref/' + f.path, new Uint8Array(f.data)); });
            var res = core.recover('/in/' + job.entry, {
                outRoot: '/out',
                noScripts: !!job.noScripts,
                sourceLabel: job.source || job.entry,
                reference: job.refs && job.refs.length ? ['/ref'] : [],
                onProgress: function (pct, msg) { self.postMessage({ type: 'progress', pct: pct, msg: msg }); }
            });
            var files = core.vfs.list(res.outDir);
            var outName = res.outDir.split('/').pop();
            var reportFile = files.filter(function (f) { return f[0] === 'RECOVERY_REPORT.md'; })[0];
            var summary = {
                name: res.name, outName: outName, creatorVersion: res.creatorVersion, stats: res.stats,
                engine: res.engine || 'cocos', engineVersion: res.engineVersion || null,
                warnings: res.report.warnings, notes: res.report.notes, facts: res.report.facts,
                fileCount: files.length, bytes: files.reduce(function (s, f) { return s + f[1].length; }, 0)
            };
            var report = reportFile ? new TextDecoder().decode(reportFile[1]) : '';
            core.vfs.reset();
            if (job.zip) {
                self.postMessage({ type: 'progress', pct: 99, msg: 'Đóng gói .zip...' });
                var zip = copyOut(await core.buildZip(files, outName));
                self.postMessage({ type: 'done', summary: summary, report: report, zip: zip }, [zip]);
            } else {
                var list = files.map(function (f) { return [f[0], copyOut(f[1])]; });
                self.postMessage({ type: 'done', summary: summary, report: report, files: list }, list.map(function (f) { return f[1]; }));
            }
        } catch (err) {
            core.vfs.reset();
            self.postMessage({
                type: 'error',
                message: String((err && err.message) || err),
                unsupported: err instanceof core.UnsupportedBuildError,
                stack: err && err.stack ? String(err.stack).split('\n').slice(0, 6).join('\n') : ''
            });
        }
    };
}
