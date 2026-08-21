# Apps

- `desktop`：启动同包 Server 生产入口并加载同包 Web dist 的 Electron 完整本地宿主；
- `server`：生产 DSH Host roster、真实 Agent Loop、Episode handoff 与 Channel Runtime 适配层；
- `web`：NekroNxt Shell、DSH Settings 通用 Schema 表单和 DSH Client/Slot 原生界面兼容岛；动态创造与原生设置共享一个 Client ModuleSystem，但按产品表面使用独立 Cordis Context/SlotRegistry，避免 DSH 单一 `root` Slot 互相遮蔽。

Desktop、Server 与 Web 使用原子 Product Release：不独立投放 UI，Desktop 启动同包 Server，Server 容器打包同包 Web dist；两种宿主复用同一 Core 契约，不创建第二套领域实现。发布边界见 `../docs/decisions/accepted/2026-08-21-原子产品Release与双宿主分发.md`。
