# NekroNXT 品牌资产

本目录保存公开构建能够独立消费和验证的 NekroNXT 品牌母版。项目 Logo 采用水月荧头像章；角色不是产品中的默认智能体，也不用于频道消息、智能体头像或运行状态。

## 目录

- `sources/`：经确认的高分辨率输入。源图不含提示词、文件路径或生成器元数据；
- `generated/logo/`：主标、微型标、单色标、矢量追踪版和横向组合标；
- `generated/platform/`：Stable/Preview 应用图标、Web 小图标及安装器 SVG；
- `generated/process/`：安装、升级、备份和恢复流程的 12 个装饰性 SVG；
- `generated/status/`：安装过程的 6 个状态 SVG；
- `generated/distribution/`：GitHub、社交分享和 Release 卡片；
- `exports/`：由导出器生成的 PNG、ICO、ICNS 和 BMP；
- [`raster/`](raster/README.md)：README、安装文档和产品场景插画；
- [`screenshots/`](screenshots/README.md)：生产产品旅程生成、只含虚构数据的真实界面截图；
- [`release-images/`](release-images/README.md)：当前正式发布专用、发布后可清理的临时配图；
- `manifest.json`：用途、源文件、格式、尺寸、SHA-256 与版权类别。

产品实际消费物位于 `apps/web/public/` 与 `apps/desktop/resources/`。这些目录不是另一套母版，必须通过根命令同步：

```bash
pnpm brand:export
pnpm brand:check
```

`brand:export` 会先从确认后的头像源生成 SVG，再导出平台位图并同步消费者。`brand:check` 只读验证必需文件、SVG viewBox、PNG 尺寸和元数据、ICO 帧、BMP 位深、导出哈希及消费者一致性；所有平台都会解析 ICNS 的十个标准 chunk（包括 native 16/32 的 ARGB-RLE），逐帧与来源 SVG 的新鲜栅格结果比较。在 macOS 上还会用 `iconutil` 再解码十帧，检查原生工具看到的尺寸、alpha bounds 与非透明覆盖率。DMG 检查直接扫描 `660 × 420` PNG 像素，`y>356` 只允许珍珠背景色。

## 视觉规则

- 产品名写作 `NekroNXT`，受限空间可写 `NXT`；
- Stable 使用主头像章，Preview 只增加黄铜—流明蓝—黄铜三节点校准标记；
- 16–32px 使用微型输入，64px 以上使用主输入；
- macOS ICNS 的 128px 以上帧消费 `app-icon-macos-stable.svg` / `app-icon-macos-preview.svg`：1024 画布使用不透明深靛满版底，由 macOS 施加最终系统遮罩，不预绘外层圆角框；头像章以中心保持的 `1.16` 倍放大。逻辑 16px 与 32px 帧分别消费 `app-icon-macos-micro-16-*` / `app-icon-macos-micro-32-*`，两者减少色阶与细碎线条，并为 Preview 使用专门放大的三节点标记；对应 @2x 帧继续使用同一逻辑尺寸母版。Windows、Linux 与 Web 继续消费原通用图标母版；
- 月潮靛、流明蓝和黄铜只承担品牌识别，成功、警告和失败继续使用产品语义色；
- 安装与过程图标是 64px 装饰素材；日常按钮、菜单和状态仍使用产品 ui-kit 与 Lucide；
- DMG Finder 窗口固定为 `660 × 420`，应用与 Applications 保持在 `(190, 220)` / `(470, 220)`；首次打开按约 `660 × 360` 的可见安全区设计，必要文案、通道标记和装饰轨迹都不越过 `y=356`，无需向下拖动窗口；背景不预绘应用或 Applications 图标，避免与 Finder 叠加资源重影。

## 权利

本目录中的 Logo、角色和宣传素材不属于项目软件许可证的授权范围，使用边界见 [`docs/BRAND.md`](../../docs/BRAND.md)。
