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

describe('DSH Dynamic Client Runtime', () => {
  const agentId = AgentIdSchema.parse('agt_dynamicclient')
  const episodeId = EpisodeIdSchema.parse('eps_dynamicclient')

  afterEach(() => {
    vi.unstubAllGlobals()
    Reflect.deleteProperty(globalThis, '__ModuleLoader__')
  })

  it('uses the published Client runner to approve, load, render, retract and decline a dynamic Package', async () => {
    const resolutions: unknown[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string, init?: RequestInit) => {
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
              name: '动态界面探针',
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
        if (input.endsWith('/approve') || input.endsWith('/decline')) {
          const body = init?.body
          if (typeof body !== 'string') throw new TypeError('dynamic decision request body must be JSON text.')
          resolutions.push(
            input.endsWith('/approve')
              ? HostApiContracts.dynamicApprove.request.parse(JSON.parse(body))
              : HostApiContracts.dynamicDecline.request.parse(JSON.parse(body)),
          )
          return Promise.resolve(stubResponse(200, { accepted: true }))
        }
        return Promise.resolve(stubResponse(404, { error: { code: 'not-found', message: 'x' } }))
      }),
    )
    const host = new HttpDynamicClientHost(agentId, episodeId)
    const runtime = await DshDynamicClientRuntime.create(host, { querySelectorAll: () => [] })
    const pending: DynamicInventoryRow = {
      pluginId: 'plugin-1',
      agentId,
      packages: [
        {
          packageId: 'package-1',
          name: '动态界面探针',
          purpose: '验证官方 Client runner 审批链。',
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
      expect(resolutions).toEqual([{ episodeId, requestId: 'approval-1', pluginRunId: 'run-1' }])
      expect(runtime.loaded()).toHaveLength(1)
      const [entry] = runtime.slots.entriesOfSlot('agent.workbench.sections')
      if (typeof entry?.component !== 'function') throw new TypeError('Dynamic product Slot must be callable.')
      const rendered: unknown = Reflect.apply(entry.component, undefined, [{ agentId, displayName: '动态测试智能体' }])
      if (!isValidElement(rendered)) throw new TypeError('Dynamic product Slot must return a React element.')
      expect(renderToStaticMarkup(rendered)).toBe('<section data-dynamic="probe">动态界面已加载</section>')

      await runtime.reconcile([{ ...pending, activeRun: { pluginRunId: 'run-1', packageId: 'package-1' } }])
      await runtime.reconcile([])
      expect(runtime.loaded()).toEqual([])
      expect(runtime.slots.entriesOfSlot('agent.workbench.sections')).toHaveLength(0)

      const declined = {
        ...pending,
        latestRun: { ...pending.latestRun!, approvalRequestId: 'approval-2', pluginRunId: 'run-2' },
      }
      await runtime.reconcile([declined])
      await runtime.decline('approval-2')
      expect(resolutions.at(-1)).toEqual({ episodeId, requestId: 'approval-2' })
    } finally {
      await runtime.dispose()
    }
  })

  it('retracts DSH WebUI root registrations and reports the product Slot guard failure', async () => {
    const guardReports: unknown[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string, init?: RequestInit) => {
        if (input.endsWith('/run-host-half')) {
          return Promise.resolve(
            stubResponse(200, {
              ok: true,
              pluginId: 'plugin-root',
              packageId: 'package-root',
              pluginRunId: 'run-root',
              waitingFor: [],
              startedHere: true,
            }),
          )
        }
        if (input.endsWith('/get-client-code')) {
          return Promise.resolve(
            stubResponse(200, {
              pluginId: 'plugin-root',
              packageId: 'package-root',
              pluginRunId: 'run-root',
              name: '错误页面入口',
              code: `return {
                inject: ['slots'],
                apply(ctx) {
                  ctx.slots.register({ name: 'root' }, () => React.createElement('div', null, 'wrong root'))
                }
              }`,
            }),
          )
        }
        if (input.endsWith('/approve')) return Promise.resolve(stubResponse(200, { accepted: true }))
        if (input.endsWith('/report-guard-failure')) {
          if (typeof init?.body === 'string') guardReports.push(JSON.parse(init.body))
          return Promise.resolve(stubResponse(200, { ok: true }))
        }
        return Promise.resolve(stubResponse(404, { error: { code: 'not-found', message: 'x' } }))
      }),
    )
    const runtime = await DshDynamicClientRuntime.create(new HttpDynamicClientHost(agentId, episodeId), {
      querySelectorAll: () => [],
    })
    const pending: DynamicInventoryRow = {
      pluginId: 'plugin-root',
      agentId,
      packages: [
        {
          packageId: 'package-root',
          name: '错误页面入口',
          purpose: '验证 root 被拒绝。',
          hasHostHalf: false,
          hasClientHalf: true,
        },
      ],
      latestRun: {
        pluginRunId: 'run-root',
        packageId: 'package-root',
        mode: 'run',
        status: 'awaiting-approval',
        approvalRequestId: 'approval-root',
        requiresApproval: true,
      },
    }
    try {
      await runtime.reconcile([pending])
      await expect(runtime.approve('approval-root')).rejects.toThrow('unsupported Slots: root')
      expect(runtime.loaded()).toEqual([])
      expect(guardReports).toHaveLength(1)
      expect(guardReports[0]).toMatchObject({
        episodeId,
        pluginId: 'plugin-root',
        pluginRunId: 'run-root',
      })
      const report = guardReports[0]
      expect(typeof report === 'object' && report !== null && 'message' in report ? report.message : '').toContain(
        'root',
      )
    } finally {
      await runtime.dispose()
    }
  })
})
