# 扩展包格式

`@nekro-nxt/extension-format` 定义 NekroNXT 扩展的分享格式：`.nxt-extension` 传输包（v2）的结构与完整性校验、Manifest V7 扩展清单，以及 Revision 内容摘要（`contentDigest` / `payloadDigest`）。NekroNXT 导入、保存与社区发布前的校验共用这一份实现，因此社区接受的包一定能被 NekroNXT 安装。

- `verifyExtensionPackage(bytes)`：与 NekroNXT 导入相同的完整校验，返回传输清单与校验后的 Revision；
- `parseExtensionImport(bytes)`：只做包结构、文件清单与文件摘要校验；
- `materializeImportedRevision(...)` / `revisionDigests(...)`：校验清单、源码与资源并计算摘要；
- `extensionManifestSchema` 及各贡献 Schema：扩展清单结构；`hasAgentLayer`、`extensionProvides`、`contributionLayer`、`layerConfigSchema`、`manifestAdapter` 读出一个扩展的两层结构（本机实例与智能体挂载）与「提供什么」标签。

Manifest V7 与传输包 v2 没有 `scope`：贡献归属由种类决定，见[扩展形态统一](../../docs/decisions/accepted/2026-10-09-扩展形态统一.md)。Manifest V6 及更早、传输包 v1 不再读取，统一抛出 `LEGACY_EXTENSION_MESSAGE`（提示从社区获取新版或让智能体重新创造）。

## 版本谱系与数据版本（SDK 10）

Manifest 可选字段 `lineage: { parent, ancestry, branchOf? }` 记录这个版本接在哪个版本之后：`parent` 是上一个版本（第一个版本为 `null`），`ancestry` 是更早的版本，从近到远、最多 256 个，`ancestry[0]` 必须等于 `parent`，不能包含自身或重复；分支的第一个版本 `parent` 为 `null`，`branchOf: { extensionId, revisionId }` 指向它分支自的版本。`lineage` 计入 `contentDigest`、不计入 `payloadDigest`，同样内容在不同历史上的两个版本载荷摘要相同。

可选字段 `dataVersion`（正整数，默认 1）是扩展存储数据的格式版本，计入 `payloadDigest`。带 `lineage`、`dataVersion` 或管理员级命令的清单必须声明 `requires.sdk >= 10`。

`lineageAfter`、`lineageOfBranch`、`lineageDepth`（版本号）、`lineageRelation`（同一版本、本机领先、远端领先、两边分叉或无关）与 `isFastForward` 实现谱系计算；`summarizePermissions`、`combinationFindings`、`highestPermissionLevel`、`addedPermissionItems` 是与社区审查共用的权限风险分级。

## 扩展图标

Manifest 可选字段 `icon: { path, sha256 }` 声明扩展自身的图标，`path` 只能是 `assets/icon.svg`、`assets/icon.png`、`assets/icon.webp` 之一，`sha256` 是图标文件原始字节的 SHA-256（SVG 即 UTF-8 字节）。

- 包内（`.nxt-extension` 的 `revision/assets/`）与 NekroNXT 保存的 Revision 目录存原始字节；内存中的 `resources` 仍是文本映射，PNG / WebP 的值是规范的标准 base64，SVG 是原文。`resourceBytes` / `resourceContent` 在两种表示之间转换，`resourceDigest` 按原始字节计算摘要。
- 校验：SVG 与页面 SVG 图标使用同一白名单；PNG / WebP 检查文件头，原始字节不超过 128 KiB，必须是边长 64–512 像素的正方形。
- 图标计入 `contentDigest` 与 `payloadDigest`；没有图标的包摘要与 0.1 版完全一致。

，可在 Node、浏览器与 Cloudflare Workers 中运行。本包以 MIT 许可发布；NekroNXT 其余代码仍为 AGPL-3.0-only。
