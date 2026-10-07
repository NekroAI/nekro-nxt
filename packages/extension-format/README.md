# 扩展包格式

`@nekro-nxt/extension-format` 定义 NekroNXT 扩展的分享格式：`.nxt-extension` 传输包的结构与完整性校验、Manifest V6 扩展清单，以及 Revision 内容摘要（`contentDigest` / `payloadDigest`）。NekroNXT 导入、保存与社区发布前的校验共用这一份实现，因此社区接受的包一定能被 NekroNXT 安装。

- `verifyExtensionPackage(bytes)`：与 NekroNXT 导入相同的完整校验，返回传输清单与校验后的 Revision；
- `parseExtensionImport(bytes)`：只做包结构、文件清单与文件摘要校验；
- `materializeImportedRevision(...)` / `revisionDigests(...)`：校验清单、源码与资源并计算摘要；
- `extensionManifestSchema` 及各贡献 Schema：扩展清单结构。

## 扩展图标

Manifest V6 可选字段 `icon: { path, sha256 }` 声明扩展自身的图标，`path` 只能是 `assets/icon.svg`、`assets/icon.png`、`assets/icon.webp` 之一，`sha256` 是图标文件原始字节的 SHA-256（SVG 即 UTF-8 字节）。

- 包内（`.nxt-extension` 的 `revision/assets/`）与 NekroNXT 保存的 Revision 目录存原始字节；内存中的 `resources` 仍是文本映射，PNG / WebP 的值是规范的标准 base64，SVG 是原文。`resourceBytes` / `resourceContent` 在两种表示之间转换，`resourceDigest` 按原始字节计算摘要。
- 校验：SVG 与页面 SVG 图标使用同一白名单；PNG / WebP 检查文件头，原始字节不超过 128 KiB，必须是边长 64–512 像素的正方形。
- 图标计入 `contentDigest` 与 `payloadDigest`；没有图标的包摘要与 0.1 版完全一致。

，可在 Node、浏览器与 Cloudflare Workers 中运行。本包以 MIT 许可发布；NekroNXT 其余代码仍为 AGPL-3.0-only。
