import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DshDynamicClientRuntime, type DynamicInventoryRow } from '../src/dsh-dynamic-client.ts'
import { HttpDynamicClientHost } from '../src/http-dynamic-host.ts'

const stubResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
})

describe('HttpDynamicClientHost (browser dynamic Client circuit)', () => {
  let fetchMock: (input: string, init?: RequestInit) => Promise<unknown>

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('drives runHostHalf, approve, getClientCode and invoke against the Agent API', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    fetchMock = vi.fn((input: string, init?: RequestInit) => {
      requests.push({ url: input, ...(init === undefined ? {} : { init }) })
      if (input.endsWith('/run-host-half')) {
        return Promise.resolve(stubResponse(200, { ok: true, pluginRunId: 'run-7' }))
      }
      if (input.endsWith('/approve')) return Promise.resolve(stubResponse(200, { accepted: true }))
      if (input.endsWith('/get-client-code')) {
        return Promise.resolve(
          stubResponse(200, { code: 'return { apply() {} }', pluginId: 'p', pluginRunId: 'run-7' }),
        )
      }
      if (input.endsWith('/invoke')) {
        return Promise.resolve(stubResponse(200, { ok: true, value: { result: 'ok' } }))
      }
      return Promise.resolve(stubResponse(404, { error: { code: 'not-found', message: 'x' } }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const host = new HttpDynamicClientHost('agent-1')

    const hostHalf = await host.runHostHalf('agent-1', 'plugin-1', 'package-1', 'run', 'approval-1', false)
    expect(hostHalf.ok).toBe(true)
    expect((hostHalf as { pluginRunId: string }).pluginRunId).toBe('run-7')
    const hostHalfCall = requests.find((r) => r.url.endsWith('/run-host-half'))
    expect(JSON.parse(hostHalfCall?.init?.body as string)).toMatchObject({
      pluginId: 'plugin-1',
      packageId: 'package-1',
      mode: 'run',
      requestId: 'approval-1',
    })

    const ack = await host.resolveRequestRun('approval-1', { ok: true, pluginRunId: 'run-7' })
    expect(ack.accepted).toBe(true)
    const approveCall = requests.find((r) => r.url.endsWith('/approve'))
    expect(JSON.parse(approveCall?.init?.body as string)).toEqual({ requestId: 'approval-1', pluginRunId: 'run-7' })

    const source = await host.getClientCode('agent-1', 'plugin-1', 'run-7')
    expect(source.code).toContain('apply')

    const invokeResult = await host.invoke('plugin-1', 'run-7', 'run', null)
    expect(invokeResult).toMatchObject({ ok: true, value: { result: 'ok' } })
    const invokeCall = requests.find((r) => r.url.endsWith('/invoke'))
    expect(JSON.parse(invokeCall?.init?.body as string)).toEqual({
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
            code: `return {
              inject: ['slots'],
              apply(ctx) {
                ctx.slots.register(
                  { name: 'root' },
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

    const host = new HttpDynamicClientHost('agent-1')
    const runtime = await DshDynamicClientRuntime.create(host, { querySelectorAll: () => [] })
    const pending: DynamicInventoryRow = {
      pluginId: 'plugin-1',
      agentId: 'agent-1',
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
      const [entry] = runtime.slots.entriesOfSlot('root')
      expect(entry).toBeDefined()
      expect(renderToStaticMarkup(createElement(entry!.component as () => ReturnType<typeof createElement>))).toBe(
        '<section data-dynamic="probe">动态界面已加载</section>',
      )
    } finally {
      await runtime.dispose()
    }
  })
})
