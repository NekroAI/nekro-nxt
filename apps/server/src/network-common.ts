import type { LookupAddress } from 'node:dns'
import { BlockList, isIP, type LookupFunction } from 'node:net'

const isPrivateIpv4 = (value: string): boolean => {
  const octets = value.split('.').map(Number)
  const [first = -1, second = -1] = octets
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127) ||
    first >= 224
  )
}

const blockedIpv6 = new BlockList()
for (const [address, prefix] of [
  ['::', 8],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blockedIpv6.addSubnet(address, prefix, 'ipv6')
}

export const isPrivateNetworkAddress = (value: string): boolean => {
  const normalized = value.toLowerCase().split('%')[0] ?? ''
  const family = isIP(normalized)
  if (family === 4) return isPrivateIpv4(normalized)
  if (family !== 6) return true
  return blockedIpv6.check(normalized, 'ipv6')
}

export const normalizeUrlHostname = (url: URL): string => url.hostname.toLowerCase().replace(/^\[|\]$/gu, '')

/**
 * `lookup` for http(s).request that always answers with one already-validated address. Node 22 calls it with
 * `all: true` (family autoselection) and then expects an address list, so both callback shapes are honoured.
 */
export const pinnedLookup =
  (resolved: { readonly address: string; readonly family: 4 | 6 }): LookupFunction =>
  (_hostname, options, callback) => {
    if (options.all === true) {
      ;(callback as (error: null, addresses: LookupAddress[]) => void)(null, [
        { address: resolved.address, family: resolved.family },
      ])
      return
    }
    callback(null, resolved.address, resolved.family)
  }
