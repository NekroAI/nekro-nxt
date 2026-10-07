# @nekro-nxt/extension-sdk

NekroNXT 扩展开发 SDK：扩展入口工厂 `defineHostExtension` / `defineClientExtension`，以及宿主注入能力（`ctx.nxt`）、工具、面板、页面与适配器的类型。

```ts
import { defineHostExtension } from '@nekro-nxt/extension-sdk'

export default defineHostExtension(async ({ harness }) => ({
  inject: ['tools'],
  apply(ctx) {
    harness.registerTool(
      ctx,
      harness.defineTool({
        name: 'roll_dice',
        description: '掷骰子，返回每颗骰子的点数与总和',
        // 每个参数名对应一个 Schema；必填参数写 required: true。
        parameters: {
          sides: { type: 'integer', description: '骰子面数，2 到 1000，默认 6' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: ({ sides }) => ({ value: 1 + Math.floor(Math.random() * (typeof sides === 'number' ? sides : 6)) }),
      }),
    )
  },
}))
```

扩展在 NekroNXT 导入时由宿主重新构建，`@nekro-nxt/extension-sdk` 的导入会被替换为宿主提供的同一实现；本包用于在扩展仓库中开发与类型检查。打包为 `.nxt-extension` 请使用 [`@nekro-nxt/extension-format`](https://www.npmjs.com/package/@nekro-nxt/extension-format)。

能力说明、权限声明与编写约定见 [NekroNXT 扩展文档](https://github.com/NekroAI/nekro-nxt/blob/main/packages/extension-sdk/README.md)，官方示范扩展见 [nekro-nxt-extensions](https://github.com/NekroAI/nekro-nxt-extensions)。

本包以 MIT 许可发布；NekroNXT 其余代码仍为 AGPL-3.0-only。
