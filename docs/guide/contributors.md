# 贡献者入口

## 环境

- Node.js `^22.19.0 || >=24.0.0`；
- pnpm `11.7.0`；
- Git；
- 产品旅程需要 Playwright Chromium。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Web 默认监听 `http://127.0.0.1:4961`，并代理本地 Server `127.0.0.1:4960`。默认数据根是仓库根 `data/`。

## 从哪里读

1. 根 `AGENTS.md`：产品铁律、术语、生命周期和完成条件；
2. `docs/README.md`：公开知识路由；
3. `apps/README.md` 或 `packages/README.md`：代码所有者与消费者；
4. 对应协议、Decision 和包 README。

前端改动还需阅读术语、桌面 UI、界面交互模型和产品旅程文档。消息、Channel 或 Adapter 改动需阅读消息投递协议和对应 Decision。

## 验证

```bash
pnpm check
pnpm test
pnpm build
pnpm test:journey
```

用户可见 Web 改动必须完成生产构建产品旅程和真实像素视觉验收。品牌资产使用 `pnpm brand:export` 生成，使用 `pnpm brand:check` 验证；公开构建不得依赖 `.local`。

## 提交

提交说明使用英文类型前缀和中文主题，格式为 `type(scope): 中文动词短语`。类型使用 `feat`、`fix`、`refactor`、`docs`、`test`、`merge`。测试、示例、截图和文档只使用虚构样本，不提交真实聊天、个人昵称、群标识、平台临时 URL、凭据或本机绝对路径。

完整流程见[参与贡献](../CONTRIBUTING.md)和[开发与测试规范](../06-开发与测试规范.md)。

准备公开 Release 或仓库可见性时，使用[仓库公开检查清单](publication-checklist.md)。
