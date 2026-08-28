import { describe, expect, it } from 'vitest'
import { HostUiModuleRuntime } from '../src/host-ui-client.tsx'

describe('Host UI Client Runtime', () => {
  it('returns a cached external-store snapshot until runtime state changes', () => {
    const runtime = new HostUiModuleRuntime([])
    const first = runtime.snapshot()
    expect(runtime.snapshot()).toBe(first)
    expect(first).toEqual({ loading: false, revision: 0 })
  })
})
