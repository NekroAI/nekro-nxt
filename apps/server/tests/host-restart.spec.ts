import {
  AgentIdSchema,
  ChannelIdSchema,
  HostApiContracts,
  HostApiErrorSchema,
  type AgentId,
  type ChannelId,
} from '@nekro-nxt/contracts'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NekroRuntime } from '../src/bootstrap.js'
import { ExtensionCommandPort } from '../src/extension-governance/commands.js'
import {
  fileRestartRequest,
  HOST_RESTART_DELAY_MS,
  HostRestart,
  hostRestartTool,
  type HostRestartOptions,
} from '../src/host-restart.js'
import { startNekroServer, type NekroServerHandle } from '../src/main.js'

const directories: string[] = []
const servers = new Set<NekroServerHandle>()

afterEach(async () => {
  for (const server of servers) await server.stop()
  servers.clear()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

/** A restart whose exit is only recorded: the test process never ends. */
const fakeRestart = (options: Partial<HostRestartOptions> = {}) => {
  const exits: number[] = []
  const scheduled: number[] = []
  const restart = new HostRestart({
    hostKind: 'server',
    exit: () => exits.push(Date.now()),
    isReady: () => true,
    startupMs: () => 8_000,
    schedule: (run, delayMs) => {
      scheduled.push(delayMs)
      run()
    },
    ...options,
  })
  return { restart, exits, scheduled }
}

describe('HostRestart', () => {
  it('estimates from how long this process took to start, rounded up to five seconds', () => {
    // 1.5 s reply + 5 s shutdown + 8 s startup, and 5 s more for the container to come back.
    expect(fakeRestart().restart.status()).toEqual({ supported: true, hostKind: 'server', estimatedSeconds: 20 })
    expect(fakeRestart({ hostKind: 'desktop' }).restart.status()).toEqual({
      supported: true,
      hostKind: 'desktop',
      estimatedSeconds: 15,
    })
    expect(fakeRestart({ startupMs: () => 3_600_000 }).restart.status().estimatedSeconds).toBe(300)
  })

  it('exits once after the reply delay, however often it is asked', () => {
    const { restart, exits, scheduled } = fakeRestart()
    expect(restart.request()).toEqual({ estimatedSeconds: 20 })
    expect(restart.request()).toEqual({ estimatedSeconds: 20 })
    expect(scheduled).toEqual([HOST_RESTART_DELAY_MS])
    expect(exits).toHaveLength(1)
  })

  it('refuses while an upgrade is running and where nothing would start the process again', () => {
    const upgrading = fakeRestart({ isReady: () => false })
    expect(upgrading.restart.blockedReason()).toBe('NekroNXT 正在完成升级，完成后再重启。')
    expect(() => upgrading.restart.request()).toThrow('正在完成升级')
    expect(upgrading.exits).toHaveLength(0)

    const embedded = new HostRestart({ hostKind: 'server', isReady: () => true, startupMs: () => undefined })
    expect(embedded.status()).toMatchObject({ supported: false })
    expect(() => embedded.request()).toThrow('不能从页面重启')
  })
})

const startServer = async (requestRestart?: () => void) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'nxt-restart-'))
  directories.push(dataRoot)
  const distIndex = path.join(dataRoot, 'web', 'index.html')
  await mkdir(path.dirname(distIndex), { recursive: true })
  await writeFile(distIndex, '<div id="root"></div>')
  const server = await startNekroServer({
    dataRoot,
    distIndex,
    ...(requestRestart === undefined ? {} : { requestRestart }),
  })
  servers.add(server)
  return `http://127.0.0.1:${server.port}`
}

describe('/api/host/restart', () => {
  it('reports the host kind and restarts through the exit it was given', async () => {
    const requested = vi.fn()
    const origin = await startServer(requested)
    const status = HostApiContracts.getHostRestart.parseResponse(
      await (await fetch(`${origin}/api/host/restart`)).json(),
    )
    expect(status).toMatchObject({ supported: true, hostKind: 'server' })

    const response = await fetch(`${origin}/api/host/restart`, { method: 'POST' })
    expect(response.status).toBe(200)
    expect(HostApiContracts.restartHost.parseResponse(await response.json())).toEqual({
      estimatedSeconds: status.estimatedSeconds,
    })
    // The reply goes out first; the exit follows after a short delay, and only once.
    expect(requested).not.toHaveBeenCalled()
    await fetch(`${origin}/api/host/restart`, { method: 'POST' })
    await vi.waitFor(() => expect(requested).toHaveBeenCalledTimes(1), { timeout: HOST_RESTART_DELAY_MS + 2_000 })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(requested).toHaveBeenCalledTimes(1)
  })

  it('says so where the service cannot restart itself', async () => {
    const origin = await startServer()
    expect(
      HostApiContracts.getHostRestart.parseResponse(await (await fetch(`${origin}/api/host/restart`)).json()),
    ).toMatchObject({ supported: false })
    const response = await fetch(`${origin}/api/host/restart`, { method: 'POST' })
    expect(response.status).toBe(409)
    expect(HostApiErrorSchema.parse(await response.json())).toMatchObject({
      error: { code: 'host-restart-unavailable', message: expect.stringContaining('不能从页面重启') as unknown },
    })
  })
})

const createRuntime = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nxt-restart-runtime-'))
  directories.push(directory)
  const runtime = await NekroRuntime.create({
    coreDatabasePath: path.join(directory, 'core.sqlite'),
    sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
    assetRoot: path.join(directory, 'assets'),
    extensionDataRoot: path.join(directory, 'extensions'),
    extensionCacheRoot: path.join(directory, 'cache'),
  })
  await runtime.start()
  const agent = runtime.core.createAgent({
    displayName: '值班智能体',
    persona: '',
    model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    // Even an agent that may change extensions on its own only asks for a restart.
    capabilities: { extensionAutonomy: 'autonomous' },
  })
  const channel = runtime.core.createChannel({
    connectionId: runtime.internalConnectionId,
    platformChannelId: 'restart-room',
    kind: 'internal',
  })
  runtime.core.createBinding({ channelId: channel.id, agentId: agent.definition.id, triggerPolicy: 'observe-only' })
  return { runtime, agentId: agent.definition.id, channelId: channel.id }
}

const noticeTexts = (spy: { mock: { calls: { parts: readonly { type: string; text?: string }[] }[][] } }): string[] =>
  spy.mock.calls.flatMap(([input]) => input?.parts.map((part) => part.text ?? '') ?? [])

describe('agent restart requests', () => {
  it('always waits for an administrator, posts the reason and restarts on approval', async () => {
    const { runtime, agentId, channelId } = await createRuntime()
    try {
      // Without a way to restart, the tool is not offered and a request is refused.
      expect(() => runtime.requestHostRestart({ agentId, channelId, reason: '虚构原因' })).toThrow('手动重启')
      const { restart, exits } = fakeRestart({ hostKind: 'desktop' })
      runtime.hostRestart = restart
      const notices = vi.spyOn(runtime.channels, 'sendHostNotice')

      const action = { kind: 'restart-host', reason: '虚构原因', channelId } as const
      expect(runtime.extensionActions.assess(action, { kind: 'agent', agentId, channelId }).decision).toBe('request')

      const asked = runtime.requestHostRestart({ agentId, channelId, reason: '连接一直卡在重连' })
      expect(runtime.extensionRequests.get(asked.number)).toMatchObject({
        status: 'pending',
        kind: 'restart-host',
        summary: '重启 NekroNXT',
      })
      expect(noticeTexts(notices).at(-1)).toBe(
        `值班智能体请求重启 NekroNXT。理由：连接一直卡在重连。管理员发送 /ext approve ${asked.number} 同意，或 /ext reject ${asked.number} 拒绝；24 小时内有效。`,
      )
      expect(exits).toHaveLength(0)

      const message = await new ExtensionCommandPort(runtime).ext(
        { subcommand: 'approve', target: String(asked.number) },
        {
          channelId,
          agentId,
          identity: {
            source: 'platform',
            connectionId: runtime.internalConnectionId,
            platformUserId: 'admin-1',
            displayName: '管理员甲',
          },
          administrator: true,
        },
      )
      expect(message).toBe(`已同意请求 #${asked.number}：已安排重启。`)
      expect(noticeTexts(notices).at(-1)).toBe('正在重启，大约 15 秒后回来。')
      expect(exits).toHaveLength(1)
      expect(runtime.extensionRequests.get(asked.number)).toMatchObject({ status: 'completed', decidedBy: '管理员甲' })
    } finally {
      await runtime.dispose()
    }
  })

  it('refuses the approval while an upgrade is running', async () => {
    const { runtime, agentId, channelId } = await createRuntime()
    try {
      let ready = true
      const { restart, exits } = fakeRestart({ isReady: () => ready })
      runtime.hostRestart = restart
      const asked = runtime.requestHostRestart({ agentId, channelId, reason: '配置改了没有生效' })
      ready = false
      await expect(runtime.extensionRequests.approve(asked.number, { kind: 'console' })).rejects.toThrow(
        'NekroNXT 正在完成升级，完成后再重启。',
      )
      expect(exits).toHaveLength(0)
      expect(runtime.extensionRequests.get(asked.number)).toMatchObject({ status: 'failed' })
    } finally {
      await runtime.dispose()
    }
  })

  it('asks for a reason and files the request through the host', () => {
    const agentId = AgentIdSchema.parse('agt_fixture')
    const channelId = ChannelIdSchema.parse('chn_fixture')
    const filed: { agentId: AgentId; channelId: ChannelId; reason: string }[] = []
    const requester = {
      request: (input: { agentId: AgentId; channelId: ChannelId; reason: string }) => {
        filed.push(input)
        return { number: 7 }
      },
    }
    expect(hostRestartTool(agentId, channelId, () => requester).name).toBe('nekro_nxt_restart')
    expect(() => fileRestartRequest(agentId, channelId, requester, '  ')).toThrow('为什么需要重启')
    expect(fileRestartRequest(agentId, channelId, requester, '连接卡住')).toBe('已在频道里发出请求 #7，等管理员同意。')
    expect(filed).toEqual([{ agentId, channelId, reason: '连接卡住' }])
    expect(() => fileRestartRequest(agentId, channelId, undefined, '连接卡住')).toThrow('手动重启')
  })
})
