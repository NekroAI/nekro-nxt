# 贡献者入口

## 环境

- Node.js `^22.19.0 || >=24.0.0`；
- pnpm `11.28.9`；
- Git；
- 产品旅程需要 Playwright Chromium。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Web 默认监听 `http://127.0.0.1:4961`，并代理本地 Server `127.0.0.1:4960`。默认数据根是仓库根 `data/`。

## 从哪里读

根 [`AGENTS.md`](../../AGENTS.md) 保存项目边界。已知局部修复可直接读相关实现、测试和契约章节；未知来源从[公开索引](../README.md)、[Apps](../../apps/README.md) 或 [Packages](../../packages/README.md) 定位。前端按影响查术语、设计和交互模型，改变用户路径再查产品旅程；消息或 Adapter 变化核对对应消息契约。

## 验证

[开发规范的检查阶梯](../06-开发与测试规范.md#6-检查阶梯)是本地验证范围的唯一说明。局部修改用受影响测试，Web 修改运行生产构建下的相关旅程并查看真实画面；完整交付使用 `pnpm verify:product`，CI 保留全量检查。

`pnpm test:coverage` 是独立门禁，适用范围和阈值见[覆盖率门禁](../06-开发与测试规范.md#覆盖率门禁)。品牌资产使用 `pnpm brand:export` 生成，使用 `pnpm brand:check` 验证；公开构建不依赖本地私有资料。

## 提交

提交说明使用英文类型前缀和中文主题，格式为 `type(scope): 中文动词短语`。类型使用 `feat`、`fix`、`refactor`、`docs`、`test`、`merge`。测试、示例、截图和文档只使用虚构样本，不提交真实聊天、个人昵称、群标识、平台临时 URL、凭据或本机绝对路径。

完整流程见[参与贡献](../CONTRIBUTING.md)和[开发与测试规范](../06-开发与测试规范.md)。

准备公开 Release 或仓库可见性时，使用[仓库公开检查清单](publication-checklist.md)。
