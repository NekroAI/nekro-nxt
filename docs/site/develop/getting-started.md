---
summary: 用 TypeScript 写一个给智能体用的工具扩展：目录结构、清单、源码、打包、导入和调试。
ui: [工坊 → 导入扩展, 日志]
routes: []
keywords: [写扩展, 开发扩展, 扩展开发, SDK, extension.json, defineHostExtension, 打包, nxt-extension, 导入, 调试, 示例]
---

# 写第一个扩展

扩展是一段 TypeScript，用 `@nekro-nxt/extension-sdk` 声明要注册的工具、页面或平台，能力由 NekroNXT 在运行时提供。这一页带你写一个掷骰子的工具：智能体在群里被要求“掷个 2d6”时调用它。

## 两种写法

- **让智能体写**：最快。在智能体的“能力”里打开动态创造，在频道里描述需求，见[让她自己做扩展](../extensions/dynamic-creation.md)。做好后可以在扩展详情里导出、发布，也可以让她接着改；
- **自己写**：照这一页。目前还没有独立的脚手架和命令行工具，最省事的办法是在[官方扩展仓库](https://github.com/NekroAI/nekro-nxt-extensions)里新建一个目录，用它的打包和测试工具。

需要 Node.js 22 或更新版本，以及 pnpm。

## 准备

```bash
git clone https://github.com/NekroAI/nekro-nxt-extensions.git
cd nekro-nxt-extensions
pnpm install
```

仓库里每个扩展一个目录，`extensions/dice` 就是本页例子的完整版本。新建 `extensions/my-dice/`：

```text
extensions/my-dice/
  extension.json   清单：身份、权限、配置、贡献
  src/host.ts      源码，只能是这一个文件，只导入 SDK
  tests/host.test.ts
  README.md        给使用者看的介绍，发布时用作社区介绍
```

## 清单

`extension.json` 声明扩展是谁、提供什么、要什么权限：

```json
{
  "id": "ext_01J0EXAMPLE0000000000000000",
  "slug": "my-dice",
  "displayName": "我的掷骰子",
  "description": "按骰子表达式掷骰，例如 2d6+1。",
  "createdAt": 1790000000000,
  "requires": { "sdk": 7 },
  "permissions": { "permissions": [], "networkOrigins": [] },
  "contributions": [
    {
      "kind": "tool",
      "name": "roll_dice",
      "description": "按骰子表达式掷骰并返回每颗骰子的点数和总和。",
      "verificationInput": { "expression": "2d6+1" }
    }
  ]
}
```

- `id` 是 `ext_` 加 26 位大写字母和数字，创建后永远不变；`slug` 只用小写字母、数字和连字符；
- `requires.sdk` 是需要的最低宿主能力等级，用到的接口要求更高等级时要跟着调高，见 [SDK 参考](sdk.md#能力等级)；
- `verificationInput` 是保存和导入时用来真实调用一次工具的输入，必须没有副作用；
- 这个工具不联网、不存数据，所以不申请任何权限。权限只申请用得到的，见 [SDK 参考](sdk.md#权限)。

## 源码

`src/host.ts`：

```ts
import { defineHostExtension } from '@nekro-nxt/extension-sdk'

interface RollArgs {
  readonly expression: string
}

type RollResult =
  | { readonly ok: true; readonly rolls: number[]; readonly total: number }
  | { readonly ok: false; readonly message: string }

const roll = (expression: string): RollResult => {
  const match = /^(\d{1,2})d(\d{1,3})([+-]\d{1,4})?$/u.exec(expression.replace(/\s+/gu, ''))
  if (match === null) return { ok: false, message: '骰子表达式要写成 2d6、1d20+3 这样。' }
  const rolls = Array.from({ length: Number(match[1]) }, () => 1 + Math.floor(Math.random() * Number(match[2])))
  return { ok: true, rolls, total: rolls.reduce((sum, value) => sum + value, 0) + Number(match[3] ?? 0) }
}

export default defineHostExtension(async ({ harness }) => ({
  inject: ['tools'],
  apply(ctx) {
    harness.registerTool(
      ctx,
      harness.defineTool<RollArgs, RollResult>({
        name: 'roll_dice',
        description: '按骰子表达式掷骰，返回每颗骰子的点数和总和。',
        parameters: {
          expression: { type: 'string', required: true, description: '骰子表达式，例如 3d6+2' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [
            { type: 'text', text: value.ok ? `${value.rolls.join(' + ')} = ${value.total}` : value.message },
          ],
        },
        execute: ({ expression }) => roll(expression),
      }),
    )
  },
}))
```

几条约定：

- `defineHostExtension` 的函数在这台机器上只执行一次（本机实例）；它返回的插件会挂到每个启用这个扩展的智能体上，工具在 `apply(ctx)` 里注册；
- 出错时返回 `{ ok: false, message }`，`message` 写给用户看的中文，不要抛异常；
- 源码只能是一个文件，只能导入 SDK。导入时 NekroNXT 会重新构建它；
- 工具描述和参数描述写清格式、范围和默认值，智能体靠它们决定怎么调用。

## 测试和打包

仓库带一个内存替身 `tools/testing.ts`，可以不启动 NekroNXT 直接调用工具：

```ts
import { createTestHost } from '../../../tools/testing.js'
import extension from '../src/host.js'

const host = await createTestHost(extension)
const { value } = await host.call('roll_dice', { expression: '2d6' })
```

```bash
pnpm release:prepare my-dice   # 内容变了以后生成新的版本记录 release.json
pnpm build                     # 打包到 dist/my-dice.nxt-extension
pnpm check                     # 目录清单、类型检查、单测和打包一起检查
```

每次改完源码都要先运行 `pnpm release:prepare`，否则打包会提示内容和 `release.json` 记录的版本不一致。新目录还要登记到仓库的扩展目录清单里，`pnpm check` 会指出缺了什么。

## 导入和试用

1. 在 NekroNXT 的「工坊」顶部点“导入扩展”，选择 `dist/my-dice.nxt-extension`，也可以直接把文件拖进工坊；
2. 导入时会做和保存一样的验证：用 `verificationInput` 真实调用每个工具，界面在各种密度和明暗主题下渲染一遍。失败会拒绝导入并说明原因；
3. 导入后不会自动启用。在扩展详情里为一个智能体启用；
4. 在她的频道里说“掷个 2d6”。

改了源码要再试时，重新打包、再导入一次，新的会成为同一个扩展的下一个版本，在扩展详情的“版本”里可以切换。

## 调试

- 在源码里用 `ctx.logger`（工具里）或 factory 参数里的 `logger` 写日志，在左侧导航底部的「日志」里按来源查看。调试级别的日志默认不保存，需要时在日志页临时开启；
- 工具每次调用的输入和结果，在频道里那一轮的运行记录里能看到；
- 不要在日志里记录聊天正文、提示词或凭据。

## 接下来

- [SDK 参考](sdk.md)：能调用的宿主能力、权限和配置；
- [发布到社区](publish.md)：发布流程和审查标准；
- 官方扩展仓库里还有带页面（`purchase-list`）、带配置和凭据（`web-search`）的完整例子。
