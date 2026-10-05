'use strict';
/* os / process / module rỗng cho bản trình duyệt. */

const os = {
  homedir: () => '/home',
  tmpdir: () => '/tmp',
  cpus: () => [],
  platform: () => 'browser',
  type: () => 'Browser',
  EOL: '\n',
};

const process = {
  env: {},
  argv: [],
  platform: 'browser',
  version: '',
  versions: {},
  browser: true,
  cwd: () => '/',
  exit: () => {},
  on: () => {},
  emitWarning: () => {},
  nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
  hrtime: Object.assign(() => [0, 0], { bigint: () => BigInt(Math.round(performance.now() * 1e6)) }),
  memoryUsage: () => ({ heapUsed: 0, rss: 0 }),
  stdout: { write: () => true, isTTY: false },
  stderr: { write: () => true, isTTY: false },
};

module.exports = { os, process, empty: {} };
