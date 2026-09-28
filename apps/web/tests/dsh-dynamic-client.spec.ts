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
      const [entry] = runtime.entries('agent.workbench.sections')
      if (typeof entry?.component !== 'function') throw new TypeError('Dynamic product Slot must be callable.')
      const rendered: unknown = createElement(entry.component, { agentId, displayName: '动态测试智能体' })
      if (!isValidElement(rendered)) throw new TypeError('Dynamic product Slot must return a React element.')
      expect(renderToStaticMarkup(rendered)).toBe('<section data-dynamic="probe">动态界面已加载</section>')

      await runtime.reconcile([{ ...pending, activeRun: { pluginRunId: 'run-1', packageId: 'package-1' } }])
      await runtime.reconcile([])
      expect(runtime.loaded()).toEqual([])
      expect(runtime.entries('agent.workbench.sections')).toHaveLength(0)

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

  it('registers dynamic Host pages with permissions and retracts their navigation and components', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string) => {
        if (input.endsWith('/run-host-half')) {
          return Promise.resolve(
            stubResponse(200, {
              ok: true,
              pluginId: 'plugin-page',
              packageId: 'package-page',
              pluginRunId: 'run-page',
              waitingFor: [],
              startedHere: true,
            }),
          )
        }
        if (input.endsWith('/get-client-code')) {
          return Promise.resolve(
            stubResponse(200, {
              pluginId: 'plugin-page',
              packageId: 'package-page',
              pluginRunId: 'run-page',
              name: '动态项目页',
              code: `return {
                inject: ['pages', 'ui'],
                apply(ctx) {
                  ctx.pages.declarePermissions({ permissions: ['agents.read'], networkOrigins: [] })
                  ctx.pages.register({
                    page: {
                      kind: 'host-page', entryId: 'overview', title: '项目概览',
                      icon: { kind: 'host-icon', name: 'layout-dashboard' },
                      objectPane: 'navigation', startPath: ''
                    },
                    navigation: {
                      getSnapshot: () => ({ revision: 0, groups: [{ id: 'main', items: [{ id: 'overview', label: '概览', path: '' }] }] }),
                      subscribe: () => () => undefined
                    }
                  }, ({ relativePath }) => React.createElement(ctx.ui.Section, { 'data-page': 'overview', className: styles.section }, relativePath || '首页'))
                }
              }`,
            }),
          )
        }
        if (input.endsWith('/approve')) return Promise.resolve(stubResponse(200, { accepted: true }))
        return Promise.resolve(stubResponse(404, { error: { code: 'not-found', message: 'x' } }))
      }),
    )
    const runtime = await DshDynamicClientRuntime.create(new HttpDynamicClientHost(agentId, episodeId), {
      querySelectorAll: () => [],
    })
    const pending: DynamicInventoryRow = {
      pluginId: 'plugin-page',
      agentId,
      packages: [
        {
          packageId: 'package-page',
          name: '动态项目页',
          purpose: '验证动态页面注册。',
          hasHostHalf: false,
          hasClientHalf: true,
        },
      ],
      latestRun: {
        pluginRunId: 'run-page',
        packageId: 'package-page',
        mode: 'run',
        status: 'awaiting-approval',
        approvalRequestId: 'approval-page',
        requiresApproval: true,
      },
    }
    try {
      await runtime.reconcile([pending])
      await runtime.approve('approval-page')
      expect(runtime.pagePermissions()).toEqual({ permissions: ['agents.read'], networkOrigins: [] })
      const [entry] = runtime.pageEntries()
      expect(entry?.page).toMatchObject({ entryId: 'overview', objectPane: 'navigation' })
      expect(entry?.navigation?.getSnapshot()).toMatchObject({ groups: [{ id: 'main' }] })
      expect(entry?.navigation?.getSnapshot()).toBe(entry?.navigation?.getSnapshot())
      const rendered = createElement(entry!.component, {
        pageInstanceId: 'preview',
        entryId: 'overview',
        relativePath: 'tasks',
        search: {},
        navigate: () => undefined,
      })
      expect(renderToStaticMarkup(rendered)).toContain('data-nxt-ui-component="Section"')
      expect(renderToStaticMarkup(rendered)).toContain('>tasks</section>')
      await runtime.reconcile([{ ...pending, activeRun: { pluginRunId: 'run-page', packageId: 'package-page' } }])
      await runtime.reconcile([])
      expect(runtime.pageEntries()).toEqual([])
      expect(runtime.pagePermissions()).toEqual({ permissions: [], networkOrigins: [] })
    } finally {
      await runtime.dispose()
    }
  })

  it('restores an already-running Client from authoritative inventory after a browser refresh', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string) => {
        if (input.endsWith('/get-client-code')) {
          calls.push('get-client-code')
          return Promise.resolve(
            stubResponse(200, {
              pluginId: 'plugin-restored-page',
              packageId: 'package-restored-page',
              pluginRunId: 'run-restored-page',
              name: '刷新恢复页面',
              code: `return {
                inject: ['pages', 'ui'],
                apply(ctx) {
                  ctx.pages.declarePermissions({ permissions: [], networkOrigins: [] })
                  ctx.pages.register({
                    page: {
                      kind: 'host-page', entryId: 'overview', title: '恢复后的项目概览',
                      icon: { kind: 'host-icon', name: 'layout-dashboard' },
                      objectPane: 'hidden', startPath: ''
                    }
                  }, () => React.createElement('main', { 'data-page': 'restored' }, '刷新后仍可见'))
                }
              }`,
            }),
          )
        }
        if (input.endsWith('/approve') || input.endsWith('/run-host-half')) {
          calls.push(input.endsWith('/approve') ? 'approve' : 'run-host-half')
          return Promise.resolve(stubResponse(500, { error: { code: 'unexpected', message: '不应重复执行' } }))
        }
        return Promise.resolve(stubResponse(404, { error: { code: 'not-found', message: 'x' } }))
      }),
    )
    const runtime = await DshDynamicClientRuntime.create(new HttpDynamicClientHost(agentId, episodeId), {
      querySelectorAll: () => [],
    })
    const running: DynamicInventoryRow = {
      pluginId: 'plugin-restored-page',
      agentId,
      packages: [
        {
          packageId: 'package-restored-page',
          name: '刷新恢复页面',
          purpose: '验证浏览器刷新恢复。',
          hasHostHalf: false,
          hasClientHalf: true,
        },
      ],
      activeRun: { pluginRunId: 'run-restored-page', packageId: 'package-restored-page' },
      latestRun: {
        pluginRunId: 'run-restored-page',
        packageId: 'package-restored-page',
        mode: 'run',
        status: 'running',
        host: { status: 'absent', waitingFor: [] },
        client: { status: 'running', waitingFor: [] },
      },
    }
    try {
      await runtime.reconcile([running])
      expect(calls).toEqual(['get-client-code'])
      expect(runtime.loaded()).toHaveLength(1)
      const [entry] = runtime.pageEntries()
      expect(entry?.page.entryId).toBe('overview')
      const rendered = createElement(entry!.component, {
        pageInstanceId: 'preview',
        entryId: 'overview',
        relativePath: '',
        search: {},
        navigate: () => undefined,
      })
      expect(renderToStaticMarkup(rendered)).toBe('<main data-page="restored">刷新后仍可见</main>')

      await runtime.reconcile([running])
      expect(calls).toEqual(['get-client-code'])
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

const syntheticAgent = AgentIdSchema.parse('agt_lifecycle')
const syntheticEpisode = EpisodeIdSchema.parse('eps_lifecycle')
const runningRow = (run = 'run-lifecycle'): DynamicInventoryRow => ({
  agentId: syntheticAgent,
  pluginId: 'plugin-lifecycle',
  packages: [
    {
      packageId: 'package-lifecycle',
      name: '生命周期测试',
      purpose: '合成测试',
      hasHostHalf: false,
      hasClientHalf: true,
    },
  ],
  activeRun: { pluginRunId: run, packageId: 'package-lifecycle' },
})
const clientSource = (code: string, run = 'run-lifecycle') => ({
  pluginId: 'plugin-lifecycle',
  packageId: 'package-lifecycle',
  pluginRunId: run,
  name: '生命周期测试',
  code,
})
const productSlotSource = `return {
  inject: ['slots'],
  apply(ctx) {
    ctx.slots.register({ name: 'agent.workbench.sections', id: 'lifecycle' },
      () => React.createElement('section', null, '生命周期测试'))
  }
}`

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('DSH Client lifecycle on the published UI renderer', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    Reflect.deleteProperty(globalThis, '__ModuleLoader__')
  })

  it('preserves one module owner and releases it only after the shared disposal completes', async () => {
    const host = new HttpDynamicClientHost(syntheticAgent, syntheticEpisode)
    const runtime = await DshDynamicClientRuntime.create(host, { querySelectorAll: () => [] })
    const owner: unknown = Reflect.get(globalThis, '__ModuleLoader__')
    await expect(DshDynamicClientRuntime.create(host, { querySelectorAll: () => [] })).rejects.toThrow(
      'already installed',
    )
    expect(Reflect.get(globalThis, '__ModuleLoader__')).toBe(owner)
    const disposal = runtime.dispose()
    expect(runtime.dispose()).toBe(disposal)
    await disposal
    expect(Reflect.get(globalThis, '__ModuleLoader__')).toBeUndefined()
    await expect(runtime.reconcile([])).rejects.toThrow('disposed')
    const refreshed = await DshDynamicClientRuntime.create(host, { querySelectorAll: () => [] })
    await refreshed.dispose()
  })

  it('uses the product SlotCore without mounting the native WebUI or fake Session services', async () => {
    const Slots = await import('@deepseek-ai/dsh-client-ui-slots')
    const registry = vi.spyOn(Slots.SlotCore.prototype, 'register')
    // There is deliberately no document root or createElement available here.
    const runtime = await DshDynamicClientRuntime.create(new HttpDynamicClientHost(syntheticAgent, syntheticEpisode), {
      querySelectorAll: () => [],
    })
    try {
      expect(registry).toHaveBeenCalled()
      expect(runtime.renderRoot(syntheticAgent, '测试')).toBeDefined()
    } finally {
      await runtime.dispose()
    }
  })

  it('cleans a partially registered plugin after activation throws and can load a fixed run', async () => {
    let broken = true
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          stubResponse(
            200,
            clientSource(
              broken
                ? productSlotSource.replace('\n  }\n}', '\n    throw new Error("synthetic activation failure")\n  }\n}')
                : productSlotSource,
              broken ? 'run-lifecycle' : 'run-fixed',
            ),
          ),
        ),
      ),
    )
    const runtime = await DshDynamicClientRuntime.create(new HttpDynamicClientHost(syntheticAgent, syntheticEpisode), {
      querySelectorAll: () => [],
    })
    try {
      await expect(runtime.reconcile([runningRow()])).rejects.toThrow('synthetic activation failure')
      expect(runtime.loaded()).toEqual([])
      expect(runtime.entries('agent.workbench.sections')).toEqual([])
      broken = false
      await runtime.reconcile([runningRow('run-fixed')])
      expect(runtime.loaded()).toHaveLength(1)
    } finally {
      await runtime.dispose()
    }
  })

  it('discards an obsolete source response after a newer inventory has removed the run', async () => {
    const requested = deferred<void>()
    const response = deferred<ReturnType<typeof stubResponse>>()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        requested.resolve()
        return response.promise
      }),
    )
    const runtime = await DshDynamicClientRuntime.create(new HttpDynamicClientHost(syntheticAgent, syntheticEpisode), {
      querySelectorAll: () => [],
    })
    try {
      const restoring = runtime.reconcile([runningRow()])
      await requested.promise
      const reset = runtime.reconcile([])
      response.resolve(stubResponse(200, clientSource(productSlotSource)))
      await Promise.all([restoring, reset])
      expect(runtime.loaded()).toEqual([])
      expect(runtime.entries('agent.workbench.sections')).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  it('waits for in-flight loading on disposal and rejects its late result', async () => {
    const requested = deferred<void>()
    const response = deferred<ReturnType<typeof stubResponse>>()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        requested.resolve()
        return response.promise
      }),
    )
    const runtime = await DshDynamicClientRuntime.create(new HttpDynamicClientHost(syntheticAgent, syntheticEpisode), {
      querySelectorAll: () => [],
    })
    const restoring = runtime.reconcile([runningRow()])
    const rejected = expect(restoring).rejects.toThrow('disposed')
    await requested.promise
    const owner: unknown = Reflect.get(globalThis, '__ModuleLoader__')
    let disposed = false
    const disposal = runtime.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    expect(Reflect.get(globalThis, '__ModuleLoader__')).toBe(owner)
    response.resolve(stubResponse(200, clientSource(productSlotSource)))
    await rejected
    await disposal
    expect(runtime.slots.entriesOfSlot('agent.workbench.sections')).toEqual([])
    expect(Reflect.get(globalThis, '__ModuleLoader__')).toBeUndefined()
  })

  it.each(['dispose', 'retract'] as const)(
    'does not settle an old approval after %s during the Host half request',
    async (action) => {
      const requested = deferred<void>()
      const response = deferred<ReturnType<typeof stubResponse>>()
      const fetch = vi.fn((url: string) => {
        if (!url.endsWith('/run-host-half')) throw new Error(`Unexpected late request: ${url}`)
        requested.resolve()
        return response.promise
      })
      vi.stubGlobal('fetch', fetch)
      const runtime = await DshDynamicClientRuntime.create(
        new HttpDynamicClientHost(syntheticAgent, syntheticEpisode),
        {
          querySelectorAll: () => [],
        },
      )
      await runtime.reconcile([
        {
          ...runningRow(),
          activeRun: undefined,
          latestRun: {
            pluginRunId: 'run-lifecycle',
            packageId: 'package-lifecycle',
            mode: 'run',
            status: 'awaiting-approval',
            approvalRequestId: 'approval-lifecycle',
            requiresApproval: true,
          },
        },
      ])
      const approving = runtime.approve('approval-lifecycle')
      const rejected = expect(approving).rejects.toThrow(action === 'dispose' ? 'disposed' : '动态审批已失效')
      await requested.promise
      const disposal = action === 'dispose' ? runtime.dispose() : runtime.reconcile([])
      response.resolve(
        stubResponse(200, {
          ok: true,
          pluginId: 'plugin-lifecycle',
          packageId: 'package-lifecycle',
          pluginRunId: 'run-lifecycle',
          waitingFor: [],
          startedHere: true,
        }),
      )
      await rejected
      await disposal
      expect(fetch).toHaveBeenCalledTimes(1)
      await runtime.dispose()
    },
  )

  it('rejects a source for another run before evaluating it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(stubResponse(200, clientSource(productSlotSource, 'run-obsolete')))),
    )
    const runtime = await DshDynamicClientRuntime.create(new HttpDynamicClientHost(syntheticAgent, syntheticEpisode), {
      querySelectorAll: () => [],
    })
    try {
      await expect(runtime.reconcile([runningRow()])).rejects.toThrow('不一致')
      expect(runtime.loaded()).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })
})
