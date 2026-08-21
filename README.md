# Playable Ads Tools

Bộ tool cho quy trình làm playable ad. Mỗi tool là một thư mục tĩnh tự chạy được,
xử lý **hoàn toàn trong trình duyệt** — không file nào rời khỏi máy bạn.

**Mở `index.html` ở thư mục gốc là dùng được**, không cần cài gì.

## Thêm tool mới

Tạo một thư mục ở cấp 1 có `index.html` dùng đúng khối `.topbar` mà các tool đang dùng:

```html
<header class="topbar">
    <div class="brand-mark">XY</div>   <!-- badge 2 chữ trên card -->
    <div>
        <h1>Tên Tool</h1>              <!-- tên trên card -->
        <p>Một câu mô tả ngắn</p>      <!-- mô tả trên card -->
    </div>
    <div class="local-badge"><span></span> Local only</div>
</header>
```

Push lên GitHub là xong — card tự xuất hiện ở trang chủ, **không phải sửa dòng code
nào**. Workflow `.github/workflows/pages.yml` quét lại thư mục rồi deploy.

Chạy local thì gọi `node scripts/build-manifest.js` (hoặc `serve.bat`, nó tự chạy).

### Nếu không muốn theo khuôn `.topbar`

Đặt một `tool.json` cạnh `index.html`, nó đè lên mọi thứ script tự đoán:

```json
{
  "name": "Tên Tool",
  "desc": "Mô tả ngắn",
  "badge": "XY",
  "tags": ["cocos", "3d"],
  "order": -1,
  "hidden": false
}
```

`order` nhỏ hơn thì lên trước (mặc định 0, sau đó sắp theo tên). `hidden: true` thì
ẩn khỏi trang chủ.

Thiếu cả hai thì script vẫn không gãy: nó rơi về `<title>`, rồi cuối cùng về tên thư
mục (`my-new-tool` → *My New Tool*, badge `MN`).

## Cấu trúc

| Đường dẫn | Vai trò |
|---|---|
| `index.html`, `hub.css`, `hub.js` | Trang chủ — **không bao giờ phải sửa khi thêm tool** |
| `tools-data.js` | Sinh tự động, đừng sửa tay |
| `scripts/build-manifest.js` | Quét thư mục, rút metadata, ghi `tools-data.js` |
| `serve.js`, `serve.bat` | Server tĩnh chạy local, không bắt buộc |
| `.github/workflows/pages.yml` | Dựng lại danh sách + deploy lên Pages mỗi lần push |

Script quét chỉ nhìn **thư mục cấp 1**, nên thư mục con bên trong một tool không bị
nhận nhầm thành tool riêng. Tên bắt đầu bằng `.` hoặc `_` cũng bị bỏ qua.

## `serve.bat` — không bắt buộc

Chrome chặn đọc thư mục qua kéo thả khi trang mở bằng `file://`. Vài tool cần kéo cả
thư mục `assets` hoặc thư mục build vào, những lúc đó chạy `serve.bat` để mở qua
`http://localhost:8000`. Server chỉ phục vụ file tĩnh, **không xử lý gì cả**.
