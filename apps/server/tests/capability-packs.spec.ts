/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- The run_code runtime and conversation fixtures supply only the fields the code under test reads. */
import { Context } from '@deepseek-ai/cordis'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, renderToolsSdk } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import {
  capabilityCatalogText,
  capabilityGuardMessage,
  capabilityLoadState,
  mountCapabilityPacks,
  sdkDeclarations,
  visibleSdkSchemas,
  type LoadStateAgent,
} from '../src/capability-packs.ts'
import {
  EXTENSION_DEVELOPMENT_PACK,
  EXTENSION_MANAGEMENT_PACK,
  extensionCapabilityPacks,
} from '../src/extension-capability-packs.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()))
})

const fixtureTool = (name: string, description: string) =>
  defineTool({
    name,
    description,
    parameters: { query: { type: 'string', required: true, description: `${name} 的查询内容。` } },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: () => Promise.resolve({ ok: true }),
  })

/** A run_code deployment as DSH sees it globally: three tools, one of them in a pack. */
const programmaticContext = async () => {
  const context = new Context()
  contexts.push(context)
  await context.plugin(SystemPrompt, { personaPrefix: '', includeHarnessIdentity: false })
  context.provide('ptcRuntime', { language: 'typescript' } as never)
  await context.plugin(ToolRuntime, { mode: 'ptc' })
  context.tools.register(fixtureTool('fixture_chat', '在频道里说话。'))
  context.tools.register(fixtureTool('fixture_list', '列出虚构的扩展。'))
  context.tools.register(fixtureTool('fixture_define', '定义虚构的候选。'))
  return context
}

const sdkText = async (context: Context): Promise<string> =>
  (await context.systemPrompt.assemble({})).sections.find((section) => section.name === 'tools:sdk')?.text ?? ''

describe('capability pack declarations', () => {
  it('renders the same SDK text as DSH when no pack hides anything', async () => {
    const context = await programmaticContext()
    const dsh = await sdkText(context)
    expect(dsh).toContain('fixture_list')
    expect(renderToolsSdk(visibleSdkSchemas(context.tools, undefined))).toBe(dsh)
    mountCapabilityPacks(context, { packs: [], presentation: 'ptc', rootSessionId: 'fixture-root' })
    expect(await sdkText(context)).toBe(dsh)
  })

  it('leaves pack tools out of the SDK text, stable across assemblies', async () => {
    const context = await programmaticContext()
    mountCapabilityPacks(context, {
      packs: [{ name: '虚构管理', purpose: '管理虚构的扩展。', tools: ['fixture_list'] }],
      presentation: 'ptc',
      rootSessionId: 'fixture-root',
    })
    const text = await sdkText(context)
    expect(text).not.toContain('fixture_list')
    expect(text).toContain('fixture_chat')
    expect(text).toContain('fixture_define')
    expect(text).toContain('capability_load')
    expect(text).toBe(
      renderToolsSdk(visibleSdkSchemas(context.tools, undefined).filter((schema) => schema.name !== 'fixture_list')),
    )
    expect(await sdkText(context)).toBe(text)
  })

  it('hands over only the two declaration interfaces of a pack', async () => {
    const context = await programmaticContext()
    const schemas = visibleSdkSchemas(context.tools, undefined).filter((schema) => schema.name === 'fixture_list')
    const declarations = sdkDeclarations(schemas)
    expect(declarations.startsWith('```ts\ninterface ToolArgsMap {')).toBe(true)
    expect(declarations).toContain('fixture_list: {')
    expect(declarations).toContain('interface ToolOutputMap {')
    expect(declarations).not.toContain('fixture_chat')
    expect(declarations).not.toContain('declare const tools')
    expect(declarations).not.toContain('Writing code for run_code')
  })
})

/** A conversation as load state reads it: a log whose visible part can shrink. */
const fixtureAgent = () => {
  const events = new Map<number, unknown>()
  let seq = 0
  const nodes: SessionSeq[] = []
  const agent = {
    session: {
      get seq() {
        return SessionSeq(seq)
      },
      surface: { nodes },
      eventAt: (at: SessionSeq) => events.get(Number(at)),
    },
  }
  return {
    agent: agent as unknown as LoadStateAgent,
    deliver(packs: string[]) {
      events.set(seq, { type: 'user/message', data: { source: { kind: 'nekro-nxt-capability-pack', packs } } })
      nodes.push(SessionSeq(seq))
      seq += 1
    },
    compact() {
      nodes.splice(0)
      seq += 1
    },
  }
}

describe('capability pack load state', () => {
  it('keeps each conversation, a sub-conversation too, on its own state', () => {
    const state = capabilityLoadState()
    const root = fixtureAgent()
    const child = fixtureAgent()
    state.loading(root.agent, ['扩展管理'])
    expect(state.isLoaded(root.agent, '扩展管理')).toBe(true)
    expect(state.isLoaded(child.agent, '扩展管理')).toBe(false)
    root.deliver(['扩展管理'])
    state.stepStarted(root.agent)
    expect(state.isLoaded(root.agent, '扩展管理')).toBe(true)
    expect(state.isLoaded(child.agent, '扩展管理')).toBe(false)
  })

  it('unloads a pack whose delivery the model no longer reads', () => {
    const state = capabilityLoadState()
    const root = fixtureAgent()
    state.loading(root.agent, ['扩展开发'])
    state.stepStarted(root.agent)
    // The call failed before its delivery reached the log.
    expect(state.isLoaded(root.agent, '扩展开发')).toBe(false)
    root.deliver(['扩展开发'])
    expect(state.isLoaded(root.agent, '扩展开发')).toBe(true)
    root.compact()
    expect(state.isLoaded(root.agent, '扩展开发')).toBe(false)
  })
})

describe('extension capability packs', () => {
  const byName = (packs: ReturnType<typeof extensionCapabilityPacks>) =>
    Object.fromEntries(packs.map((pack) => [pack.name, pack.tools]))

  it('gives agents without dynamic creation management but not development', () => {
    const packs = byName(extensionCapabilityPacks({ dynamicCreation: false, extensionAutonomy: 'confirm' }))
    expect(Object.keys(packs)).toEqual([EXTENSION_MANAGEMENT_PACK])
    expect(packs[EXTENSION_MANAGEMENT_PACK]).toEqual(
      expect.arrayContaining([
        'nekro_nxt_extension_list',
        'nekro_nxt_extension_inspect',
        'nekro_nxt_extension_action',
        'nekro_nxt_credential_list',
        'nekro_nxt_credential_request',
        'nekro_nxt_extension_request_withdraw',
      ]),
    )
  })

  it('keeps management read-only under manual autonomy', () => {
    const viewOnly = extensionCapabilityPacks({ dynamicCreation: false, extensionAutonomy: 'manual' })
    expect(byName(viewOnly)).toEqual({
      [EXTENSION_MANAGEMENT_PACK]: ['nekro_nxt_extension_list', 'nekro_nxt_extension_inspect'],
    })
    expect(viewOnly[0]?.instructions).toContain('「手动」')
    // Developing still needs credential lookups for test values, so they move to the development pack.
    const developing = byName(extensionCapabilityPacks({ dynamicCreation: true, extensionAutonomy: 'manual' }))
    expect(developing[EXTENSION_MANAGEMENT_PACK]).not.toContain('nekro_nxt_extension_action')
    expect(developing[EXTENSION_DEVELOPMENT_PACK]).toEqual(
      expect.arrayContaining(['nekro_nxt_extension_define', 'cordis_run', 'nekro_nxt_credential_list']),
    )
  })

  it('keeps the development instructions short and points to the skill', () => {
    const development = extensionCapabilityPacks({ dynamicCreation: true, extensionAutonomy: 'autonomous' }).find(
      (pack) => pack.name === EXTENSION_DEVELOPMENT_PACK,
    )
    expect(development?.instructions?.length).toBeLessThanOrEqual(1500)
    expect(development?.instructions).toContain('cordis-plugin-development')
    expect(development?.tools).not.toContain('nekro_nxt_extension_action')
  })

  it('words the catalog and the refusal the way the agent reads them', () => {
    expect(capabilityGuardMessage('扩展开发')).toBe('这个工具在「扩展开发」能力包里，先调用 capability_load 加载。')
    const catalog = capabilityCatalogText([{ name: '扩展管理', purpose: '查看和管理已有扩展。' }])
    expect(catalog).toContain('- 扩展管理：查看和管理已有扩展。')
    expect(catalog).not.toContain('扩展开发')
  })
})
