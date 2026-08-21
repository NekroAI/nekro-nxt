import { isValidElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentIdSchema, EpisodeIdSchema, HostApiContracts } from '@nekro-nxt/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DshDynamicClientRuntime, type DynamicInventoryRow } from '../src/dsh-dynamic-client.ts'
import { HttpDynamicClientHost } from '../src/http-dynamic-host.ts'

const stubResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
})

describe('HttpDynamicClientHost (browser dynamic Client circuit)', () => {
  const agentId = AgentIdSchema.parse('agt_dynamicbrowser')
  const episodeId = EpisodeIdSchema.parse('eps_dynamicbrowser')
  let fetchMock: (input: string, init?: RequestInit) => Promise<unknown>

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('drives runHostHalf, approve, getClientCode and invoke against the Agent API', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    fetchMock = vi.fn((input: string, init?: RequestInit) => {
      requests.push({ url: input, ...(init === undefined ? {} : { init }) })
      if (input.endsWith('/run-host-half')) {
        return Promise.resolve(
          stubResponse(200, {
            ok: true,
            pluginId: 'plugin-1',
            packageId: 'package-1',
            pluginRunId: 'run-7',
            waitingFor: [],
            startedHere: true,
          }),
        )
      }
      if (input.endsWith('/approve')) return Promise.resolve(stubResponse(200, { accepted: true }))
      if (input.endsWith('/get-client-code')) {
        return Promise.resolve(
          stubResponse(200, {
            code: 'return { apply() {} }',
            name: '动态探针',
            pluginId: 'plugin-1',
            packageId: 'package-1',
            pluginRunId: 'run-7',
          }),
        )
      }
      if (input.endsWith('/invoke')) {
        return Promise.resolve(stubResponse(200, { ok: true, value: { result: 'ok' } }))
      }
      return Promise.resolve(stubResponse(404, { error: { code: 'not-found', message: 'x' } }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const host = new HttpDynamicClientHost(agentId, episodeId)

    const hostHalf = await host.runHostHalf(agentId, 'plugin-1', 'package-1', 'run', 'approval-1', false)
    expect(hostHalf.ok).toBe(true)
    if (!hostHalf.ok) throw new Error(hostHalf.message)
    expect(hostHalf.pluginRunId).toBe('run-7')
    const hostHalfCall = requests.find((r) => r.url.endsWith('/run-host-half'))
    const hostHalfBody = hostHalfCall?.init?.body
    if (typeof hostHalfBody !== 'string') throw new TypeError('run-host-half request body must be JSON text.')
    expect(HostApiContracts.dynamicRunHostHalf.request.parse(JSON.parse(hostHalfBody))).toMatchObject({
      episodeId,
      pluginId: 'plugin-1',
      packageId: 'package-1',
      mode: 'run',
      requestId: 'approval-1',
    })

    const ack = await host.resolveRequestRun('approval-1', { ok: true, pluginRunId: 'run-7' })
    expect(ack.accepted).toBe(true)
    const approveCall = requests.find((r) => r.url.endsWith('/approve'))
    const approveBody = approveCall?.init?.body
    if (typeof approveBody !== 'string') throw new TypeError('approve request body must be JSON text.')
    expect(HostApiContracts.dynamicApprove.request.parse(JSON.parse(approveBody))).toEqual({
      episodeId,
      requestId: 'approval-1',
      pluginRunId: 'run-7',
    })

    const source = await host.getClientCode(agentId, 'plugin-1', 'run-7')
    expect(source.code).toContain('apply')

    const invokeResult = await host.invoke('plugin-1', 'run-7', 'run', null)
    expect(invokeResult).toMatchObject({ ok: true, value: { result: 'ok' } })
    const invokeCall = requests.find((r) => r.url.endsWith('/invoke'))
    const invokeBody = invokeCall?.init?.body
    if (typeof invokeBody !== 'string') throw new TypeError('invoke request body must be JSON text.')
    expect(HostApiContracts.dynamicInvoke.request.parse(JSON.parse(invokeBody))).toEqual({
      episodeId,
      pluginId: 'plugin-1',
      pluginRunId: 'run-7',
      method: 'run',
      args: null,
    })
  })

  it('drives the real browser Dynamic Client runtime to approve and render a dynamic UI', async () => {
    // Transport is stubbed at the /api boundary; the rest is the real
    // DshDynamicClientRuntime + real HttpDynamicClientHost integration.
    fetchMock = vi.fn((input: string) => {
      if (input.endsWith('/run-host-half')) {
        return Promise.resolve(
          stubResponse(200, {
            ok: true,
            pluginId: 'plugin-1',
            packageId: 'package-1',
            pluginRunId: 'run-1',
            waitingFor: [],
            startedHere: true,
          }),
        )
      }
      if (input.endsWith('/get-client-code')) {
        return Promise.resolve(
          stubResponse(200, {
            pluginId: 'plugin-1',
            packageId: 'package-1',
            pluginRunId: 'run-1',
            name: '动态界面',
            code: `return {
              inject: ['slots'],
              apply(ctx) {
                ctx.slots.register(
                  { name: 'agent.workbench.sections', id: 'main' },
                  () => React.createElement('section', { 'data-dynamic': 'probe' }, '动态界面已加载')
                )
              }
            }`,
          }),
        )
      }
      if (input.endsWith('/approve')) return Promise.resolve(stubResponse(200, { accepted: true }))
      return Promise.resolve(stubResponse(404, { error: { code: 'not-found', message: 'x' } }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const host = new HttpDynamicClientHost(agentId, episodeId)
    const runtime = await DshDynamicClientRuntime.create(host, { querySelectorAll: () => [] })
    const pending: DynamicInventoryRow = {
      pluginId: 'plugin-1',
      agentId,
      packages: [
        {
          packageId: 'package-1',
          name: '动态界面',
          purpose: '验证真实 Host 审批链',
          hasHostHalf: false,
          hasClientHalf: true,
        },
      ],
      latestRun: {
        pluginRunId: 'run-1',
        packageId: 'package-1',
        mode: 'run',
        status: 'awaiting-approval',
        approvalRequestId: 'approval-1',
        requiresApproval: true,
      },
    }
    try {
      await runtime.reconcile([pending])
      await runtime.approve('approval-1')
      expect(runtime.loaded()).toHaveLength(1)
      const [entry] = runtime.slots.entriesOfSlot('agent.workbench.sections')
      if (typeof entry?.component !== 'function') throw new TypeError('Dynamic product Slot must be callable.')
      const rendered: unknown = Reflect.apply(entry.component, undefined, [{ agentId, displayName: '动态测试智能体' }])
      if (!isValidElement(rendered)) throw new TypeError('Dynamic product Slot must return a React element.')
      expect(renderToStaticMarkup(rendered)).toBe('<section data-dynamic="probe">动态界面已加载</section>')
    } finally {
      await runtime.dispose()
    }
  })
})
