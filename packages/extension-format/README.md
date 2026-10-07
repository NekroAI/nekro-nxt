# 扩展包格式

`@nekro-nxt/extension-format` 定义 NekroNXT 扩展的分享格式：`.nxt-extension` 传输包的结构与完整性校验、Manifest V6 扩展清单，以及 Revision 内容摘要（`contentDigest` / `payloadDigest`）。NekroNXT 导入、保存与社区发布前的校验共用这一份实现，因此社区接受的包一定能被 NekroNXT 安装。

- `verifyExtensionPackage(bytes)`：与 NekroNXT 导入相同的完整校验，返回传输清单与校验后的 Revision；
- `parseExtensionImport(bytes)`：只做包结构、文件清单与文件摘要校验；
- `materializeImportedRevision(...)` / `revisionDigests(...)`：校验清单、源码与资源并计算摘要；
- `extensionManifestSchema` 及各贡献 Schema：扩展清单结构。

实现不依赖 Node 专有 API，可在 Node、浏览器与 Cloudflare Workers 中运行。本包以 MIT 许可发布；NekroNXT 其余代码仍为 AGPL-3.0-only。
