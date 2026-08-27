import { describe, expect, it } from 'vitest'
import { fetchAdapterRemoteBytes } from '../src/adapter-remote-assets.ts'

describe('Adapter remote Asset policy', () => {
  it('requires credential-free HTTPS and a positive byte limit', async () => {
    await expect(fetchAdapterRemoteBytes({ url: 'http://media.example.test/file', maxBytes: 10 })).rejects.toThrow(
      /HTTPS/u,
    )
    await expect(
      fetchAdapterRemoteBytes({ url: 'https://user:secret@media.example.test/file', maxBytes: 10 }),
    ).rejects.toThrow(/HTTPS/u)
    await expect(fetchAdapterRemoteBytes({ url: 'https://media.example.test/file', maxBytes: 0 })).rejects.toThrow(
      /positive/u,
    )
  })

  it('rejects loopback, private, link-local and metadata destinations before connecting', async () => {
    for (const url of [
      'https://127.0.0.1/file',
      `https://${['10', '0', '0', '1'].join('.')}/file`,
      `https://${['169', '254', '169', '254'].join('.')}/latest/meta-data`,
      'https://[::1]/file',
      'https://[fd00::1]/file',
    ]) {
      await expect(fetchAdapterRemoteBytes({ url, maxBytes: 10 })).rejects.toThrow(/不允许的网络/u)
    }
  })
})
