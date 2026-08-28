import { describe, expect, it, vi } from 'vitest'
import { isPrivateNetworkAddress, performHostUiNetworkRequest } from '../src/host-ui-network.js'

const publicOrigin = `https://${['8', '8', '8', '8'].join('.')}`
const alternatePublicOrigin = `https://${['1', '1', '1', '1'].join('.')}`

describe('Host UI network request guard', () => {
  it('rejects loopback, private, link-local and unique-local addresses', () => {
    expect(isPrivateNetworkAddress(['127', '0', '0', '1'].join('.'))).toBe(true)
    expect(isPrivateNetworkAddress(['10', '2', '3', '4'].join('.'))).toBe(true)
    expect(isPrivateNetworkAddress(['192', '168', '1', '2'].join('.'))).toBe(true)
    expect(isPrivateNetworkAddress(['169', '254', '1', '1'].join('.'))).toBe(true)
    expect(isPrivateNetworkAddress('::1')).toBe(true)
    expect(isPrivateNetworkAddress('fd00::1')).toBe(true)
    expect(isPrivateNetworkAddress('2606:4700:4700::1111')).toBe(false)
  })

  it('rejects unapproved origins before fetch', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(
      performHostUiNetworkRequest({ url: `${publicOrigin}/data` }, [alternatePublicOrigin], fetchImpl),
    ).rejects.toThrow('未获准访问')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects bracketed IPv6 loopback before fetch', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(
      performHostUiNetworkRequest({ url: 'http://[::1]/data' }, ['http://[::1]'], fetchImpl),
    ).rejects.toThrow('本机或私网')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects redirects that escape the approved origin', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: `${alternatePublicOrigin}/private` },
      }),
    )
    await expect(
      performHostUiNetworkRequest({ url: `${publicOrigin}/start` }, [publicOrigin], fetchImpl),
    ).rejects.toThrow('未获准访问')
  })

  it('returns a bounded text projection for an approved public response', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }))
    await expect(
      performHostUiNetworkRequest({ url: `${publicOrigin}/data` }, [publicOrigin], fetchImpl),
    ).resolves.toEqual({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
    })
  })
})
