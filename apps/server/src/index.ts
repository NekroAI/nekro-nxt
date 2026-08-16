import { AgentRegistry, type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AttachmentStore, {
  AttachmentId,
  type ImageAttachmentRef,
  type ImageMediaType,
  type SaveImageAttachment,
  type StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import SandboxBashExecutor from '@deepseek-ai/dsh-bash-sandbox'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import DynamicCordisRunnerService, {
  ApprovalRequestId,
  CordisDynamicPackageId,
  CordisDynamicPluginId,
  CordisDynamicPluginRunId,
  type CordisDynamicRunMode,
  type CordisErrorDetails,
  type DynamicCordisClientSource,
  type DynamicCordisDefineReceipt,
  type DynamicCordisHostHalfResult,
  type DynamicCordisInventoryRow,
  type DynamicCordisInvokeResult,
  type DynamicCordisPackageInspection,
  type DynamicCordisRenderFailure,
  type DynamicCordisResolveAck,
  type DynamicCordisRunResolution,
  type DynamicCordisRunResponse,
  type DynamicCordisStopResponse,
  type DynamicCordisUndefineReceipt,
  type HostCordisInspectProviderRegistration,
} from '@deepseek-ai/dsh-cordis-host-runner'
import { freezeMessage, MessageId, type ContentBlock, type LlmAdapter, type UserMessage } from '@deepseek-ai/dsh-llm'
import * as FsObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import * as SessionCheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import { SqliteSessionPersistence } from '@deepseek-ai/dsh-session-persistence-sqlite'
import { PERSONA_ORDER, PERSONA_SECTION, SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as CordisTool from '@deepseek-ai/dsh-tool-cordis'
import * as BashTool from '@deepseek-ai/dsh-tool-bash'
import * as FsTool from '@deepseek-ai/dsh-tool-fs'
import { defineTool, ToolRuntime, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type {
  AgentSessionDriver,
  ChannelRuntime,
  ChannelHistoryRepository,
  EpisodeCloseReason,
  SendMessageInput,
  SendMessageResult,
} from '@nekro-nxt/channel-runtime'
import {
  AssetIdSchema,
  parseMessageParts,
  type AdmissionId,
  type AgentRevisionId,
  type EpisodeId,
  type JsonValue,
} from '@nekro-nxt/contracts'
import type {
  AgentRevisionRecord,
  AssetEnrichmentRepository,
  AssetRecord,
  AssetService,
  ChannelEventRecord,
} from '@nekro-nxt/core'
import type {
  ExtensionActivationHost,
  ExtensionBuildArtifact,
  ExtensionRevisionRecord,
  MountedExtension,
} from '@nekro-nxt/extension-runtime'
import type { ExtensionHostEnvironment, ExtensionJsonValue, ExtensionPluginFactory } from '@nekro-nxt/extension-sdk'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'

export * from './qq-openclaw.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'nekro-nxt-channel': {
      readonly kind: 'nekro-nxt-channel'
      readonly admissionId: string
      readonly channelEventIds: readonly string[]
    }
    'nekro-nxt-handoff': {
      readonly kind: 'nekro-nxt-handoff'
      readonly handoffId: string
      readonly fromEpisodeId: string
      readonly form: 'recall'
    }
  }
}

const HOST_DSH_PACKAGE_VERSIONS = {
  '@deepseek-ai/cordis': '4.0.1',
  '@deepseek-ai/dsh-agent': '0.1.0-rc.6',
  '@deepseek-ai/dsh-agent-loop': '0.1.0-rc.6',
  '@deepseek-ai/dsh-attachment': '0.1.0-rc.6',
  '@deepseek-ai/dsh-bash-sandbox': '0.1.0-rc.6',
  '@deepseek-ai/dsh-compaction-basic': '0.1.0-rc.6',
  '@deepseek-ai/dsh-cordis-host-runner': '0.1.0-rc.6',
  '@deepseek-ai/dsh-llm': '0.1.0-rc.6',
  '@deepseek-ai/dsh-fs-observation-policy': '0.1.0-rc.6',
  '@deepseek-ai/dsh-fs-sandbox': '0.1.0-rc.6',
  '@deepseek-ai/dsh-sandbox-local': '0.1.0-rc.6',
  '@deepseek-ai/dsh-sandbox-policy': '0.1.0-rc.6',
  '@deepseek-ai/dsh-scope': '0.1.0-rc.6',
  '@deepseek-ai/dsh-session': '0.1.0-rc.6',
  '@deepseek-ai/dsh-session-checkpoint-policy': '0.1.0-rc.6',
  '@deepseek-ai/dsh-session-persistence-sqlite': '0.1.0-rc.6',
  '@deepseek-ai/dsh-system-prompt': '0.1.0-rc.6',
  '@deepseek-ai/dsh-shell-env': '0.1.0-rc.6',
  '@deepseek-ai/dsh-subprocess-local': '0.1.0-rc.6',
  '@deepseek-ai/dsh-token-meter': '0.1.0-rc.6',
  '@deepseek-ai/dsh-tool-bash': '0.1.0-rc.6',
  '@deepseek-ai/dsh-tool-cordis': '0.1.0-rc.6',
  '@deepseek-ai/dsh-tool-fs': '0.1.0-rc.6',
  '@deepseek-ai/dsh-tools': '0.1.0-rc.6',
} as const

export function assertHostDshPackageVersions(): void {
  const require = createRequire(import.meta.url)
  for (const [name, expected] of Object.entries(HOST_DSH_PACKAGE_VERSIONS)) {
    const manifest = require(`${name}/package.json`) as { readonly version?: unknown }
    const actual = typeof manifest.version === 'string' ? manifest.version : '<invalid>'
    if (actual !== expected) {
      throw new Error(`DSH Host package version mismatch: ${name} expected ${expected}, received ${actual}.`)
    }
  }
}

export interface AgentCommunicationPort {
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>
}

export interface DshHostRuntimeOptions {
  readonly sessionDatabasePath: string
  readonly communication: AgentCommunicationPort
  readonly history: ChannelHistoryRepository
  readonly assets: AssetEnrichmentRepository
  readonly assetService: AssetService
  readonly resolveAgentRevision: (revisionId: AgentRevisionId) => AgentRevisionRecord | undefined
  /** Absolute workspace used by explicitly granted development capabilities. */
  readonly developmentWorkspaceRoot?: string
  readonly configureLlm?: (context: Context) => Promise<void> | void
}

export interface DynamicPackageDefinitionInput {
  readonly plugin:
    | { readonly kind: 'new'; readonly idPrefix: string }
    | {
        readonly kind: 'existing'
        readonly pluginId: string
      }
  readonly name: string
  readonly purpose: string
  readonly code: { readonly host?: string; readonly client?: string }
}

const noFieldsSchema = { type: 'object', properties: {}, additionalProperties: false } as const
const jsonObjectSchema = { type: 'object', additionalProperties: true } as const

const EXTENSION_PRIVATE_SERVICE_KEYS = [
  'agents',
  'attachments',
  'compaction',
  'llm',
  'sandbox',
  'sandboxPolicy',
  'sessionPersistence',
  'sessions',
  'shell',
  'shellEnv',
  'subprocess',
  'tokenMeter',
] as const
const PERSISTENT_EXTENSION_HOST_SERVICES = new Set(['tools'])

const isolatePrivateExtensionServices = (context: Context): Context =>
  EXTENSION_PRIVATE_SERVICE_KEYS.reduce((isolated, key) => isolated.isolate(key), context)

const persistentExtensionContext = (context: Context): Context =>
  ({
    tools: context.tools,
    get: (service: string) => (service === 'tools' ? context.tools : undefined),
  }) as unknown as Context

const nekroNxtInspectProvider = (input: {
  readonly episodeId: EpisodeId
  readonly channelId: Parameters<AssetEnrichmentRepository['canAccessAsset']>[1]
  readonly revision: AgentRevisionRecord
}): HostCordisInspectProviderRegistration => ({
  manifest: {
    id: 'nekro-nxt-runtime',
    description:
      '读取当前 NekroNxt 智能体、频道和动态创造边界；这些结果只用于设计扩展，不是可由扩展直接调用的业务 Service。',
    methods: [
      {
        name: 'currentContext',
        description: '读取当前产品智能体 Revision、频道身份和三项相互独立的授权。',
        inputSchema: noFieldsSchema,
        outputSchema: jsonObjectSchema,
      },
      {
        name: 'extensionRules',
        description: '读取动态运行、保存本地扩展和启用给智能体之间的稳定边界。',
        inputSchema: noFieldsSchema,
        outputSchema: jsonObjectSchema,
      },
    ],
  },
  query: (method, queryInput, context) => {
    if (
      queryInput !== undefined &&
      (typeof queryInput !== 'object' || queryInput === null || Array.isArray(queryInput))
    ) {
      throw new TypeError('NekroNxt inspect input must be an object when provided.')
    }
    if (context.agent.id !== `nxt-${input.episodeId}`) {
      throw new Error('NekroNxt inspect query crossed its owning DSH Session.')
    }
    if (method === 'currentContext') {
      return Promise.resolve(
        JSON.parse(
          JSON.stringify({
            agent: {
              agentId: input.revision.agentId,
              agentRevisionId: input.revision.id,
              displayName: input.revision.displayName,
              model: input.revision.model,
              capabilities: input.revision.capabilities,
            },
            channel: { channelId: input.channelId, episodeId: input.episodeId },
          }),
        ) as JsonValue,
      )
    }
    if (method === 'extensionRules') {
      return Promise.resolve({
        dynamicRun: {
          lifetime: 'current-dsh-session',
          persistence: false,
          securityBoundary: false,
        },
        save: { createsImmutableSourceRevision: true, activatesAutomatically: false },
        activation: { target: 'one-agent', safeSwitchRequired: true },
        forbidden: ['host-path-as-identity', 'direct-core-database-access', 'implicit-shell-or-file-grant'],
      } as JsonValue)
    }
    throw new Error(`Unknown NekroNxt inspect method: ${method}`)
  },
})

interface PersistentExtensionRegistration {
  readonly key: string
  readonly agentId: AgentRevisionRecord['agentId']
  readonly revision: ExtensionRevisionRecord
  readonly artifact: ExtensionBuildArtifact
  readonly config: JsonValue
  readonly fibers: Map<string, Fiber>
  readonly mounting: Map<string, Promise<void>>
  readonly handlers: Map<
    string,
    Map<string, (input: ExtensionJsonValue) => ExtensionJsonValue | Promise<ExtensionJsonValue>>
  >
  active: boolean
}

const DSH_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

class NekroAssetAttachmentStore extends AttachmentStore {
  readonly imageLimits = {
    maxImageBytes: 128 * 1024 * 1024,
    maxImagesPerMessage: 20,
    maxMessageImageBytes: 256 * 1024 * 1024,
    maxImagePixels: 100_000_000,
    mediaTypes: DSH_IMAGE_MEDIA_TYPES,
  }
  readonly assets: AssetEnrichmentRepository
  readonly assetService: AssetService

  constructor(context: Context, config: { assets: AssetEnrichmentRepository; assetService: AssetService }) {
    super(context)
    this.assets = config.assets
    this.assetService = config.assetService
  }

  async validateImage(input: SaveImageAttachment): Promise<void> {
    const metadata = await sharp(input.data).metadata()
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > this.imageLimits.maxImagePixels) {
      throw new Error('Image dimensions are unavailable or exceed the configured limit.')
    }
  }

  saveImage(): Promise<ImageAttachmentRef> {
    return Promise.reject(new Error('NekroNxt images must enter through Asset Service before DSH projection.'))
  }

  async refForAsset(asset: AssetRecord, name?: string): Promise<ImageAttachmentRef> {
    if (!DSH_IMAGE_MEDIA_TYPES.includes(asset.mediaType as ImageMediaType)) {
      throw new Error(`DSH does not support the Asset image media type: ${asset.mediaType}`)
    }
    const metadata = await sharp(this.assetService.blobPath(asset)).metadata()
    if (!metadata.width || !metadata.height) throw new Error(`Asset image dimensions are unavailable: ${asset.id}`)
    return {
      attachmentId: AttachmentId(asset.id),
      mediaType: asset.mediaType as ImageMediaType,
      bytes: asset.byteSize,
      width: metadata.width,
      height: metadata.height,
      ...(name === undefined ? {} : { name: path.basename(name) }),
    }
  }

  async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    signal?.throwIfAborted()
    const asset = this.assets.getAssetById(AssetIdSchema.parse(ref.attachmentId))
    if (!asset) throw new Error(`Attachment Asset is unavailable: ${ref.attachmentId}`)
    const data = new Uint8Array(await readFile(this.assetService.blobPath(asset), { signal }))
    const digest = `sha256:${createHash('sha256').update(data).digest('hex')}`
    if (digest !== asset.contentDigest || data.byteLength !== ref.bytes) {
      throw new Error(`Attachment Asset failed integrity verification: ${asset.id}`)
    }
    return { ref, data }
  }
}

const SEND_MESSAGE_POLICY = `你正在参与 NekroNxt 频道对话。任何用户可见发言都必须调用 send_message；普通模型文字只会记录为内部输出，不会发送到频道。需要回复时请明确调用工具，不要声称已经发送但不调用工具。`

const communicationTool = (episodeId: EpisodeId, communication: AgentCommunicationPort) =>
  defineTool({
    name: 'send_message',
    description: '向触发当前对话的频道发送一条用户可见消息。普通模型文字不会自动发送。',
    parameters: {
      target: {
        type: 'object',
        required: true,
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['current'], required: true },
        },
      },
      parts: {
        type: 'array',
        required: true,
        items: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: { type: 'string', const: 'text', required: true },
                text: { type: 'string', required: true },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: { type: 'string', const: 'mention', required: true },
                memberId: { type: 'string', required: true },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: { type: 'string', const: 'image', required: true },
                assetId: { type: 'string', required: true },
                alt: { type: 'string' },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: { type: 'string', const: 'file', required: true },
                assetId: { type: 'string', required: true },
                name: { type: 'string' },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: { type: 'string', const: 'audio', required: true },
                assetId: { type: 'string', required: true },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: { type: 'string', const: 'quote', required: true },
                messageId: { type: 'string', required: true },
              },
            },
          ],
        },
      },
      replyTo: { type: 'string' },
      clientRequestId: { type: 'string' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          logicalMessageId: { type: 'string', required: true },
          status: {
            type: 'string',
            enum: ['sent', 'partially-sent', 'failed', 'unknown'],
            required: true,
          },
          receipts: { type: 'array', required: true },
        },
      },
      render: (_arguments, value) => [
        {
          type: 'text',
          text: `频道消息 ${value.logicalMessageId} 的投递状态：${value.status}。`,
        },
      ],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('send_message requires a live DSH Agent execution.')
      const parts = parseMessageParts(args.parts)
      const result = await communication.sendMessage({
        episodeId,
        parts,
        ...(args.replyTo === undefined ? {} : { replyTo: args.replyTo }),
        sourceTurnId: String(exec.callId),
        clientRequestId: args.clientRequestId ?? `${episodeId}:${exec.callId}`,
        signal: exec.signal,
      })
      return JSON.parse(JSON.stringify(result)) as JsonValue as {
        logicalMessageId: string
        status: 'sent' | 'partially-sent' | 'failed' | 'unknown'
        receipts: JsonValue[]
      }
    },
  })

const historyTools = (
  channelId: Parameters<ChannelHistoryRepository['listChannelHistory']>[0],
  history: ChannelHistoryRepository,
) => [
  defineTool({
    name: 'conversation_history_read',
    description: '按时间倒序读取当前频道的原始历史消息，不读取其他频道。',
    parameters: {
      limit: { type: 'integer', description: '读取条数，1 到 100。' },
      beforeOccurredAt: { type: 'integer', description: '上一页末项的 occurredAt。' },
      beforeSourceId: { type: 'string', description: '上一页末项的 sourceId。' },
    },
    output: {
      schema: { type: 'array', items: { type: 'json' } },
      render: (_arguments, value) => [{ type: 'text', text: `读取到 ${value.length} 条当前频道历史。` }],
    },
    execute: (args) => {
      const hasOccurredAt = args.beforeOccurredAt !== undefined
      const hasSourceId = args.beforeSourceId !== undefined
      if (hasOccurredAt !== hasSourceId) throw new Error('History pagination requires both cursor fields.')
      const entries = history.listChannelHistory(channelId, {
        ...(args.limit === undefined ? {} : { limit: args.limit }),
        ...(hasOccurredAt && hasSourceId
          ? { before: { occurredAt: args.beforeOccurredAt!, sourceId: args.beforeSourceId! } }
          : {}),
      })
      return Promise.resolve(JSON.parse(JSON.stringify(entries)) as JsonValue[])
    },
  }),
  defineTool({
    name: 'conversation_history_search',
    description: '在当前频道已持久化的入站和出站原文中进行全文搜索，不读取其他频道。',
    parameters: {
      query: { type: 'string', required: true, description: '要查找的原文片段。' },
      limit: { type: 'integer', description: '返回条数，1 到 100。' },
    },
    output: {
      schema: { type: 'array', items: { type: 'json' } },
      render: (_arguments, value) => [{ type: 'text', text: `找到 ${value.length} 条当前频道历史。` }],
    },
    execute: (args) => {
      const hits = history.searchChannelHistory(channelId, args.query, {
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      })
      return Promise.resolve(JSON.parse(JSON.stringify(hits)) as JsonValue[])
    },
  }),
]

const assetInspectTool = (
  channelId: Parameters<AssetEnrichmentRepository['canAccessAsset']>[1],
  assets: AssetEnrichmentRepository,
) =>
  defineTool({
    name: 'asset_inspect',
    description: '读取当前频道有权访问的资源元数据和图片增强结果；只接受 assetId，不接受路径、URL 或摘要。',
    parameters: {
      assetId: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'json' },
      render: (_arguments, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: (args) => {
      const assetId = AssetIdSchema.parse(args.assetId)
      if (!assets.canAccessAsset(assetId, channelId))
        throw new Error('Asset is not accessible from the current Channel.')
      const asset = assets.getAssetById(assetId)
      if (!asset) throw new Error(`Asset metadata is unavailable: ${assetId}`)
      const value = {
        asset,
        enrichments: assets.listAssetEnrichments(assetId).map((record) => ({
          ...record,
          derivedContentTrust: 'untrusted',
        })),
      }
      return Promise.resolve(JSON.parse(JSON.stringify(value)) as JsonValue)
    },
  })

const assetViewImageTool = (
  channelId: Parameters<AssetEnrichmentRepository['canAccessAsset']>[1],
  assets: AssetEnrichmentRepository,
  attachments: NekroAssetAttachmentStore,
) =>
  defineTool({
    name: 'asset_view_image',
    description: '让支持图片输入的当前模型重新读取当前频道有权访问的一张图片。',
    parameters: { assetId: { type: 'string', required: true } },
    output: {
      schema: { type: 'json' },
      render: (_arguments, value) => [{ type: 'image', attachment: value as unknown as ImageAttachmentRef }],
    },
    execute: async (args) => {
      const assetId = AssetIdSchema.parse(args.assetId)
      if (!assets.canAccessAsset(assetId, channelId))
        throw new Error('Asset is not accessible from the current Channel.')
      const asset = assets.getAssetById(assetId)
      if (!asset) throw new Error(`Asset metadata is unavailable: ${assetId}`)
      return (await attachments.refForAsset(asset)) as unknown as JsonValue
    },
  })

const projectEvent = (event: ChannelEventRecord): ContentBlock[] => {
  const blocks: ContentBlock[] = [
    {
      type: 'text',
      text: `频道事件 ${event.id}${event.senderMemberId ? `，发送成员 ${event.senderMemberId}` : ''}：`,
    },
  ]
  for (const part of event.parts) {
    switch (part.type) {
      case 'text':
        blocks.push({ type: 'text', text: part.text })
        break
      case 'mention':
        blocks.push({ type: 'text', text: `提及频道成员 ${part.memberId}` })
        break
      case 'image':
        blocks.push({ type: 'text', text: `收到图片资源 ${part.assetId}${part.alt ? `（${part.alt}）` : ''}` })
        break
      case 'file':
        blocks.push({ type: 'text', text: `收到文件资源 ${part.assetId}${part.name ? `（${part.name}）` : ''}` })
        break
      case 'audio':
        blocks.push({ type: 'text', text: `收到音频资源 ${part.assetId}` })
        break
      case 'quote':
        blocks.push({ type: 'text', text: `引用频道消息 ${part.messageId}` })
        break
    }
  }
  return blocks
}

async function mountDevelopmentCapabilities(
  agentContext: Context,
  revision: AgentRevisionRecord,
  workspaceRoot: string | undefined,
): Promise<void> {
  const { developmentShell, fullFileAccess } = revision.capabilities
  if (!developmentShell && !fullFileAccess) return
  if (workspaceRoot === undefined) {
    throw new Error('Development capabilities require an explicit workspace root.')
  }

  const capabilityContext = agentContext
    .isolate('sandboxPolicy')
    .isolate('fs')
    .isolate('subprocess')
    .isolate('sandbox')
    .isolate('shell')
    .isolate('shellEnv')
  await capabilityContext.plugin(SandboxPolicyService, {
    mode: fullFileAccess ? 'danger-full-access' : 'workspace-write',
    workspaceRoot,
  })
  await capabilityContext.plugin(SandboxedFileSystem, { cwd: workspaceRoot })
  await capabilityContext.plugin(FsObservationPolicy)
  await capabilityContext.plugin(FsTool, {})

  if (developmentShell) {
    await capabilityContext.plugin(LocalSubprocessRuntime)
    await capabilityContext.plugin(LocalSandboxProvider, {})
    await capabilityContext.plugin(SandboxBashExecutor, { cwd: workspaceRoot })
    await capabilityContext.plugin(ShellEnv, {})
    await capabilityContext.plugin(BashTool, { enableRunInBackground: false })
  }
}

/** Owns the minimal production DSH Host roster and adapts it to Channel Runtime. */
export class DshHostRuntime implements AgentSessionDriver, ExtensionActivationHost {
  readonly #context: Context
  readonly #communication: AgentCommunicationPort
  readonly #history: ChannelHistoryRepository
  readonly #assets: AssetEnrichmentRepository
  readonly #resolveAgentRevision: DshHostRuntimeOptions['resolveAgentRevision']
  readonly #developmentWorkspaceRoot: string | undefined
  readonly #handles = new Map<string, AgentHandle>()
  readonly #imageInputSessions = new Set<string>()
  readonly #dynamicSessions = new Map<
    string,
    { readonly context: Context; readonly runner: DynamicCordisRunnerService }
  >()
  readonly #productAgentBySession = new Map<string, AgentRevisionRecord['agentId']>()
  readonly #persistentExtensions = new Map<string, PersistentExtensionRegistration>()
  #disposed = false

  private constructor(context: Context, options: DshHostRuntimeOptions) {
    this.#context = context
    this.#communication = options.communication
    this.#history = options.history
    this.#assets = options.assets
    this.#resolveAgentRevision = options.resolveAgentRevision
    this.#developmentWorkspaceRoot = options.developmentWorkspaceRoot
  }

  static async create(options: DshHostRuntimeOptions): Promise<DshHostRuntime> {
    assertHostDshPackageVersions()
    if (!path.isAbsolute(options.sessionDatabasePath)) {
      throw new TypeError('DSH Session database path must be absolute.')
    }
    if (options.developmentWorkspaceRoot !== undefined && !path.isAbsolute(options.developmentWorkspaceRoot)) {
      throw new TypeError('Development workspace root must be absolute when configured.')
    }
    const context = new Context()
    try {
      await context.plugin(NekroAssetAttachmentStore, {
        assets: options.assets,
        assetService: options.assetService,
      })
      await context.plugin((await import('@deepseek-ai/dsh-llm')).LlmRuntime)
      await options.configureLlm?.(context)
      await context.plugin(SessionStore)
      await context.plugin(SqliteSessionPersistence, {
        path: options.sessionDatabasePath,
        writeBatchMaxDelayMs: 1,
      })
      await context.plugin(SystemPrompt, { persona: '' })
      await context.plugin(ToolRuntime, { mode: 'native' })
      await context.plugin(AgentRegistry)
      await context.plugin(TokenMeter)
      await context.plugin(BasicCompactionEngine, { auto: true })
      await context.plugin(AgentLoop, { agents: [] })
      await context.plugin(SessionCheckpointPolicy)
      return new DshHostRuntime(context, options)
    } catch (error) {
      await context.fiber.dispose()
      throw error
    }
  }

  registerLlmAdapter(providers: string[], adapter: LlmAdapter): () => void {
    this.#assertActive()
    return this.#context.llm.registerAdapter(providers, adapter)
  }

  async createSession(input: Parameters<AgentSessionDriver['createSession']>[0]): Promise<string> {
    this.#assertActive()
    const sessionId = SessionId(`nxt-${input.episodeId}`)
    if (this.#context.agents.get(sessionId)) return sessionId
    const revision = this.#resolveAgentRevision(input.agentRevisionId)
    if (!revision || revision.id !== input.agentRevisionId || revision.agentId !== input.agentId) {
      throw new Error(`Cannot resolve the pinned Agent Revision: ${input.agentRevisionId}`)
    }
    const modelInfo = await this.#context.llm.resolveModelInfo(revision.model.provider, revision.model.model)
    const supportsImage = modelInfo.inputModalities?.includes('image') === true
    const setup = async (agentContext: Context): Promise<void> => {
      agentContext.effect(() => {
        this.#productAgentBySession.set(sessionId, revision.agentId)
        return () => this.#productAgentBySession.delete(sessionId)
      }, 'nekro-nxt: product Agent ownership')
      agentContext.systemPrompt.section({
        name: PERSONA_SECTION,
        order: PERSONA_ORDER,
        text: revision.persona,
      })
      agentContext.systemPrompt.section({
        name: 'nekro-nxt:channel-communication',
        order: 20,
        text: SEND_MESSAGE_POLICY,
      })
      agentContext.tools.register(communicationTool(input.episodeId, this.#communication))
      for (const tool of historyTools(input.channelId, this.#history)) agentContext.tools.register(tool)
      agentContext.tools.register(assetInspectTool(input.channelId, this.#assets))
      if (supportsImage) {
        agentContext.tools.register(
          assetViewImageTool(input.channelId, this.#assets, this.#context.attachments as NekroAssetAttachmentStore),
        )
      }
      if (revision.capabilities.dynamicCreation) {
        const dynamicContext = isolatePrivateExtensionServices(agentContext)
          .isolate('dynamicCordisRunner')
          .isolate('cordisInspect')
        await dynamicContext.plugin(DynamicCordisRunnerService, { vmTimeoutMs: 5000 })
        const runner = dynamicContext.get('dynamicCordisRunner')
        if (!(runner instanceof DynamicCordisRunnerService)) {
          throw new Error('Dynamic Cordis runner did not publish its isolated Service.')
        }
        const inspectRegistry = dynamicContext.get('cordisInspect')
        if (!inspectRegistry) throw new Error('Dynamic Cordis runner did not provide its Inspect registry.')
        dynamicContext.effect(
          () =>
            inspectRegistry.register(
              nekroNxtInspectProvider({
                episodeId: input.episodeId,
                channelId: input.channelId,
                revision,
              }),
            ),
          'nekro-nxt: inspect provider',
        )
        await dynamicContext.plugin(CordisTool)
        dynamicContext.effect(() => {
          if (this.#dynamicSessions.has(sessionId)) {
            throw new Error(`Dynamic creation is already mounted for DSH Session: ${sessionId}`)
          }
          const owned = { context: dynamicContext, runner }
          this.#dynamicSessions.set(sessionId, owned)
          return () => {
            if (this.#dynamicSessions.get(sessionId) === owned) this.#dynamicSessions.delete(sessionId)
          }
        }, 'nekro-nxt: dynamic session ownership')
      }
      await mountDevelopmentCapabilities(agentContext, revision, this.#developmentWorkspaceRoot)
      await this.#mountPersistentExtensionsIntoSession(revision.agentId, sessionId, agentContext)
    }
    const persisted = (await this.#context.sessionPersistence.list()).some(({ id }) => id === sessionId)
    const handle = persisted
      ? await this.#context.agents.resume({
          resumeSessionId: sessionId,
          agentOptions: { provider: revision.model.provider, model: revision.model.model },
          setup,
        })
      : await this.#context.agents.create({
          sessionId,
          ...((revision.capabilities.developmentShell || revision.capabilities.fullFileAccess) &&
          this.#developmentWorkspaceRoot !== undefined
            ? { meta: { cwd: this.#developmentWorkspaceRoot } }
            : {}),
          agentOptions: { provider: revision.model.provider, model: revision.model.model },
          setup,
        })
    this.#handles.set(sessionId, handle)
    if (supportsImage) this.#imageInputSessions.add(sessionId)
    if (
      input.handoff !== undefined &&
      !handle.agent.session.events.some(
        (event) =>
          event.type === 'user/message' &&
          event.data.source.kind === 'nekro-nxt-handoff' &&
          event.data.source.handoffId === input.handoff?.id,
      )
    ) {
      handle.agent.inject(
        freezeMessage({
          id: MessageId(`nxt-${input.handoff.id}`),
          role: 'user',
          content: [
            {
              type: 'text',
              text: `这是上一段连续对话的交接摘要。把它视为有来源的既有背景，并从新消息继续：\n\n${input.handoff.summary}`,
            },
          ],
          source: {
            kind: 'nekro-nxt-handoff',
            handoffId: input.handoff.id,
            fromEpisodeId: input.handoff.fromEpisodeId,
            form: 'recall',
          },
        }),
      )
      await this.#context.sessions.flush(handle.agent.session)
    }
    return sessionId
  }

  async admit(input: Parameters<AgentSessionDriver['admit']>[0]): Promise<{ readonly dshMessageId: string }> {
    this.#assertActive()
    if (input.events.length === 0) throw new Error('A DSH Admission requires at least one Channel Event.')
    const sessionId = SessionId(input.dshSessionId)
    const agent = this.#context.agents.get(sessionId)
    if (!agent) throw new Error(`DSH Agent Session is not live: ${input.dshSessionId}`)
    const dshMessageId = MessageId(`nxt-${input.admissionId}`)
    const message = freezeMessage({
      id: dshMessageId,
      role: 'user',
      content: (await Promise.all(input.events.map((event) => this.#projectEvent(sessionId, event)))).flat(),
      source: {
        kind: 'nekro-nxt-channel',
        admissionId: input.admissionId,
        channelEventIds: input.events.map(({ id }) => id),
      },
    }) satisfies UserMessage
    if (input.mode === 'inject') agent.inject(message)
    else agent.followup(message)
    await this.#context.sessions.flush(agent.session)
    return { dshMessageId }
  }

  sessionStatus(dshSessionId: string): 'idle' | 'running' {
    this.#assertActive()
    const agent = this.#context.agents.get(SessionId(dshSessionId))
    if (!agent) throw new Error(`DSH Agent Session is not live: ${dshSessionId}`)
    return agent.status
  }

  findAdmissionMessage(dshSessionId: string, admissionId: AdmissionId): string | undefined {
    this.#assertActive()
    const agent = this.#context.agents.get(SessionId(dshSessionId))
    if (!agent) throw new Error(`DSH Agent Session is not live: ${dshSessionId}`)
    for (const event of agent.session.events) {
      if (
        event.type === 'user/message' &&
        event.data.source.kind === 'nekro-nxt-channel' &&
        event.data.source.admissionId === admissionId
      ) {
        return event.data.id
      }
    }
    return undefined
  }

  async createHandoffSummary(
    input: Parameters<AgentSessionDriver['createHandoffSummary']>[0],
  ): Promise<{ readonly summary: string; readonly provider: string; readonly model: string }> {
    this.#assertActive()
    const agent = this.#context.agents.get(SessionId(input.dshSessionId))
    if (!agent) throw new Error(`DSH Agent Session is not live: ${input.dshSessionId}`)
    await agent.whenIdle()
    return agent.runMaintenance(async (signal) => {
      const entries = this.#history.listChannelHistory(input.episode.channelId, { limit: 100 }).toReversed()
      const transcript = entries
        .map((entry) => `${entry.occurredAt} ${entry.source} ${entry.sourceId}: ${JSON.stringify(entry.parts)}`)
        .join('\n')
      const message = freezeMessage({
        id: MessageId(`handoff-input-${input.episode.id}`),
        role: 'user',
        content: [
          {
            type: 'text',
            text: `请根据以下频道原文生成交接摘要。\n来源边界：${input.sourceEvents.map(({ id }) => id).join(' → ')}\n\n${transcript}`,
          },
        ],
        source: { kind: 'plugin', plugin: 'nekro-nxt-channel-runtime', form: 'recall' },
      })
      let summary = ''
      let finishKind: string | undefined
      for await (const chunk of this.#context.llm.stream({
        provider: input.revision.model.provider,
        model: input.revision.model.model,
        system:
          '你是对话交接摘要器。只输出简洁中文摘要，保留未完成目标、用户明确约束、关键决定和仍有效的资源引用；不要声称发送消息，不要调用工具。',
        messages: [message],
        maxTokens: 1024,
        signal,
      })) {
        if (chunk.type === 'text-delta') summary += chunk.text
        if (chunk.type === 'finish') finishKind = chunk.reason.kind
      }
      if (finishKind !== 'stop')
        throw new Error(`Handoff summarization did not stop cleanly: ${finishKind ?? 'missing'}`)
      summary = summary.trim()
      if (summary.length === 0) throw new Error('Handoff summarization returned no text.')
      return {
        summary,
        provider: input.revision.model.provider,
        model: input.revision.model.model,
      }
    })
  }

  async cancelSession(dshSessionId: string, reason: EpisodeCloseReason): Promise<void> {
    this.#assertActive()
    const sessionId = SessionId(dshSessionId)
    const handle = this.#handles.get(sessionId)
    if (!handle) throw new Error(`DSH Agent Session is not owned by this Host: ${dshSessionId}`)
    handle.agent.cancel({ kind: 'hook', reason })
    await handle.dispose()
    this.#handles.delete(sessionId)
    this.#imageInputSessions.delete(sessionId)
    this.#dynamicSessions.delete(sessionId)
    this.#productAgentBySession.delete(sessionId)
  }

  async applyCompatibleRevision(input: Parameters<AgentSessionDriver['applyCompatibleRevision']>[0]): Promise<void> {
    this.#assertActive()
    const agent = this.#context.agents.get(SessionId(input.dshSessionId))
    if (!agent) throw new Error(`DSH Agent Session is not live: ${input.dshSessionId}`)
    await agent.whenIdle()
  }

  async whenIdle(dshSessionId: string): Promise<void> {
    const agent = this.#context.agents.get(SessionId(dshSessionId))
    if (!agent) throw new Error(`DSH Agent Session is not live: ${dshSessionId}`)
    await agent.whenIdle()
  }

  sessionEvents(dshSessionId: string) {
    const agent = this.#context.agents.get(SessionId(dshSessionId))
    if (!agent) throw new Error(`DSH Agent Session is not live: ${dshSessionId}`)
    return agent.session.events
  }

  defineDynamicPackage(dshSessionId: string, input: DynamicPackageDefinitionInput): DynamicCordisDefineReceipt {
    const { agent, runner } = this.#dynamicRuntime(dshSessionId)
    return runner.define({
      sessionId: agent.id,
      plugin:
        input.plugin.kind === 'new'
          ? { kind: 'new', idPrefix: input.plugin.idPrefix }
          : { kind: 'existing', pluginId: CordisDynamicPluginId(input.plugin.pluginId) },
      name: input.name,
      purpose: input.purpose,
      code: input.code,
    })
  }

  runDynamicPackage(
    dshSessionId: string,
    pluginId: string,
    packageId: string,
    mode: CordisDynamicRunMode,
    signal?: AbortSignal,
  ): Promise<DynamicCordisRunResponse> {
    const { agent, runner } = this.#dynamicRuntime(dshSessionId)
    return runner
      .run(agent, CordisDynamicPluginId(pluginId), CordisDynamicPackageId(packageId), mode, signal)
      .then(async (result) => {
        if (
          result.ok &&
          result.waitingFor.some((service) =>
            EXTENSION_PRIVATE_SERVICE_KEYS.includes(service as (typeof EXTENSION_PRIVATE_SERVICE_KEYS)[number]),
          )
        ) {
          await runner.stop(agent, CordisDynamicPluginId(pluginId))
          return {
            ok: false,
            reason: 'host-half-failed',
            message: `Dynamic Extension requested a private Host Service: ${result.waitingFor.join(', ')}`,
          }
        }
        return result
      })
  }

  stopDynamicPlugin(dshSessionId: string, pluginId: string): Promise<DynamicCordisStopResponse> {
    const { agent, runner } = this.#dynamicRuntime(dshSessionId)
    return runner.stop(agent, CordisDynamicPluginId(pluginId))
  }

  undefineDynamicPlugin(dshSessionId: string, pluginId: string): Promise<DynamicCordisUndefineReceipt> {
    const { agent, runner } = this.#dynamicRuntime(dshSessionId)
    return runner.undefine(agent, CordisDynamicPluginId(pluginId))
  }

  inspectDynamicPackage(dshSessionId: string, pluginId: string, packageId: string): DynamicCordisPackageInspection {
    const { agent, runner } = this.#dynamicRuntime(dshSessionId)
    return runner.inspectPackage(agent, CordisDynamicPluginId(pluginId), CordisDynamicPackageId(packageId))
  }

  dynamicInventory(dshSessionId: string): readonly DynamicCordisInventoryRow[] {
    const { agent, runner } = this.#dynamicRuntime(dshSessionId)
    return runner.inventory().filter(({ agentId }) => agentId === agent.id)
  }

  runDynamicHostHalf(
    dshSessionId: string,
    pluginId: string,
    packageId: string,
    mode: CordisDynamicRunMode,
    requestId: string | null,
    approveFutureVersions: boolean,
  ): Promise<DynamicCordisHostHalfResult> {
    const { agent, runner } = this.#dynamicRuntime(dshSessionId)
    return runner.runHostHalf(
      agent,
      CordisDynamicPluginId(pluginId),
      CordisDynamicPackageId(packageId),
      mode,
      requestId === null ? null : ApprovalRequestId(requestId),
      approveFutureVersions,
    )
  }

  getDynamicClientCode(dshSessionId: string, pluginId: string, pluginRunId: string): DynamicCordisClientSource {
    const { agent, runner } = this.#dynamicRuntime(dshSessionId)
    return runner.getClientCode(agent, CordisDynamicPluginId(pluginId), CordisDynamicPluginRunId(pluginRunId))
  }

  resolveDynamicRunRequest(
    dshSessionId: string,
    requestId: string,
    resolution: DynamicCordisRunResolution,
  ): Promise<DynamicCordisResolveAck> {
    const { agent, runner } = this.#dynamicRuntime(dshSessionId)
    const owned = runner
      .inventory()
      .some((row) => row.agentId === agent.id && row.latestRun?.approvalRequestId === ApprovalRequestId(requestId))
    if (!owned) throw new Error('Dynamic Client approval request is not owned by this DSH Session.')
    return runner.resolveRequestRun(ApprovalRequestId(requestId), resolution)
  }

  settleDynamicUserRun(
    dshSessionId: string,
    pluginId: string,
    resolution: DynamicCordisRunResolution,
  ): Promise<DynamicCordisRunResponse> {
    const { agent, runner } = this.#dynamicRuntime(dshSessionId)
    return runner.settleUserRun(agent, CordisDynamicPluginId(pluginId), resolution)
  }

  invokeDynamicHost(
    dshSessionId: string,
    pluginId: string,
    pluginRunId: string,
    method: string,
    input: JsonValue = null,
  ): Promise<DynamicCordisInvokeResult> {
    const { agent, runner } = this.#dynamicRuntime(dshSessionId)
    const owned = runner.inventory().some((row) => row.agentId === agent.id && row.pluginId === pluginId)
    if (!owned) throw new Error('Dynamic Extension is not owned by this DSH Session.')
    return runner.invoke(CordisDynamicPluginId(pluginId), CordisDynamicPluginRunId(pluginRunId), method, input)
  }

  reportDynamicRenderFailure(
    dshSessionId: string,
    pluginId: string,
    pluginRunId: string,
    failure: DynamicCordisRenderFailure,
  ): Promise<null> {
    const { agent, runner } = this.#dynamicRuntime(dshSessionId)
    return runner.reportRenderFailure(
      agent,
      CordisDynamicPluginId(pluginId),
      CordisDynamicPluginRunId(pluginRunId),
      failure,
    )
  }

  reportDynamicGuardFailure(
    dshSessionId: string,
    pluginId: string,
    pluginRunId: string,
    failure: CordisErrorDetails,
  ): Promise<null> {
    const { agent, runner } = this.#dynamicRuntime(dshSessionId)
    return runner.reportClientGuardFailure(
      agent,
      CordisDynamicPluginId(pluginId),
      CordisDynamicPluginRunId(pluginRunId),
      failure,
    )
  }

  dynamicToolNames(dshSessionId: string): readonly string[] {
    this.#dynamicRuntime(dshSessionId)
    return this.toolNames(dshSessionId)
  }

  toolNames(dshSessionId: string): readonly string[] {
    this.#assertActive()
    const agent = this.#context.agents.get(SessionId(dshSessionId))
    if (!agent) throw new Error(`DSH Agent Session is not live: ${dshSessionId}`)
    return this.#context.tools.schemas(scopeOf(agent.ctx)).map(({ name }) => name)
  }

  async invokeExtensionHost(
    dshSessionId: string,
    extensionRevisionId: string,
    method: string,
    input: JsonValue = null,
  ): Promise<JsonValue> {
    this.#assertActive()
    const agentId = this.#productAgentBySession.get(dshSessionId)
    if (!agentId) throw new Error(`DSH Agent Session is not live: ${dshSessionId}`)
    const registration = [...this.#persistentExtensions.values()].find(
      (candidate) => candidate.agentId === agentId && candidate.revision.id === extensionRevisionId,
    )
    const handler = registration?.handlers.get(dshSessionId)?.get(method)
    if (!handler) throw new Error(`Extension Host method is unavailable: ${method}`)
    return JSON.parse(JSON.stringify(await handler(input))) as JsonValue
  }

  queryNekroNxtInspect(dshSessionId: string, method: 'currentContext' | 'extensionRules'): Promise<JsonValue> {
    const { agent, context } = this.#dynamicRuntime(dshSessionId)
    const registry = context.get('cordisInspect')
    if (!registry) throw new Error('Cordis Inspect registry is unavailable in this DSH Session.')
    return registry.query('host', 'nekro-nxt-runtime', method, {}, agent, new AbortController().signal)
  }

  async waitUntilSafe(agentId: AgentRevisionRecord['agentId']): Promise<void> {
    this.#assertActive()
    await Promise.all(
      [...this.#handles.entries()]
        .filter(([sessionId]) => this.#productAgentBySession.get(sessionId) === agentId)
        .map(([, handle]) => handle.agent.whenIdle()),
    )
  }

  async mount(
    agentId: AgentRevisionRecord['agentId'],
    revision: ExtensionRevisionRecord,
    artifact: ExtensionBuildArtifact,
    config: JsonValue,
  ): Promise<MountedExtension> {
    this.#assertActive()
    const key = `${agentId}\0${revision.extensionId}\0${revision.id}`
    if (this.#persistentExtensions.has(key)) throw new Error('Extension Revision is already mounted for this Agent.')
    const registration: PersistentExtensionRegistration = {
      key,
      agentId,
      revision,
      artifact,
      config,
      fibers: new Map(),
      mounting: new Map(),
      handlers: new Map(),
      active: true,
    }
    this.#persistentExtensions.set(key, registration)
    try {
      await Promise.all(
        [...this.#handles.entries()]
          .filter(([sessionId]) => this.#productAgentBySession.get(sessionId) === agentId)
          .map(([sessionId, handle]) =>
            this.#mountPersistentExtensionInSession(registration, sessionId, handle.agent.ctx),
          ),
      )
    } catch (error) {
      await this.#unmountPersistentExtension(registration)
      throw error
    }
    return {
      evidence: {
        hostLoaded: artifact.hostEntry !== undefined,
        clientBuilt: artifact.clientEntry !== undefined,
        details: [
          `revision:${revision.id}`,
          `sessions:${registration.fibers.size}`,
          ...(artifact.clientEntry === undefined ? [] : [`client:${path.basename(artifact.clientEntry)}`]),
        ],
      },
      dispose: () => this.#unmountPersistentExtension(registration),
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    await Promise.allSettled(
      [...this.#persistentExtensions.values()].map((entry) => this.#unmountPersistentExtension(entry)),
    )
    await Promise.allSettled([...this.#handles.values()].map((handle) => handle.dispose()))
    this.#handles.clear()
    this.#imageInputSessions.clear()
    this.#dynamicSessions.clear()
    this.#productAgentBySession.clear()
    this.#persistentExtensions.clear()
    await this.#context.fiber.dispose()
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('DSH Host Runtime is disposed.')
  }

  #dynamicRuntime(dshSessionId: string): {
    readonly agent: Agent
    readonly context: Context
    readonly runner: DynamicCordisRunnerService
  } {
    this.#assertActive()
    const agent = this.#context.agents.get(SessionId(dshSessionId))
    if (!agent) throw new Error(`DSH Agent Session is not live: ${dshSessionId}`)
    const owned = this.#dynamicSessions.get(dshSessionId)
    if (!owned) {
      throw new Error('Dynamic creation is not granted to this Agent Revision.')
    }
    return { agent, ...owned }
  }

  async #mountPersistentExtensionsIntoSession(
    agentId: AgentRevisionRecord['agentId'],
    sessionId: string,
    agentContext: Context,
  ): Promise<void> {
    for (const registration of this.#persistentExtensions.values()) {
      if (registration.agentId === agentId && registration.active) {
        await this.#mountPersistentExtensionInSession(registration, sessionId, agentContext)
      }
    }
  }

  async #mountPersistentExtensionInSession(
    registration: PersistentExtensionRegistration,
    sessionId: string,
    agentContext: Context,
  ): Promise<void> {
    if (!registration.active || registration.fibers.has(sessionId)) return
    const inFlight = registration.mounting.get(sessionId)
    if (inFlight) return inFlight
    const mounting = (async () => {
      if (!registration.artifact.hostEntry) return
      const loaded = (await import(
        `${pathToFileURL(registration.artifact.hostEntry).href}?build=${registration.artifact.buildKey}`
      )) as { readonly default?: unknown }
      if (typeof loaded.default !== 'function') throw new Error('Extension Host artifact has no default factory.')
      const factory = loaded.default as ExtensionPluginFactory<ExtensionHostEnvironment>
      const handlers = new Map<
        string,
        (input: ExtensionJsonValue) => ExtensionJsonValue | Promise<ExtensionJsonValue>
      >()
      const plugin = await factory({
        harness: {
          // `defineTool` is the runtime validator; dynamic source cannot preserve its const-generic input type.
          defineTool: (options: unknown) => defineTool(options as never),
          registerTool: (context: unknown, tool: unknown) => {
            if ((typeof context !== 'object' && typeof context !== 'function') || context === null) {
              throw new TypeError('Extension Tool registration requires its Extension Context.')
            }
            const extensionContext = context as {
              readonly tools?: { register(toolDefinition: ToolDefinition): () => void }
            }
            if (!extensionContext.tools) throw new TypeError('Extension Context does not provide Tool registration.')
            return extensionContext.tools.register(tool as ToolDefinition)
          },
          handle: (
            method: string,
            handler: (input: ExtensionJsonValue) => ExtensionJsonValue | Promise<ExtensionJsonValue>,
          ) => {
            if (!method.trim() || typeof handler !== 'function') throw new TypeError('Invalid Extension Host handler.')
            if (handlers.has(method)) throw new Error(`Extension Host handler is already registered: ${method}`)
            handlers.set(method, handler)
            let active = true
            const dispose = () => {
              if (!active) return
              active = false
              if (handlers.get(method) === handler) handlers.delete(method)
            }
            return dispose
          },
        },
        config: registration.config,
      })
      if (typeof plugin !== 'object' || plugin === null) {
        throw new TypeError('Extension Host factory must return a Cordis Plugin object.')
      }
      const forbiddenServices = plugin.inject?.filter((service) => !PERSISTENT_EXTENSION_HOST_SERVICES.has(service))
      if (forbiddenServices && forbiddenServices.length > 0) {
        throw new Error(`Extension Host requested unavailable Services: ${forbiddenServices.join(', ')}`)
      }
      const extensionContext = isolatePrivateExtensionServices(agentContext)
      const extensionPlugin = {
        ...(plugin.inject === undefined ? {} : { inject: [...plugin.inject] }),
        apply: (context: Context) => plugin.apply(persistentExtensionContext(context)),
      }
      const fiber = extensionContext.plugin(extensionPlugin)
      try {
        await fiber
      } catch (error) {
        await fiber.dispose()
        throw error
      }
      if (!registration.active) {
        await fiber.dispose()
        return
      }
      registration.fibers.set(sessionId, fiber)
      registration.handlers.set(sessionId, handlers)
      fiber.ctx.effect(
        () => () => {
          handlers.clear()
          registration.handlers.delete(sessionId)
          registration.fibers.delete(sessionId)
        },
        'nekro-nxt: Extension session mount',
      )
    })().finally(() => registration.mounting.delete(sessionId))
    registration.mounting.set(sessionId, mounting)
    return mounting
  }

  async #unmountPersistentExtension(registration: PersistentExtensionRegistration): Promise<void> {
    if (!registration.active && !this.#persistentExtensions.has(registration.key)) return
    registration.active = false
    if (this.#persistentExtensions.get(registration.key) === registration) {
      this.#persistentExtensions.delete(registration.key)
    }
    await Promise.allSettled([...registration.mounting.values()])
    const fibers = [...registration.fibers.values()]
    registration.fibers.clear()
    registration.handlers.clear()
    await Promise.allSettled(fibers.map((fiber) => fiber.dispose()))
  }

  async #projectEvent(sessionId: SessionId, event: ChannelEventRecord): Promise<ContentBlock[]> {
    const blocks = projectEvent(event).filter(
      (block) =>
        !(
          block.type === 'text' &&
          event.parts.some((part) => part.type === 'image' && block.text.startsWith(`收到图片资源 ${part.assetId}`))
        ),
    )
    for (const part of event.parts) {
      if (part.type !== 'image') continue
      if (!this.#assets.canAccessAsset(part.assetId, event.channelId)) {
        blocks.push({ type: 'text', text: `图片资源 ${part.assetId} 当前不可访问。` })
        continue
      }
      const asset = this.#assets.getAssetById(part.assetId)
      if (!asset) {
        blocks.push({ type: 'text', text: `图片资源 ${part.assetId} 的元数据不可用。` })
        continue
      }
      if (this.#imageInputSessions.has(sessionId)) {
        const attachment = await (this.#context.attachments as NekroAssetAttachmentStore).refForAsset(asset, part.alt)
        blocks.push({ type: 'image', attachment })
        continue
      }
      const enrichment = this.#assets
        .listAssetEnrichments(asset.id)
        .toReversed()
        .find(({ state }) => state === 'succeeded')
      blocks.push({
        type: 'text',
        text: enrichment
          ? `图片资源 ${asset.id} 的不可信派生理解（${enrichment.enhancerId}/v${enrichment.promptVersion}）：${enrichment.summary ?? '无摘要'}${enrichment.ocrText ? `；OCR：${enrichment.ocrText}` : ''}`
          : `图片资源 ${asset.id} 已收到，但当前模型不支持图片输入，图片增强结果暂不可用。`,
      })
    }
    return blocks
  }
}

/** Composes Extension switching with Channel Episode handoff instead of hot-replacing a live Session. */
export class ChannelExtensionActivationHost implements ExtensionActivationHost {
  readonly #channels: ChannelRuntime
  readonly #dsh: DshHostRuntime

  constructor(channels: ChannelRuntime, dsh: DshHostRuntime) {
    this.#channels = channels
    this.#dsh = dsh
  }

  async waitUntilSafe(agentId: AgentRevisionRecord['agentId']): Promise<void> {
    await this.#dsh.waitUntilSafe(agentId)
    await this.#channels.rolloverAgentActivations(agentId)
  }

  mount(
    agentId: AgentRevisionRecord['agentId'],
    revision: ExtensionRevisionRecord,
    artifact: ExtensionBuildArtifact,
    config: JsonValue,
  ): Promise<MountedExtension> {
    return this.#dsh.mount(agentId, revision, artifact, config)
  }
}

export { HOST_DSH_PACKAGE_VERSIONS }
