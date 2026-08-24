# Glin UI 隔离实验

本分支在独立 worktree 中验证 Glin UI 视觉体系，不改变 NekroNXT 的对象模型、用户路径、组件行为或生产默认配置。

## 实验边界

- Web 使用 `@glinui/tokens` 的玻璃层级、圆角、阴影与动效曲线；
- NekroNXT 的语义 Token 作为稳定适配层，现有 UI Kit API、Radix 弹层策略、Presence、拖拽、频道滚动与 Composer 状态保持不变；
- 持续滚动的消息区和对象列表只使用半透明颜色。高成本 backdrop blur 集中在 Shell、Composer、Popover、Tooltip 和 Dialog；
- 不使用 Glin 的 Canvas 液态折射 Hook，避免 ResizeObserver 与位移图生成进入高频聊天渲染路径；
- `data-reduced-transparency`、`data-reduced-motion`、系统深浅主题和增强对比继续生效。

## 客户端窗口衔接

48px Renderer 顶栏是无系统标题栏窗口的连续上盖，最外层窗口圆角由 macOS、Windows 和 Linux 宿主负责。顶栏内的品牌与实验标识使用轻量玻璃胶囊；图标轨、对象列和主画布从顶栏下沿连续向下，顶部不重复收圆，只在窗口主体底部形成 18px 外轮廓。控件、列表选择、面板与 Dialog 分别使用 10px、12px、16px 与 20px 半径，避免相邻表面出现无意义的弧度跳变。

## 隔离运行

实验入口固定使用独立端口和数据目录：

```sh
pnpm dev:glin
```

| 资源 | 实验值 |
|---|---|
| Server / API | `http://127.0.0.1:5960` |
| Vite Web | `http://127.0.0.1:5961` |
| 数据根 | worktree 内 `.local/glin-experiment-data/` |

`dev:glin` 显式设置 `NEKRO_DATA`、`NEKRO_PORT`、`NEKRO_API_PROXY` 和 `NEKRO_WEB_PORT`。Vite 保持 `strictPort: true`，任一端口被占用时启动失败，不自动接管其他实例。

## 验收

实验使用生产 bundle 产品旅程检查一级路由、三种桌面视口、双主题、减少动效、减少透明、Composer 多行几何、消息方向、末条消息可见性、弹层和严重无障碍问题。视觉验收读取真实 Chromium 截图，不以 DOM 命中或构建成功代替画面判断。
