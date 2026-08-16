# Client migrations

该包拥有浏览器客户端持久状态的顺序 migration registry，并提供宿主升级步骤的最小协调器。它不访问 DOM、网络、数据库或具体存储，因而可以在 Web、Electron 和测试中使用同一套迁移语义。

Client 业务事实仍来自 Host；这里只迁移主题、布局、可恢复草稿等明确允许的客户端状态。Core SQLite、DSH Session 和 Extension 文件格式由各自所有者迁移，详细边界见 `../../docs/decisions/accepted/2026-08-16-客户端状态与数据迁移基础设施.md`。

## 验证

```sh
pnpm --filter @nekro-nxt/client-migrations test
pnpm --filter @nekro-nxt/client-migrations typecheck
```
