import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { freezeMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { AdapterChannelInboundEvent } from '@nekro-nxt/adapter-sdk'
import type { MessagePart } from '@nekro-nxt/contracts'
import type { SecretRegistry } from './secret-registry.js'

export const SECRET_ARGUMENT_DENIAL = '参数里含有已保存的凭据，这次调用没有执行。'
export const CREDENTIAL_PATH_DENIAL = '这个位置存放凭据，工具不能访问。'

/** DSH file tools address their target through `file_path`. */
const FILE_PATH_TOOLS = new Set(['read', 'write', 'edit', 'read_image'])
/** A local-store entry, or a relative climb into a `credentials` directory. */
const CREDENTIAL_TEXT_PATTERNS = [
  /[0-9a-f]{32}\.secret\b/iu,
  /credentials[\\/][^\s'"`]*\.secret\b/iu,
  /(?:^|[\s'"`=:])(?:\.\.[\\/])+(?:[^\s'"`]*[\\/])?credentials(?:[\\/\s'"`]|$)/iu,
]

export interface CredentialRedactionOptions {
  readonly secrets: SecretRegistry
  /** Credential directories and files (absolute). Tool calls naming them are denied. */
  readonly protectedPaths: readonly string[]
  readonly platform?: NodeJS.Platform
}

const redactBlocks = (secrets: SecretRegistry, blocks: readonly ContentBlock[]): ContentBlock[] | undefined => {
  const redacted = secrets.redactValue(blocks)
  return redacted === blocks ? undefined : [...redacted]
}

const redactContexts = (
  secrets: SecretRegistry,
  messages: readonly UserMessage[] | undefined,
): UserMessage[] | undefined => {
  if (messages === undefined) return undefined
  let changed = false
  const next = messages.map((message) => {
    const content = redactBlocks(secrets, message.content)
    if (content === undefined) return message
    changed = true
    return freezeMessage({ ...message, content })
  })
  return changed ? next : undefined
}

/**
 * The dispatch result with registered secrets replaced in its canonical value, content, error and contexts. A
 * success is returned without its canonical mark, so the registry re-renders content from the redacted value.
 */
export const redactDispatchResult = (secrets: SecretRegistry, result: ToolExecutionResult): ToolExecutionResult => {
  const additionalContexts = redactContexts(secrets, result.additionalContexts)
  if (result.isError) {
    const content = redactBlocks(secrets, result.content)
    const message = secrets.redact(result.error.message)
    if (content === undefined && additionalContexts === undefined && message === result.error.message) return result
    return {
      ...result,
      error: { ...result.error, message },
      content: content ?? result.content,
      ...(additionalContexts === undefined ? {} : { additionalContexts }),
    }
  }
  const value = secrets.redactValue(result.value)
  if (value === result.value && additionalContexts === undefined) return result
  return { ...result, value, ...(additionalContexts === undefined ? {} : { additionalContexts }) }
}

/** The post-execute decision with every projection that reaches the model redacted. */
export const redactPostDecision = (
  secrets: SecretRegistry,
  result: Readonly<ToolExecutionResult>,
  decision: PostToolDecision,
): PostToolDecision => {
  const decisionContexts = redactContexts(secrets, decision.additionalContexts)
  const contexts = decisionContexts ?? decision.additionalContexts
  if (decision.kind === 'block') {
    const feedback = redactBlocks(secrets, decision.feedback)
    if (feedback === undefined && decisionContexts === undefined) return decision
    return {
      ...decision,
      feedback: feedback ?? decision.feedback,
      ...(contexts === undefined ? {} : { additionalContexts: contexts }),
    }
  }
  // The registry appends the dispatch result's own contexts after this decision and offers no way to replace them.
  // Context deferred by a tool body skips `tools/execute`; when it carries a secret, only a block can drop it.
  const resultContexts = redactContexts(secrets, result.additionalContexts)
  if (resultContexts !== undefined) {
    const feedback =
      'value' in decision
        ? [{ type: 'text' as const, text: JSON.stringify(secrets.redactValue(decision.value)) }]
        : (redactBlocks(secrets, decision.content ?? result.content) ?? decision.content ?? result.content)
    return { kind: 'block', feedback, additionalContexts: [...resultContexts, ...(contexts ?? [])] }
  }
  if ('value' in decision) {
    const value = secrets.redactValue(decision.value)
    if (value === decision.value && decisionContexts === undefined) return decision
    return { kind: 'accept', value, ...(contexts === undefined ? {} : { additionalContexts: contexts }) }
  }
  const content = redactBlocks(secrets, decision.content ?? result.content)
  if (content === undefined && decisionContexts === undefined) return decision
  return {
    kind: 'accept',
    ...(content === undefined ? (decision.content === undefined ? {} : { content: decision.content }) : { content }),
    ...(contexts === undefined ? {} : { additionalContexts: contexts }),
  }
}

/** Whether one tool call names a credential store location. Text matching on commands and programs is best effort. */
export const referencesCredentialPath = (
  exec: Pick<ToolExecution, 'name' | 'arguments'>,
  protectedPaths: readonly string[],
  platform: NodeJS.Platform = process.platform,
): boolean => {
  const fold = (text: string): string => (platform === 'linux' ? text : text.toLowerCase())
  const roots = protectedPaths.map((entry) => fold(path.resolve(entry)))
  const basenames = protectedPaths.map((entry) => fold(path.basename(entry))).filter((name) => name.startsWith('.'))
  const inside = (candidate: string): boolean => {
    const resolved = fold(path.resolve(candidate))
    return roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))
  }
  const mentions = (text: string): boolean => {
    const folded = fold(text)
    return (
      roots.some((root) => folded.includes(root)) ||
      basenames.some((name) => folded.includes(name)) ||
      CREDENTIAL_TEXT_PATTERNS.some((pattern) => pattern.test(text))
    )
  }
  const args = exec.arguments
  if (FILE_PATH_TOOLS.has(exec.name) && args !== null && typeof args === 'object' && !Array.isArray(args)) {
    const target: unknown = Reflect.get(args, 'file_path')
    if (typeof target === 'string' && path.isAbsolute(target) && inside(target)) return true
  }
  const stack: unknown[] = [args]
  while (stack.length > 0) {
    const item = stack.pop()
    if (typeof item === 'string') {
      if (mentions(item)) return true
    } else if (item !== null && typeof item === 'object') {
      for (const entry of Object.values(item)) stack.push(entry)
    }
  }
  return false
}

/**
 * Keeps registered credential values out of everything a tool hands back to the model, the Session and its traces.
 *
 * - A global `tools.guard` denies calls whose arguments carry a secret (any registered form) or name a credential
 *   store location. Guards run after every `tools/pre-execute` listener and cannot be overridden.
 * - `tools/execute` (outermost) redacts the canonical value, so `run_code` programs, nested PTC results and the
 *   rendered content all derive from the redacted value.
 * - `tools/post-execute` redacts content installed after dispatch (projected content, other listeners'
 *   replacements). It is registered without `prepend`, so `dsh-spill-policy`, which prepends and bounds the content
 *   its `next()` returns, always spills the redacted text.
 * - `tools/ptc-dispatch-log` redacts the durable copy of each sub-call before spill bounds it, for the same reason.
 *
 * Returns the disposer for every registration.
 */
export const mountCredentialRedaction = (context: Context, options: CredentialRedactionOptions): (() => void) => {
  const { secrets, protectedPaths } = options
  const offGuard = context.tools.guard((exec) => {
    if (secrets.containsValue(exec.arguments)) return SECRET_ARGUMENT_DENIAL
    if (referencesCredentialPath(exec, protectedPaths, options.platform)) return CREDENTIAL_PATH_DENIAL
    return undefined
  })
  const offExecute = context.on('tools/execute', async (_exec, next) => redactDispatchResult(secrets, await next()), {
    prepend: true,
  })
  const offPost = context.on('tools/post-execute', async (_exec, result, next) =>
    redactPostDecision(secrets, result, await next()),
  )
  const offLog = context.on('tools/ptc-dispatch-log', async (_dispatch, next) => {
    const content = await next()
    return redactBlocks(secrets, content) ?? content
  })
  return () => {
    offLog()
    offPost()
    offExecute()
    offGuard()
  }
}

/** Inbound message text, captions, file names, card text and adapter facts with registered secrets replaced. */
export const redactInboundEvent = (
  secrets: SecretRegistry,
  event: AdapterChannelInboundEvent,
): AdapterChannelInboundEvent => {
  let changed = false
  const parts = event.parts.map((part): MessagePart => {
    const redacted = redactPart(secrets, part)
    if (redacted !== part) changed = true
    return redacted
  })
  const facts = event.facts === undefined ? undefined : secrets.redactValue(event.facts)
  if (facts !== event.facts) changed = true
  return changed ? { ...event, parts, ...(facts === undefined ? {} : { facts }) } : event
}

const redactPart = (secrets: SecretRegistry, part: MessagePart): MessagePart => {
  const text = (value: string): string => secrets.redact(value)
  switch (part.type) {
    case 'text': {
      const redacted = text(part.text)
      return redacted === part.text ? part : { ...part, text: redacted }
    }
    case 'image':
      return part.alt === undefined || text(part.alt) === part.alt ? part : { ...part, alt: text(part.alt) }
    case 'file':
      return part.name === undefined || text(part.name) === part.name ? part : { ...part, name: text(part.name) }
    case 'rich': {
      const summary = text(part.summary)
      const title = part.title === undefined ? undefined : text(part.title)
      return summary === part.summary && title === part.title
        ? part
        : { ...part, summary, ...(title === undefined ? {} : { title }) }
    }
    case 'mention':
    case 'audio':
    case 'quote':
      return part
  }
}
