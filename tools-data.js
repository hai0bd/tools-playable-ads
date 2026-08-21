/* File này do scripts/build-manifest.js sinh ra — ĐỪNG SỬA TAY.
 * Sửa ở đây sẽ mất khi CI chạy lại. Muốn đổi tên hay mô tả một tool thì sửa
 * khối .topbar trong index.html của tool đó, hoặc thêm tool.json cạnh nó.
 */
window.TOOLS = [
  {
    "slug": "asset-optimizer",
    "name": "Asset Optimizer",
    "desc": "Nén texture, audio và model cho Cocos Creator — giữ nguyên UUID",
    "badge": "AO",
    "entry": "asset-optimizer/",
    "pages": [],
    "hasTests": false,
    "hasReadme": true,
    "updated": null,
    "tags": [],
    "order": 0,
    "hidden": false
  },
  {
    "slug": "build-size-analyzer",
    "name": "Build Size Analyzer",
    "desc": "Thống kê dung lượng build Cocos Creator",
    "badge": "BS",
    "entry": "build-size-analyzer/",
    "pages": [],
    "hasTests": false,
    "hasReadme": false,
    "updated": null,
    "tags": [],
    "order": 0,
    "hidden": false
  },
  {
    "slug": "playable-converter",
    "name": "Playable Converter",
    "desc": "Chuyển đổi playable HTML giữa các mạng quảng cáo",
    "badge": "PC",
    "entry": "playable-converter/",
    "pages": [
      {
        "file": "decode.html",
        "label": "Decode / Encode — spVars & URL-encoded"
      }
    ],
    "hasTests": true,
    "hasReadme": false,
    "updated": null,
    "tags": [],
    "order": 0,
    "hidden": false
  },
  {
    "slug": "playable-mesh-replacer",
    "name": "Playable Mesh Replacer",
    "desc": "Thay model 3D + texture trong playable HTML (Cocos Creator)",
    "badge": "MR",
    "entry": "playable-mesh-replacer/",
    "pages": [],
    "hasTests": true,
    "hasReadme": true,
    "updated": null,
    "tags": [],
    "order": 0,
    "hidden": false
  }
];
window.TOOLS_BUILT_AT = "2026-08-21T01:30:06.185Z";
