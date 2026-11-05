import type { ChannelRuntimeContext } from '@nekro-nxt/contracts'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { CapabilityPackView, PromptSectionSize } from './capability-packs.js'
import { boundedDetail } from './channel-runtime-projection.js'

const CHANGE_LIMIT = 20

/** DSH's own fixed estimate for prompt text (dsh-token-meter). */
const CHARS_PER_TOKEN = 4

/**
 * What each part of the system prompt is, in the inspector's words. DSH's per-tool guidance (`tool:bash`, `tool:read`)
 * counts as 「工具说明」; anything else as 「其他」.
 */
const PROMPT_SECTION_LABELS: Readonly<Record<string, string>> = {
  'tools:sdk': '工具声明',
  'deployment:persona-prefix': '人设',
  'nekro-nxt:persona-reference-protocol': '人设',
  'nekro-nxt:channel-instructions': '频道说明',
  'nekro-nxt:channel-context': '频道信息',
  'nekro-nxt:channel-communication': '发言规则',
  'nekro-nxt:context-management': '记忆与上下文',
  'nekro-nxt:image-context': '图片',
  'nekro-nxt:code-run': '编排模式',
  'tools:ptc-only': '编排模式',
  'nekro-nxt:community-feedback': '社区反馈',
  'nekro-nxt:command-host': '命令',
  'nekro-nxt:windows-commands': '命令',
  'nekro-nxt:command-accounts': '命令',
}

/** System prompt parts grouped by label in prompt order, with estimated tokens. */
export const projectPromptSections = (sections: readonly PromptSectionSize[]) => {
  const groups = new Map<string, number>()
  for (const section of sections) {
    const label = PROMPT_SECTION_LABELS[section.name] ?? (section.name.startsWith('tool:') ? '工具说明' : '其他')
    groups.set(label, (groups.get(label) ?? 0) + section.chars)
  }
  return [...groups].map(([label, chars]) => ({ label, chars, tokens: Math.ceil(chars / CHARS_PER_TOKEN) }))
}

const blockText = (content: readonly { readonly type: string; readonly text?: string }[]): string =>
  content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('\n')
    .trim()

/**
 * What the live session sends the model, read from DSH's own folds: the request header in force (route config and
 * assembled tool schemas), the route metadata, and the system and developer messages still on the derived history.
 * Before the first model request the header is absent and only already-derived instructions show.
 */
export const projectSessionContext = (
  session: Pick<Session, 'requestHeader' | 'requestContext' | 'deriveMessages'>,
  events: readonly SessionEvent[],
  capabilities?: CapabilityPackView,
): ChannelRuntimeContext => {
  const header = session.requestHeader()
  const route = session.requestContext()
  const config = header?.config
  const provider = route?.provider ?? config?.provider
  const model = route?.model ?? config?.model
  const instructions = session.deriveMessages().flatMap((message) => {
    if (message.role !== 'system' && message.role !== 'developer') return []
    const text = blockText(message.content)
    if (!text) return []
    const value = boundedDetail(text)
    return [{ role: message.role, text: value.text, truncated: value.truncated }]
  })
  const changes = events
    .flatMap((event) =>
      event.type === 'request/header'
        ? [{ at: event.time, reason: event.data.reason, toolCount: event.data.header.tools?.length ?? 0 }]
        : [],
    )
    .slice(-CHANGE_LIMIT)
  const sections = capabilities?.promptSections() ?? []
  const packs = capabilities?.packs()
  return {
    available: true,
    ...(provider === undefined || model === undefined
      ? {}
      : {
          route: {
            provider,
            model,
            ...(route?.contextWindow === undefined ? {} : { contextWindow: route.contextWindow }),
            ...(config?.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
            ...(config?.temperature === undefined ? {} : { temperature: config.temperature }),
            ...(config?.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
          },
        }),
    instructions,
    tools: (header?.tools ?? []).map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.parameters === undefined ? {} : { parameters: JSON.stringify(tool.parameters, null, 2) }),
    })),
    changes,
    ...(sections.length === 0 ? {} : { promptSections: projectPromptSections(sections) }),
    ...(packs === undefined ? {} : { capabilityPacks: { available: [...packs.available], loaded: [...packs.loaded] } }),
  }
}

export const unavailableSessionContext: ChannelRuntimeContext = {
  available: false,
  instructions: [],
  tools: [],
  changes: [],
}
