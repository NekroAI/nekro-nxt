# 命令回声示例

构建整个工作区后，在仓库根目录执行：

```sh
pnpm --filter @nekro-nxt/server exec tsx examples/command-echo/build.ts
```

在工坊导入生成的 `.local/command-echo.nxt-extension`，给智能体启用。在绑定频道输入 `/echo "你好 世界" --count 2`；短名冲突时使用 `/ext_COMMANDDEMO:echo`。停用后补全与目录不再显示此扩展命令。重复导入相同版本保持原有导入去重语义；开发新版本时同时修改 Manifest 的 revisionId 与构建脚本中的版本号。

宿主导入验证器会在隔离环境中实际执行 factory、命令及清理；处理器只使用验证后的参数。此示例不需要模型、网络、私有文件或平台管理权限。契约见 [命令系统](../../../../docs/10-命令系统.md)。
