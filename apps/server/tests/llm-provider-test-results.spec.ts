import { createHash } from 'node:crypto'
import type { JsonValue } from '@nekro-nxt/contracts'
import type { SystemSettingRecord } from '@nekro-nxt/storage-sqlite'
import { describe, expect, it } from 'vitest'
import {
  LlmProviderTestResults,
  llmConnectionFingerprint,
  llmTestFailureMessage,
  type LlmProviderTestResultRepository,
} from '../src/llm-provider-test-results.js'

const memoryRepository = (): LlmProviderTestResultRepository & { readonly rows: Map<string, SystemSettingRecord> } => {
  const rows = new Map<string, SystemSettingRecord>()
  return {
    rows,
    getSystemSetting: (key) => rows.get(key),
    putSystemSetting: (key: string, value: JsonValue, expectedRevision: number | undefined, updatedAt: number) => {
      const current = rows.get(key)
      if (current?.revision !== expectedRevision) throw new Error('System setting revision conflict.')
      const record = { key, value, revision: (current?.revision ?? 0) + 1, updatedAt }
      rows.set(key, record)
      return record
    },
  }
}

const connection = {
  provider: 'example-gateway',
  baseURL: 'https://gateway.example.test/v1',
  api: 'openai-completions',
  apiKey: 'synthetic-unit-key',
}

describe('LlmProviderTestResults', () => {
  it('returns the latest result for the same connection and nothing once address, protocol or key change', () => {
    let clock = 1_000
    const results = new LlmProviderTestResults(memoryRepository(), () => clock)
    expect(results.latest(connection)).toBeNull()
    results.record(connection, { ok: false, model: 'example-model', message: '认证失败，请更新 API 密钥。' })
    clock = 2_000
    results.record(connection, { ok: true, model: 'example-model' })
    expect(results.latest(connection)).toEqual({ at: 2_000, ok: true, model: 'example-model' })
    expect(results.latest({ ...connection, apiKey: 'synthetic-rotated-key' })).toBeNull()
    expect(results.latest({ ...connection, baseURL: 'https://other.example.test/v1' })).toBeNull()
    expect(results.latest({ ...connection, api: 'anthropic-messages' })).toBeNull()
    expect(results.latest({ ...connection, apiKey: undefined })).toBeNull()
  })

  it('keeps the saved connection result when an unsaved draft is tested, and forgets everything on removal', () => {
    const repository = memoryRepository()
    const results = new LlmProviderTestResults(repository, () => 5_000)
    results.record(connection, { ok: true, model: 'example-model' })
    for (const index of [1, 2, 3]) {
      results.record({ ...connection, baseURL: `https://draft-${index}.example.test/v1` }, { ok: false, message: 'x' })
    }
    expect(results.latest(connection)).toMatchObject({ ok: true })
    // Only a handful of connections are remembered.
    results.record({ ...connection, baseURL: 'https://draft-4.example.test/v1' }, { ok: false, message: 'x' })
    expect(results.latest(connection)).toBeNull()

    results.forget(connection.provider)
    expect(repository.rows.get('llm.provider-test.example-gateway')?.value).toEqual({ version: 1, entries: [] })
    expect(results.latest({ ...connection, baseURL: 'https://draft-4.example.test/v1' })).toBeNull()
  })

  it('stores neither the key nor its plain digest', () => {
    const repository = memoryRepository()
    new LlmProviderTestResults(repository).record(connection, {
      ok: false,
      model: 'example-model',
      message: llmTestFailureMessage(new Error(`rejected ${connection.apiKey}`), connection.apiKey),
    })
    const stored = JSON.stringify([...repository.rows.values()])
    expect(stored).not.toContain(connection.apiKey)
    expect(stored).toContain('rejected ***')
    expect(stored).not.toContain(createHash('sha256').update(connection.apiKey).digest('hex'))
    expect(llmConnectionFingerprint(connection)).toBe(llmConnectionFingerprint({ ...connection }))
  })

  it('shortens long failure reasons to one line', () => {
    const message = llmTestFailureMessage(new Error(`第一行\n${'很长的原因'.repeat(80)}`), undefined)
    expect(message).not.toContain('\n')
    expect(message.length).toBeLessThanOrEqual(160)
    expect(message.endsWith('…')).toBe(true)
  })
})
