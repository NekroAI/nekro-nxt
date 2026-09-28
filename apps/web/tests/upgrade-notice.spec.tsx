import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostUpgradeSummary, RuntimeCompatibilityDiagnostic } from '@nekro-nxt/contracts'
import { retryUpgradeDiagnostic, selectUpgradeDiagnostics } from '../src/components/upgrade-notice.js'

const diagnostic = (
  kind: RuntimeCompatibilityDiagnostic['objectKind'],
  id: string,
): RuntimeCompatibilityDiagnostic => ({
  objectKind: kind,
  objectId: id,
  objectVersion: 'synthetic',
  configurationRevision: '1',
  runtimeFingerprint: 'test-runtime',
  status: 'isolated',
  phase: 'load',
  reason: '合成兼容失败',
  retryable: true,
  checkedAt: 1,
})
const summary: HostUpgradeSummary = {
  runtimeVersion: '0.1.7-rc.2',
  sessionCompatibilityId: 'test',
  resetContexts: true,
  diagnostics: [
    diagnostic('agent', 'agent-a'),
    diagnostic('model-provider', 'provider-a'),
    diagnostic('extension', 'extension-a'),
    { ...diagnostic('extension', 'compatible'), status: 'compatible' },
  ],
}

describe('upgrade diagnostic ownership', () => {
  it('shows only the selected agent and its model provider', () => {
    expect(
      selectUpgradeDiagnostics(summary, { agentId: 'agent-a', providerId: 'provider-a' }).map((item) => item.objectId),
    ).toEqual(['agent-a', 'provider-a'])
    expect(selectUpgradeDiagnostics(summary, { agentId: 'agent-b' })).toEqual([])
  })
  it('shows only the selected extension, and all isolated objects in settings', () => {
    expect(selectUpgradeDiagnostics(summary, { extensionId: 'extension-a' }).map((item) => item.objectId)).toEqual([
      'extension-a',
    ])
    expect(selectUpgradeDiagnostics(summary, {})).toHaveLength(3)
    expect(selectUpgradeDiagnostics(undefined, {})).toEqual([])
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('compatibility retry', () => {
  it('retries the current object configuration and then reloads the authoritative snapshot', async () => {
    const sequence: string[] = []
    const fetch = vi.fn((path: string, init?: RequestInit) => {
      expect(path).toBe('/api/runtime/compatibility/retry')
      sequence.push('retry')
      if (typeof init?.body !== 'string') throw new TypeError('Expected JSON request body.')
      expect(JSON.parse(init.body)).toEqual({ objectKind: 'model-provider', objectId: 'provider-a' })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ diagnostics: [] }) })
    })
    vi.stubGlobal('fetch', fetch)
    const refresh = vi.fn(() => {
      sequence.push('snapshot')
      return Promise.resolve()
    })
    await expect(retryUpgradeDiagnostic(diagnostic('model-provider', 'provider-a'), refresh)).resolves.toEqual([])
    expect(sequence).toEqual(['retry', 'snapshot'])
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/runtime/compatibility/retry')
  })

  it('preserves the server rejection instead of displaying a successful retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 400,
          json: () => Promise.resolve({ error: { code: 'unsupported', message: '此类型不支持重试。' } }),
        }),
      ),
    )
    const refresh = vi.fn(() => Promise.resolve())
    await expect(retryUpgradeDiagnostic(diagnostic('client-page', 'page-a'), refresh)).rejects.toThrow(
      '此类型不支持重试',
    )
    expect(refresh).not.toHaveBeenCalled()
  })

  it('associates extension isolation with the activation agent without changing its object ID', () => {
    const isolation = {
      ...diagnostic('extension', 'extension-a'),
      configurationRevision: JSON.stringify(['agent-a', {}]),
    }
    expect(selectUpgradeDiagnostics({ ...summary, diagnostics: [isolation] }, { agentId: 'agent-a' })).toEqual([
      isolation,
    ])
    expect(selectUpgradeDiagnostics({ ...summary, diagnostics: [isolation] }, { agentId: 'agent-b' })).toEqual([])
    expect(selectUpgradeDiagnostics({ ...summary, diagnostics: [isolation] }, { extensionId: 'extension-a' })).toEqual([
      isolation,
    ])
  })
})
