import {
  InstanceDescriptorSchema,
  InstanceDescriptorWireSchema,
  insecureHttpManagementPairProofMessage,
} from '../src/management-api.ts'
import { describe, expect, it } from 'vitest'

const base = {
  format: 'nxt.instance-descriptor',
  descriptorVersion: 1,
  instanceId: 'nxt_instance_01H00000000000000000000027',
  releaseId: 'nxt.test-release',
  productVersion: '0.0.0-test',
  desktopChromeProtocol: 1,
}

describe('management descriptor compatibility wire contract', () => {
  it('keeps HTTPS/loopback on protocol 1 and explicit remote HTTP on protocol 2', () => {
    expect(
      InstanceDescriptorSchema.parse({ ...base, managementProtocol: 1, transport: 'auto-tls-pinned-v1' }),
    ).toMatchObject({ managementProtocol: 1, transport: 'auto-tls-pinned-v1' })
    expect(
      InstanceDescriptorSchema.parse({ ...base, managementProtocol: 2, transport: 'explicit-http-v1' }),
    ).toMatchObject({ managementProtocol: 2, transport: 'explicit-http-v1' })
    expect(() =>
      InstanceDescriptorSchema.parse({ ...base, managementProtocol: 1, transport: 'explicit-http-v1' }),
    ).toThrow('不匹配')
  })

  it('parses future wire values without accepting them as the operational descriptor', () => {
    const wire = InstanceDescriptorWireSchema.parse({
      ...base,
      managementProtocol: 9,
      transport: 'future-http-v9',
      futureCapability: { revision: 3 },
    })
    expect(wire).toMatchObject({
      managementProtocol: 9,
      transport: 'future-http-v9',
      futureCapability: { revision: 3 },
    })
    expect(() =>
      InstanceDescriptorSchema.parse({ ...base, managementProtocol: 9, transport: 'future-http-v9' }),
    ).toThrow()
  })

  it('uses a distinct proof domain for explicitly insecure HTTP pairing', () => {
    expect(
      insecureHttpManagementPairProofMessage({
        challengeId: 'challenge',
        serverNonce: 'server-nonce',
        clientNonce: 'client-nonce',
        instanceId: InstanceDescriptorSchema.parse({
          ...base,
          managementProtocol: 2,
          transport: 'explicit-http-v1',
        }).instanceId,
        transportBinding: 'binding',
      }),
    ).toMatch(/^nxt-management-pair-insecure-http-v1\n/u)
  })
})
