import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { defineTool, renderToolsSdk, type ToolRuntime } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'

/**
 * Capability packs (#133): tools an agent rarely needs stay registered for the whole session but out of the tool
 * declarations, until the agent loads their pack with `capability_load`. Loading hands the pack's instructions and
 * declarations to the conversation as a message, so the system prompt, and the cache behind it, stays the same.
 *
 * Under run_code the declarations live in DSH's `tools:sdk` section; the `system-prompt/assemble` waterfall renders
 * that section again with DSH's own `renderToolsSdk`, minus every pack tool, loaded or not. Calling a pack tool before
 * its pack is loaded is refused by a tool guard. With direct tool calls the request's tool list carries the
 * declarations, so pack tools join it once loaded; that is only cheap on routes that can add tools mid-conversation,
 * and the caller keeps every tool resident elsewhere.
 */
export interface CapabilityPack {
  /** Shown to the agent and passed back to `capability_load`, e.g. 「扩展管理」. */
  readonly name: string
  /** One line in the catalog. */
  readonly purpose: string
  readonly tools: readonly string[]
  /** Short working notes delivered with the declarations. */
  readonly instructions?: string
}

export const CAPABILITY_LOAD_TOOL = 'capability_load'

/** One system prompt section as last sent, for the inspector. */
export interface PromptSectionSize {
  readonly name: string
  readonly chars: number
}

export interface CapabilityPackView {
  /** Section sizes of the root conversation's latest system prompt, in prompt order. */
  promptSections(): readonly PromptSectionSize[]
  /** Packs the root conversation can load, and those it has loaded; undefined when this session uses no packs. */
  packs(): { readonly available: readonly string[]; readonly loaded: readonly string[] } | undefined
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'nekro-nxt-capability-catalog': {
      readonly kind: 'nekro-nxt-capability-catalog'
      readonly entries: readonly { readonly name: string; readonly purpose: string }[]
    }
    'nekro-nxt-capability-pack': { readonly kind: 'nekro-nxt-capability-pack'; readonly packs: readonly string[] }
  }
}

type SdkSchemas = Parameters<typeof renderToolsSdk>[0]
type Scope = Parameters<ToolRuntime['get']>[1]

/**
 * The schemas DSH renders into `tools:sdk` for one scope (its private `sdkSchemas`): every visible tool but run_code,
 * with its output schema. Rendering them with `renderToolsSdk` gives DSH's own section text.
 */
export const visibleSdkSchemas = (tools: ToolRuntime, scope: Scope): SdkSchemas =>
  tools.schemas(scope).flatMap((schema) => {
    if (schema.name === 'run_code') return []
    const definition = tools.get(schema.name, scope)
    return definition === undefined ? [] : [{ ...schema, output: structuredClone(definition.output.schema) }]
  })

/** The two interfaces of a rendered SDK; they merge with the ones in the system prompt. */
export const sdkDeclarations = (schemas: SdkSchemas): string => {
  const rendered = renderToolsSdk(schemas)
  const start = rendered.indexOf('interface ToolArgsMap')
  const end = rendered.indexOf('\ntype ToolName')
  return start < 0 || end < start ? rendered : `\`\`\`ts\n${rendered.slice(start, end).trimEnd()}\n\`\`\``
}

export const capabilityGuardMessage = (pack: string): string =>
  `这个工具在「${pack}」能力包里，先调用 ${CAPABILITY_LOAD_TOOL} 加载。`

export const capabilityCatalogText = (entries: readonly { readonly name: string; readonly purpose: string }[]) =>
  entries.length === 0
    ? '〔能力包〕现在没有可以加载的能力包，之前列出的已经不能用了。'
    : [
        `〔能力包〕下面这些能力的工具平时不在工具声明里。用到时先用 ${CAPABILITY_LOAD_TOOL} 加载对应的包，包的说明和工具声明会出现在对话里，之后就能调用。这份列表替换之前的列表。`,
        ...entries.map((entry) => `- ${entry.name}：${entry.purpose}`),
      ].join('\n')

/** Catalog identity: the entries as recorded, `{ name, purpose }` in order. */
const catalogDigest = (entries: unknown) => JSON.stringify(entries)

type SessionView = Pick<Agent['session'], 'surface' | 'eventAt' | 'seq'>

/** Packs whose delivery message is still in what the model reads; a compaction that drops it unloads the pack. */
const packsOnSurface = (session: SessionView): Set<string> => {
  const loaded = new Set<string>()
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message' || event.data.source.kind !== 'nekro-nxt-capability-pack') continue
    const packs: unknown = event.data.source.packs
    if (Array.isArray(packs)) for (const name of packs) if (typeof name === 'string') loaded.add(name)
  }
  return loaded
}

/** The latest catalog the model can still read, as its digest. */
const catalogOnSurface = (session: SessionView): string | undefined => {
  let digest: string | undefined
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message' || event.data.source.kind !== 'nekro-nxt-capability-catalog') continue
    const entries: unknown = event.data.source.entries
    if (Array.isArray(entries)) digest = catalogDigest(entries)
  }
  return digest
}

/** The part of an agent that load state reads: its log and what the model still sees of it. */
export type LoadStateAgent = { readonly session: SessionView }

/**
 * Which packs each conversation has loaded. A pack counts as loaded while its delivery message is still in what the
 * model reads, so a compaction that drops the message unloads it and a resumed session keeps it. Between the load and
 * the next step the message is not appended yet, so the pack counts as loaded from the call itself until then. Every
 * conversation, a sub-conversation too, has its own state.
 */
export const capabilityLoadState = () => {
  const pending = new WeakMap<LoadStateAgent, Set<string>>()
  const surfaceCache = new WeakMap<LoadStateAgent, { readonly seq: number; readonly loaded: Set<string> }>()
  return {
    loading: (agent: LoadStateAgent, names: readonly string[]): void => {
      const marked = pending.get(agent) ?? new Set<string>()
      for (const name of names) marked.add(name)
      pending.set(agent, marked)
    },
    stepStarted: (agent: LoadStateAgent): void => {
      pending.delete(agent)
    },
    isLoaded: (agent: LoadStateAgent, pack: string): boolean => {
      if (pending.get(agent)?.has(pack) === true) return true
      const seq = Number(agent.session.seq)
      let cached = surfaceCache.get(agent)
      if (cached?.seq !== seq) {
        cached = { seq, loaded: packsOnSurface(agent.session) }
        surfaceCache.set(agent, cached)
      }
      return cached.loaded.has(pack)
    },
  }
}

export const mountCapabilityPacks = (
  context: Context,
  options: {
    /** Empty mounts only the inspector's measurement. */
    readonly packs: readonly CapabilityPack[]
    readonly presentation: 'ptc' | 'native'
    readonly rootSessionId: string
    /** Told the packs any conversation of the session loads, so the next session's handoff can mention them. */
    readonly onLoad?: (packs: readonly string[]) => void
  },
): CapabilityPackView => {
  const tools = context.tools
  const packs = options.packs.filter((pack) => pack.tools.length > 0)
  const packOf = new Map<string, CapabilityPack>()
  for (const pack of packs) for (const name of pack.tools) if (!packOf.has(name)) packOf.set(name, pack)
  let sections: readonly PromptSectionSize[] = []
  let root: Agent | undefined

  const loadState = capabilityLoadState()
  const isLoaded = loadState.isLoaded
  const availableFor = (scope: Scope): CapabilityPack[] =>
    tools.get(CAPABILITY_LOAD_TOOL, scope) === undefined
      ? []
      : packs.filter((pack) => pack.tools.some((name) => tools.get(name, scope) !== undefined))

  if (packs.length > 0) {
    tools.register(
      defineTool({
        name: CAPABILITY_LOAD_TOOL,
        description: '加载能力包，之后就能调用包里的工具。包名见对话里的能力包列表。',
        parameters: {
          names: {
            type: 'array',
            items: { type: 'string' },
            required: true,
            description: '要加载的能力包名称，例如「扩展管理」。',
          },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
        execute(args, exec) {
          const input = z.object({ names: z.array(z.string().trim().min(1)).min(1) }).parse(args)
          const agent = exec.agent
          if (agent === undefined) throw new Error('capability_load needs a conversation.')
          const available = availableFor(agent)
          const requested = [...new Set(input.names.map((name) => name.replace(/^「|」$/gu, '')))]
          const unknown = requested.filter((name) => !available.some((pack) => pack.name === name))
          if (unknown.length > 0) {
            throw new Error(
              available.length === 0
                ? `没有可以加载的能力包。`
                : `没有「${unknown.join('」「')}」这个能力包。可以加载的有：${available.map((pack) => `「${pack.name}」`).join('')}。`,
            )
          }
          const already = requested.filter((name) => isLoaded(agent, name))
          const loading = available.filter((pack) => requested.includes(pack.name) && !already.includes(pack.name))
          if (loading.length > 0) {
            loadState.loading(
              agent,
              loading.map((pack) => pack.name),
            )
            options.onLoad?.(loading.map((pack) => pack.name))
            exec.deferContext(
              createUserMessage({
                content: [
                  {
                    type: 'text',
                    text: loading
                      .map((pack) => {
                        const schemas = visibleSdkSchemas(tools, agent).filter(
                          (schema) => packOf.get(schema.name) === pack,
                        )
                        return [
                          `〔能力包「${pack.name}」〕`,
                          ...(pack.instructions === undefined ? [] : [pack.instructions]),
                          options.presentation === 'ptc'
                            ? `在 run_code 里通过 tools 调用这些工具：\n${sdkDeclarations(schemas)}`
                            : `现在可以直接调用：${schemas.map((schema) => schema.name).join('、')}。`,
                        ].join('\n\n')
                      })
                      .join('\n\n'),
                  },
                ],
                source: { kind: 'nekro-nxt-capability-pack', packs: loading.map((pack) => pack.name) },
              }),
            )
          }
          const parts = [
            ...(loading.length === 0
              ? []
              : [
                  `已加载${loading.map((pack) => `「${pack.name}」`).join('')}，${
                    options.presentation === 'ptc' ? '说明和工具声明附在这次结果后面。' : '说明附在这次结果后面。'
                  }`,
                ]),
            ...(already.length === 0 ? [] : [`${already.map((name) => `「${name}」`).join('')}已经加载过了。`]),
          ]
          return Promise.resolve(parts.join(''))
        },
      }),
    )
    tools.guard((exec) => {
      const pack = packOf.get(exec.name)
      if (pack === undefined || exec.agent === undefined) return undefined
      return isLoaded(exec.agent, pack.name) ? undefined : capabilityGuardMessage(pack.name)
    })
    context.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
      loadState.stepStarted(agent)
      const decision = await next()
      if (decision.kind === 'reject') return decision
      signal.throwIfAborted()
      const entries = availableFor(agent).map((pack) => ({ name: pack.name, purpose: pack.purpose }))
      const digest = catalogDigest(entries)
      const visible = catalogOnSurface(agent.session)
      if (visible === digest || (visible === undefined && entries.length === 0)) return decision
      const catalog: UserMessage = createUserMessage({
        content: [{ type: 'text', text: capabilityCatalogText(entries) }],
        source: { kind: 'nekro-nxt-capability-catalog', entries },
      })
      return { ...decision, messages: [...decision.messages, catalog] }
    })
  }

  context.on('system-prompt/assemble', async (_assembly, assembleContext, next): Promise<PromptAssembly> => {
    let assembly = await next()
    const scope = assembleContext.scope
    const agent = (assembleContext as { readonly agent?: Agent }).agent
    if (packs.length > 0) {
      if (options.presentation === 'ptc') {
        const index = assembly.sections.findIndex((section) => section.name === 'tools:sdk' && section.text !== '')
        const section = assembly.sections[index]
        const schemas = visibleSdkSchemas(tools, scope)
        // NXT runs TypeScript programs; another runtime's SDK text is left as DSH wrote it.
        const typescript =
          (context.get('ptcRuntime') as { readonly language?: string } | undefined)?.language === 'typescript'
        if (section !== undefined && typescript && schemas.some((schema) => packOf.has(schema.name))) {
          const replaced = [...assembly.sections]
          replaced[index] = { ...section, text: renderToolsSdk(schemas.filter((schema) => !packOf.has(schema.name))) }
          assembly = { ...assembly, sections: replaced }
        }
      } else if (agent !== undefined) {
        const hidden = (name: string) => {
          const pack = packOf.get(name)
          return pack !== undefined && !isLoaded(agent, pack.name)
        }
        if (assembly.tools.some((tool) => hidden(tool.name))) {
          assembly = { ...assembly, tools: assembly.tools.filter((tool) => !hidden(tool.name)) }
        }
      }
    }
    if (agent !== undefined && String(agent.id) === options.rootSessionId) {
      root = agent
      sections = assembly.sections
        .filter((section) => section.text !== '')
        .map((section) => ({ name: section.name, chars: section.text.length }))
    }
    return assembly
  })

  return {
    promptSections: () => sections,
    packs: () => {
      if (packs.length === 0) return undefined
      const agent = root
      return {
        available: (agent === undefined ? packs : availableFor(agent)).map((pack) => pack.name),
        loaded: agent === undefined ? [] : packs.filter((pack) => isLoaded(agent, pack.name)).map((pack) => pack.name),
      }
    },
  }
}
