import { z } from 'zod'
import {
  AgentIdSchema,
  AgentRevisionIdSchema,
  ChannelEventIdSchema,
  ChannelIdSchema,
  ConnectionIdSchema,
  ExtensionRevisionIdSchema,
  MessagePartSchema,
  OutboundIntentIdSchema,
  type AgentId,
  type ChannelId,
  type ChannelMemberId,
  type MessagePart,
} from './domain.js'

export const CommandPermissionSchema = z.enum(['public', 'channel-admin'])
export type CommandPermission = z.output<typeof CommandPermissionSchema>
const nameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\p{L}\p{N}_-]+$/u)
const scalarSchema = z.union([z.string(), z.number().finite(), z.boolean()])
export const CommandParameterSchema = z
  .object({
    name: nameSchema,
    description: z.string().max(500).optional(),
    kind: z.enum(['positional', 'option']),
    type: z.enum(['string', 'number', 'integer', 'boolean']),
    required: z.boolean().optional(),
    default: scalarSchema.optional(),
    choices: z.array(scalarSchema).min(1).max(100).optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  })
  .strict()
export const CommandDefinitionSchema = z
  .object({
    name: nameSchema,
    aliases: z.array(nameSchema).max(16).default([]),
    description: z.string().min(1).max(1000),
    parameters: z.array(CommandParameterSchema).max(32).default([]),
    examples: z.array(z.string().max(2000)).max(16).default([]),
    minimumPermission: CommandPermissionSchema.default('public'),
    enabledByDefault: z.boolean().default(true),
  })
  .strict()
  .superRefine((definition, ctx) => {
    const names = [definition.name, ...definition.aliases]
    if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', message: '命令名称和别名不能重复。' })
    if (new Set(definition.parameters.map((p) => p.name)).size !== definition.parameters.length)
      ctx.addIssue({ code: 'custom', message: '参数名称不能重复。' })
    let optional = false
    for (const p of definition.parameters) {
      if (p.min !== undefined && p.max !== undefined && p.min > p.max)
        ctx.addIssue({ code: 'custom', message: `参数 ${p.name} 的范围无效。` })
      if (p.kind === 'positional') {
        if (optional && p.required) ctx.addIssue({ code: 'custom', message: '必填位置参数必须在可选参数之前。' })
        if (!p.required || p.default !== undefined) optional = true
      }
      if (p.default !== undefined) {
        try {
          if (validateValue(p, String(p.default)) !== p.default) throw new Error('默认值类型不匹配。')
        } catch {
          ctx.addIssue({ code: 'custom', message: `参数 ${p.name} 的默认值无效。` })
        }
      }
    }
  })
export type CommandDefinition = z.output<typeof CommandDefinitionSchema>
export const CommandPolicySchema = z
  .object({ enabled: z.boolean().optional(), permission: CommandPermissionSchema.optional() })
  .strict()
export type CommandPolicy = z.output<typeof CommandPolicySchema>
export const CommandExecutionIdentitySchema = z
  .object({
    source: z.enum(['web', 'platform']),
    connectionId: ConnectionIdSchema.optional(),
    platformUserId: z.string().optional(),
    displayName: z.string(),
    viewerId: z.string().optional(),
  })
  .strict()
export type CommandExecutionIdentity = z.output<typeof CommandExecutionIdentitySchema>
export const CommandResultSchema = z
  .object({
    parts: z
      .array(MessagePartSchema)
      .min(1)
      .max(32)
      .refine(
        (parts) => parts.every((p) => ['text', 'image', 'file'].includes(p.type)),
        '命令结果仅支持文本、图片和文件。',
      ),
    summary: z.string().max(2000).optional(),
  })
  .strict()
export type CommandResult = z.output<typeof CommandResultSchema>
export const CommandExecutionRecordSchema = z
  .object({
    id: z.string().min(1),
    channelId: ChannelIdSchema,
    source: z.enum(['web', 'platform']),
    requestId: z.string().min(1).max(200),
    eventId: ChannelEventIdSchema.optional(),
    rawText: z.string(),
    identity: CommandExecutionIdentitySchema,
    commandName: z.string().optional(),
    commandVersion: z.string().optional(),
    extensionRevisionId: ExtensionRevisionIdSchema.optional(),
    agentId: AgentIdSchema.optional(),
    agentRevisionId: AgentRevisionIdSchema.optional(),
    status: z.enum(['pending', 'running', 'succeeded', 'failed', 'uncertain']),
    result: CommandResultSchema.optional(),
    error: z.string().optional(),
    replyIntentId: OutboundIntentIdSchema.optional(),
    replyError: z.string().optional(),
    createdAt: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative().optional(),
  })
  .strict()
export type CommandExecutionRecord = z.output<typeof CommandExecutionRecordSchema>
export interface CommandExecutionContext {
  readonly channelId: ChannelId
  readonly agentId?: AgentId
  readonly identity: CommandExecutionIdentity
  readonly arguments: Readonly<Record<string, string | number | boolean>>
  readonly signal: AbortSignal
  readonly host: {
    status(): { readonly bound: boolean; readonly responseMode?: string; readonly running: boolean }
    stop(): Promise<void>
    reset(mode: 'clear' | 'compact'): Promise<void>
  }
}
export type CommandHandler = (context: CommandExecutionContext) => CommandResult | Promise<CommandResult>
export const CommandCatalogEntrySchema = z
  .object({
    definition: CommandDefinitionSchema,
    fullName: z.string(),
    source: z.string(),
    extensionRevisionId: ExtensionRevisionIdSchema.optional(),
    enabled: z.boolean(),
    permission: CommandPermissionSchema,
    usage: z.string(),
    available: z.boolean(),
    globalPolicy: CommandPolicySchema.optional(),
    channelPolicy: CommandPolicySchema.optional(),
  })
  .strict()
export type CommandCatalogEntry = z.output<typeof CommandCatalogEntrySchema>

/** Shell-like quoting without evaluation or interpolation. */
export function tokenizeCommand(text: string): string[] {
  const tokens: string[] = []
  let value = '',
    quote = '',
    escaped = false,
    started = false
  for (const char of text) {
    if (escaped) {
      value += char
      escaped = false
      started = true
      continue
    }
    if (char === '\\') {
      escaped = true
      started = true
      continue
    }
    if (quote) {
      if (char === quote) quote = ''
      else value += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/u.test(char)) {
      if (started) tokens.push(value)
      value = ''
      started = false
      continue
    }
    value += char
    started = true
  }
  if (escaped || quote) throw new Error('引号或转义未闭合。')
  if (started) tokens.push(value)
  return tokens
}
function validateValue(p: z.output<typeof CommandParameterSchema>, raw: string): string | number | boolean {
  let value: string | number | boolean = raw
  if (p.type === 'boolean') {
    if (!['true', 'false'].includes(raw)) throw new Error(`参数 ${p.name} 必须为 true 或 false。`)
    value = raw === 'true'
  } else if (p.type !== 'string') {
    value = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(value) || (p.type === 'integer' && !Number.isSafeInteger(value)))
      throw new Error(`参数 ${p.name} 必须为${p.type === 'integer' ? '整数' : '数字'}。`)
  }
  const size = typeof value === 'string' ? [...value].length : typeof value === 'number' ? value : undefined
  if (size !== undefined && ((p.min !== undefined && size < p.min) || (p.max !== undefined && size > p.max)))
    throw new Error(`参数 ${p.name} 超出允许范围。`)
  if (p.choices !== undefined && !p.choices.includes(value))
    throw new Error(`参数 ${p.name} 必须为：${p.choices.join('、')}。`)
  return value
}
export function parseCommandArguments(
  definition: CommandDefinition,
  tokens: readonly string[],
): Readonly<Record<string, string | number | boolean>> {
  const args = new Map<string, string | number | boolean>()
  const positions = definition.parameters.filter((p) => p.kind === 'positional')
  let index = 0,
    options = true
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (options && token === '--') {
      options = false
      continue
    }
    let p: CommandDefinition['parameters'][number] | undefined,
      raw = token
    if (options && token.startsWith('--')) {
      const equal = token.indexOf('=')
      const key = token.slice(2, equal < 0 ? undefined : equal)
      p = definition.parameters.find((p) => p.kind === 'option' && p.name === key)
      if (!p) throw new Error(`未知选项：--${key}`)
      if (equal >= 0) raw = token.slice(equal + 1)
      else if (p.type === 'boolean' && (tokens[i + 1] === undefined || !['true', 'false'].includes(tokens[i + 1]!)))
        raw = 'true'
      else {
        const next = tokens[++i]
        if (next === undefined || next.startsWith('--')) throw new Error(`选项 --${key} 缺少值。`)
        raw = next
      }
    } else {
      p = positions[index++]
      if (!p) throw new Error(`多余参数：${token}`)
    }
    if (args.has(p.name)) throw new Error(`重复参数：${p.name}`)
    args.set(p.name, validateValue(p, raw))
  }
  for (const p of definition.parameters) {
    if (args.has(p.name)) continue
    if (p.default !== undefined) args.set(p.name, p.default)
    else if (p.required) throw new Error(`缺少参数：${p.kind === 'option' ? '--' : ''}${p.name}`)
  }
  return Object.fromEntries(args)
}
export function commandUsage(definition: CommandDefinition, name = definition.name): string {
  return (
    '/' +
    name +
    definition.parameters
      .map((p) => {
        const value =
          p.kind === 'option' ? `--${p.name} ${p.type === 'boolean' ? '[true|false]' : `<${p.name}>`}` : `<${p.name}>`
        return ' ' + (p.required ? value : `[${value}]`)
      })
      .join('')
  )
}
export type CommandRecognition =
  | { readonly kind: 'command'; readonly text: string }
  | { readonly kind: 'escaped'; readonly parts: readonly MessagePart[] }
  | { readonly kind: 'chat' }
export function recognizeCommand(parts: readonly MessagePart[], botMemberId?: ChannelMemberId): CommandRecognition {
  let input = parts
  while (input.length > 1 && input[0]?.type === 'text' && input[0].text.trim() === '') input = input.slice(1)
  if (input[0]?.type === 'mention' && input[0].memberId === botMemberId) input = input.slice(1)
  if (input.length === 0 || input.some((p) => p.type !== 'text')) return { kind: 'chat' }
  const text = input
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
    .trimStart()
  if (text.startsWith('//')) return { kind: 'escaped', parts: [{ type: 'text', text: text.slice(1) }] }
  if (!text.startsWith('/')) return { kind: 'chat' }
  return { kind: 'command', text }
}
