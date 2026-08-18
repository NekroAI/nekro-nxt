import { describe, expect, it } from 'vitest'
import { QQOpenClawHttpTransport, QQTransportError } from '../src/index.ts'

type Call = { readonly url: string; readonly init: RequestInit | undefined }

const json = (body: unknown, status = 200, headers?: HeadersInit): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const sequenceFetch =
  (
    handlers: Array<(url: string, init: RequestInit | undefined) => Response | Promise<Response>>,
    calls: Call[],
  ): typeof fetch =>
  (input, init) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
    calls.push({ url, init })
    const handler = handlers.shift()
    if (!handler) return Promise.reject(new Error(`Unexpected fetch: ${url}`))
    return Promise.resolve(handler(url, init))
  }

const createTransport = (
  fetchImplementation: typeof fetch,
  options: { readonly secret?: string; readonly now?: () => number } = {},
) =>
  new QQOpenClawHttpTransport({
    appId: 'app-id',
    clientSecretCredentialRef: 'credential:qq',
    credentials: { resolve: () => Promise.resolve(options.secret ?? 'secret') },
    fetch: fetchImplementation,
    now: options.now ?? (() => 1_000),
    apiBaseUrl: 'https://api.test/',
    tokenBaseUrl: 'https://token.test/',
  })

const signal = () => new AbortController().signal

describe('QQ OpenClaw HTTP edge cases', () => {
  it('caches and resets tokens, accepts alternate token fields, and classifies token failures', async () => {
    const calls: Call[] = []
    let now = 1_000
    const transport = createTransport(
      sequenceFetch(
        [
          () => json({ accessToken: 'cached-token', expiresIn: 7200 }),
          () => json({ access_token: 'fresh-token', expires_in: 7200 }),
        ],
        calls,
      ),
      { now: () => now },
    )
    await expect(transport.accessToken(signal())).resolves.toBe('cached-token')
    await expect(transport.accessToken(signal())).resolves.toBe('cached-token')
    expect(calls).toHaveLength(1)
    await transport.stop()
    now += 1
    await expect(transport.accessToken(signal())).resolves.toBe('fresh-token')
    expect(calls).toHaveLength(2)

    const empty = createTransport(sequenceFetch([() => json({ access_token: '' })], []), { secret: '  ' })
    await expect(empty.accessToken(signal())).rejects.toMatchObject({ kind: 'authentication' })
    const missing = createTransport(sequenceFetch([() => json({ expires_in: 60 })], []))
    await expect(missing.accessToken(signal())).rejects.toMatchObject({ kind: 'authentication' })
    const rejected = createTransport(sequenceFetch([() => json({ message: 'denied' }, 403)], []))
    await expect(rejected.accessToken(signal())).rejects.toMatchObject({ kind: 'authentication' })
    const network = createTransport(sequenceFetch([() => Promise.reject(new Error('offline'))], []))
    await expect(network.accessToken(signal())).rejects.toMatchObject({ kind: 'transient' })
  })

  it('handles Gateway URL and response-shape failures without leaking response bodies', async () => {
    const missingUrl = createTransport(sequenceFetch([() => json({ access_token: 'token' }), () => json({})], []))
    await expect(missingUrl.gatewayUrl(signal())).rejects.toMatchObject({ kind: 'transient' })
    const badJson = createTransport(
      sequenceFetch(
        [
          () => json({ access_token: 'token' }),
          () => new Response('{not-json', { status: 200, headers: { 'content-type': 'application/json' } }),
        ],
        [],
      ),
    )
    await expect(badJson.gatewayUrl(signal())).rejects.toMatchObject({ kind: 'transient' })

    const permanent = createTransport(sequenceFetch([() => json({ access_token: 'token' }), () => json({}, 400)], []))
    await expect(
      permanent.sendText({
        target: { kind: 'c2c', openId: 'user' },
        markdown: false,
        content: 'bad',
        signal: signal(),
      }),
    ).rejects.toMatchObject({ kind: 'permanent' })
    const unknown = createTransport(sequenceFetch([() => json({ access_token: 'token' }), () => json({}, 500)], []))
    await expect(
      unknown.sendText({
        target: { kind: 'c2c', openId: 'user' },
        markdown: false,
        content: 'uncertain',
        signal: signal(),
      }),
    ).rejects.toMatchObject({ kind: 'unknown' })
    const retryFailed = createTransport(
      sequenceFetch([() => json({ access_token: 'token' }), () => json({}, 401), () => json({}, 401)], []),
    )
    await expect(
      retryFailed.sendText({
        target: { kind: 'c2c', openId: 'user' },
        markdown: false,
        content: 'retry',
        signal: signal(),
      }),
    ).rejects.toMatchObject({ kind: 'authentication' })
    const noMessageId = createTransport(
      sequenceFetch([() => json({ access_token: 'token' }), () => new Response(null, { status: 204 })], []),
    )
    await expect(
      noMessageId.sendText({
        target: { kind: 'group', openId: 'group' },
        markdown: true,
        content: 'empty',
        signal: signal(),
      }),
    ).rejects.toMatchObject({ kind: 'unknown' })
  })

  it('uses upload defaults and alternate part fields, while rejecting malformed upload plans', async () => {
    const calls: Call[] = []
    const bytes = new Uint8Array([1, 2, 3])
    const transport = createTransport(
      sequenceFetch(
        [
          () => json({ access_token: 'token' }),
          () => json({ upload_id: 'upload', parts: [{ part_number: '1', upload_url: 'https://upload.test/part' }] }),
          () => new Response(null, { status: 204 }),
          () => json({}),
          () => json({ file_info: { token: 'file' } }),
        ],
        calls,
      ),
    )
    await expect(
      transport.upload({
        target: { kind: 'c2c', openId: 'user' },
        bytes,
        mediaType: 'application/octet-stream',
        signal: signal(),
      }),
    ).resolves.toEqual({ fileInfo: '{"token":"file"}' })
    expect(calls.map(({ url }) => url)).toEqual([
      'https://token.test/app/getAppAccessToken',
      'https://api.test/v2/users/user/upload_prepare',
      'https://upload.test/part',
      'https://api.test/v2/users/user/upload_part_finish',
      'https://api.test/v2/users/user/files',
    ])

    const noUploadId = createTransport(sequenceFetch([() => json({ access_token: 'token' }), () => json({})], []))
    await expect(
      noUploadId.upload({
        target: { kind: 'group', openId: 'group' },
        bytes,
        mediaType: 'image/png',
        signal: signal(),
      }),
    ).rejects.toMatchObject({ kind: 'transient' })
    const invalidPart = createTransport(
      sequenceFetch(
        [() => json({ access_token: 'token' }), () => json({ upload_id: 'upload', parts: [{ size: 0 }] })],
        [],
      ),
    )
    await expect(
      invalidPart.upload({
        target: { kind: 'group', openId: 'group' },
        bytes,
        mediaType: 'audio/wav',
        signal: signal(),
      }),
    ).rejects.toMatchObject({ kind: 'permanent' })
    const noFileInfo = createTransport(
      sequenceFetch(
        [() => json({ access_token: 'token' }), () => json({ upload_id: 'upload', parts: [] }), () => json({})],
        [],
      ),
    )
    await expect(
      noFileInfo.upload({
        target: { kind: 'group', openId: 'group' },
        bytes,
        mediaType: 'video/mp4',
        signal: signal(),
      }),
    ).rejects.toMatchObject({ kind: 'transient' })
  })

  it('classifies date and absent rate-limit hints and upload-part failures', async () => {
    const date = new Date(2_000).toUTCString()
    const rateDate = createTransport(
      sequenceFetch([() => json({ access_token: 'token' }), () => json({}, 429, { 'retry-after': date })], []),
      { now: () => 1_000 },
    )
    const rateDateFailure = await rateDate
      .sendText({
        target: { kind: 'c2c', openId: 'user' },
        markdown: false,
        content: 'slow',
        signal: signal(),
      })
      .catch((error: unknown) => error)
    expect(rateDateFailure).toBeInstanceOf(QQTransportError)
    if (!(rateDateFailure instanceof QQTransportError)) throw new TypeError('Expected a rate-limit failure.')
    expect(rateDateFailure.kind).toBe('rate-limited')
    expect(rateDateFailure.retryAfterMs).toBe(1_000)
    const rateUnknown = createTransport(
      sequenceFetch([() => json({ access_token: 'token' }), () => json({}, 429, { 'retry-after': 'later' })], []),
    )
    await expect(
      rateUnknown.sendText({
        target: { kind: 'c2c', openId: 'user' },
        markdown: false,
        content: 'slow',
        signal: signal(),
      }),
    ).rejects.toMatchObject({ kind: 'rate-limited' })

    const uploadFailure = createTransport(
      sequenceFetch(
        [
          () => json({ access_token: 'token' }),
          () =>
            json({
              upload_id: 'upload',
              block_size: 2,
              parts: [{ offset: 0, size: 2, url: 'https://upload.test/part' }],
            }),
          () => json({}, 500),
        ],
        [],
      ),
    )
    await expect(
      uploadFailure.upload({
        target: { kind: 'group', openId: 'group' },
        bytes: new Uint8Array([1, 2]),
        mediaType: 'image/jpeg',
        signal: signal(),
      }),
    ).rejects.toMatchObject({ kind: 'transient' })
    const uploadNetwork = createTransport(
      sequenceFetch(
        [
          () => json({ access_token: 'token' }),
          () => json({ upload_id: 'upload', parts: [{ url: 'https://upload.test/part', size: 1 }] }),
          () => Promise.reject(new Error('upload offline')),
        ],
        [],
      ),
    )
    await expect(
      uploadNetwork.upload({
        target: { kind: 'group', openId: 'group' },
        bytes: new Uint8Array([1]),
        mediaType: 'audio/mpeg',
        signal: signal(),
      }),
    ).rejects.toMatchObject({ kind: 'transient' })

    const bounded = new QQTransportError('unknown', 'x'.repeat(600))
    expect(bounded.message).toHaveLength(512)
  })
})
