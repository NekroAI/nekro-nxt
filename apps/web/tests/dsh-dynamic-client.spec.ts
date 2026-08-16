import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  DshDynamicClientRuntime,
  type DynamicClientHostPort,
  type DynamicInventoryRow,
} from '../src/dsh-dynamic-client.ts'

describe('DSH Dynamic Client Runtime', () => {
  it('uses the published Client runner to approve, load, render, retract and decline a dynamic Package', async () => {
    const resolutions: unknown[] = []
    const host: DynamicClientHostPort = {
      runHostHalf: (_agentId, pluginId, packageId) =>
        Promise.resolve({
          ok: true,
          pluginId,
          packageId,
          pluginRunId: 'run-1' as never,
          waitingFor: [],
          startedHere: true,
        }),
      getClientCode: (_agentId, pluginId, pluginRunId) =>
        Promise.resolve({
          pluginId,
          packageId: 'package-1' as never,
          pluginRunId,
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
      resolveRequestRun: (_requestId, resolution) => {
        resolutions.push(resolution)
        return Promise.resolve({ accepted: true })
      },
      settleUserRun: () => Promise.reject(new Error('not used')),
      invoke: () => Promise.reject(new Error('not used')),
      reportRenderFailure: () => Promise.resolve(),
      reportGuardFailure: () => Promise.resolve(),
    }
    const runtime = await DshDynamicClientRuntime.create(host, { querySelectorAll: () => [] })
    const pending: DynamicInventoryRow = {
      pluginId: 'plugin-1',
      agentId: 'session-1',
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
      expect(resolutions).toEqual([expect.objectContaining({ ok: true, pluginRunId: 'run-1' })])
      expect(runtime.loaded()).toHaveLength(1)
      const [entry] = runtime.slots.entriesOfSlot('root')
      expect(entry).toBeDefined()
      expect(renderToStaticMarkup(createElement(entry!.component as () => ReturnType<typeof createElement>))).toBe(
        '<section data-dynamic="probe">动态界面已加载</section>',
      )

      await runtime.reconcile([{ ...pending, activeRun: { pluginRunId: 'run-1', packageId: 'package-1' } }])
      await runtime.reconcile([])
      expect(runtime.loaded()).toEqual([])
      expect(runtime.slots.entriesOfSlot('root')).toEqual([])

      const declined = {
        ...pending,
        latestRun: { ...pending.latestRun!, approvalRequestId: 'approval-2', pluginRunId: 'run-2' },
      }
      await runtime.reconcile([declined])
      await runtime.decline('approval-2')
      expect(resolutions.at(-1)).toMatchObject({ ok: false, reason: 'rejected' })
    } finally {
      await runtime.dispose()
    }
  })
})
