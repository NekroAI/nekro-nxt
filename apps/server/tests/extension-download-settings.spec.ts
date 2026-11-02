import { describe, expect, it } from 'vitest'
import type { JsonValue } from '@nekro-nxt/contracts'
import { readExtensionDownloadLimit, writeExtensionDownloadLimit } from '../src/extension-download-settings.js'

const MiB = 1024 * 1024

const memorySettings = () => {
  const values = new Map<string, { value: JsonValue; revision: number }>()
  return {
    get: (key: string) => values.get(key),
    put: (key: string, value: JsonValue) => {
      values.set(key, { value, revision: (values.get(key)?.revision ?? 0) + 1 })
    },
  }
}

describe('扩展下载上限', () => {
  it('defaults to 1 GiB and keeps what an administrator sets, up to 5 GiB', () => {
    const settings = memorySettings()
    expect(readExtensionDownloadLimit(settings)).toBe(1024 * MiB)
    expect(writeExtensionDownloadLimit(settings, 256 * MiB)).toBe(256 * MiB)
    expect(readExtensionDownloadLimit(settings)).toBe(256 * MiB)
    expect(writeExtensionDownloadLimit(settings, 5 * 1024 * MiB)).toBe(5 * 1024 * MiB)
  })

  it('refuses values above 5 GiB or below 8 MiB and ignores a stored value it cannot read', () => {
    const settings = memorySettings()
    expect(() => writeExtensionDownloadLimit(settings, 5 * 1024 * MiB + 1)).toThrow()
    expect(() => writeExtensionDownloadLimit(settings, MiB)).toThrow()
    settings.put('extension.downloadLimit', { maxBytes: 'big' })
    expect(readExtensionDownloadLimit(settings)).toBe(1024 * MiB)
  })
})
