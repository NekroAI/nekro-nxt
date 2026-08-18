import { isValidElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentIdSchema, HostApiContracts } from '@nekro-nxt/contracts'
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

  afterEach(() => vi.unstubAllGlobals())

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
                { name: 'root' },
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
    const host = new HttpDynamicClientHost(agentId)
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
      expect(resolutions).toEqual([{ requestId: 'approval-1', pluginRunId: 'run-1' }])
      expect(runtime.loaded()).toHaveLength(1)
      const [entry] = runtime.slots.entriesOfSlot('root')
      expect(entry).toBeDefined()
      if (typeof entry?.component !== 'function') throw new TypeError('Dynamic Slot component must be callable.')
      const rendered: unknown = Reflect.apply(entry.component, undefined, [{}])
      if (!isValidElement(rendered)) throw new TypeError('Dynamic Slot component must return a React element.')
      expect(renderToStaticMarkup(rendered)).toBe('<section data-dynamic="probe">动态界面已加载</section>')

      await runtime.reconcile([{ ...pending, activeRun: { pluginRunId: 'run-1', packageId: 'package-1' } }])
      await runtime.reconcile([])
      expect(runtime.loaded()).toEqual([])
      expect(runtime.slots.entriesOfSlot('root')).toHaveLength(1)

      const declined = {
        ...pending,
        latestRun: { ...pending.latestRun!, approvalRequestId: 'approval-2', pluginRunId: 'run-2' },
      }
      await runtime.reconcile([declined])
      await runtime.decline('approval-2')
      expect(resolutions.at(-1)).toEqual({ requestId: 'approval-2' })
    } finally {
      await runtime.dispose()
    }
  })
})
