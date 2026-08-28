import { createElement, isValidElement } from 'react'
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
      if (input.endsWith('/report-client-verification')) {
        return Promise.resolve(stubResponse(200, { ok: true }))
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
    expect(invokeResult).toEqual({ result: 'ok' })
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

    await host.reportClientVerification(
      agentId,
      'plugin-1',
      'package-1',
      'run-7',
      [],
      [{ name: 'conversation.message.rich', key: 'synthetic-chat:card' }],
    )
    const verificationCall = requests.find((r) => r.url.endsWith('/report-client-verification'))
    const verificationBody = verificationCall?.init?.body
    if (typeof verificationBody !== 'string') throw new TypeError('verification request body must be JSON text.')
    expect(HostApiContracts.dynamicReportClientVerification.request.parse(JSON.parse(verificationBody))).toEqual({
      episodeId,
      pluginId: 'plugin-1',
      packageId: 'package-1',
      pluginRunId: 'run-7',
      renderedSlots: [],
      renderedHostSlots: [{ name: 'conversation.message.rich', key: 'synthetic-chat:card' }],
      renderedPages: [],
      permissions: { permissions: [], networkOrigins: [] },
    })
  })

  it('unwraps dynamic RPC values and rejects Host handler failures', async () => {
    fetchMock = vi.fn((input: string) =>
      Promise.resolve(
        stubResponse(
          200,
          input.endsWith('/invoke') ? { ok: false, message: 'synthetic handler failure' } : { rows: [] },
        ),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const host = new HttpDynamicClientHost(agentId, episodeId)
    await expect(host.invoke('plugin-1', 'run-7', 'identity.current', null)).rejects.toThrow(
      'synthetic handler failure',
    )
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
                  () => {
                    const [label] = React.useState('动态界面已加载')
                    return React.createElement('section', { 'data-dynamic': 'probe' }, label)
                  }
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
      const [entry] = runtime.entries('agent.workbench.sections')
      if (typeof entry?.component !== 'function') throw new TypeError('Dynamic product Slot must be callable.')
      const rendered: unknown = createElement(entry.component, { agentId, displayName: '动态测试智能体' })
      if (!isValidElement(rendered)) throw new TypeError('Dynamic product Slot must return a React element.')
      expect(renderToStaticMarkup(rendered)).toBe('<section data-dynamic="probe">动态界面已加载</section>')
    } finally {
      await runtime.dispose()
    }
  })

  it('loads and renders a dynamic Adapter rich-message Slot through the product registry', async () => {
    fetchMock = vi.fn((input: string) => {
      if (input.endsWith('/run-host-half')) {
        return Promise.resolve(
          stubResponse(200, {
            ok: true,
            pluginId: 'plugin-adapter',
            packageId: 'package-adapter',
            pluginRunId: 'run-adapter',
            waitingFor: [],
            startedHere: true,
          }),
        )
      }
      if (input.endsWith('/get-client-code')) {
        return Promise.resolve(
          stubResponse(200, {
            pluginId: 'plugin-adapter',
            packageId: 'package-adapter',
            pluginRunId: 'run-adapter',
            name: '动态适配器界面',
            code: `return {
              inject: ['slots'],
              apply(ctx) {
                ctx.slots.register(
                  { name: 'conversation.message.rich', id: 'synthetic-chat:card' },
                  ({ part }) => React.createElement('article', { 'data-dynamic-adapter-card': '' }, part.summary)
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
    const runtime = await DshDynamicClientRuntime.create(new HttpDynamicClientHost(agentId, episodeId), {
      querySelectorAll: () => [],
    })
    const pending: DynamicInventoryRow = {
      pluginId: 'plugin-adapter',
      agentId,
      packages: [
        {
          packageId: 'package-adapter',
          name: '动态适配器界面',
          purpose: '验证 Adapter rich Slot。',
          hasHostHalf: true,
          hasClientHalf: true,
        },
      ],
      latestRun: {
        pluginRunId: 'run-adapter',
        packageId: 'package-adapter',
        mode: 'run',
        status: 'awaiting-approval',
        approvalRequestId: 'approval-adapter',
        requiresApproval: true,
      },
    }
    try {
      await runtime.reconcile([pending])
      await runtime.approve('approval-adapter')
      const [entry] = runtime.entries('conversation.message.rich')
      if (!entry) throw new TypeError('Dynamic Adapter rich Slot must be registered.')
      const rendered = createElement(entry.component, {
        part: { type: 'rich', adapterKey: 'synthetic-chat', kind: 'card', summary: '合成卡片' },
        messageId: 'msg_SYNTHETIC',
        channelId: 'chn_SYNTHETIC',
      })
      expect(renderToStaticMarkup(rendered)).toBe('<article data-dynamic-adapter-card="">合成卡片</article>')
    } finally {
      await runtime.dispose()
    }
  })
})
