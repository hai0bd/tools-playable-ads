'use strict';
/* Bộ giải mã WebP (core/util/webp.js) phải ra đúng từng byte như libwebp.
 * fixtures/webp: ảnh nhỏ phủ các nhánh — VP8L (bảng màu, alpha), VP8 lossy, ALPH (lượng tử, lọc gradient),
 * loop filter simple/normal + segment + nhiều partition (key frame libvpx); expected.json = md5 RGBA do libwebp giải. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isWebP, decodeWebP } = require('../core/util/webp');

const DIR = path.join(__dirname, 'fixtures', 'webp');
const expected = JSON.parse(fs.readFileSync(path.join(DIR, 'expected.json'), 'utf8'));

for (const [name, want] of Object.entries(expected)) {
  test(`WebP == libwebp: ${name} (${want.what})`, () => {
    const bytes = fs.readFileSync(path.join(DIR, name + '.webp'));
    assert.ok(isWebP(bytes));
    const img = decodeWebP(bytes);
    assert.strictEqual(img.width, want.width);
    assert.strictEqual(img.height, want.height);
    assert.strictEqual(crypto.createHash('md5').update(img.data).digest('hex'), want.rgbaMd5);
  });
}

test('không phải WebP / WebP hỏng', () => {
  assert.strictEqual(isWebP(Buffer.from('\x89PNG\r\n\x1a\n0000000000000000', 'latin1')), false);
  const bytes = fs.readFileSync(path.join(DIR, 'ly_tiny_33x31.webp'));
  assert.throws(() => decodeWebP(bytes.subarray(0, 24)));
});
