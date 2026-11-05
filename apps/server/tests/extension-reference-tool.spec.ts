import { renderNekroNxtExtensionReferenceTopic } from '@nekro-nxt/extension-sdk'
import { describe, expect, it } from 'vitest'
import { EXTENSION_REFERENCE_TOOL, extensionReferenceTool } from '../src/extension-reference-tool.ts'
import { EXTENSION_DEVELOPMENT_TOOLS } from '../src/extension-capability-packs.ts'

const read = async (topics: unknown): Promise<unknown> =>
  await extensionReferenceTool().execute(
    { topics },
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- The tool reads nothing from its run context.
    {} as Parameters<ReturnType<typeof extensionReferenceTool>['execute']>[1],
  )

describe('nekro_nxt_extension_reference', () => {
  it('belongs to the extension development pack', () => {
    expect(extensionReferenceTool().name).toBe(EXTENSION_REFERENCE_TOOL)
    expect(EXTENSION_DEVELOPMENT_TOOLS).toContain(EXTENSION_REFERENCE_TOOL)
  })

  it('returns the requested topics once each, by id or title', async () => {
    const text = await read(['config', '面板、工具视图与界面组件', 'config'])
    expect(text).toBe(
      [renderNekroNxtExtensionReferenceTopic('ui'), renderNekroNxtExtensionReferenceTopic('config')].join('\n\n'),
    )
    expect(text).toContain('ctx.toolViews.register(')
    expect(text).toContain('页面背景、安全边距与根滚动')
  })

  it('lists the topics it has when one is unknown', async () => {
    await expect(read(['tools', 'weather'])).rejects.toThrow(
      /没有「weather」这个主题。可以读的有：tools（工具与 RPC）、/u,
    )
  })
})
