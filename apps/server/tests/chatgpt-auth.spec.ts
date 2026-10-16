import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatGptAuth, verifyChatGptIdentity } from '../src/chatgpt-auth.js'
import { createChatGptAdapter, chatGptPayload } from '../src/chatgpt-models.js'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'

const inputUrl = (input: Parameters<typeof fetch>[0]) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
const bodyText = (body: RequestInit['body']) => {
  if (typeof body === 'string') return body
  if (body instanceof URLSearchParams) return body.toString()
  throw new Error('Expected a text request body.')
}
const json = (value: unknown) => Promise.resolve(Response.json(value))
const HostState = z.object({ hostId: z.string() })
const ExpiringState = z
  .object({ accounts: z.array(z.object({ tokens: z.object({ expiresAt: z.number() }).passthrough() }).passthrough()) })
  .passthrough()

const collect = async (stream: AsyncIterable<StreamChunk>) => {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const roots: string[] = []
const owners: ChatGptAuth[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const auth of owners.splice(0)) await auth.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const tokens = (suffix = 'one') => ({
  access_token: `synthetic-access-${suffix}`,
  refresh_token: `synthetic-refresh-${suffix}`,
  id_token: `synthetic-id-${suffix}`,
  token_type: 'Bearer',
  expires_in: 3600,
  scope: 'openid email offline_access resource.invoke chatgpt.tokens.use.direct',
})
const root = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nxt-chatgpt-test-'))
  roots.push(directory)
  return directory
}
async function fixture(options: { scope?: string; expires?: number; verify?: boolean } = {}) {
  const directory = await root()
  const requests: URLSearchParams[] = []
  const transport = vi.fn<typeof fetch>((input, init) => {
    const url = inputUrl(input)
    if (url.endsWith('/oauth/token')) {
      const form = new URLSearchParams(bodyText(init?.body))
      requests.push(form)
      return json({
        ...tokens(form.get('grant_type') === 'refresh_token' ? 'rotated' : 'one'),
        ...(options.scope === undefined ? {} : { scope: options.scope }),
        expires_in: options.expires ?? 3600,
      })
    }
    if (url.endsWith('/models'))
      return json({
        models: [
          { slug: 'synthetic-chat', display_name: '示例模型', visibility: 'list' },
          { slug: 'hidden-model', display_name: '隐藏模型', visibility: 'hidden' },
        ],
      })
    if (url.endsWith('/openid-configuration')) return json({ revocation_endpoint: 'https://auth.openai.com/revoke' })
    if (url.endsWith('/revoke')) return Promise.resolve(new Response(null, { status: 200 }))
    throw new Error('Unexpected test URL.')
  })
  const verify = vi.fn(() => {
    if (options.verify === false) return Promise.reject(new Error('ChatGPT 账号校验失败，请重新登录。'))
    return Promise.resolve({ subject: 'synthetic-subject', email: 'tester@example.test' })
  })
  const auth = await ChatGptAuth.open(directory, { fetch: transport, verifyIdentity: verify })
  owners.push(auth)
  return { directory, auth, requests, transport, verify }
}
const start = async (auth: ChatGptAuth, accountId?: string) => new URL((await auth.start(accountId)).authorizeUrl)
async function complete(authorize: URL, extras: Record<string, string> = {}) {
  const callback = new URL(authorize.searchParams.get('redirect_uri')!)
  callback.search = new URLSearchParams({
    state: authorize.searchParams.get('state')!,
    code: 'synthetic-code',
    client_id: 'oaiapp_synthetic',
    ...extras,
  }).toString()
  return fetch(callback, { headers: { Connection: 'close' } })
}

describe('ChatGPT public-client authorization', () => {
  it('binds PKCE, nonce and issued registration, hides credentials, restores identity and catalog after restart', async () => {
    const { auth, directory, requests, verify } = await fixture()
    const authorize = await start(auth)
    expect(authorize.origin).toBe('https://auth.openai.com')
    expect(authorize.searchParams.get('client_id')).toBe('dynamic_agent_client')
    expect(authorize.searchParams.get('agent_name_hint')).toBe('NekroNXT')
    expect(new URL(authorize.searchParams.get('redirect_uri')!).hostname).toBe('127.0.0.1')
    expect((await complete(authorize)).status).toBe(200)
    expect(requests[0]!.get('client_id')).toBe('oaiapp_synthetic')
    expect(requests[0]!.get('redirect_uri')).toBe(authorize.searchParams.get('redirect_uri'))
    expect(createHash('sha256').update(requests[0]!.get('code_verifier')!).digest('base64url')).toBe(
      authorize.searchParams.get('code_challenge'),
    )
    expect(verify).toHaveBeenCalledWith('synthetic-id-one', 'oaiapp_synthetic', authorize.searchParams.get('nonce'))
    await auth.refreshModels()
    expect(auth.view().models).toEqual([{ id: 'synthetic-chat', name: '示例模型' }])
    expect(JSON.stringify(auth.view())).not.toMatch(/synthetic-(access|refresh|id)|subject|clientId|hostId/)
    const stored = HostState.parse(JSON.parse(await readFile(path.join(directory, 'accounts.json'), 'utf8')))
    await auth.dispose()
    owners.splice(owners.indexOf(auth), 1)
    const restored = await ChatGptAuth.open(directory)
    owners.push(restored)
    expect(restored.view().models).toEqual(auth.view().models)
    const returning = await start(restored, restored.view().activeId!)
    expect(returning.searchParams.get('client_id')).toBe('oaiapp_synthetic')
    expect(returning.searchParams.has('agent_name_hint')).toBe(false)
    expect(returning.searchParams.get('ext_agent_host_id')).toBe(stored.hostId)
    expect(returning.searchParams.get('id_token_hint')).toBe('synthetic-id-one')
    expect(returning.searchParams.get('state')).not.toBe(authorize.searchParams.get('state'))
  })

  it('rejects mismatched state without consuming the real attempt, then cancels and closes its listener', async () => {
    const { auth, requests } = await fixture()
    const authorize = await start(auth)
    expect((await complete(authorize, { state: 'wrong-state' })).status).toBe(400)
    expect(requests).toHaveLength(0)
    expect(auth.view().login?.status).toBe('waiting')
    await auth.cancel()
    expect(auth.view().login?.status).toBe('cancelled')
    await expect(complete(authorize)).rejects.toThrow()
  })

  it('handles denied consent and invalid identity without activating or overwriting an account', async () => {
    const { auth, requests } = await fixture({ verify: false })
    const denied = await start(auth)
    expect((await complete(denied, { error: 'access_denied' })).status).toBe(400)
    expect(requests).toHaveLength(0)
    expect((await complete(await start(auth))).status).toBe(400)
    expect(auth.view().activeId).toBeNull()
    expect(auth.view().accounts).toEqual([])
    const retry = await start(auth)
    expect(retry.searchParams.get('client_id')).toBe('oaiapp_synthetic')
  })

  it('requires granted plan permission and does not use an identity-only token for inference', async () => {
    const { auth, transport } = await fixture({ scope: 'openid email' })
    await complete(await start(auth))
    expect(auth.view().accounts[0]!.planEnabled).toBe(false)
    await expect(auth.refreshModels()).rejects.toThrow('套餐额度')
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('serializes rotating refreshes and saves the replacement atomically with preserved grant', async () => {
    const { auth, requests, directory } = await fixture({ expires: 61 })
    await complete(await start(auth))
    const stored = ExpiringState.parse(JSON.parse(await readFile(path.join(directory, 'accounts.json'), 'utf8')))
    stored.accounts[0]!.tokens.expiresAt = 1
    await auth.dispose()
    owners.splice(owners.indexOf(auth), 1)
    await writeFile(path.join(directory, 'accounts.json'), JSON.stringify(stored))
    // The replacement is long-lived so concurrent callers observe the committed rotation.
    const transport: typeof fetch = (_input, init) => {
      requests.push(new URLSearchParams(bodyText(init?.body)))
      return json(tokens('rotated'))
    }
    const restored = await ChatGptAuth.open(directory, {
      fetch: transport,
      verifyIdentity: () => Promise.resolve({ subject: 'synthetic-subject' }),
    })
    owners.push(restored)
    const id = restored.view().activeId!
    expect(await Promise.all([restored.accessToken(id), restored.accessToken(id)])).toEqual([
      'synthetic-access-rotated',
      'synthetic-access-rotated',
    ])
    expect(requests.filter((form) => form.get('grant_type') === 'refresh_token')).toHaveLength(1)
    expect(requests[1]!.get('client_id')).toBe('oaiapp_synthetic')
    expect(requests[1]!.has('scope')).toBe(false)
    const saved = await readFile(path.join(directory, 'accounts.json'), 'utf8')
    expect(saved).toContain('synthetic-refresh-rotated')
    expect(saved).not.toContain('synthetic-refresh-one')
  })

  it('retains registration after logout, clears token hints and reports unconfirmed remote revocation', async () => {
    const { auth, transport } = await fixture()
    await complete(await start(auth))
    const id = auth.view().activeId!
    transport.mockImplementation(() => Promise.reject(new Error('synthetic network failure')))
    expect(await auth.logout(id)).toEqual({ revoked: false })
    expect(auth.view().activeId).toBeNull()
    expect(auth.view().accounts[0]!.signedIn).toBe(false)
    const returning = await start(auth, id)
    expect(returning.searchParams.get('client_id')).toBe('oaiapp_synthetic')
    expect(returning.searchParams.has('id_token_hint')).toBe(false)
  })

  it('imports a protected transfer once while preserving the receiving host identity', async () => {
    const { auth, directory } = await fixture()
    await complete(await start(auth))
    await auth.refreshModels()
    const receiver = await root()
    const initial = await ChatGptAuth.open(receiver)
    const host = HostState.parse(JSON.parse(await readFile(path.join(receiver, 'accounts.json'), 'utf8')))
    await initial.dispose()
    await writeFile(path.join(receiver, 'import-accounts.json'), await readFile(path.join(directory, 'accounts.json')))
    const imported = await ChatGptAuth.open(receiver)
    owners.push(imported)
    expect(imported.view().models).toEqual(auth.view().models)
    const received = HostState.parse(JSON.parse(await readFile(path.join(receiver, 'accounts.json'), 'utf8')))
    expect(received.hostId).toBe(host.hostId)
    await expect(readFile(path.join(receiver, 'import-accounts.json'))).rejects.toThrow()
  })
})

it('verifies signed ID tokens and rejects wrong issuer, audience, expiry, nonce and signature', async () => {
  const keys = await generateKeyPair('RS256')
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'synthetic-key' }] })
  const sign = (fields = {}, privateKey = keys.privateKey) =>
    new SignJWT({ nonce: 'synthetic-nonce', ...fields })
      .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key' })
      .setSubject('synthetic-subject')
      .setIssuedAt()
      .setIssuer('https://auth.openai.com')
      .setAudience('oaiapp_synthetic')
      .setExpirationTime('1h')
      .sign(privateKey)
  await expect(verifyChatGptIdentity(await sign(), 'oaiapp_synthetic', 'synthetic-nonce', jwks)).resolves.toEqual({
    subject: 'synthetic-subject',
  })
  await expect(verifyChatGptIdentity(await sign(), 'wrong-client', 'synthetic-nonce', jwks)).rejects.toThrow()
  await expect(verifyChatGptIdentity(await sign(), 'oaiapp_synthetic', 'wrong-nonce', jwks)).rejects.toThrow()
  const invalidIssuer = await new SignJWT({ nonce: 'synthetic-nonce' })
    .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key' })
    .setSubject('synthetic-subject')
    .setIssuedAt()
    .setIssuer('https://invalid.example.test')
    .setAudience('oaiapp_synthetic')
    .setExpirationTime('1h')
    .sign(keys.privateKey)
  await expect(verifyChatGptIdentity(invalidIssuer, 'oaiapp_synthetic', 'synthetic-nonce', jwks)).rejects.toThrow()
  const expired = await new SignJWT({ nonce: 'synthetic-nonce' })
    .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key' })
    .setSubject('synthetic-subject')
    .setIssuedAt()
    .setIssuer('https://auth.openai.com')
    .setAudience('oaiapp_synthetic')
    .setExpirationTime(1)
    .sign(keys.privateKey)
  await expect(verifyChatGptIdentity(expired, 'oaiapp_synthetic', 'synthetic-nonce', jwks)).rejects.toThrow()
  const other = await generateKeyPair('RS256')
  await expect(
    verifyChatGptIdentity(await sign({}, other.privateKey), 'oaiapp_synthetic', 'synthetic-nonce', jwks),
  ).rejects.toThrow()
})

it('keeps the ChatGPT Responses payload stateless, streaming and namespace-scoped', () => {
  const body = chatGptPayload({
    store: true,
    stream: false,
    input: [{ role: 'system', content: '示例指令' }],
    tools: [{ type: 'function', name: 'synthetic_tool' }],
    temperature: 1,
    max_output_tokens: 16,
    previous_response_id: 'synthetic-response',
    metadata: {},
  })
  expect(body).toEqual({
    store: false,
    stream: true,
    input: [{ role: 'developer', content: '示例指令' }],
    tools: [
      {
        type: 'namespace',
        name: 'nekro_nxt',
        description: 'NekroNXT tools',
        tools: [{ type: 'function', name: 'synthetic_tool' }],
      },
    ],
  })
})

it('has no selectable ChatGPT models before sign-in and resolves only the authorized catalog', async () => {
  const { auth } = await fixture()
  const adapter = createChatGptAdapter(auth)
  expect(await adapter.listModels('chatgpt')).toEqual([])
  await complete(await start(auth))
  await auth.refreshModels()
  expect(await adapter.listModels('chatgpt')).toMatchObject([{ id: 'synthetic-chat', name: '示例模型' }])
  await expect(adapter.resolveModel('chatgpt', 'hidden-model')).rejects.toThrow()
})

for (const terminal of ['completed', 'incomplete', 'failed', 'missing'] as const) {
  it(`sends the public Responses wire with tools and accepts only completed inference (${terminal})`, async () => {
    const { auth } = await fixture()
    await complete(await start(auth))
    await auth.refreshModels()
    const item = {
      type: 'function_call',
      id: 'fc_synthetic',
      call_id: 'call_synthetic',
      name: 'synthetic_tool',
      arguments: '{}',
    }
    const events = [
      { type: 'response.created', response: { id: 'resp_synthetic' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{}' },
      { type: 'response.output_item.done', output_index: 0, item },
      ...(terminal === 'missing'
        ? []
        : [
            {
              type: `response.${terminal}`,
              response: {
                id: 'resp_synthetic',
                status: terminal,
                output: [item],
                usage: {
                  input_tokens: 4,
                  output_tokens: 2,
                  total_tokens: 6,
                  input_tokens_details: { cached_tokens: 0 },
                  output_tokens_details: { reasoning_tokens: 0 },
                },
                ...(terminal === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
                ...(terminal === 'failed' ? { error: { code: 'synthetic_failure', message: '示例失败' } } : {}),
              },
            },
          ]),
    ]
    const wire = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
      ),
    )
    vi.stubGlobal('fetch', wire)
    const adapter = createChatGptAdapter(auth)
    const chunks = await collect(
      adapter.stream({
        provider: 'chatgpt',
        model: 'synthetic-chat',
        system: '示例指令',
        messages: [{ role: 'user', content: [{ type: 'text', text: '示例输入' }] }],
        tools: [{ name: 'synthetic_tool', description: '示例工具', parameters: { type: 'object', properties: {} } }],
        maxTokens: 16,
        temperature: 0.2,
      }),
    )
    expect(wire).toHaveBeenCalledOnce()
    const [url, init] = wire.mock.calls[0]!
    expect(inputUrl(url)).toBe('https://api.openai.com/v1/responses')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-access-one')
    const body = z.record(z.string(), z.unknown()).parse(JSON.parse(bodyText(init?.body)))
    expect(body['store']).toBe(false)
    expect(body['stream']).toBe(true)
    expect(body).not.toHaveProperty('max_output_tokens')
    expect(body).not.toHaveProperty('temperature')
    expect(body['tools']).toMatchObject([{ type: 'namespace', name: 'nekro_nxt' }])
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: terminal === 'completed' ? 'tool-calls' : 'error' },
    })
    if (terminal === 'completed')
      expect(chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')).toMatchObject({
        type: 'block-end',
        block: { type: 'tool-call', name: 'synthetic_tool', arguments: '{}' },
      })
  })
}

it('keeps same-email registrations separate and freezes the selected account when preparing a call', async () => {
  const { auth, transport, requests } = await fixture()
  await complete(await start(auth))
  await auth.refreshModels()
  const firstId = auth.view().activeId!
  const adapter = createChatGptAdapter(auth)
  const prepared = await adapter.prepareCall('chatgpt', 'synthetic-chat')
  transport.mockImplementationOnce(() => json(tokens('two')))
  await complete(await start(auth), { client_id: 'oaiapp_synthetic_two' })
  await auth.refreshModels()
  const secondId = auth.view().activeId!
  expect(auth.view().accounts).toMatchObject([
    { id: firstId, label: '账号 1' },
    { id: secondId, label: '账号 2' },
  ])
  const response = `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_synthetic', status: 'completed', output: [] } })}\n\ndata: [DONE]\n\n`
  const wire = vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response(response, { headers: { 'content-type': 'text/event-stream' } })),
  )
  vi.stubGlobal('fetch', wire)
  const input = {
    provider: 'chatgpt',
    model: 'synthetic-chat',
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: '示例' }] }],
  }
  await collect(prepared.stream(input))
  await collect(adapter.stream(input))
  expect(wire.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization'))).toEqual([
    'Bearer synthetic-access-one',
    'Bearer synthetic-access-two',
  ])
  vi.unstubAllGlobals()
  const returning = await start(auth, firstId)
  expect((await complete(returning, { client_id: 'different-client' })).status).toBe(400)
  expect(auth.view().activeId).toBe(secondId)
  expect(requests).toHaveLength(1)
  await complete(await start(auth, firstId))
  expect(auth.view().accounts.map((account) => account.label)).toEqual(['账号 1', '账号 2'])
  await auth.select(secondId)
  expect(auth.view().activeId).toBe(secondId)
})

it('aborts pending catalog requests, closes authorization and waits for quiescence on dispose', async () => {
  const { auth, transport } = await fixture()
  await complete(await start(auth))
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  transport.mockImplementationOnce(
    async (_input, init) =>
      new Promise((_resolve, reject) => {
        started()
        init!.signal!.addEventListener('abort', () => reject(new Error('synthetic aborted request')), { once: true })
      }),
  )
  const request = auth.refreshModels()
  const rejected = expect(request).rejects.toThrow('aborted')
  await ready
  const disposing = auth.dispose()
  expect(auth.dispose()).toBe(disposing)
  await disposing
  await rejected
  await expect(auth.start()).rejects.toThrow('已停止')
})
