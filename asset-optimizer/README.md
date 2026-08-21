# Asset Optimizer

Tối ưu **texture**, **audio** và **model 3D** cho dự án Cocos Creator 3.x.

**Mở `index.html` là dùng được.** Không cài đặt, không server, không phụ thuộc. Mọi việc mã hoá
và đo đạc chạy ngay trong trình duyệt, không file nào rời khỏi máy bạn.

Kéo file vào → bấm **Tối ưu** → tải về gói `.zip`. Kéo kèm `.meta` thì UUID được giữ nguyên,
nên áp dụng xong mọi tham chiếu trong material, scene và prefab tự khớp.

## Yêu cầu

Chrome hoặc Edge bản mới. Không cần Node, không cần ffmpeg, không cần npm install.

Trang tự dò khả năng của trình duyệt ngay khi mở và hiện kết quả ở góc trên phải:

| Hiện | Nghĩa là |
|---|---|
| *trình duyệt hỗ trợ đủ WebP + AAC* | dùng được toàn bộ |
| *có WebP, KHÔNG có AAC* | chỉ tối ưu được ảnh; phần audio bị bỏ qua |
| *không mã hoá được WebP* | trình duyệt quá cũ |

## `serve.bat` — không bắt buộc

Chrome **chặn đọc thư mục qua kéo thả** khi trang mở bằng `file://`. Nếu bạn muốn kéo nguyên
thư mục `assets` vào thì chạy `serve.bat` để mở qua `http://localhost:8090`. Server này chỉ
phục vụ file tĩnh — **không xử lý gì cả**, mọi việc vẫn nằm trong trình duyệt.

Nút **"Chọn thư mục…"** thì chạy được ở cả hai môi trường, nên phần lớn trường hợp không cần server.

## Trình duyệt làm được những gì

Đây là những con số đo được, không phải suy đoán:

| Việc | Cách làm | Kiểm chứng |
|---|---|---|
| WebP **lossless** | `canvas.toBlob('image/webp', 1.0)` | so từng pixel với bản gốc: **giống hệt** |
| WebP lossy | cùng hàm, quality < 1 | 42264 B → 2510 B ở q90 |
| **AAC-LC** `.m4a` | WebCodecs `AudioEncoder` + muxer tự viết | `ffprobe` đọc ra `profile=LC`, giải mã sạch |
| Phân tích alpha | đọc thẳng kênh alpha của `ImageData` | chính xác tuyệt đối, không phải giá trị thống kê |
| PSNR | ghép lên nền rồi tính MSE trên RGB | xem mục dưới |
| Đóng gói `.zip` | tự dựng, method 0 (store) | `Expand-Archive` của Windows mở được |

### Vì sao phải tự viết muxer `.m4a`

`AudioEncoder` cho ra **khung AAC thô**, không phải file. Cách khác là `MediaRecorder` với
`audio/mp4` — cho file hoàn chỉnh, không cần muxer, nhưng nó ghi theo **thời gian thật**:
bài 48 giây mất đúng 48 giây. Muxer tự viết xong trong chớp mắt (đo được: 3 giây audio → **34 ms**).

## Luật xử lý texture

Mỗi luật đến từ một phép đo, không phải từ suy đoán.

| Trường hợp | Xử lý | Vì sao |
|---|---|---|
| có subMeta `sprite-frame` | **lossless** | `.meta` chứa biên cắt và đỉnh mesh **đã bake** (`trimX`, `rawWidth`, `vertices.rawPosition`). Lossy đổi alpha ở mép → Cocos tính biên cắt khác khi import → sprite lệch, trong khi `.meta` ta chép sang vẫn mang số cũ |
| **tên có hậu tố bản đồ dữ liệu** (`_M` `_R` `_N` `_AO` `_ORM`…) | **lossless** | ba kênh RGB cất ba con số khác nhau chứ không phải màu. `Bike_Neon_M`: kênh B lệch tới **142/255** ở q90 — đủ để roughness 0.80 thành 0.24, tức **sai vật liệu** chứ không phải nhiễu hạt. `_D` `_E` `_A` `_C` KHÔNG nằm trong danh sách: đó là màu thật |
| **ba kênh gần như độc lập** (tương quan < 0.5) | **lossless** | bắt được bản đồ dữ liệu đặt tên tự do. Đo trên dự án: ảnh giống ảnh chụp cho 0.83–0.99, bản đồ dữ liệu cho −0.20…0.28 |
| **có pixel trong suốt** | **lossless** | với ảnh nhiều vùng trong suốt, lossy hầu như không giảm thêm byte mà vẫn thêm rủi ro |
| **alpha đặc** (không pixel nào trong suốt) | thử **lossy** | rất phổ biến với ảnh xuất từ DCC. `Female_Eye.png`: lossless 1028 B, q90 **231 B** — ép lossless là mất 78% phần tiết kiệm mà chẳng bảo vệ được gì |
| không alpha | thử **lossy** | mắt không phân biệt ở PSNR 42–65 dB |
| lossy không qua ngưỡng PSNR | **lùi về lossless** | và báo rõ lý do trong cột ghi chú |
| kết quả không nhỏ hơn đủ nhiều | **giữ nguyên** | `star.png` 2.8 KB → WebP 3.0 KB: header WebP làm file nhỏ phình ra |
| cạnh > 16383 px | **bỏ qua** | WebP không mã hoá nổi |
| trong thư mục có `auto-atlas.pac` | **bỏ qua** | packer gộp lại và mã hoá lại lúc build, định dạng file nguồn không tới được gói cuối |

Alpha chỉ phân **hai lớp có ý nghĩa**: đặc thì cho lossy, có pixel trong suốt thì buộc lossless.
Không tách tiếp thành "nhị phân" / "chuyển sắc" — phân biệt đó cần histogram, còn min/max thì
không nói được (ảnh gradient mượt cũng cho min 0 max 255), mà tách ra cũng dẫn tới cùng một
quyết định. Báo một phân loại không đo được chắc chắn thì tệ hơn là không báo.

### "Lossless" nghĩa chính xác là gì

Đã đo trên PNG có màu giấu dưới vùng `alpha = 0`:

| Bước | RGB dưới vùng trong suốt | RGB nhìn thấy | Kênh alpha |
|---|---|---|---|
| PNG → canvas | **6048 giá trị đổi** | 0 đổi | **0 đổi** |
| canvas → WebP lossless → canvas | 0 đổi | 0 đổi | 0 đổi |

Mất mát nằm ở bước **giải mã PNG**, không phải ở bước mã hoá WebP: canvas nhân alpha vào màu
rồi chia ngược, nên màu nằm dưới pixel trong suốt bị chuẩn hoá. WebP lossless bản thân nó
không mất một bit nào.

An toàn vì hai lý do đo được: **mọi pixel nhìn thấy nguyên vẹn**, và **kênh alpha nguyên vẹn
tuyệt đối**. Cocos tính biên cắt sprite-frame chỉ dựa vào alpha, nên số đã bake trong `.meta`
vẫn khớp.

Vì vậy tool nói *"pixel nhìn thấy và alpha nguyên vẹn"*, **không** nói *"giữ nguyên từng pixel"*.

### Đo PSNR trên ảnh có alpha

So thẳng các kênh màu sẽ tính cả sai lệch ở vùng `alpha = 0` — nơi không ai nhìn thấy — và cho
ra con số thấp giả tạo. Tool ghép ảnh lên **hai nền tương phản** (đen và trắng) rồi lấy giá trị
**tệ nhất**: alpha bị lệch thì một trong hai nền lộ ra ngay, còn sai lệch dưới vùng trong suốt
thì cả hai đều bỏ qua — đúng như mắt người.

## Luật xử lý audio

| Luật | Vì sao |
|---|---|
| codec **AAC-LC**, container `.m4a` | Opus/Vorbis nén tương đương nhưng **iOS Safari không giải mã được** |
| **bỏ qua** file đã là AAC | lossy → lossy là tổn thất chồng tổn thất mà dung lượng gần như không đổi |
| **cắt im lặng cuối file** | tìm thấy 0.44 s và 0.665 s trong hai bản cắt tay khác nhau — nếu loop sẽ nghe rõ khoảng hụt |
| **chừa biên độ** | file gốc thường chạm 0 dBFS, không còn chỗ cho SFX chồng lên |
| báo **RAM** chứ không chỉ dung lượng tải | Web Audio giải nén ra float32 PCM. 191 s stereo = **67 MB RAM** — đủ treo webview máy yếu |

RAM tính theo sample rate của **AudioContext** (48 kHz), không phải của file: trình duyệt lấy
mẫu lại về tần số phần cứng khi giải nén, nên hạ sample rate của file **không** giảm RAM.
Muốn giảm thì phải cắt ngắn hoặc bật **mono**.

## Luật xử lý model

Chỉ nhận `.glb`. Bài toán không phải nén mà là **vứt bỏ thứ không dùng đến**.

Rig xuất từ Blender thường mang cả xương ĐIỀU KHIỂN — IK target, mechanism, tweak — bên cạnh
xương thật sự làm biến dạng mesh. Xương điều khiển chỉ phục vụ animator, không vẽ ra pixel nào,
nhưng vẫn tốn chỗ và vẫn được bake animation đủ ba kênh.

| Luật | Vì sao |
|---|---|
| bỏ xương **không có weight** | không ảnh hưởng một vertex nào — cắt đi không đánh đổi gì |
| **giữ lại chuỗi cha** của xương được giữ | transform tính từ cha; mất mắt xích là con cháu văng đi |
| bỏ track có giá trị **không đổi** suốt clip | tương đương đặt tư thế tĩnh cho xương |
| chỉ bake hằng số vào node khi **mọi clip đồng ý** | mỗi clip có bind pose riêng thì clip sau ghi đè clip trước — đã gặp thật, lệch 0.45° mà mắt không thấy |
| tỉa keyframe theo **sai số**, không theo fps | resample 30fps cho sai lệch **121.8°** ở bàn chân; decimation cùng dung lượng chỉ **0.32°** |
| **giữ nguyên tên file và tên bên trong** | Cocos sinh sub-asset id từ TÊN — đổi tên là mọi `uuid@subid` đứt |
| từ chối Draco / meshopt / quantization | dữ liệu nằm sau tầng nén không đọc được; thà báo lỗi còn hơn ghi file hỏng |

Đo trên rig Rigify thật (`pitbull.glb`): 791 xương / **137 có weight**, 7128 track /
**349 thật sự đổi giá trị**. Kết quả **3.25 MB → 0.89 MB (−73%)** mà sai lệch **0.001°**.
Bật dung sai 0.1° thì xuống **0.57 MB (−83%)** với sai lệch 0.27°.

### Khác biệt quan trọng: ở đây CHỨNG MINH được là không hỏng

Texture và audio chỉ đo được xấp xỉ (PSNR). Model thì khác: tool tính **world matrix của
từng xương có weight** ở 20 mốc thời gian trên cả hai bản rồi so. Mọi vertex đều do world
matrix của xương ảnh hưởng nó đặt vị trí — khớp ở đây là khớp hình dạng, không phải cảm nhận.

Vì vậy khi để dung sai 0 mà sai lệch vượt 0.01°, tool **bỏ file** thay vì giao: lời hứa
"chuyển động y hệt" mà sai thì file đó không dùng được.

### Cái bẫy: socket

`SkeletalAnimation.Socket` trỏ tới xương bằng **tên**. Xương không có weight sẽ bị cắt và
socket trỏ vào hư không — vật gắn kèm biến mất. Tìm xem scene đang dùng socket nào:

```bash
node -e "const s=JSON.parse(require('fs').readFileSync('assets/Game.scene','utf8'));s.forEach(o=>{if(o.__type__==='cc.SkeletalAnimation.Socket')console.log(o.path)})"
```

Lấy tên xương ở cuối đường dẫn, điền vào ô **Giữ thêm xương** rồi chạy lại.

## Cách giữ nguyên UUID

Khi `foo.png` thành `foo.webp`, nếu để Cocos tự import thì nó cấp UUID mới và mọi material trỏ
vào file cũ đều gãy. Thay vào đó tool chép `.meta` cũ sang tên mới, giữ nguyên `uuid` ở **mọi
tầng** `subMetas`, chỉ đặt `imported: false` và `files: []` để Cocos import lại.

Làm được vì sub-asset id là **hằng số theo loại**: `6c48a` texture, `f9941` sprite-frame,
`b47c0` cubemap. Tham chiếu dạng `<uuid>@6c48a` vì thế tự khớp mà không cần vá gì.

`subMetas` lồng nhiều tầng — cubemap của skybox có 8 node — nên việc reset phải **đệ quy**.
Bỏ sót một tầng là để lại con trỏ tới file trong `library/` không còn tồn tại.

Đã kiểm chứng end-to-end trên 20 file của dự án Rush: cả 20 `.meta` mang `imported: true` sau
khi import, và **25/25 tham chiếu còn nguyên, 0 gãy**.

## Áp dụng kết quả

Gói `.zip` tải về gồm:

```
assets/…             file mới + .meta tương ứng
DELETE-LIST.txt      file cũ PHẢI xoá
APPLY.md             hướng dẫn áp dụng và lùi lại
```

**Bước xoá là bắt buộc.** Nếu chép file mới vào mà để lại file cũ, `assets/` sẽ có hai `.meta`
mang **cùng một UUID** — Cocos không xử lý được tình huống này.

## Kéo thư mục `build` vào (tuỳ chọn)

Dung lượng file nguồn **không phải** dung lượng xuất xưởng: giữa hai con số đó có importer
chuyển đổi, atlas packer gộp sprite, và bộ lọc phụ thuộc loại bỏ asset không ai dùng.

Trên dự án Rush, `NeonCitySkyBox2.png` nặng **19.6 MB** nhưng không được tham chiếu ở đâu —
nó không đóng góp một byte nào cho gói cuối. Đo theo dung lượng nguồn thì riêng nó chiếm 95%
báo cáo và làm mọi phần trăm khác vô nghĩa.

Chọn thư mục `build` thì tool tách được **tiết kiệm THẬT** khỏi tiết kiệm trên giấy. Nó chỉ đọc
**tên** file, không đọc nội dung — nên nhanh và không tốn gì.

## Bố cục

```
index.html          mở cái này
app.js              điều phối, luật quyết định, trình bày
styles.css
browser/img.js      phân tích ảnh, mã hoá WebP, đo PSNR
browser/m4a.js      mã hoá AAC + muxer MP4
browser/zip.js      ghi .zip
browser/meta.js     đọc/sinh .meta, giữ UUID
browser/glb.js      đọc/cắt/ghi GLB, kiểm chứng world matrix

serve.bat/serve.js  KHÔNG bắt buộc — chỉ để kéo thả được cả thư mục
optimize.js         CLI cho Node (cần ffmpeg) — quét cả dự án, hợp khi tự động hoá
lib/                thư viện của CLI
```

## Giới hạn đã biết

- **Không đụng** FBX, prefab, engine module. Tab Model chỉ nhận `.glb` — FBX phải qua Blender
  export ra `.glb` trước.
- **Không giảm số vertex và không nén hình học.** Tab Model chỉ cắt xương và keyframe thừa;
  mesh giữ nguyên từng byte.
- **Không tối ưu được ảnh atlas** do build sinh ra — chúng không có file nguồn trong `assets/`.
  Muốn nhỏ hơn thì chỉnh chất lượng trong `auto-atlas.pac` hoặc tắt packing.
- **Không tự áp dụng.** Chép đè và xoá file là việc bạn quyết định, sau khi đọc báo cáo.
- Bản CLI (`optimize.js`) dùng ffmpeg nên **PSNR có thể lệch** so với bản trình duyệt: ffmpeg
  tính trên mặt phẳng YUV còn bản trình duyệt tính MSE thẳng trên RGB. Bản trình duyệt khắt
  khe hơn, tức là thiên về an toàn.
