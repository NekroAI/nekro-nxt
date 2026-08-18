# Apps

- `server`：生产 DSH Host roster、真实 Agent Loop、Episode handoff 与 Channel Runtime 适配层；
- `web`：NekroNxt Shell、DSH Settings 通用 Schema 表单和 DSH Client/Slot 原生界面兼容岛；动态创造与原生设置共享一个 Client ModuleSystem，但按产品表面使用独立 Cordis Context/SlotRegistry，避免 DSH 单一 `root` Slot 互相遮蔽。

Desktop 在 M7 进入；Server 与 Web 复用同一 Core 契约，不创建第二套领域实现。
