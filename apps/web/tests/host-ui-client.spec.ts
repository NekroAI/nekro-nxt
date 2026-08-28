import { describe, expect, it } from 'vitest'
import { HostUiModuleRuntime, readHostUiNavigation } from '../src/host-ui-client.tsx'

describe('Host UI Client Runtime', () => {
  it('returns a cached external-store snapshot until runtime state changes', () => {
    const runtime = new HostUiModuleRuntime([])
    const first = runtime.snapshot()
    expect(runtime.snapshot()).toBe(first)
    expect(first).toEqual({ loading: false, revision: 0 })
  })

  it('projects invalid or throwing Navigation Providers into an isolated failure state', () => {
    expect(
      readHostUiNavigation({
        getSnapshot: () => ({ revision: -1, groups: [] }),
        subscribe: () => () => undefined,
      }),
    ).toMatchObject({ status: 'failed' })
    expect(
      readHostUiNavigation({
        getSnapshot: () => {
          throw new Error('synthetic navigation failure')
        },
        subscribe: () => () => undefined,
      }),
    ).toMatchObject({ status: 'failed', error: { message: 'synthetic navigation failure' } })
  })
})
