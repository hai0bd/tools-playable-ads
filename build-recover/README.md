# Build Recover

Dựng lại **project từ bản build playable** — dành cho lúc mất source mà chỉ còn file build:

- **Cocos Creator 3.x** (super-html, web-mobile): scene, prefab, ảnh, sprite frame, atlas, âm thanh, font,
  Spine, DragonBones, model 3D (.glb), animation, material, cube map và **script TypeScript dịch ngược**
  từ JavaScript đã biên dịch.
- **Unity** (playable **Luna**): scene, prefab, texture + sprite (kể cả sprite nằm trong atlas Luna), mesh
  (kể cả skinned), material, animation clip, Animator controller, âm thanh, text/JSON/Spine data, particle,
  UI + TextMesh Pro, collider/joint/rigidbody, RenderTexture, URP Asset, ScriptableObject, Tags/Layers/Sorting layers, package
  manifest — và **script C#**: đủ class + field serialize đúng kiểu (dữ liệu trong scene gắn đúng), thân
  hàm dịch tự động từ Bridge.NET JavaScript về C# để trong comment.

**Mở `index.html` là dùng được.** Không cài đặt, không server. Mọi việc chạy trong trình duyệt, không
file nào rời khỏi máy.

## Dùng

1. Thả vào ô **Thêm bản build** (nhiều cái một lúc cũng được):
   - `.html` playable super-html (mọi kênh: AppLovin, Google, Unity, Mintegral…),
   - `.html` playable **Luna** (Unity) — tool tự nhận ra và dựng project Unity,
   - `.zip` build web-mobile hoặc zip chứa playable,
   - thư mục `web-mobile`.
2. **Quét thư mục…** — chọn một thư mục lớn (kể cả ổ NAS): tool tìm mọi bản build bên trong, gom các
   bản khác kênh của cùng một phiên bản và chọn sẵn một bản mỗi phiên bản.
3. **Lưu project vào**: chọn một thư mục (Chrome/Edge ghi thẳng ra đĩa, mỗi project một thư mục con,
   trùng tên thì `_2`, `_3`… — không bao giờ ghi đè) hoặc để mặc định tải về `.zip`.
4. Mở thư mục project bằng Cocos Creator (Dashboard → Add project) hoặc Unity Hub (project từ Luna). Đọc
   `RECOVERY_REPORT.md` trong project — hoặc nút **Báo cáo** — để biết phần nào là suy đoán. Chip xanh
   **Cần import: …** trên thẻ việc là các package phải import tay (Spine 3.x, DOTween, TMP Essentials):
   chưa import thì component của chúng báo *Missing Script*; GUID đã khớp bản chính thức nên import xong tự nối lại.

**Chạy song song**: mỗi bản build chạy trong một Web Worker riêng (mặc định 4, chỉnh trong Cài đặt);
thêm việc lúc nào cũng được, huỷ / chạy lại từng việc.

**Project tham chiếu** (tuỳ chọn): chọn một project cũ có cùng script — file `.ts` nào trùng uuid thì
dùng nguyên bản gốc thay cho bản dịch ngược. Chỉ `.ts` và `.ts.meta` được đọc.

## `serve.bat` — không bắt buộc

Chrome **chặn đọc thư mục qua kéo thả** khi trang mở bằng `file://`. Muốn kéo cả thư mục `web-mobile`
vào thì chạy `serve.bat` (http://localhost:8095). Nút **Chọn thư mục build…** và **Quét thư mục…** thì
chạy ở cả hai môi trường. Server chỉ phục vụ file tĩnh, không xử lý gì.

## Cấu trúc

| Đường dẫn | Vai trò |
|---|---|
| `index.html`, `styles.css`, `app.js` | Giao diện: hàng đợi việc, worker, ghi thư mục / zip, quét thư mục |
| `worker.js` | Chạy một việc trong Web Worker |
| `dist/recover-core.js` | Lõi đã đóng gói cho trình duyệt — **sinh tự động, đừng sửa tay** |
| `core/` | Lõi khôi phục (CommonJS, chạy được cả Node) |
| `core/luna/` | Luna → Unity: đọc payload, chạy `Deserializers`, ghi YAML Unity (scene, prefab, mesh, anim…), dịch script |
| `core/luna/unity/known-guids.json` | GUID script/shader của UGUI, TMP, Spine, URP… + fileID asset builtin của Unity (`scripts/unity-knowledge.js`, `scripts/unity-builtins/`) |
| `core/util/webp.js`, `webp-tables.js` | Giải mã WebP (VP8 lossy, VP8L lossless, alpha) thuần JS, khớp từng byte với libwebp — Luna hay nén texture sang WebP mà Unity không import được |
| `shims/` | Thay `fs` / `zlib` / `crypto` / `vm` / `path` / `Buffer` của Node khi chạy trong trình duyệt |
| `browser/entry.js` | Điểm vào của bundle: snapshot editor, đóng gói zip |
| `browser/editor-snapshot.json` | Phiên bản importer + uuid asset builtin của Cocos Creator 3.8.7 |
| `scripts/bundle.js` | Đóng gói `core/` → `dist/recover-core.js` |
| `cli/cocos-recover.js` | Bản dòng lệnh (Node) |
| `vendor/brotli-core.js` | Giải nén Brotli (chép từ playable-converter) |
| `tests/` | Test Node |

### Vì sao worker tạo từ Blob

Trang mở bằng `file://` thì Chrome cấm `new Worker('worker.js')` lẫn `importScripts`. Nên
`dist/recover-core.js` là **một hàm** (`RecoverCoreFactory`); trang lấy mã nguồn của nó bằng
`Function.prototype.toString`, ghép với `worker.js` thành một Blob rồi tạo worker từ Blob đó. Cùng một
cách chạy được cả `file://` lẫn `http://`.

### Lõi Node chạy trong trình duyệt thế nào

`core/` viết cho Node: đọc build từ đĩa, ghi project ra đĩa. `scripts/bundle.js` (esbuild) thay các
module Node bằng `shims/`:

- `fs` → ổ ảo trong bộ nhớ: `/in` (file build), `/ref` (project tham chiếu), `/out` (project dựng lại).
- `zlib` → inflate/deflate đồng bộ viết tay (lõi mã hoá PNG giữa chừng nên không dùng được
  `CompressionStream` vốn là async); Brotli dùng `vendor/brotli-core.js`.
- `crypto` → md5 viết tay (id sub-asset của model, uuid ổn định).
- `vm` → `with (Proxy)` cho hai chỗ lõi chạy code của build (object literal super-html, bộ giải chuỗi
  của javascript-obfuscator).
- `Buffer` → lớp con của `Uint8Array`, giữ đúng hai điểm hay sai: `slice()` trả view, `latin1` là
  byte → code point (không phải windows-1252).

Kết quả của bundle được so từng file với bản Node trên 8 bản build thật (PLY37, PLY68, IEC24,
NextBots, MiniMart, Gangster, Monster_FPS1, 99Night): trùng từng byte, riêng PNG mã hoá lại thì trùng
từng pixel.

### Sửa lõi

```bash
npm install                      # @babel/* cho bản Node
npm i --no-save esbuild          # hoặc đặt ESBUILD_PATH trỏ tới esbuild có sẵn
node scripts/bundle.js           # sinh lại dist/recover-core.js
node --test tests/*.test.js      # test
```

Máy có Cocos Creator thì `bundle.js` chụp lại `browser/editor-snapshot.json` từ editor đó; không có thì
dùng bản đã commit.

### Dòng lệnh

```bash
node cli/cocos-recover.js <file.html | file.zip | thư mục build> -o <thư mục project>
node cli/cocos-recover.js --batch <thư mục chứa nhiều build> -o <thư mục gốc>
```

Bản Node tự tìm Cocos Creator cài trên máy để lấy phiên bản importer, và đọc/ghi thẳng đĩa.

## Luna → Unity

Playable Luna nhúng mọi thứ trong một file `.html`: JSON bundle, `data.blob` (mesh, key animation), ảnh,
âm thanh (Brotli + base64/base122) và code game Bridge.NET. Bảng **`Deserializers`** trong chính code đó
cho biết từng vị trí trong mảng dữ liệu là field nào — tool chạy nó với một ngữ cảnh ghi lại (không
phải bảng tự viết), nên đọc được mọi phiên bản Luna đã thử (4.4 → 7.2, Unity 2020.3 → 2022.3).

Mở project: Unity Hub → *Add project from disk* (Unity cùng phiên bản trong `ProjectVersion.txt` hoặc mới
hơn). `RECOVERY_REPORT.md` ghi các bước còn lại: import TMP Essential Resources, Spine (3.x cài bằng
`.unitypackage`; 4.x đã trỏ sẵn git trong `Packages/manifest.json`), DOTween nếu game dùng.

Đã thử bằng Unity 2022.3.62f2 ở batchmode trên 7 creative (2D UI, 3D, skinned, ragdoll, Spine, URP): project
import không lỗi, scene mở không thiếu script, camera render ra đúng cảnh như bản chơi Luna
(`scripts/unity-builtins/BuildRecoverVerify.cs`).

Texture Luna đã nén sang **WebP** (tuỳ chọn nén của Luna; Unity không đọc được `.webp`) được giải mã và ghi lại
thành PNG — ảnh gốc `.jpg` thì giờ là `.png`. Bộ giải mã đã so từng byte với libwebp trên 134 ảnh (mọi biến thể
lossy/lossless/alpha, loop filter, nhiều partition); `tests/webp.test.js` giữ 7 ảnh mẫu.

Mở project không bao giờ gặp lỗi compile (thân hàm nằm trong comment). "Missing Script" chỉ xuất hiện khi game
dùng plugin tool không tự cài được — Spine 3.x, DOTween Pro, plugin trả phí khác — và biến mất khi import plugin
đó, vì component đã trỏ đúng GUID bản chính thức (script nằm trong DLL như DOTween Pro: GUID của DLL + fileID
băm MD4 từ tên class, như Unity; bảng lấy từ các DLL có trên máy bằng `scripts/unity-knowledge.js`).

Field script trỏ tới kiểu của package chưa có trong project (Spine 3.x, DOTween…) được khai báo `UnityEngine.Object`
để project compile ngay; comment cạnh field ghi kiểu gốc để đổi lại sau khi import package.

Giới hạn riêng của Luna: texture ở độ phân giải Luna đã nén; shader tuỳ biến chỉ còn GLSL đã biên dịch
(tool tạo shader unlit thay thế cùng tên, cùng thuộc tính); font .ttf/.otf không có trong build; Avatar
humanoid và cấu hình import FBX không còn; instance prefab trong scene đã bị Luna "unpack".

## Giới hạn

- Cocos: chỉ Cocos Creator **3.x** (2.x có cấu trúc build khác hẳn — tool báo rõ khi gặp).
- Asset không được scene nào dùng thì không có trong build → không khôi phục được.
- Build không lưu đường dẫn asset (trừ scene và bundle có `paths`): cấu trúc thư mục là **suy đoán** theo
  màn hình/prefab dùng asset.
- Script: logic, tên class/hàm/thuộc tính và `@property` giữ nguyên; tên biến cục bộ là tên đã minify,
  comment gốc không còn.
- Texture chỉ có dạng nén (ASTC/ETC/PVR) mà không kèm PNG/JPG thì không khôi phục được ảnh.
