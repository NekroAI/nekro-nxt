import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { LlmRuntime, createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { describeSubscriptionFailure } from '../src/subscription-failures.ts'
import { SubscriptionLogins, type SubscriptionStatusView } from '../src/subscription-login.ts'

const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

/** The account model as the route stores it: levels pi-ai can send, each under its own name; `ultra` is left out. */
const ACCOUNT_MODEL = {
  id: 'gpt-5.5',
  name: 'GPT-5.5',
  contextWindow: 272000,
  input: ['text', 'image'],
  reasoningEfforts: { low: 'low', medium: 'medium', max: 'max' },
}

/** A signed access token as ChatGPT issues it; only the profile claim matters here. */
const accessToken = (email: string, serial: number) =>
  [
    Buffer.from('{"alg":"none"}').toString('base64url'),
    Buffer.from(
      JSON.stringify({ sub: `subject-${email}`, 'https://api.openai.com/profile': { email }, serial }),
    ).toString('base64url'),
    'signature-not-checked',
  ].join('.')

/** OpenAI's endpoints as this feature reaches them. Each sign-in issues the next queued account's tokens. */
function openai(queue: string[]) {
  const requests: { url: string; authorization: string | null; body: string }[] = []
  let issued = 0
  const respond = (input: RequestInfo | URL, init?: RequestInit): Response => {
    const url = String(input instanceof Request ? input.url : input)
    const authorization = new Headers(init?.headers).get('authorization')
    const body =
      typeof init?.body === 'string' ? init.body : init?.body instanceof URLSearchParams ? String(init.body) : ''
    requests.push({ url, authorization, body })
    if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
      const email = queue[issued++] ?? 'extra@example.com'
      return Response.json({
        access_token: accessToken(email, issued),
        refresh_token: `refresh-${email}-${issued}`,
        id_token: 'id-token',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      })
    }
    if (url === 'https://auth.openai.com/.well-known/openid-configuration')
      return Response.json({ revocation_endpoint: 'https://auth.openai.com/oauth/revoke' })
    if (url === 'https://auth.openai.com/oauth/revoke') return new Response(null, { status: 200 })
    if (url === 'https://api.openai.com/v1/models')
      return Response.json({
        models: [
          {
            slug: 'gpt-5.5',
            display_name: 'GPT-5.5',
            visibility: 'list',
            context_window: 272000,
            input_modalities: ['text', 'image'],
            supported_reasoning_levels: [
              { effort: 'low', description: 'Fast' },
              { effort: 'medium', description: 'Balanced' },
              { effort: 'max', description: 'Deepest' },
              { effort: 'ultra', description: 'Delegates tasks' },
            ],
          },
          { slug: 'internal-tool', display_name: 'Internal', visibility: 'hide' },
        ],
      })
    if (url === 'https://api.openai.com/v1/responses')
      return Response.json({ error: { message: 'not in this test' } }, { status: 400 })
    return new Response(null, { status: 404 })
  }
  const handler = (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(respond(input, init))
  return { requests, handler }
}

async function host(profiles: Record<string, Record<string, unknown>> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'nxt-subscription-'))
  directories.push(root)
  const context = new Context()
  contexts.push(context)
  await context.plugin(LocalCredentialProvider, { path: path.join(root, '.credentials.yaml') })
  await context.plugin(AuthorizationService)
  await context.plugin(LlmRuntime)
  await context.plugin(LlmPiAi as Plugin, { providers: profiles })
  let revision = 0
  const subscriptions = new SubscriptionLogins(context, {
    profile: (provider) => ({ revision, ...(profiles[provider] ? { value: profiles[provider] } : {}) }),
    mutateProfile: (ops, expectedRevision) => {
      expect(expectedRevision).toBe(revision)
      for (const op of ops) {
        const [, provider, field] = op.path
        if (field === undefined)
          profiles[provider!] = op.op === 'set' ? z.record(z.string(), z.unknown()).parse(op.value) : {}
        else if (op.op === 'set') profiles[provider!]![field] = op.value
        else delete profiles[provider!]![field]
      }
      revision++
      return Promise.resolve()
    },
  })
  return { context, subscriptions, profiles }
}

async function until(
  subscriptions: SubscriptionLogins,
  done: (status: SubscriptionStatusView) => boolean,
): Promise<SubscriptionStatusView> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const status = await subscriptions.status('openai')
    if (done(status)) return status
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Subscription status did not settle: ${JSON.stringify(await subscriptions.status('openai'))}`)
}

/** Sign in by pasting the callback URL, the path a browser on another machine takes. */
async function signIn(subscriptions: SubscriptionLogins): Promise<SubscriptionStatusView> {
  await subscriptions.login('openai')
  const waiting = await until(
    subscriptions,
    (status) => status.login?.prompt !== null && status.login?.prompt !== undefined,
  )
  const authorize = new URL(waiting.login!.notices.find((notice) => notice.url)!.url!)
  expect(authorize.searchParams.get('agent_name_hint')).toBe('NekroNXT')
  expect(authorize.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:[0-9a-f-]{36}$/u)
  const callback = new URL(authorize.searchParams.get('redirect_uri')!)
  callback.search = new URLSearchParams({
    code: 'authorization-code',
    state: authorize.searchParams.get('state')!,
    client_id: 'issued-client',
  }).toString()
  subscriptions.answer('openai', waiting.login!.prompt!.id, callback.toString())
  return until(subscriptions, (status) => status.login?.status !== 'running')
}

describe('subscription sign-in', () => {
  it('replaces normalized empty model defaults with the account catalog after sign-in', async () => {
    vi.stubGlobal('fetch', openai(['first@example.com']).handler)
    const { subscriptions, profiles } = await host({
      openai: { api: 'openai-responses', models: [], modelOverrides: {} },
    })
    expect((await signIn(subscriptions)).login?.status).toBe('authorized')
    expect(profiles['openai']?.['models']).toMatchObject([{ id: 'gpt-5.5', name: 'GPT-5.5' }])
  })

  it('settles a model-list failure after authorization and keeps the signed-in credential for retry', async () => {
    const network = openai(['first@example.com'])
    let failCatalog = true
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      String(input instanceof Request ? input.url : input) === 'https://api.openai.com/v1/models' && failCatalog
        ? Promise.resolve(new Response(null, { status: 503 }))
        : network.handler(input, init),
    )
    const { context, subscriptions, profiles } = await host({ openai: { api: 'openai-responses' } })
    const done = await signIn(subscriptions)
    expect(done.login).toMatchObject({ status: 'failed' })
    expect(done.login?.error).toContain('已登录 ChatGPT，但没能读取模型列表')
    expect(done.accounts).toHaveLength(1)
    expect(await context.credentials.readRecord(LlmPiAi.recordKeyFor('openai'))).toMatchObject({
      kind: 'grant',
      payload: { refresh: 'refresh-first@example.com-1' },
    })
    expect(profiles['openai']).not.toHaveProperty('models')
    failCatalog = false
    expect(await subscriptions.discoverModels('openai')).toMatchObject([{ id: 'gpt-5.5', name: 'GPT-5.5' }])
  })

  it('stores the sign-in where DSH reads it, so the ordinary route sends the account token', async () => {
    const network = openai(['first@example.com'])
    vi.stubGlobal('fetch', network.handler)
    const { context, subscriptions, profiles } = await host({ openai: {} })

    const done = await signIn(subscriptions)
    expect(done.login).toMatchObject({ status: 'authorized', error: null })
    expect(done.accounts).toEqual([expect.objectContaining({ label: 'first@example.com', email: 'first@example.com' })])
    expect(done.activeAccountId).toBe(done.accounts[0]!.id)
    // The untouched catalog became the models this account may use.
    expect(profiles['openai']).toEqual({ models: [ACCOUNT_MODEL] })

    for await (const chunk of context.llm.stream({
      provider: 'openai',
      model: 'gpt-5',
      system: 'test',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      maxTokens: 16,
    })) {
      if (chunk.type === 'finish') expect(chunk.reason.kind).toBe('error')
    }
    const request = network.requests.find((item) => item.url === 'https://api.openai.com/v1/responses')
    expect(request?.authorization).toBe(`Bearer ${accessToken('first@example.com', 1)}`)
    // The preview route rejects output caps; pi-ai drops them for a ChatGPT token.
    expect(JSON.parse(request!.body)).not.toHaveProperty('max_output_tokens')
  })

  it('keeps several accounts and swaps the active one without losing either token', async () => {
    const network = openai(['first@example.com', 'second@example.com'])
    vi.stubGlobal('fetch', network.handler)
    const { context, subscriptions } = await host({ openai: {} })
    await signIn(subscriptions)
    const second = await signIn(subscriptions)
    expect(second.accounts.map((account) => account.label)).toEqual(['first@example.com', 'second@example.com'])
    const [first, latest] = second.accounts
    expect(second.activeAccountId).toBe(latest!.id)

    await subscriptions.activate('openai', first!.id)
    const slot = await context.credentials.readRecord(LlmPiAi.recordKeyFor('openai'))
    expect(slot).toMatchObject({ kind: 'grant', payload: { refresh: 'refresh-first@example.com-1' } })
    await subscriptions.activate('openai', latest!.id)
    expect(await context.credentials.readRecord(LlmPiAi.recordKeyFor('openai'))).toMatchObject({
      payload: { refresh: 'refresh-second@example.com-2' },
    })

    const removed = await subscriptions.remove('openai', latest!.id)
    expect(removed.revocationConfirmed).toBe(true)
    expect(network.requests.find((item) => item.url.endsWith('/oauth/revoke'))?.body).toContain(
      'token=refresh-second%40example.com-2',
    )
    expect(await context.credentials.readRecord(LlmPiAi.recordKeyFor('openai'))).toBeUndefined()
    const after = await subscriptions.status('openai')
    expect(after.activeAccountId).toBeNull()
    expect(after.accounts.map((account) => account.label)).toEqual(['first@example.com'])
  })

  it('refuses to sign in over an API key until the route switches, and lists only the account models', async () => {
    vi.stubGlobal('fetch', openai(['first@example.com']).handler)
    const { subscriptions, profiles } = await host({ openai: { apiKeyEnv: 'OPENAI_API_KEY' } })
    await expect(subscriptions.login('openai')).rejects.toThrow('API 密钥')
    await subscriptions.useSubscription('openai', 0)
    expect(profiles['openai']).toEqual({ api: 'openai-responses' })
    await signIn(subscriptions)
    expect(profiles['openai']).toEqual({ api: 'openai-responses', models: [ACCOUNT_MODEL] })
  })

  it('recognizes the same account signing in again by its subject', async () => {
    vi.stubGlobal('fetch', openai(['first@example.com', 'first@example.com']).handler)
    const { subscriptions } = await host({ openai: {} })
    const first = await signIn(subscriptions)
    const again = await signIn(subscriptions)
    expect(again.accounts).toHaveLength(1)
    expect(again.activeAccountId).toBe(first.activeAccountId)
  })

  it('explains plan refusals instead of showing the raw OpenAI error', () => {
    expect(
      describeSubscriptionFailure(
        'OpenAI API error (403): {"message":"The ChatGPT user is not eligible for subscription sharing.","code":"subscription_sharing_user_not_eligible"}',
      ),
    ).toContain('不能把套餐额度用于 NekroNXT')
    expect(describeSubscriptionFailure('OpenAI API error (500): upstream')).toBeUndefined()
  })

  it('reports a cancelled sign-in without touching the stored account', async () => {
    vi.stubGlobal('fetch', openai(['first@example.com']).handler)
    const { context, subscriptions } = await host({ openai: {} })
    await subscriptions.login('openai')
    await until(subscriptions, (status) => Boolean(status.login?.prompt))
    subscriptions.cancel('openai')
    const settled = await until(subscriptions, (status) => status.login?.status !== 'running')
    expect(settled.login?.status).toBe('cancelled')
    expect(settled.accounts).toEqual([])
    expect(await context.credentials.readRecord(LlmPiAi.recordKeyFor('openai'))).toBeUndefined()
  })
})
