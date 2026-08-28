import { describe, expect, it } from 'vitest'
import {
  fetchAdapterRemoteBytes,
  parseAdapterRemoteAssetUrl,
  pinnedAdapterAssetLookup,
} from '../src/adapter-remote-assets.ts'

describe('Adapter remote Asset policy', () => {
  it('requires credential-free HTTPS by default and allows public HTTP only when requested', async () => {
    expect(() => parseAdapterRemoteAssetUrl('http://media.example.test/file')).toThrow(/HTTPS/u)
    expect(parseAdapterRemoteAssetUrl('http://media.example.test/file', true).href).toBe(
      'http://media.example.test/file',
    )
    expect(() => parseAdapterRemoteAssetUrl('http://user:secret@media.example.test/file', true)).toThrow(/HTTP/u)
    expect(() => parseAdapterRemoteAssetUrl('ftp://media.example.test/file', true)).toThrow(/HTTP/u)
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

  it('returns the pinned address in the array shape requested by Node 22 HTTP clients', async () => {
    const selected = { address: ['203', '0', '113', '10'].join('.'), family: 4 }
    const pinnedLookup = pinnedAdapterAssetLookup(selected)

    await new Promise<void>((resolve, reject) => {
      pinnedLookup('media.example.test', { all: true }, (error, address, family) => {
        if (error) {
          reject(error)
          return
        }
        expect(address).toEqual([selected])
        expect(family).toBeUndefined()
        resolve()
      })
    })

    await new Promise<void>((resolve, reject) => {
      pinnedLookup('media.example.test', { all: false }, (error, address, family) => {
        if (error) {
          reject(error)
          return
        }
        expect(address).toBe(selected.address)
        expect(family).toBe(selected.family)
        resolve()
      })
    })
  })
})
