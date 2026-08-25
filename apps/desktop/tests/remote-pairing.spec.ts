import { createSecureContext } from 'node:tls'
import { createServer as createHttpServer } from 'node:http'
import { parseJsonValue } from '@nekro-nxt/contracts'
import { createServer, type Server } from 'node:https'
import { generate } from 'selfsigned'
import { afterEach, describe, expect, it } from 'vitest'
import {
  certificateSpki,
  enrollRemoteDevice,
  inspectRemoteInstance,
  parseRemoteDescriptor,
} from '../src/remote-pairing.ts'
import type { InstanceOperationError } from '../src/instance-operation-error.ts'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    }),
  )
})

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, 'localhost', () => {
      server.off('error', reject)
      resolve()
    })
  })
  servers.push(server)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('测试 TLS Server 未获得端口。')
  return address.port
}

describe('Desktop remote pairing transport security', () => {
  it('pins every HTTPS request and sends no enrollment body after a certificate switch', async () => {
    const [first, second] = await Promise.all([
      generate([{ name: 'commonName', value: 'localhost' }]),
      generate([{ name: 'commonName', value: 'localhost' }]),
    ])
    const firstContext = createSecureContext({ key: first.private, cert: first.cert })
    const secondContext = createSecureContext({ key: second.private, cert: second.cert })
    const firstSpki = certificateSpki(first.cert)
    const instanceId = 'nxt_instance_01H00000000000000000000024'
    let handshakes = 0
    let enrollmentRequests = 0
    const server = createServer(
      {
        key: first.private,
        cert: first.cert,
        SNICallback: (_servername, callback) => {
          handshakes += 1
          callback(null, handshakes <= 3 ? firstContext : secondContext)
        },
      },
      (request, response) => {
        const send = (status: number, body: unknown) => {
          const encoded = JSON.stringify(body)
          response.writeHead(status, {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(encoded),
          })
          response.end(encoded)
        }
        if (request.url === '/.well-known/nekro-nxt') {
          send(200, {
            format: 'nxt.instance-descriptor',
            descriptorVersion: 1,
            instanceId,
            releaseId: 'nxt.test-release',
            productVersion: '0.0.0-test',
            managementProtocol: 1,
            desktopChromeProtocol: 1,
            transport: 'auto-tls-pinned-v1',
          })
          return
        }
        if (request.url === '/api/management/pairing/challenge') {
          send(200, {
            challengeId: 'challenge_01H00000000000000000000000',
            serverNonce: 'server_nonce_01H0000000000000000000000',
            instanceId,
            spkiSha256: firstSpki,
            expiresAt: Date.now() + 60_000,
          })
          return
        }
        if (request.url === '/api/management/devices/enroll') {
          enrollmentRequests += 1
          request.resume()
          send(500, { error: { code: 'unexpected_enrollment', message: '不应收到 enrollment。' } })
          return
        }
        send(404, { error: { code: 'not_found', message: '未找到。' } })
      },
    )
    const port = await listen(server)
    const inspection = await inspectRemoteInstance(`https://localhost:${port}`)

    await expect(
      enrollRemoteDevice({
        inspection,
        managementKey: 'm'.repeat(32),
        deviceLabel: 'NekroNXT test device',
        clientReleaseId: 'nxt.test-release',
      }),
    ).rejects.toMatchObject({ code: 'tls-identity-changed' })
    expect(enrollmentRequests).toBe(0)
    expect(handshakes).toBeGreaterThanOrEqual(4)
  })

  it('maps future protocol and transport values to stable actionable errors', () => {
    const base = {
      format: 'nxt.instance-descriptor',
      descriptorVersion: 1,
      instanceId: 'nxt_instance_01H00000000000000000000025',
      releaseId: 'nxt.test-release',
      productVersion: '0.0.0-test',
      managementProtocol: 1,
      desktopChromeProtocol: 1,
      transport: 'auto-tls-pinned-v1',
    }
    expect(() =>
      parseRemoteDescriptor({ ...base, managementProtocol: 9, futureField: true }, 'auto-tls-pinned-v1'),
    ).toThrow(expect.objectContaining<Partial<InstanceOperationError>>({ code: 'incompatible-instance' }))
    expect(() =>
      parseRemoteDescriptor(
        { ...base, transport: 'future-transport-v2', futureCapability: { revision: 3 } },
        'auto-tls-pinned-v1',
      ),
    ).toThrow(expect.objectContaining<Partial<InstanceOperationError>>({ code: 'incompatible-instance' }))
    expect(() => parseRemoteDescriptor({ ...base, transport: 'loopback-http' }, 'auto-tls-pinned-v1')).toThrow(
      expect.objectContaining<Partial<InstanceOperationError>>({ code: 'transport-mismatch' }),
    )
    expect(parseRemoteDescriptor({ ...base, futureCapability: { revision: 3 } }, 'auto-tls-pinned-v1')).toMatchObject({
      transport: 'auto-tls-pinned-v1',
      managementProtocol: 1,
    })
    expect(() => parseRemoteDescriptor({ unexpected: true }, 'auto-tls-pinned-v1')).toThrow(
      expect.objectContaining<Partial<InstanceOperationError>>({ code: 'operation-failed' }),
    )
  })

  it('uses protocol 2 without SPKI claims for explicitly confirmed HTTP pairing', async () => {
    const instanceId = 'nxt_instance_01H00000000000000000000028'
    let enrollmentBody = ''
    const server = createHttpServer((request, response) => {
      const send = (status: number, body: unknown) => {
        const encoded = JSON.stringify(body)
        response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) })
        response.end(encoded)
      }
      if (request.url === '/api/management/pairing/challenge') {
        request.resume()
        send(200, {
          challengeId: 'challenge_01H00000000000000000000001',
          serverNonce: 'server_nonce_01H0000000000000000000001',
          instanceId,
          transportBinding: 'insecure_http_binding_01H0000000000000001',
          expiresAt: Date.now() + 60_000,
        })
        return
      }
      if (request.url === '/api/management/devices/enroll') {
        request.setEncoding('utf8')
        request.on('data', (chunk: string) => (enrollmentBody += chunk))
        request.on('end', () =>
          send(201, {
            deviceId: 'nxt_device_01H00000000000000000000007',
            deviceSecret: 'device_secret_01H000000000000000000007',
          }),
        )
        return
      }
      send(404, { error: { code: 'not_found', message: '未找到。' } })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, 'localhost', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('测试 HTTP Server 未获得端口。')
    try {
      const descriptor = parseRemoteDescriptor(
        {
          format: 'nxt.instance-descriptor',
          descriptorVersion: 1,
          instanceId,
          releaseId: 'nxt.test-release',
          productVersion: '0.0.0-test',
          managementProtocol: 2,
          desktopChromeProtocol: 1,
          transport: 'explicit-http-v1',
        },
        'explicit-http-v1',
      )
      const paired = await enrollRemoteDevice({
        inspection: { origin: `http://localhost:${address.port}`, descriptor },
        managementKey: 'm'.repeat(32),
        deviceLabel: 'NekroNXT test device',
        clientReleaseId: 'nxt.test-release',
      })
      expect(paired.spkiSha256).toBeUndefined()
      expect(paired.deviceSecret).toBe('device_secret_01H000000000000000000007')
      const enrollment = parseJsonValue(JSON.parse(enrollmentBody))
      expect(
        typeof enrollment === 'object' &&
          enrollment !== null &&
          'proof' in enrollment &&
          typeof enrollment['proof'] === 'string',
      ).toBe(true)
      expect(enrollmentBody).not.toContain('m'.repeat(32))
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
