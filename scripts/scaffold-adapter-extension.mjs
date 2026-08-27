import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const readArg = (name) => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

const key = readArg('--key')?.trim()
const displayName = readArg('--name')?.trim()
const outputArg = readArg('--out')?.trim()
const rich = process.argv.includes('--rich')
if (!key || !/^[a-z][a-z0-9-]{1,62}[a-z0-9]$/u.test(key) || !displayName || !outputArg) {
  console.error('用法：pnpm scaffold:adapter --key <adapter-key> --name <展示名> --out <目标目录> [--rich]')
  process.exit(1)
}

const output = path.resolve(outputArg)
if (
  await stat(output).then(
    () => true,
    () => false,
  )
) {
  console.error(`目标已存在，脚手架不会覆盖：${output}`)
  process.exit(1)
}

const q = JSON.stringify
const moduleImport = 'import'
const moduleFrom = 'from'
const files = new Map([
  [
    'source/definition.ts',
    `import type { AdapterHostContributionV1 } from '@nekro-nxt/extension-sdk'
${moduleImport} { createRuntime } ${moduleFrom} './runtime.js'

export const ADAPTER_KEY = ${q(key)}
export const descriptor: AdapterHostContributionV1['descriptor'] = {
  key: ADAPTER_KEY,
  displayName: ${q(displayName)},
  description: '连接 ${displayName}；请将示例协议替换为平台公开协议。',
  userCreatable: true,
  aliasEditable: true,
  channelDiscovery: 'adapter-observed',
  diagnostics: { receive: true, send: true },
  configSchema: {
    schemaVersion: 1,
    type: 'object',
    required: ['websocketUrl', 'apiBaseUrl', 'token'],
    properties: {
      websocketUrl: { type: 'string', title: 'WebSocket 地址', default: 'wss://${key}.example.invalid/events' },
      apiBaseUrl: { type: 'string', title: 'API 地址', default: 'https://${key}.example.invalid/api' },
      token: { type: 'credential-reference', credentialKey: 'token', title: '访问令牌' },
    },
  },
}

export const contribution: AdapterHostContributionV1 = {
  apiVersion: 1,
  descriptor,
  create: (context, stored) => Promise.resolve(createRuntime(context, stored)),
}
`,
  ],
  [
    'source/transport.ts',
    `import type { AdapterConnectionHostContext, AdapterWebSocketConnection } from '@nekro-nxt/extension-sdk'

export const connectEvents = (
  context: AdapterConnectionHostContext,
  websocketUrl: string,
  tokenReference: string,
): Promise<AdapterWebSocketConnection> =>
  context.credentials.resolve(tokenReference).then((token) =>
    context.transport.connectWebSocket({ url: websocketUrl, headers: { authorization: 'Bearer ' + token } })
  )
`,
  ],
  [
    'source/inbound.ts',
    `export interface ExampleInbound {
  readonly eventId: string
  readonly messageId: string
  readonly channelId: string
  readonly channelName?: string
  readonly senderId: string
  readonly senderName?: string
  readonly text: string
}

export const parseInbound = (data: string | Uint8Array): ExampleInbound => {
  const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
  const value = JSON.parse(text)
  if (!value || typeof value !== 'object' || typeof value.eventId !== 'string' || typeof value.channelId !== 'string' || typeof value.text !== 'string') {
    throw new TypeError('Invalid ${displayName} inbound event.')
  }
  return value
}
`,
  ],
  [
    'source/runtime.ts',
    `import type {
  AdapterConnectionHostContext,
  AdapterConnectionRuntime,
  AdapterStoredConnectionConfiguration,
  PhysicalDeliveryRequest,
} from '@nekro-nxt/extension-sdk'
${moduleImport} { ADAPTER_KEY } ${moduleFrom} './definition.js'
${moduleImport} { parseInbound } ${moduleFrom} './inbound.js'
${moduleImport} { connectEvents } ${moduleFrom} './transport.js'

export const createRuntime = (
  context: AdapterConnectionHostContext,
  stored: AdapterStoredConnectionConfiguration,
): AdapterConnectionRuntime => {
  let socket: Awaited<ReturnType<typeof connectEvents>> | undefined
  let unsubscribe: (() => void) | undefined
  const websocketUrl = String(stored.configuration.websocketUrl)
  const apiBaseUrl = String(stored.configuration.apiBaseUrl)
  const tokenReference = stored.credentialRefs.token
  if (!tokenReference) throw new Error('Missing token credential reference.')
  return {
    capabilities: {
      text: true,
      mentions: false,
      images: false,
      files: false,
      audio: false,
      replies: false,
      mixedContent: false,
      proactiveSend: true,
    },
    async start() {
      socket = await connectEvents(context, websocketUrl, tokenReference)
      unsubscribe = socket.subscribe((event) => {
        if (event.type === 'open') context.diagnostics.publish({ status: 'connected' })
        if (event.type !== 'message') return
        void (async () => {
          const input = parseInbound(event.data)
          const channelId = await context.channels.ensure({
            platformChannelId: input.channelId,
            kind: 'group',
            ...(input.channelName === undefined ? {} : { displayName: input.channelName }),
            observedAt: context.now(),
          })
          const senderMemberId = await context.members.ensure({
            channelId,
            platformUserId: input.senderId,
            ...(input.senderName === undefined ? {} : { displayName: input.senderName }),
            observedAt: context.now(),
          })
          await context.acceptInbound({
            connectionId: context.connectionId,
            channelId,
            adapterKey: ADAPTER_KEY,
            platformEventId: input.eventId,
            platformMessageId: input.messageId,
            kind: 'message-created',
            senderMemberId,
            parts: [{ type: 'text', text: input.text }],
            platformTimestamp: context.now(),
            receivedAt: context.now(),
            dedupeKey: input.eventId,
          })
        })().catch((error) => context.diagnostics.publish({ status: 'failed', message: String(error) }))
      })
    },
    async stop() {
      unsubscribe?.()
      unsubscribe = undefined
      await socket?.close(1000, 'adapter stopped')
      socket = undefined
      context.diagnostics.publish({ status: 'stopped' })
    },
    async deliver(request: PhysicalDeliveryRequest, signal: AbortSignal) {
      const token = await context.credentials.resolve(tokenReference)
      const response = await context.transport.request({
        url: apiBaseUrl + '/messages',
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({
          channelId: await context.channels.resolvePlatformChannelId(request.channelId),
          text: request.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\\n'),
        }),
        signal,
      })
      return response.status >= 200 && response.status < 300
        ? { status: 'sent', platformMessageId: 'example-' + request.deliveryId }
        : { status: 'failed', failure: { kind: 'transient', message: 'HTTP ' + response.status } }
    },
  }
}
`,
  ],
  [
    'source/host.ts',
    `import { defineHostExtension } from '@nekro-nxt/extension-sdk'
${moduleImport} { contribution } ${moduleFrom} './definition.js'

export default defineHostExtension(async ({ harness }) => {
  harness.registerAdapter(contribution)
  return { apply() {} }
})
`,
  ],
  [
    'tests/runtime.spec.ts',
    `import { createFakeAdapterHostContext } from '@nekro-nxt/test-harness'
import { LogicalMessageIdSchema, PhysicalDeliveryIdSchema } from '@nekro-nxt/contracts'
import { describe, expect, it } from 'vitest'
${moduleImport} { contribution } ${moduleFrom} '../source/definition.js'

describe('${displayName} Adapter scaffold', () => {
  it('parses config, discovers inbound, returns outbound receipt, and stops without resources', async () => {
    const fake = createFakeAdapterHostContext()
    fake.credentials.set('cred-token', 'synthetic-token')
    const runtime = await contribution.create(fake.context, {
      configuration: {
        websocketUrl: 'wss://${key}.example.invalid/events',
        apiBaseUrl: 'https://${key}.example.invalid/api',
      },
      credentialRefs: { token: 'cred-token' },
    })
    await runtime.start()
    fake.transport.sockets[0]?.emit({
      type: 'message',
      data: JSON.stringify({
        eventId: 'event-example', messageId: 'message-example', channelId: 'channel-example',
        senderId: 'user-example', text: 'hello'
      }),
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(fake.events).toHaveLength(1)
    const channelId = [...fake.channels.values()][0]!
    const receipt = await runtime.deliver({
      deliveryId: PhysicalDeliveryIdSchema.parse('phy_EXAMPLE'),
      logicalMessageId: LogicalMessageIdSchema.parse('msg_EXAMPLE'),
      connectionId: fake.context.connectionId,
      channelId, parts: [{ type: 'text', text: 'world' }]
    }, new AbortController().signal)
    expect(receipt.status).toBe('sent')
    await runtime.stop()
    fake.assertIdle()
  })
})
`,
  ],
  [
    'package.json',
    `${JSON.stringify(
      {
        name: `nekro-nxt-adapter-${key}`,
        private: true,
        type: 'module',
        scripts: { test: 'vitest run' },
        dependencies: { '@nekro-nxt/extension-sdk': 'workspace:*' },
        devDependencies: {
          '@nekro-nxt/contracts': 'workspace:*',
          '@nekro-nxt/test-harness': 'workspace:*',
          vitest: '^4.1.8',
          typescript: '^6.0.3',
        },
      },
      null,
      2,
    )}\n`,
  ],
  [
    'README.md',
    `# ${displayName} Adapter Extension

这是由 NekroNXT 适配器脚手架生成的离线起点。示例主机只使用 example.invalid，测试通过 Fake Host/HTTP/WebSocket 运行，不连接真实平台。

实现顺序：完善 definition.ts 的版本化 Schema；在 transport.ts 使用 Host Transport；在 inbound.ts 严格校验平台事件；在 runtime.ts 完成频道发现、入站提交、出站回执和可等待的 stop。动态运行、保存 Revision、安装到本机仍是三个独立动作。
`,
  ],
])

if (rich) {
  files.set(
    'source/client.ts',
    `import { defineAdapterClientExtension } from '@nekro-nxt/extension-sdk'

export default defineAdapterClientExtension(async ({ React }) => ({
  inject: ['slots'],
  apply(ctx) {
    ctx.slots.register(
      { name: 'conversation.message.rich', id: '${key}:example-card' },
      ({ part }) => React.createElement('article', null, part.title ?? part.summary),
    )
  },
}))
`,
  )
}

for (const [relative, content] of files) {
  const target = path.join(output, relative)
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  await writeFile(target, content, 'utf8')
}

console.log(`已创建适配器脚手架：${output}`)
