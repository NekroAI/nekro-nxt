import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { highestPermissionLevel, materializeImportedRevision, summarizePermissions } from '@nekro-nxt/extension-format'
import {
  AgentIdSchema,
  ChannelIdSchema,
  EpisodeIdSchema,
  HostApiContracts,
  type AgentId,
  type ExtensionId,
} from '@nekro-nxt/contracts'
import { NekroRuntime } from '../src/bootstrap.js'
import { createNekroHostApi } from '../src/host-api.js'
import { ExtensionActionSchema, type ExtensionActor } from '../src/extension-governance/actions.js'
import { ExtensionCommandPort } from '../src/extension-governance/commands.js'
import { ExtensionGovernanceTools } from '../src/extension-governance/tool-port.js'
import { extensionAgentTools } from '../src/extension-governance/agent-tools.js'

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

const createRuntime = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nxt-configure-'))
  directories.push(directory)
  const runtime = await NekroRuntime.create({
    coreDatabasePath: path.join(directory, 'core.sqlite'),
    sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
    assetRoot: path.join(directory, 'assets'),
    extensionDataRoot: path.join(directory, 'extensions'),
    extensionCacheRoot: path.join(directory, 'cache'),
  })
  await runtime.start()
  return runtime
}

/** Fails to start when the host `fail` setting is on, so a bad configuration can be told apart. */
const SOURCE = `export default ({ harness }) => {
  if (harness.config().fail === true) throw new Error('虚构的启动失败')
  harness.handle('ping', () => 'ok')
  return {
    inject: ['tools'],
    apply(ctx) {
      harness.registerTool(ctx, harness.defineTool({
        name: 'config_probe',
        description: '配置探针',
        parameters: {},
        output: { schema: { type: 'string' }, render(_args, value) { return [{ type: 'text', text: value }] } },
        execute() { return String(ctx.config().city) },
      }))
    },
  }
}`

/** Every field level in both layers; an imported extension may keep fields for administrators. */
const importConfigured = async (runtime: NekroRuntime) => {
  const content = materializeImportedRevision({
    manifest: {
      schemaVersion: 7,
      requires: { sdk: 12 },
      extensionId: 'ext_CONFIGURED',
      revisionId: 'xrv_CONFIGUREDONE',
      entrypoints: { host: 'source/host.ts' },
      permissions: {
        permissions: [],
        networkOrigins: [],
        agent: { network: { mode: 'config', fields: ['baseUrl'] } },
        host: { network: { mode: 'config', fields: ['hostUrl'] } },
      },
      contributions: [
        { kind: 'tool', name: 'config_probe', description: '配置探针' },
        { kind: 'rpc', method: 'ping' },
      ],
      config: {
        host: {
          schema: {
            type: 'object',
            dict: {
              region: { type: 'string', meta: { description: '地区', default: '示例区' } },
              hostUrl: { type: 'string', meta: { description: '本机服务地址' } },
              billing: { type: 'boolean', meta: { description: '计费', default: false, agentWritable: false } },
              fail: { type: 'boolean', meta: { description: '故障开关', default: false } },
            },
          },
        },
        agent: {
          schema: {
            type: 'object',
            dict: {
              city: { type: 'string', meta: { description: '城市', default: '示例市' } },
              greeting: { type: 'string', meta: { description: '问候语', required: true } },
              baseUrl: { type: 'string', meta: { description: '服务地址' } },
              apiKey: { type: 'string', meta: { description: 'API Key', role: 'secret' } },
              plan: { type: 'string', meta: { description: '套餐', default: 'free', agentWritable: false } },
            },
          },
        },
      },
    },
    sources: { host: SOURCE },
  })
  const { extension } = await runtime.extensionService.importRevision({
    extension: { id: content.manifest.extensionId, slug: 'configured-probe', displayName: '配置探针', description: '' },
    revision: {
      id: content.manifest.revisionId,
      contentDigest: content.contentDigest,
      payloadDigest: content.payloadDigest,
    },
    manifest: content.manifest,
    sources: content.sources,
  })
  return extension.id
}

let channelSequence = 0

const agentWithChannel = (
  runtime: NekroRuntime,
  autonomy: 'manual' | 'confirm' | 'autonomous',
  configRequesters: 'admins' | 'everyone' = 'admins',
) => {
  const agent = runtime.core.createAgent({
    displayName: `配置智能体${++channelSequence}`,
    persona: '',
    model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    capabilities: { extensionAutonomy: autonomy, extensionConfigRequesters: configRequesters },
  })
  const channel = runtime.core.createChannel({
    connectionId: runtime.internalConnectionId,
    platformChannelId: `configure-${channelSequence}`,
    kind: 'internal',
  })
  runtime.core.createBinding({ channelId: channel.id, agentId: agent.definition.id, triggerPolicy: 'observe-only' })
  return { agentId: agent.definition.id, channelId: channel.id }
}

const addCredential = (runtime: NekroRuntime, name: string, autoUse: boolean) =>
  runtime.credentialLibrary.create({
    kind: 'generic',
    name,
    domains: ['api.weather.test'],
    value: `fictional-${autoUse ? 'auto' : 'asked'}-weather-value`,
    autoUse,
  })

const enableAsConsole = (runtime: NekroRuntime, extensionId: ExtensionId, agentId: AgentId) =>
  runtime.extensionActions.perform(
    { kind: 'enable', extensionId, agentId, values: { greeting: '你好' } },
    { kind: 'console' },
  )

type Level = 'normal' | 'network' | 'secret' | 'admin'
type Layer = 'agent' | 'host'

/** A change to one field of `level` in `layer`; credentials bind one the agent may use without asking. */
const change = (extensionId: ExtensionId, agentId: AgentId, layer: Layer, level: Level) => {
  const fields: Record<
    Layer,
    Record<Level, { values?: Record<string, string | boolean>; credentials?: Record<string, string> }>
  > = {
    agent: {
      normal: { values: { city: '虚构城' } },
      network: { values: { baseUrl: 'https://weather.example.test' } },
      secret: { credentials: { apiKey: '天气服务' } },
      admin: { values: { plan: 'pro' } },
    },
    host: {
      normal: { values: { region: '虚构区' } },
      network: { values: { hostUrl: 'https://host.example.test' } },
      secret: { values: { region: '虚构区' } },
      admin: { values: { billing: true } },
    },
  }
  return {
    kind: 'configure' as const,
    extensionId,
    layer,
    ...(layer === 'agent' ? { agentId } : {}),
    values: fields[layer][level].values ?? {},
    credentials: fields[layer][level].credentials ?? {},
  }
}

/**
 * The rules of 智能体扩展配置与凭据 C10 and C11, stated once: administrator-only fields go to the console; with
 * administrators as requesters, members are refused; with everyone, members only change ordinary fields of the agent's
 * own configuration; then manual autonomy is console-only, the host layer and network fields ask, and the rest follow
 * autonomy.
 */
const expected = (row: {
  readonly autonomy: 'manual' | 'confirm' | 'autonomous'
  readonly setting: 'admins' | 'everyone'
  readonly requester: 'admin' | 'member'
  readonly layer: Layer
  readonly level: Level
}): 'run' | 'request' | 'console' => {
  if (row.level === 'admin') return 'console'
  if (row.requester === 'member') {
    if (row.setting === 'admins') return 'console'
    if (row.layer === 'host' || row.level !== 'normal') return 'console'
  }
  if (row.autonomy === 'manual') return 'console'
  if (row.layer === 'host' || row.level === 'network') return 'request'
  return row.autonomy === 'confirm' ? 'request' : 'run'
}

describe('configure gating', () => {
  it('decides by field level, layer, requester, setting and autonomy', async () => {
    const runtime = await createRuntime()
    try {
      const extensionId = await importConfigured(runtime)
      await addCredential(runtime, '天气服务', true)
      const rows: Parameters<typeof expected>[0][] = []
      for (const autonomy of ['manual', 'confirm', 'autonomous'] as const)
        for (const setting of ['admins', 'everyone'] as const)
          for (const requester of ['admin', 'member'] as const)
            for (const layer of ['agent', 'host'] as const)
              for (const level of ['normal', 'network', 'secret', 'admin'] as const) {
                // The host layer of this fixture has no credential field.
                if (layer === 'host' && level === 'secret') continue
                rows.push({ autonomy, setting, requester, layer, level })
              }
      // Each combination of autonomy and setting is one agent with the extension enabled.
      const agents = new Map<string, AgentId>()
      for (const row of rows) {
        const key = `${row.autonomy}:${row.setting}`
        if (agents.has(key)) continue
        const { agentId } = agentWithChannel(runtime, row.autonomy, row.setting)
        await enableAsConsole(runtime, extensionId, agentId)
        agents.set(key, agentId)
      }
      const decisions = rows.map((row) => {
        const agentId = agents.get(`${row.autonomy}:${row.setting}`)!
        const actor: ExtensionActor = { kind: 'agent', agentId, requester: row.requester }
        return {
          ...row,
          decision: runtime.extensionActions.assess(change(extensionId, agentId, row.layer, row.level), actor).decision,
        }
      })
      expect(decisions).toEqual(rows.map((row) => ({ ...row, decision: expected(row) })))
      expect(rows).toHaveLength(84)

      // Chat administrators change anything but administrator-only fields; the console changes everything.
      const agentId = agents.get('autonomous:admins')!
      const administrator = { kind: 'administrator', label: '管理员' } as const
      for (const level of ['normal', 'network', 'secret'] as const) {
        expect(
          runtime.extensionActions.assess(change(extensionId, agentId, 'agent', level), administrator).decision,
        ).toBe('run')
      }
      expect(
        runtime.extensionActions.assess(change(extensionId, agentId, 'agent', 'admin'), administrator),
      ).toMatchObject({ decision: 'console', reason: expect.stringContaining('套餐') as unknown })
      expect(
        runtime.extensionActions.assess(change(extensionId, agentId, 'agent', 'admin'), { kind: 'console' }).decision,
      ).toBe('run')
    } finally {
      await runtime.dispose()
    }
  })

  it('asks before binding a credential whose automatic use is off and refuses another agent’s configuration', async () => {
    const runtime = await createRuntime()
    try {
      const extensionId = await importConfigured(runtime)
      await addCredential(runtime, '审批凭据', false)
      const own = agentWithChannel(runtime, 'autonomous')
      const other = agentWithChannel(runtime, 'autonomous')
      await enableAsConsole(runtime, extensionId, own.agentId)
      await enableAsConsole(runtime, extensionId, other.agentId)
      const actor: ExtensionActor = { kind: 'agent', agentId: own.agentId, requester: 'admin' }
      expect(
        runtime.extensionActions.assess(
          { ...change(extensionId, own.agentId, 'agent', 'secret'), credentials: { apiKey: '审批凭据' } },
          actor,
        ),
      ).toMatchObject({ decision: 'request', reason: expect.stringContaining('审批凭据') as unknown })
      expect(
        runtime.extensionActions.assess(change(extensionId, other.agentId, 'agent', 'normal'), actor),
      ).toMatchObject({
        decision: 'console',
        reason: '只能修改自己的智能体配置。',
      })
      expect(() =>
        runtime.extensionActions.configPlan({
          ...change(extensionId, own.agentId, 'agent', 'normal'),
          values: { apiKey: '明文' },
        }),
      ).toThrow('是凭据，不能直接写值')
      expect(() =>
        runtime.extensionActions.configPlan({
          ...change(extensionId, own.agentId, 'agent', 'normal'),
          values: { nope: 1 },
        }),
      ).toThrow('没有这些字段')
    } finally {
      await runtime.dispose()
    }
  })
})

describe('configure in effect', () => {
  it('merges the changes of one turn into one write after it ends and records who asked', async () => {
    const runtime = await createRuntime()
    try {
      const extensionId = await importConfigured(runtime)
      const entity = agentWithChannel(runtime, 'autonomous')
      await enableAsConsole(runtime, extensionId, entity.agentId)
      const tools = new ExtensionGovernanceTools(runtime)
      let endTurn: () => void = () => undefined
      const turn = new Promise<void>((resolve) => {
        endTurn = resolve
      })
      vi.spyOn(runtime.host, 'waitUntilSafe').mockReturnValue(turn)
      const notify = vi.spyOn(runtime.host, 'notifyAgent')
      const admin = { kind: 'admin' } as const
      const first = await tools.act(
        entity.agentId,
        entity.channelId,
        { ...change(extensionId, entity.agentId, 'agent', 'normal'), reason: '换城市' },
        admin,
      )
      const second = await tools.act(
        entity.agentId,
        entity.channelId,
        { ...change(extensionId, entity.agentId, 'agent', 'normal'), values: { greeting: '早上好' }, reason: '换问候' },
        admin,
      )
      expect([first.outcome, second.outcome]).toEqual(['scheduled', 'scheduled'])
      expect(second.message).toContain('已并入')
      // Nothing is written while the turn is still going.
      expect(runtime.repository.getActivation(entity.agentId, extensionId)?.config).toMatchObject({ city: '示例市' })
      endTurn()
      await expect
        .poll(() => runtime.repository.getActivation(entity.agentId, extensionId)?.config)
        .toMatchObject({ city: '虚构城', greeting: '早上好' })
      const versions = runtime.extensionConfig.versions({ extensionId, layer: 'agent', agentId: entity.agentId })
      expect(versions.map((version) => [version.version, version.source])).toEqual([
        [2, 'agent'],
        [1, 'console'],
      ])
      expect(versions[0]).toMatchObject({ actorAgentId: entity.agentId, reason: '换城市；换问候' })
      await expect.poll(() => notify.mock.calls.map(([input]) => input.text).join('\n')).toContain('已完成')
    } finally {
      await runtime.dispose()
    }
  })

  it('writes a network field only after an administrator approves the request', async () => {
    const runtime = await createRuntime()
    try {
      const extensionId = await importConfigured(runtime)
      const entity = agentWithChannel(runtime, 'autonomous')
      await enableAsConsole(runtime, extensionId, entity.agentId)
      const tools = new ExtensionGovernanceTools(runtime)
      const asked = await tools.act(
        entity.agentId,
        entity.channelId,
        change(extensionId, entity.agentId, 'agent', 'network'),
        { kind: 'admin' },
      )
      expect(asked.outcome).toBe('requested')
      expect(runtime.repository.getActivation(entity.agentId, extensionId)?.config).not.toHaveProperty('baseUrl')
      await runtime.extensionRequests.approve(asked.requestNumber!, { kind: 'administrator', label: '虚构管理员' })
      expect(runtime.repository.getActivation(entity.agentId, extensionId)?.config).toMatchObject({
        baseUrl: 'https://weather.example.test',
      })
      expect(
        runtime.extensionConfig.versions({ extensionId, layer: 'agent', agentId: entity.agentId })[0],
      ).toMatchObject({ source: 'agent', actorAgentId: entity.agentId })
    } finally {
      await runtime.dispose()
    }
  })

  it('keeps the previous configuration when the extension fails to start with the new one and tells the agent', async () => {
    const runtime = await createRuntime()
    try {
      const extensionId = await importConfigured(runtime)
      const entity = agentWithChannel(runtime, 'autonomous')
      await enableAsConsole(runtime, extensionId, entity.agentId)
      const tools = new ExtensionGovernanceTools(runtime)
      const notify = vi.spyOn(runtime.host, 'notifyAgent')
      const asked = await tools.act(
        entity.agentId,
        entity.channelId,
        { ...change(extensionId, entity.agentId, 'host', 'normal'), values: { fail: true } },
        { kind: 'admin' },
      )
      expect(asked.outcome).toBe('requested')
      await expect(runtime.extensionRequests.approve(asked.requestNumber!, { kind: 'console' })).rejects.toThrow(
        '虚构的启动失败',
      )
      const told = notify.mock.calls.map(([input]) => input.text).join('\n')
      expect(told).toContain('虚构的启动失败')
      expect(told).toContain('原来的配置')
      expect(runtime.repository.getHostInstallation(extensionId)?.config).toMatchObject({ fail: false })
      expect(runtime.extensions.liveRevision(extensionId)).toBeDefined()
      expect(runtime.extensionConfig.versions({ extensionId, layer: 'host' })).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  it('applies the previous version again as an automatic revert when the old mount did not come back', async () => {
    const runtime = await createRuntime()
    try {
      const extensionId = await importConfigured(runtime)
      const entity = agentWithChannel(runtime, 'autonomous')
      await enableAsConsole(runtime, extensionId, entity.agentId)
      const owner = { extensionId, layer: 'agent' as const, agentId: entity.agentId }
      const attached = vi.spyOn(runtime.extensions, 'isAttached')
      attached.mockReturnValueOnce(true).mockReturnValueOnce(false)
      const update = vi.spyOn(runtime.extensions, 'updateAgentConfig')
      update.mockRejectedValueOnce(new Error('虚构的挂载失败'))
      await expect(
        runtime.extensionConfig.writeOrRestore({
          owner,
          config: { city: '坏城', greeting: '你好' },
          meta: { source: 'agent' },
        }),
      ).rejects.toThrow('虚构的挂载失败')
      expect(update).toHaveBeenLastCalledWith(entity.agentId, extensionId, expect.objectContaining({ city: '示例市' }))
      expect(runtime.extensionConfig.versions(owner)[0]).toMatchObject({
        source: 'auto-revert',
        reason: '虚构的挂载失败',
      })
    } finally {
      await runtime.dispose()
    }
  })
})

describe('enable with configuration', () => {
  it('takes required values with enabling and only sends administrator-only gaps to the console', async () => {
    const runtime = await createRuntime()
    try {
      const extensionId = await importConfigured(runtime)
      const entity = agentWithChannel(runtime, 'autonomous')
      const tools = new ExtensionGovernanceTools(runtime)
      expect(runtime.extensionActions.enablementProblem(entity.agentId, extensionId)).toBeUndefined()
      expect(runtime.extensionActions.enablementMissing(entity.agentId, extensionId)).toContain('greeting')
      await expect(
        tools.act(entity.agentId, entity.channelId, { kind: 'enable', extensionId, agentId: entity.agentId }),
      ).rejects.toThrow('values')
      const enable = { kind: 'enable' as const, extensionId, agentId: entity.agentId, values: { greeting: '你好' } }
      // Judged together: a member may not set values under the default setting.
      expect(
        runtime.extensionActions.assess(enable, { kind: 'agent', agentId: entity.agentId, requester: 'member' }),
      ).toMatchObject({ decision: 'console' })
      expect(
        runtime.extensionActions.assess(
          { ...enable, values: { greeting: '你好', plan: 'pro' } },
          { kind: 'agent', agentId: entity.agentId, requester: 'admin' },
        ),
      ).toMatchObject({ decision: 'console', reason: expect.stringContaining('套餐') as unknown })
      await runtime.extensionActions.perform(enable, { kind: 'administrator', label: '虚构管理员' })
      expect(runtime.repository.getActivation(entity.agentId, extensionId)?.config).toMatchObject({
        greeting: '你好',
        city: '示例市',
      })
      expect(runtime.extensionConfig.versions({ extensionId, layer: 'agent', agentId: entity.agentId })).toMatchObject([
        { version: 1, source: 'chat-admin' },
      ])
    } finally {
      await runtime.dispose()
    }
  })
})

describe('configuration history', () => {
  it('records console writes and agent writes, and reverts by writing an old version again', async () => {
    const runtime = await createRuntime()
    const webContext = new Context()
    try {
      const extensionId = await importConfigured(runtime)
      const entity = agentWithChannel(runtime, 'autonomous')
      await enableAsConsole(runtime, extensionId, entity.agentId)
      await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
      const api = createNekroHostApi(webContext.webServer, runtime)
      const call = async (pathname: string, method: string, body?: unknown) => {
        const response = await fetch(`http://127.0.0.1:${api.port}${pathname}`, {
          method,
          ...(body === undefined
            ? {}
            : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        })
        return { status: response.status, json: (await response.json()) as unknown }
      }
      const saved = await call(`/api/agents/${entity.agentId}/extensions/${extensionId}/activation/config`, 'PUT', {
        config: { city: '控制台城', greeting: '你好', plan: 'free' },
      })
      expect(saved.status).toBe(200)
      await runtime.extensionActions.perform(
        { ...change(extensionId, entity.agentId, 'agent', 'normal'), actorAgentId: entity.agentId, reason: '用户要求' },
        { kind: 'administrator', label: '虚构管理员' },
      )
      const listed = HostApiContracts.getExtensionConfigVersions.parseResponse(
        (await call(`/api/extensions/${extensionId}/config-versions`, 'GET')).json,
      )
      expect(listed.versions.map((version) => [version.version, version.source, version.config])).toEqual([
        [3, 'agent', expect.objectContaining({ city: '虚构城' })],
        [2, 'console', expect.objectContaining({ city: '控制台城' })],
        [1, 'console', expect.objectContaining({ city: '示例市' })],
      ])
      const consoleVersion = listed.versions[1]!
      const reverted = HostApiContracts.revertExtensionConfig.parseResponse(
        (await call(`/api/extensions/${extensionId}/config-versions/${consoleVersion.id}/revert`, 'POST', {})).json,
      )
      expect(reverted.version).toMatchObject({ version: 4, source: 'revert', config: { city: '控制台城' } })
      expect(runtime.repository.getActivation(entity.agentId, extensionId)?.config).toMatchObject({ city: '控制台城' })

      // The agent reverts through its tool, judged like a change to the same fields.
      const tools = new ExtensionGovernanceTools(runtime)
      const back = runtime.extensionConfig
        .versions({ extensionId, layer: 'agent', agentId: entity.agentId })
        .find((version) => version.version === 3)!
      const outcome = await tools.act(
        entity.agentId,
        entity.channelId,
        { kind: 'revert-config', extensionId, versionId: back.id, actorAgentId: entity.agentId },
        { kind: 'admin' },
      )
      expect(outcome.outcome).toBe('scheduled')
      await expect
        .poll(() => runtime.repository.getActivation(entity.agentId, extensionId)?.config)
        .toMatchObject({ city: '虚构城' })
      expect(
        runtime.extensionConfig.versions({ extensionId, layer: 'agent', agentId: entity.agentId })[0],
      ).toMatchObject({ version: 5, source: 'revert' })
    } finally {
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })
})

describe('agents cannot widen their own reach', () => {
  it('offers no action or tool that changes capabilities, administrators, providers, connections or approvals', () => {
    const kinds = ExtensionActionSchema.options.map((option) => option.shape.kind.value)
    expect(kinds).toEqual([
      'save',
      'enable',
      'disable',
      'switch',
      'revert',
      'branch',
      'migrate-data',
      'community-publish',
      'community-update',
      'community-install',
      'community-withdraw',
      'configure',
      'revert-config',
      'use-credential',
    ])
    const unused = () => {
      throw new Error('unused')
    }
    const tools = extensionAgentTools({
      port: () => undefined,
      authoring: undefined,
      agentId: AgentIdSchema.parse('agt_FIXTURE'),
      channelId: ChannelIdSchema.parse('chn_FIXTURE'),
      episodeId: EpisodeIdSchema.parse('eps_FIXTURE'),
      sessionId: 'fixture',
      define: unused,
      restore: unused,
      setReviseIntent: vi.fn(),
    })
    const findEnum = (value: unknown): readonly string[] | undefined => {
      if (Array.isArray(value)) {
        const names = value.filter((item): item is string => typeof item === 'string')
        return names.includes('save') && names.includes('enable') ? names : undefined
      }
      if (value === null || typeof value !== 'object') return undefined
      for (const child of Object.values(value)) {
        const found = findEnum(child)
        if (found !== undefined) return found
      }
      return undefined
    }
    const actions = findEnum(tools.find((tool) => tool.name === 'nekro_nxt_extension_action'))!
    expect(actions).toContain('configure')
    for (const forbidden of ['approve', 'reject', 'capabilities', 'autonomy', 'admin', 'provider', 'connection']) {
      expect(actions.some((name) => name.includes(forbidden))).toBe(false)
      expect(tools.some((tool) => tool.name.includes(forbidden))).toBe(false)
    }
  })

  it('keeps its own capabilities, needs an administrator for approvals and the console for management permissions', async () => {
    const runtime = await createRuntime()
    try {
      const extensionId = await importConfigured(runtime)
      const entity = agentWithChannel(runtime, 'autonomous', 'everyone')
      await enableAsConsole(runtime, extensionId, entity.agentId)
      const before = runtime.repository.getAgent(entity.agentId)!.revision.capabilities
      const tools = new ExtensionGovernanceTools(runtime)
      const asked = await tools.act(
        entity.agentId,
        entity.channelId,
        { ...change(extensionId, entity.agentId, 'host', 'normal'), actorAgentId: entity.agentId },
        { kind: 'admin' },
      )
      expect(asked.outcome).toBe('requested')
      // A member (or the agent itself) cannot approve it in chat.
      await expect(
        new ExtensionCommandPort(runtime).ext(
          { subcommand: 'approve', target: String(asked.requestNumber) },
          {
            channelId: entity.channelId,
            agentId: entity.agentId,
            identity: {
              source: 'platform',
              connectionId: runtime.internalConnectionId,
              platformUserId: 'member-1',
              displayName: '群友',
            },
            administrator: false,
          },
        ),
      ).rejects.toThrow()
      expect(runtime.extensionRequests.get(asked.requestNumber!)?.status).toBe('pending')
      expect(runtime.repository.getAgent(entity.agentId)!.revision.capabilities).toEqual(before)

      // Extensions that could manage agents, connections or credentials are high risk, which only the console grants.
      for (const permission of ['agents.manage', 'connections.manage', 'credentials.write']) {
        expect(
          highestPermissionLevel(
            summarizePermissions({ permissions: { permissions: [permission], networkOrigins: [] } }),
          ),
        ).toBe('high')
      }
    } finally {
      await runtime.dispose()
    }
  })
})
