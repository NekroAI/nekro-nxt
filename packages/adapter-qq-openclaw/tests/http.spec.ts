import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { QQOpenClawHttpTransport, QQTransportError } from '../src/index.ts'

const jsonObjectSchema = z.record(z.string(), z.unknown())

const parseJsonObject = (input: string): Readonly<Record<string, unknown>> => jsonObjectSchema.parse(JSON.parse(input))

const json = (body: unknown, status = 200, headers?: HeadersInit): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const sequenceFetch = (
  handlers: Array<(url: string, init: RequestInit | undefined) => Response | Promise<Response>>,
  calls: Array<{ readonly url: string; readonly init: RequestInit | undefined }>,
): typeof fetch => {
  const implementation: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
    calls.push({ url, init })
    const handler = handlers.shift()
    if (!handler) return Promise.reject(new Error(`Unexpected fetch: ${url}`))
    return Promise.resolve(handler(url, init))
  }
  return implementation
}

const bodyText = (body: BodyInit | null | undefined): string => {
  if (body === undefined || body === null) return ''
  if (typeof body !== 'string') throw new TypeError('Expected a JSON string request body.')
  return body
}

const createTransport = (fetchImplementation: typeof fetch, secret = 'private-secret') =>
  new QQOpenClawHttpTransport({
    appId: 'app-id',
    clientSecretCredentialRef: 'credential:qq',
    credentials: { resolve: () => Promise.resolve(secret) },
    fetch: fetchImplementation,
    now: () => 1_000,
    apiBaseUrl: 'https://api.test',
    tokenBaseUrl: 'https://token.test',
  })

describe('QQ OpenClaw HTTP transport', () => {
  it('refreshes once after 401 without exposing the credential in API requests', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = []
    const transport = createTransport(
      sequenceFetch(
        [
          () => json({ access_token: 'token-1', expires_in: 7200 }),
          () => json({ code: 401 }, 401),
          () => json({ access_token: 'token-2', expires_in: 7200 }),
          () => json({ id: 'message-1', ext_info: { ref_idx: 'ref-1' } }),
        ],
        calls,
      ),
    )
    await expect(
      transport.sendText({
        target: { kind: 'group', openId: 'group/openid' },
        markdown: true,
        content: '你好',
        replyMessageId: 'inbound-1',
        messageSequence: 2,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ platformMessageId: 'message-1', refIndex: 'ref-1' })
    expect(calls.map(({ url }) => url)).toEqual([
      'https://token.test/app/getAppAccessToken',
      'https://api.test/v2/groups/group%2Fopenid/messages',
      'https://token.test/app/getAppAccessToken',
      'https://api.test/v2/groups/group%2Fopenid/messages',
    ])
    expect(calls[1]?.init?.headers).toMatchObject({ authorization: 'QQBot token-1' })
    expect(calls[3]?.init?.headers).toMatchObject({ authorization: 'QQBot token-2' })
    expect(bodyText(calls[1]?.init?.body)).not.toContain('private-secret')
    expect(parseJsonObject(bodyText(calls[3]?.init?.body))).toEqual({
      msg_type: 2,
      markdown: { content: '你好' },
      msg_id: 'inbound-1',
      msg_seq: 2,
    })
  })

  it('classifies rate limits and response loss with redacted, bounded errors', async () => {
    const rateCalls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = []
    const rateLimited = createTransport(
      sequenceFetch(
        [
          () => json({ access_token: 'token', expires_in: 7200 }),
          () => json({ message: 'slow down' }, 429, { 'retry-after': '3' }),
        ],
        rateCalls,
      ),
    )
    await expect(
      rateLimited.sendText({
        target: { kind: 'c2c', openId: 'user' },
        markdown: false,
        content: 'hello',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ kind: 'rate-limited', retryAfterMs: 3000 })

    const lostCalls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = []
    const lost = createTransport(
      sequenceFetch(
        [
          () => json({ access_token: 'token', expires_in: 7200 }),
          () => Promise.reject(new Error(`socket lost after private-secret ${'x'.repeat(1000)}`)),
        ],
        lostCalls,
      ),
    )
    const failure = await lost
      .sendText({
        target: { kind: 'c2c', openId: 'user' },
        markdown: false,
        content: 'hello',
        signal: new AbortController().signal,
      })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(QQTransportError)
    expect(failure).toMatchObject({ kind: 'unknown' })
    if (!(failure instanceof QQTransportError)) throw new TypeError('Expected QQTransportError.')
    expect(failure.message).not.toContain('private-secret')
    expect(failure.message.length).toBeLessThanOrEqual(512)
  })

  it('performs hashed multipart upload before sending the media message', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = []
    const bytes = new Uint8Array([1, 2, 3, 4])
    const transport = createTransport(
      sequenceFetch(
        [
          () => json({ access_token: 'token', expires_in: 7200 }),
          () =>
            json({
              upload_id: 'upload-1',
              block_size: 4,
              parts: [{ index: 1, offset: 0, size: 4, presigned_url: 'https://upload.test/part-1' }],
            }),
          () => new Response(null, { status: 200 }),
          () => json({}),
          () => json({ file_info: 'file-info-1' }),
          () => json({ id: 'media-message-1' }),
        ],
        calls,
      ),
    )
    const uploaded = await transport.upload({
      target: { kind: 'group', openId: 'group' },
      bytes,
      mediaType: 'video/mp4',
      fileName: 'clip.mp4',
      signal: new AbortController().signal,
    })
    expect(uploaded).toEqual({ fileInfo: 'file-info-1' })
    await expect(
      transport.sendMedia({
        target: { kind: 'group', openId: 'group' },
        fileInfo: uploaded.fileInfo,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ platformMessageId: 'media-message-1' })
    const prepare = parseJsonObject(bodyText(calls[1]?.init?.body))
    expect(prepare).toMatchObject({
      file_type: 2,
      file_name: 'clip.mp4',
      file_size: 4,
      md5: createHash('md5').update(bytes).digest('hex'),
      sha1: createHash('sha1').update(bytes).digest('hex'),
    })
    expect(calls.map(({ url }) => url)).toEqual([
      'https://token.test/app/getAppAccessToken',
      'https://api.test/v2/groups/group/upload_prepare',
      'https://upload.test/part-1',
      'https://api.test/v2/groups/group/upload_part_finish',
      'https://api.test/v2/groups/group/files',
      'https://api.test/v2/groups/group/messages',
    ])
  })
})
