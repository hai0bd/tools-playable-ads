# Playable Mesh Replacer

App local (giống `playable-converter`) để **thay model 3D + texture trong playable HTML** build bằng
**Cocos Creator 2.4.x** (wrapper SayGames — asset nhúng trong `window.__res`).

Nạp file HTML → app liệt kê mesh (kèm **preview 3D** + thống kê) và texture → chọn mesh cần thay →
thả model mới (`.glb`/`.obj`) và/hoặc chọn texture + thả ảnh mới → **Thay & tải về** bản HTML mới.

## Chạy

```
start.bat            (hoặc: node server.js  →  mở http://127.0.0.1:4174)
```

Yêu cầu: **Node.js** (chỉ để chạy server tĩnh). Toàn bộ xử lý diễn ra trong trình duyệt, offline.

## Luồng dùng

1. Kéo/thả file playable `.html` vào ô INPUT.
2. Cột trái hiện lưới **mesh** (mỗi ô có preview 3D + số đỉnh/tam giác). Bấm 1 mesh để chọn.
3. Panel phải hiện viewer lớn (kéo chuột để xoay). Thả **model mới** (`.glb` hoặc `.obj`).
   - **Tự xoay khớp hướng mesh cũ** (bật sẵn): với vật dẹt (đồng xu/đĩa/thẻ), app dùng PCA tìm
     "trục mỏng" rồi xoay model mới cho trùng hướng mesh cũ. Vật không dẹt rõ (khối) sẽ bỏ qua auto.
     Có nút **Xoay X/Y/Z 90°** + **Reset** để chỉnh tay/override.
   - **Tự khớp kích thước mesh cũ** (bật sẵn): scale đều + căn giữa cho đúng bounding-box mesh cũ.
     Tuỳ chọn "Kéo giãn từng trục" để lấp đầy đúng bbox (có thể méo).
   - App cảnh báo nếu > 65536 đỉnh.
4. (Tùy chọn) Mở "Thay cả texture" → chọn 1 texture → thả **ảnh mới** để đè.
5. Bấm **Thay & tải về** → tải `<tên>_edited.html`. Có thể thay tiếp mesh khác rồi tải lại (tích luỹ).

## File

| File | Vai trò |
|---|---|
| `index.html` | UI shell |
| `styles.css` | Giao diện (tái dùng palette playable-converter) |
| `mesh-core.js` | Logic lõi (UMD, zero-dep, chạy cả browser lẫn Node) |
| `app.js` | Wiring UI + previewer 3D (rasterizer phần mềm trên canvas 2D) |
| `server.js` / `start.bat` | Server tĩnh local (port 4174) |
| `tests/mesh-core.test.js` | Test tự chứa: `node tests/mesh-core.test.js` |

## Cách hoạt động (tóm tắt)

- Đọc `window.__res` (dictionary asset) bằng `new Function`.
- Giải mã `.bin` (base64/base122/raw, tự giải nén nếu có header "SAY").
- Parse `cc.Mesh` từ import JSON: nhận diện theo literal `".bin"` + shape, đọc vertex format động;
  **match mesh↔.bin** theo tổng byte + so bounding-box với `_minPos/_maxPos` (sai số ~1e-17).
- **Thay:** dựng `.bin` mới (giữ đúng thứ tự attribute gốc) + clone struct gốc chỉ đổi
  `verticesCount`/range/`minPos`/`maxPos`, ghi base64 mới; texture thì đổi thẳng data URI.
- **Thay THẲNG trên HTML** (không `JSON.stringify` lại toàn bộ `__res`): chỉ tìm & thay đúng
  chuỗi struct + `.bin` + texture cần đổi, giữ nguyên byte mọi asset khác + engine/loader.
  Cực kỳ quan trọng với playable dùng **base122** (như CarRace): base122 có ~20% ký tự điều khiển
  (<0x20); nếu stringify lại sẽ escape thành `\uXXXX` làm phình file ~1.5× → vượt giới hạn ~5MB.
- **Giữ ĐÚNG định dạng bin gốc** (`encodeBinaryLikeOriginal`): PocketSort lưu `.bin` base64 thuần,
  nhưng CarRace lưu **`data:sayMesh;base122,` + nén "SAY"**. Engine render mesh VÔ HÌNH nếu ghi sai
  định dạng (base64-bung) dù bytes giống hệt. Nên tool phát hiện định dạng gốc mỗi mesh và ghi lại
  cùng định dạng: `sayPack()` (nén SAY, verify round-trip qua `unpackMesh`) + `encodeBase122Bytes()`
  (khớp `K_ILLEGALS` đọc từ chính file).

## Ràng buộc

- Index 16-bit → model mới **< 65536 đỉnh**.
- GLB: **bake transform node** (translation/rotation/scale) vào geometry khi nạp — nếu bỏ qua,
  model bị sai hướng/scale (Blender hay gắn xoay 90°X vào node), model dẹt có thể nhìn nghiêng → "biến mất".
- Model **dẹt** (steak, tấm phẳng…) khi fit vào bbox mesh 3D vẫn là vật dẹt — sẽ không "lấp đầy" hình khối cũ.
- Giữ vertex format gốc (position/normal/uv0); thiếu normal/uv sẽ đắp mặc định.
- Mesh gốc nhiều submesh → model mới gộp về 1 submesh.
- Thay texture = đổi **bytes ảnh** trong slot cũ (giữ material/shader); nên cùng kích thước/POT.
- Để ý giới hạn dung lượng mạng quảng cáo (~5MB) sau khi thay.

## Đã kiểm chứng

- `node tests/mesh-core.test.js` — 11/11 pass (đọc, thay cube, identity round-trip=0, thay texture, chặn >65535 đỉnh, preview base122, fit kích thước, serialize không phình base122, bake transform GLB, auto-orient trục mỏng, SAY-pack+base122 round-trip).
- Đọc thật: PocketSort V1(5)/V2(19)/V3(45)/V4(5) + CarRace V3(45) mesh — match 100%.
- UI: nạp V3/CarRace → preview 3D + texture (kể cả base122) render, thay mesh bằng cube → HTML xuất ra
  **cùng dung lượng** (không phình), 44 mesh còn lại nguyên, playable vẫn render 0 lỗi console.

## Giới hạn

- Chỉ cho playable **Cocos 2.4.x dạng `window.__res`** (SayGames/Applovin). Bản 3.x/engine khác cần chỉnh parser.
- Không map tự động mesh↔material (người dùng tự chọn texture để thay).
- Không phục hồi định dạng model gốc (Cocos đã bake thành `cc.Mesh` khi build).
