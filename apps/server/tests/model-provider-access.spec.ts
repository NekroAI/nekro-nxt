import { describe, expect, it } from 'vitest'
import type { JsonValue } from '@nekro-nxt/contracts'
import { ModelProviderAccess } from '../src/model-provider-access.js'

const settings = (initial?: JsonValue) => {
  let record =
    initial === undefined ? undefined : { key: 'model-provider-access', value: initial, revision: 1, updatedAt: 0 }
  return {
    getSystemSetting: () => record,
    putSystemSetting: (key: string, value: JsonValue, _revision: number | undefined, updatedAt: number) => {
      record = { key, value, revision: (record?.revision ?? 0) + 1, updatedAt }
      return record
    },
    read: () => record?.value,
  }
}

describe('ModelProviderAccess', () => {
  it('opens the providers configured on the first start and keeps later ones closed', async () => {
    const repository = settings()
    const access = new ModelProviderAccess(repository)
    await access.prepare(() => Promise.resolve(['configured-a']))
    expect(access.isOpen('configured-a')).toBe(true)
    expect(access.isOpen('added-later')).toBe(false)
  })

  it('records the configured providers again over a version 1 setting that listed the whole catalog', async () => {
    const repository = settings({ version: 1, open: ['configured-a', 'catalog-only'] })
    const access = new ModelProviderAccess(repository)
    await access.prepare(() => Promise.resolve(['configured-a']))
    expect(access.isOpen('catalog-only')).toBe(false)
    expect(repository.read()).toEqual({ version: 2, open: ['configured-a'] })
  })
})
