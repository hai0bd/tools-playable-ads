'use strict';
/* vm cho trình duyệt. Lõi dùng vm ở hai chỗ:
 *   - đọc object literal của super-html:      runInNewContext('__o = {...}', ctx) rồi lấy ctx.__o
 *   - chạy bộ giải chuỗi của obfuscator:      createContext(sb); runInContext(code, sb) rồi đọc sb.__decoders
 *
 * Giả lập bằng `with (proxy) { code }`: proxy nhận mọi tên (has → true), ghi thì vào ctx, đọc
 * thì ctx trước rồi tới global. Code đặt THẲNG trong khối `with` chứ không qua eval — khai báo
 * function trong khối được tra thấy trước proxy; qua eval thì proxy chặn mất và trả undefined.
 * Không có timeout: job chạy trong worker riêng, trang chính tự huỷ worker nếu treo quá lâu.
 */

function run(code, ctx) {
  const scope = new Proxy(ctx, {
    has: () => true,
    get: (t, k) => (k === Symbol.unscopables ? undefined : k in t ? t[k] : globalThis[k]),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  // eslint-disable-next-line no-new-func
  return new Function('__vmScope', 'with (__vmScope) {\n' + code + '\n}').call(ctx, scope);
}

module.exports = {
  createContext: (sb = {}) => sb,
  isContext: () => true,
  runInContext: (code, ctx) => run(code, ctx),
  runInNewContext: (code, ctx = {}) => run(code, ctx),
  runInThisContext: (code) => (0, eval)(code),
};
