# DSH compatibility

本包拥有 DSH 精确发布矩阵、运行环境身份和公开接口兼容探针。Server、Web、Extension Builder 与 SDK 消费同一清单；各宿主仍自行声明并装配真实使用的公开 DSH 包，不由本包间接安装整套 Runtime。

## 发布矩阵与兼容性身份

唯一机器可读来源是 `src/release.json`，TypeScript 消费者从 `@nekro-nxt/dsh-compat/release` 读取 `DSH_RUNTIME_RELEASE`、`DSH_RUNTIME_FINGERPRINT` 和 `expectedDshPackageVersion()`。当前目标为：

| 项目                     | 值                    | 含义                                 |
| ------------------------ | --------------------- | ------------------------------------ |
| DSH                      | `0.1.7-rc.2`          | Host 与 Client 的精确发布族          |
| Cordis / Loader          | `4.0.4` / `1.0.5`     | 与该发布族配套的公开装配接口         |
| `sessionCompatibilityId` | `jsonl-v4`            | 会话数据兼容边界，不等于产品 Release |
| `settingsFormatVersion`  | `2`                   | NXT Host Profile 配置格式            |
| `extensionRuntimeAbi`    | `nxt-extension-dsh-2` | 扩展运行接口与缓存兼容边界           |
| `exceptions`             | 空                    | 当前没有保留旧 Client 包例外         |

运行环境指纹由上述版本、兼容标识及排序后的包矩阵确定性生成，浏览器也可消费；各缓存所有者按需要再计算摘要。普通 Release 或依赖 patch 更新不会仅因版本号变化而重置会话。改变兼容标识时必须同时实现对应所有者的迁移或明确重置路径，不能只改清单。

`packages` 中每个包必须有 workspace 消费者。禁止从相邻源码仓库解析依赖、安装浮动 dist-tag、导入 DSH 私有路径，或在业务包中维护另一套版本判断。

## Host 与 Client 接入边界

`./client` 只运行时导出标准 ESM 的 `SlotCore`，并从公开 `dsh-client-ui-renderer/client` 导出必要类型。渲染器的 `./client` 是供 DSH Client ModuleSystem 加载的注册 bundle，不是普通 Vite ESM。

Web 用同一 ModuleSystem 加载公开渲染器 `apply`，由其创建 SlotRegistry 并安装渲染器；不调用 `uiRenderer.mount()`。NXT 保留自己的 React 根、产品 Slot 与权限，React、React DOM、Cordis 和 Slot Core 保持单实例。旧 `client-runtime`、`client-web-react`、`client-schema-form` 已退出接入；通用设置表单使用 NXT 的数据解码和公开 Schemastery 校验，不执行 Schema 中的序列化回调。

Base/Web Bundle 仅用于开发期公开组合探针，不能被误认为生产 roster。Session 日志编码、锁和恢复由上游 JSONL Provider 拥有；NXT 的产品数据重置由 Core 所有者提交。

## 检查工具

- `pnpm dsh:check-update`：只读查询 GitHub `dsh-v*` Release、npm dist-tag 与当前锁定版本。网络失败不阻断离线构建；普通接缝修复无需例行联网查询。
- `pnpm dsh:plan-upgrade --target <精确版本>`：只读报告包是否发布、当前和目标 peer/exports 差异、消费者及同步入口；缺包或缺少基线元数据以非零状态退出。它不安装依赖，也不能替代 API 行为审查。
- `pnpm check:dsh-family`：离线核对清单、workspace 声明、lockfile、实际可解析的依赖图、Host roster、SDK 版本来源与 Client bundle；不把不可达的旧 pnpm 缓存误判为当前混装。
- `pnpm test:upgrade`：当前聚合升级协调器、完整恢复点和旧 Session 存储测试。Core 重置、配置、隔离、Desktop 与浏览器仍需各自检查，不能把这个命令等同于完整产品验收。

升级操作顺序与验收要求见 [DSH 升级维护指南](../../docs/dsh-upgrade.md)；数据布局、归档和宿主恢复由 [Server](../../apps/server/README.md) 维护。
