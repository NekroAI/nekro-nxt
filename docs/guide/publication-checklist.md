# 仓库公开检查清单

本清单只定义公开前门禁，不修改 GitHub 仓库可见性。仓库所有者决定实际公开时间。

## 必须完成

- [x] 提交 GNU AGPL v3.0 代码许可证，并将 `AGPL-3.0-only` 同步到所有 workspace `package.json`；
- [ ] `pnpm check`、`pnpm test`、`pnpm build`、`pnpm test:journey` 全部通过；
- [ ] `pnpm brand:check` 通过，Stable/Preview 小尺寸图标和真实安装器画面完成验收；
- [ ] 使用固定版本 Gitleaks 或等效工具扫描完整 Git 历史；
- [ ] 人工检查图片、压缩包、数据库、日志和二进制元数据；
- [ ] 在全新目录检出待公开 commit，确认构建和文档不依赖 `.local`；
- [ ] 从 README 走通桌面版、服务端、模型配置、创建智能体和排障入口；
- [ ] 确认 `ghcr.io/nekroai/nekro-nxt:preview` 可以在未登录 GitHub 的环境中拉取和启动；
- [ ] Release、内部 receipt、README 和用户文档不存在失效链接或未实现承诺。

## GitHub About

- Description：`连接多平台即时通信，让智能体参与真实多人群聊的 DSH 驱动系统`；
- Homepage：没有正式站点时留空，不填写临时地址；
- Topics：`ai-agents`、`chat`、`dsh`、`electron`、`llm`、`multi-platform`、`typescript`、`pnpm`；
- Social preview：`assets/brand/exports/distribution/github-social-preview.png`；
- Issues：开启；Wiki、Discussions：暂不启用。

## 公开时设置

1. 启用 Private Vulnerability Reporting；
2. 应用 About 描述、Topics 与社交预览；
3. 创建针对 `main` 的 ruleset：外部贡献必须使用 Pull Request，并要求现有 `all-checks-passed`；
4. 为维护者保留与仓库当前直接在 `main` 开发规则兼容的受控 bypass；
5. 确认 `docs/SECURITY.md` 中的私密报告链接可以使用；
6. 再切换仓库可见性。

公开后发现凭据或真实数据进入历史时，应先轮换凭据并清理远端历史，不能只追加删除提交。
