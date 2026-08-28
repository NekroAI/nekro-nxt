# 参与贡献

感谢你帮助改进 NekroNXT。当前项目处于早期预览阶段，优先接受能补齐用户流程、修复可靠性问题、改善文档或扩展兼容性的改动。

## 提交问题前

- 使用最新预览版或当前 `main` 复现；
- 搜索现有 Issue；
- 删除 API Key、真实聊天、账号、群标识、平台临时 URL、文件哈希和本机路径；
- 安全漏洞不要创建公开 Issue，按[安全策略](SECURITY.md)私密报告。

## 开发

```bash
pnpm install --frozen-lockfile
pnpm dev
```

开始修改前阅读 [`AGENTS.md`](../AGENTS.md)，再从[文档入口](README.md)进入对应产品、协议、Decision 和包 README。面向用户只使用“智能体”；内部类型可以保留 `AgentDefinition` 等 DSH/TypeScript 术语。

## 修改原则

- 一个事实只有一个权威文档，行为变化与文档在同一改动中更新；
- 不复制 DSH 内核，优先使用公开 API、Plugin、Service、Tool、Provider、Settings、Scope、Bundle 和 Preset；
- 状态只在真实提交点发布，注册可撤销，dispose 等待资源静止；
- 测试和截图只使用虚构样本；
- 用户可见操作必须有真实结果，未开放能力明确禁用并标注；
- 品牌资产只通过 `assets/brand/` 母版和导出器修改，角色不作为默认智能体或消息发送者。

## 验证

至少运行与改动相关的最窄检查。提交前的完整入口是：

```bash
pnpm check
pnpm test
pnpm test:coverage
pnpm build
pnpm test:journey
```

`pnpm test:coverage` 不包含在 `check` 或 `test` 中，统计范围和阈值以[开发与测试规范](06-开发与测试规范.md#覆盖率门禁)为准。用户可见 Web 改动必须补充生产构建产品旅程和真实像素视觉验收；平台安装资源还需运行 `pnpm brand:check` 并检查真实安装器画面。

## Pull Request

仓库会自动加载 [Pull Request 模板](../.github/PULL_REQUEST_TEMPLATE.md)；请保留其中的变更、验证和公开边界检查项。

- 标题和提交说明使用英文类型前缀和中文主题，格式为 `type(scope): 中文动词短语`；类型使用 `feat`、`fix`、`refactor`、`docs`、`test`、`merge`；
- 说明用户可观察到的结果、验证命令和文档更新；
- UI 改动附浅色/深色真实截图；
- 不混入无关格式化、重命名或生成文件；
- 外部贡献通过 PR 和 CI，维护者在合并前可能要求拆分范围。

提交代码表示你确认有权按项目采用的 `AGPL-3.0-only` 许可证贡献该内容。仓库可见性由维护者另行决定。
