import {
  managementPairProofMessage,
  ManagementChallengeResponseSchema,
  ManagementDeviceEnrollmentResponseSchema,
  ManagementDeviceIdSchema,
  ManagementSessionResponseSchema,
} from '@nekro-nxt/contracts'
import { openMigratedCoreDatabase, SqliteHostSecurityRepository } from '@nekro-nxt/storage-sqlite'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { request as httpsRequest } from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startManagementEdge } from '../src/management-edge.ts'

interface ResponseRecord {
  readonly status: number
  readonly headers: Record<string, string | string[] | undefined>
  readonly json: unknown
}

const request = (
  port: number,
  pathname: string,
  input: { method?: string; body?: unknown; cookie?: string; csrf?: string; origin?: string } = {},
): Promise<ResponseRecord> =>
  new Promise((resolve, reject) => {
    const encoded = input.body === undefined ? undefined : JSON.stringify(input.body)
    const req = httpsRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: input.method ?? 'GET',
        rejectUnauthorized: false,
        headers: {
          ...(encoded === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) }),
          ...(input.cookie === undefined ? {} : { cookie: input.cookie }),
          ...(input.csrf === undefined ? {} : { 'x-nxt-csrf': input.csrf }),
          ...(input.origin === undefined ? {} : { origin: input.origin }),
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            json: raw ? (JSON.parse(raw) as unknown) : undefined,
          })
        })
      },
    )
    req.once('error', reject)
    req.end(encoded)
  })

describe('automatic TLS management edge', () => {
  const roots: string[] = []
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

  it('pairs with an HMAC proof, protects proxied APIs, checks CSRF, and revokes a device', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nxt-management-edge-'))
    roots.push(root)
    const database = await openMigratedCoreDatabase(path.join(root, 'core.sqlite'))
    const repository = new SqliteHostSecurityRepository(database)
    const internal = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ proxied: true, method: req.method }))
    })
    await new Promise<void>((resolve) => internal.listen(0, '127.0.0.1', resolve))
    const internalAddress = internal.address()
    if (internalAddress === null || typeof internalAddress === 'string') throw new Error('missing internal port')
    const managementKey = 'correct horse battery staple 1234567890'
    const edge = await startManagementEdge({
      host: '127.0.0.1',
      port: 0,
      internalPort: internalAddress.port,
      dataRoot: root,
      managementKey,
      releaseId: 'test-release',
      productVersion: '0.0.0',
      repository,
    })
    try {
      expect((await request(edge.port, '/api/private')).status).toBe(401)
      expect((await request(edge.port, '/health/ready')).status).toBe(200)
      const challengeResponse = await request(edge.port, '/api/management/pairing/challenge', {
        method: 'POST',
        body: {},
      })
      const rejectedChallenge = ManagementChallengeResponseSchema.parse(challengeResponse.json)
      const rejectedEnrollment = await request(edge.port, '/api/management/devices/enroll', {
        method: 'POST',
        body: {
          challengeId: rejectedChallenge.challengeId,
          clientNonce: randomBytes(32).toString('base64url'),
          proof: randomBytes(32).toString('base64url'),
          label: '错误密钥设备',
          clientReleaseId: 'desktop-test',
        },
      })
      expect(rejectedEnrollment.status).toBe(401)
      const challenge = ManagementChallengeResponseSchema.parse(
        (
          await request(edge.port, '/api/management/pairing/challenge', {
            method: 'POST',
            body: {},
          })
        ).json,
      )
      const clientNonce = randomBytes(32).toString('base64url')
      const proof = createHmac('sha256', managementKey)
        .update(managementPairProofMessage({ ...challenge, clientNonce }))
        .digest('base64url')
      const enrollment = await request(edge.port, '/api/management/devices/enroll', {
        method: 'POST',
        body: {
          challengeId: challenge.challengeId,
          clientNonce,
          proof,
          label: '测试设备',
          clientReleaseId: 'desktop-test',
        },
      })
      expect(enrollment.status).toBe(201)
      const credential = ManagementDeviceEnrollmentResponseSchema.parse(enrollment.json)
      expect(JSON.stringify(enrollment.json)).not.toContain(managementKey)
      const replay = await request(edge.port, '/api/management/devices/enroll', {
        method: 'POST',
        body: {
          challengeId: challenge.challengeId,
          clientNonce,
          proof,
          label: '重放设备',
          clientReleaseId: 'desktop-test',
        },
      })
      expect(replay.status).toBe(401)

      const session = await request(edge.port, '/api/management/session', { method: 'POST', body: credential })
      expect(session.status).toBe(200)
      const cookies = session.headers['set-cookie']
      expect(Array.isArray(cookies)).toBe(true)
      const cookie = Array.isArray(cookies) ? cookies.map((value) => value.split(';')[0]).join('; ') : ''
      const csrf = ManagementSessionResponseSchema.parse(session.json).csrfToken
      expect((await request(edge.port, '/api/private', { cookie })).status).toBe(200)
      expect((await request(edge.port, '/api/private', { method: 'POST', body: {}, cookie })).status).toBe(403)
      expect(
        (
          await request(edge.port, '/api/private', {
            method: 'POST',
            body: {},
            cookie,
            csrf,
            origin: `https://127.0.0.1:${edge.port}`,
          })
        ).status,
      ).toBe(200)
      expect(
        (
          await request(edge.port, `/api/management/devices/${credential.deviceId}`, {
            method: 'DELETE',
            cookie,
            csrf,
            origin: `https://127.0.0.1:${edge.port}`,
          })
        ).status,
      ).toBe(200)
      expect((await request(edge.port, '/api/private', { cookie })).status).toBe(401)
    } finally {
      await edge.stop()
      await new Promise<void>((resolve, reject) => internal.close((error) => (error ? reject(error) : resolve())))
      database.close()
    }
  })

  it('keeps the instance identity and revokes every device when the management key rotates', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nxt-management-rotation-'))
    roots.push(root)
    const database = await openMigratedCoreDatabase(path.join(root, 'core.sqlite'))
    const repository = new SqliteHostSecurityRepository(database)
    const internal = createServer((_req, res) => res.end('ok'))
    await new Promise<void>((resolve) => internal.listen(0, '127.0.0.1', resolve))
    const address = internal.address()
    if (address === null || typeof address === 'string') throw new Error('missing internal port')
    const first = await startManagementEdge({
      host: '127.0.0.1',
      port: 0,
      internalPort: address.port,
      dataRoot: root,
      managementKey: 'first management key 0123456789abcdef',
      releaseId: 'rotation-test',
      productVersion: '0.0.0',
      repository,
    })
    const deviceId = ManagementDeviceIdSchema.parse('nxt_device_01H00000000000000000000000')
    repository.putDevice({ id: deviceId, label: '旧设备', secretDigest: 'digest', createdAt: 1 })
    await first.stop()
    const second = await startManagementEdge({
      host: '127.0.0.1',
      port: 0,
      internalPort: address.port,
      dataRoot: root,
      managementKey: 'second management key 0123456789abcde',
      releaseId: 'rotation-test',
      productVersion: '0.0.0',
      repository,
    })
    try {
      expect(second.instanceId).toBe(first.instanceId)
      expect(second.spkiSha256).toBe(first.spkiSha256)
      expect(repository.getActiveDevice(deviceId)).toBeUndefined()
    } finally {
      await second.stop()
      await new Promise<void>((resolve, reject) => internal.close((error) => (error ? reject(error) : resolve())))
      database.close()
    }
  })
})
