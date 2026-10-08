import type { ChannelRuntimeContext } from '@nekro-nxt/contracts'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { boundedDetail } from './channel-runtime-projection.js'

const CHANGE_LIMIT = 20

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
  }
}

export const unavailableSessionContext: ChannelRuntimeContext = {
  available: false,
  instructions: [],
  tools: [],
  changes: [],
}
