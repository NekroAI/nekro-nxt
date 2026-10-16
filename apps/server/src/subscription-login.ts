import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  AuthorizationDeclinedError,
  type AuthorizationNotice,
  type AuthorizationPrompt,
} from '@deepseek-ai/dsh-authorization'
import { credentialKey, type CredentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai'
import {
  createModels,
  type AuthEvent,
  type AuthPrompt,
  type Credential,
  type CredentialStore,
} from '@earendil-works/pi-ai'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { z } from 'zod'

/**
 * Signing in with a model subscription instead of an API key.
 *
 * The signed-in credential is pi-ai's own OAuth record in DSH's credential store (`llm-pi-ai/<provider>`), so DSH's
 * ordinary `llm-pi-ai` route sends requests and refreshes tokens exactly as for any other provider. NXT adds only
 * what DSH does not offer: the ChatGPT flow (DSH has no installation ID to pass), several saved accounts per
 * provider, and the attempt state a settings page polls.
 */

/** Providers whose subscription sign-in is offered. Others ship a login in pi-ai but their terms bar third parties. */
const SUBSCRIPTIONS = {
  openai: { label: 'ChatGPT', usageUrl: 'https://chatgpt.com/settings/usage', revoke: revokeChatGpt },
} as const
export type SubscriptionProvider = keyof typeof SUBSCRIPTIONS
export const isSubscriptionProvider = (provider: string): provider is SubscriptionProvider =>
  Object.hasOwn(SUBSCRIPTIONS, provider)

const AGENT_NAME = 'NekroNXT'
const OPENAI_ISSUER = 'https://auth.openai.com'
const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models'
const NOTICE_LIMIT = 8
/** Sign-in reads nothing from the process environment; the account is the only credential. */
const NO_AMBIENT_AUTH = { env: () => Promise.resolve(undefined), fileExists: () => Promise.resolve(false) }

// The record shape DSH's llm-pi-ai writes for a pi-ai credential. DSH does not export it; the contract test pins it.
const toRecord = (credential: Credential): CredentialRecord =>
  credential.type === 'api_key'
    ? {
        kind: 'api-key',
        ...(credential.key === undefined ? {} : { key: credential.key }),
        ...(credential.env === undefined ? {} : { env: { ...credential.env } }),
      }
    : { kind: 'grant', payload: structuredClone(credential) }
const fromRecord = (record: CredentialRecord | undefined): Credential | undefined => {
  if (record === undefined) return undefined
  if (record.kind === 'api-key')
    return {
      type: 'api_key',
      ...(record.key === undefined ? {} : { key: record.key }),
      ...(record.env === undefined ? {} : { env: { ...record.env } }),
    }
  const parsed = OAuthCredentialSchema.safeParse(record.payload)
  return parsed.success ? parsed.data : undefined
}
const AccessClaimsSchema = z
  .object({
    sub: z.string().optional(),
    email: z.string().optional(),
    'https://api.openai.com/profile': z.object({ email: z.string().optional() }).loose().optional(),
  })
  .loose()
const OAuthCredentialSchema = z
  .object({ type: z.literal('oauth'), access: z.string(), refresh: z.string(), expires: z.number() })
  .catchall(z.unknown())

const AccountSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    email: z.string().optional(),
    /** OpenAI's opaque account identifier from the access token; signing the same account in again matches it. */
    subject: z.string().optional(),
    createdAt: z.number().int().nonnegative(),
    /** The account's credential while another account holds the provider's single DSH slot. */
    parked: OAuthCredentialSchema.optional(),
  })
  .strict()
const VaultSchema = z
  .object({
    version: z.literal(1),
    /** Stable per installation, sent as OpenAI's `ext_agent_host_id` on every sign-in. */
    deviceId: z.uuid(),
    activeId: z.string().optional(),
    accounts: z.array(AccountSchema),
  })
  .strict()
type Vault = z.infer<typeof VaultSchema>
type Account = z.infer<typeof AccountSchema>

export interface SubscriptionAccountView {
  readonly id: string
  readonly label: string
  readonly email: string | null
  readonly createdAt: number
}

export interface SubscriptionPromptView {
  readonly id: string
  readonly kind: 'text' | 'secret' | 'select'
  readonly message: string
  readonly placeholder?: string
  readonly options?: readonly { readonly id: string; readonly label: string; readonly description?: string }[]
}

export interface SubscriptionLoginView {
  readonly id: string
  readonly status: 'running' | 'authorized' | 'cancelled' | 'failed'
  readonly notices: readonly AuthorizationNotice[]
  readonly prompt: SubscriptionPromptView | null
  readonly error: string | null
}

export interface SubscriptionStatusView {
  readonly provider: SubscriptionProvider
  readonly label: string
  readonly usageUrl: string
  /** False when this host cannot run the sign-in (no credential store, or the flow is unavailable). */
  readonly available: boolean
  readonly mode: 'unconfigured' | 'api-key' | 'subscription'
  readonly activeAccountId: string | null
  readonly accounts: readonly SubscriptionAccountView[]
  readonly login: SubscriptionLoginView | null
}

interface Attempt {
  readonly id: string
  status: SubscriptionLoginView['status']
  notices: AuthorizationNotice[]
  prompt: (SubscriptionPromptView & { resolve(value: string): void; reject(error: Error): void }) | undefined
  error: string | undefined
  readonly abort: AbortController
}

type ProfileOp =
  | { readonly op: 'set'; readonly path: string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: string[] }

export interface SubscriptionLoginsOptions {
  /** The llm-pi-ai profile of one route, or undefined when the route is not configured. */
  readonly profile: (provider: string) => { readonly revision: number; readonly value?: Record<string, unknown> }
  readonly mutateProfile: (ops: readonly ProfileOp[], expectedRevision: number) => Promise<void>
  readonly fetch?: typeof fetch
  readonly changed?: () => void
}

const vaultKey = (provider: SubscriptionProvider): CredentialKey =>
  credentialKey('nekro-nxt', `subscription-${provider}`)

/**
 * Who the access token belongs to, read without verifying it: only to label an account and recognize it on the
 * next sign-in, never to authenticate. ChatGPT's tokens carry an opaque subject and usually no email.
 */
function identityOf(credential: Credential | undefined): { subject?: string; email?: string } {
  if (credential?.type !== 'oauth') return {}
  try {
    const claims = AccessClaimsSchema.parse(
      JSON.parse(Buffer.from(credential.access.split('.')[1] ?? '', 'base64url').toString('utf8')),
    )
    const email = claims['https://api.openai.com/profile']?.email ?? claims.email
    return {
      ...(claims.sub ? { subject: claims.sub } : {}),
      ...(email?.includes('@') ? { email } : {}),
    }
  } catch {
    return {}
  }
}

const nextLabel = (accounts: readonly Account[]): string => {
  let number = accounts.length + 1
  while (accounts.some((account) => account.label === `账号 ${number}`)) number++
  return `账号 ${number}`
}

class SubscriptionModelDiscoveryError extends Error {}

/** pi-ai's login and refresh messages are English and technical; the page shows these instead. */
function loginFailure(error: unknown, label: string): string {
  if (error instanceof SubscriptionModelDiscoveryError)
    return `已登录 ${label}，但没能读取模型列表。请点击“获取可用模型”重试。`
  const message = error instanceof Error ? error.message : String(error)
  if (/Port \d+ is in use/u.test(message))
    return `${label} 登录需要的本机端口 1455 被占用，可能有另一个登录（例如 Codex 命令行）没有结束。结束后再试。`
  if (/did not include chatgpt\.tokens\.use\.direct/u.test(message))
    return `这个账号没有允许使用 ${label} 套餐额度。请在授权页面允许后重新登录。`
  if (/state mismatch|callback URL/iu.test(message)) return '粘贴的网址不是这次登录的回调地址，请重新登录。'
  if (/authorization failed|access_denied/iu.test(message)) return `${label} 登录已取消。`
  if (/token request failed/u.test(message)) return `${label} 授权没有完成，请重新登录。`
  return `${label} 登录没有完成，请重试。`
}

/** OpenAI asks a signed-out app to revoke the refresh token; the user can still disconnect in ChatGPT settings. */
async function revokeChatGpt(credential: Credential, fetcher: typeof fetch): Promise<boolean> {
  if (credential.type !== 'oauth' || typeof credential['clientId'] !== 'string') return false
  try {
    const discovery = z
      .object({ revocation_endpoint: z.url() })
      .parse(
        await (
          await fetcher(`${OPENAI_ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) })
        ).json(),
      )
    if (new URL(discovery.revocation_endpoint).origin !== OPENAI_ISSUER) return false
    const response = await fetcher(discovery.revocation_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: credential.refresh,
        token_type_hint: 'refresh_token',
        client_id: credential['clientId'],
      }),
      signal: AbortSignal.timeout(10_000),
    })
    return response.status === 200
  } catch {
    return false
  }
}

/**
 * Accounts and sign-in for subscription providers. One account per provider is active: it occupies DSH's single
 * credential slot, which every agent using the provider reads. The others wait in an NXT-owned record and are
 * swapped in under DSH's credential lock, so a refresh can never be written to the wrong account.
 */
export class SubscriptionLogins {
  readonly #context: Context
  readonly #options: SubscriptionLoginsOptions
  readonly #fetch: typeof fetch
  readonly #attempts = new Map<SubscriptionProvider, Attempt>()
  /** What the running sign-in displaced from the slot, per provider; the account to park afterwards. */
  readonly #replacedSlot = new Map<SubscriptionProvider, { previous?: CredentialRecord }>()
  #queue: Promise<unknown> = Promise.resolve()

  constructor(context: Context, options: SubscriptionLoginsOptions) {
    this.#context = context
    this.#options = options
    this.#fetch = options.fetch ?? fetch
  }

  dispose(): void {
    for (const attempt of this.#attempts.values()) attempt.abort.abort()
  }

  async status(provider: SubscriptionProvider): Promise<SubscriptionStatusView> {
    const vault: Pick<Vault, 'activeId' | 'accounts'> = this.#context.get('credentials')
      ? await this.#vault(provider)
      : { accounts: [] }
    const attempt = this.#attempts.get(provider)
    return {
      provider,
      label: SUBSCRIPTIONS[provider].label,
      usageUrl: SUBSCRIPTIONS[provider].usageUrl,
      available: this.#context.get('credentials') !== undefined,
      mode: this.mode(provider),
      activeAccountId: vault.activeId ?? null,
      accounts: vault.accounts.map((account) => ({
        id: account.id,
        label: account.label,
        email: account.email ?? null,
        createdAt: account.createdAt,
      })),
      login: attempt
        ? {
            id: attempt.id,
            status: attempt.status,
            notices: [...attempt.notices],
            prompt: attempt.prompt
              ? {
                  id: attempt.prompt.id,
                  kind: attempt.prompt.kind,
                  message: attempt.prompt.message,
                  ...(attempt.prompt.placeholder === undefined ? {} : { placeholder: attempt.prompt.placeholder }),
                  ...(attempt.prompt.options === undefined ? {} : { options: attempt.prompt.options }),
                }
              : null,
            error: attempt.error ?? null,
          }
        : null,
    }
  }

  /** How a route authenticates: an API key reference wins over a stored sign-in, as in DSH itself. */
  mode(provider: string): SubscriptionStatusView['mode'] {
    const { value } = this.#options.profile(provider)
    if (value === undefined) return 'unconfigured'
    return typeof value['apiKeyEnv'] === 'string' ? 'api-key' : 'subscription'
  }

  /** The saved route settings, for telling a real draft from a page that echoes them back. */
  savedProfile(provider: string): Readonly<Record<string, unknown>> | undefined {
    return this.#options.profile(provider).value
  }

  /** An untouched installed directory says nothing about the signed-in account's models. */
  hasModelSelection(provider: string): boolean {
    const value = this.savedProfile(provider)
    const overrides = value?.['modelOverrides']
    return (
      (Array.isArray(value?.['models']) && value['models'].length > 0) ||
      (typeof overrides === 'object' && overrides !== null && Object.keys(overrides).length > 0)
    )
  }

  /** The label of the account the route is using, for the provider overview. */
  async activeLabel(provider: SubscriptionProvider): Promise<string | null> {
    const vault = await this.#vault(provider)
    return vault.accounts.find((account) => account.id === vault.activeId)?.label ?? null
  }

  /** Point the route at the signed-in account. A saved API key stays in the store, unused, until chosen again. */
  useSubscription(provider: SubscriptionProvider, expectedRevision: number): Promise<void> {
    return this.#serial(async () => {
      const { value } = this.#options.profile(provider)
      const ops: ProfileOp[] =
        value === undefined
          ? [{ op: 'set', path: ['providers', provider], value: { api: 'openai-responses' } }]
          : [
              ...(value['apiKeyEnv'] === undefined
                ? []
                : [{ op: 'unset' as const, path: ['providers', provider, 'apiKeyEnv'] }]),
              // Account model lists include models the installed catalog does not know yet.
              { op: 'set' as const, path: ['providers', provider, 'api'], value: 'openai-responses' },
            ]
      await this.#options.mutateProfile(ops, expectedRevision)
      this.#options.changed?.()
    })
  }

  login(provider: SubscriptionProvider): Promise<void> {
    return this.#serial(async () => {
      if (!this.#context.get('credentials'))
        throw new Error(`${SUBSCRIPTIONS[provider].label} 登录在这台主机上不可用。`)
      if (this.#attempts.get(provider)?.status === 'running') throw new Error('已经有一个登录在进行中。')
      if (this.mode(provider) === 'api-key')
        throw new Error(`这个供应商正在使用 API 密钥。先改用 ${SUBSCRIPTIONS[provider].label} 套餐，再登录。`)
      // A copy first, so a crash between the sign-in and the bookkeeping below loses at most a refresh.
      await this.#parkCopyOfActive(provider)
      const attempt: Attempt = {
        id: randomUUID(),
        status: 'running',
        notices: [],
        prompt: undefined,
        error: undefined,
        abort: new AbortController(),
      }
      this.#attempts.set(provider, attempt)
      const replaced: { previous?: CredentialRecord } = {}
      this.#replacedSlot.set(provider, replaced)
      void this.#signIn(provider, attempt)
        .then(async (outcome) => {
          if (outcome.status === 'authorized') await this.#serial(() => this.#adoptSignedIn(provider, replaced))
          attempt.status = outcome.status
        })
        .catch((error: unknown) => {
          attempt.status = 'failed'
          attempt.error = loginFailure(error, SUBSCRIPTIONS[provider].label)
        })
        .finally(() => {
          this.#replacedSlot.delete(provider)
          attempt.prompt?.reject(new AuthorizationDeclinedError())
          attempt.prompt = undefined
          this.#options.changed?.()
        })
      this.#options.changed?.()
    })
  }

  /**
   * DSH's own flow when it offers a browser sign-in for this provider; otherwise pi-ai's login with this
   * installation's ID, which is the part DSH cannot supply. Either way the credential lands in DSH's slot.
   */
  async #signIn(provider: SubscriptionProvider, attempt: Attempt): Promise<{ status: 'authorized' | 'cancelled' }> {
    const interaction = {
      notify: (next: AuthorizationNotice) => {
        attempt.notices = [...attempt.notices, next].slice(-NOTICE_LIMIT)
        this.#options.changed?.()
      },
      prompt: (prompt: AuthorizationPrompt) => this.#ask(attempt, prompt),
    }
    const authorization = this.#context.get('authorization')
    const key = recordKeyFor(provider)
    if (authorization?.describe(key)?.methods.some((method) => method.id === 'oauth')) {
      return authorization.begin({ key, method: 'oauth', signal: attempt.abort.signal, interaction })
    }
    const deviceId = (await this.#vault(provider)).deviceId
    const models = createModels({ credentials: this.#slotStore(), authContext: NO_AMBIENT_AUTH })
    models.setProvider(openaiProvider())
    try {
      await models.login(
        provider,
        'oauth',
        {
          signal: attempt.abort.signal,
          notify: (event) => interaction.notify(notice(event)),
          prompt: (prompt) => interaction.prompt(restate(prompt)),
        },
        { getDeviceId: () => deviceId, agentName: AGENT_NAME },
      )
    } catch (error) {
      if (attempt.abort.signal.aborted) return { status: 'cancelled' }
      throw error
    }
    return { status: 'authorized' }
  }

  answer(provider: SubscriptionProvider, promptId: string, value: string): void {
    const prompt = this.#attempts.get(provider)?.prompt
    if (prompt?.id !== promptId) throw new Error('这个问题已经过期，请看最新的登录状态。')
    prompt.resolve(value)
  }

  cancel(provider: SubscriptionProvider): void {
    const attempt = this.#attempts.get(provider)
    if (attempt?.status !== 'running') return
    attempt.abort.abort()
    attempt.prompt?.reject(new AuthorizationDeclinedError())
  }

  activate(provider: SubscriptionProvider, accountId: string): Promise<void> {
    return this.#serial(async () => {
      const vault = await this.#vault(provider)
      const target = vault.accounts.find((account) => account.id === accountId)
      if (!target) throw new Error('这个账号已不存在，请刷新后重试。')
      if (vault.activeId === accountId) return
      if (!target.parked) throw new Error('这个账号需要重新登录。')
      await this.#parkCopyOfActive(provider)
      let previous: CredentialRecord | undefined
      const parked = target.parked
      await this.#context.credentials.modifyRecord(recordKeyFor(provider), (current) => {
        previous = current
        return Promise.resolve(toRecord(parked))
      })
      await this.#writeVault(provider, (current) => ({
        ...current,
        activeId: accountId,
        accounts: current.accounts.map((account) => {
          if (account.id === accountId) return withoutParked(account)
          if (account.id === current.activeId) return withParked(account, fromRecord(previous))
          return account
        }),
      }))
      this.#options.changed?.()
    })
  }

  rename(provider: SubscriptionProvider, accountId: string, label: string): Promise<void> {
    return this.#serial(async () => {
      const trimmed = label.trim()
      if (!trimmed) throw new Error('账号名称不能为空。')
      await this.#writeVault(provider, (current) => {
        if (!current.accounts.some((account) => account.id === accountId))
          throw new Error('这个账号已不存在，请刷新后重试。')
        return {
          ...current,
          accounts: current.accounts.map((account) =>
            account.id === accountId ? { ...account, label: trimmed } : account,
          ),
        }
      })
      this.#options.changed?.()
    })
  }

  /** Sign one account out of this host: revoke when OpenAI confirms it, then forget its tokens. */
  remove(provider: SubscriptionProvider, accountId: string): Promise<{ readonly revocationConfirmed: boolean }> {
    return this.#serial(async () => {
      const vault = await this.#vault(provider)
      const account = vault.accounts.find((item) => item.id === accountId)
      if (!account) throw new Error('这个账号已不存在，请刷新后重试。')
      const credential =
        vault.activeId === accountId
          ? fromRecord(await this.#context.credentials.readRecord(recordKeyFor(provider)))
          : (account.parked as Credential | undefined)
      const revocationConfirmed = credential ? await SUBSCRIPTIONS[provider].revoke(credential, this.#fetch) : true
      if (vault.activeId === accountId) await this.#context.credentials.deleteRecord(recordKeyFor(provider))
      await this.#writeVault(provider, (current) => {
        const { activeId, ...rest } = current
        return {
          ...rest,
          ...(activeId === undefined || activeId === accountId ? {} : { activeId }),
          accounts: current.accounts.filter((item) => item.id !== accountId),
        }
      })
      this.#options.changed?.()
      return { revocationConfirmed }
    })
  }

  /** The models this account may use. The installed catalog lists every OpenAI model, not the plan's. */
  async discoverModels(provider: SubscriptionProvider): Promise<readonly { id: string; name: string }[]> {
    const models = createModels({ credentials: this.#slotStore(), authContext: NO_AMBIENT_AUTH })
    models.setProvider(openaiProvider())
    // Refreshes under DSH's credential lock when the token is about to expire, as a request would.
    const token = (await models.getAuth(provider))?.auth.apiKey
    if (!token) throw new Error(`请先登录 ${SUBSCRIPTIONS[provider].label}。`)
    try {
      const response = await this.#fetch(OPENAI_MODELS_URL, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) throw new Error(`Model catalog returned HTTP ${response.status}`)
      const catalog = z
        .object({
          models: z.array(
            z.object({ slug: z.string().min(1), display_name: z.string().min(1), visibility: z.string() }).loose(),
          ),
        })
        .loose()
        .parse(await response.json())
      return catalog.models
        .filter((model) => model.visibility === 'list')
        .map((model) => ({ id: model.slug, name: model.display_name }))
    } catch (cause) {
      throw new SubscriptionModelDiscoveryError(
        `没能读取 ${SUBSCRIPTIONS[provider].label} 账号的模型列表，请检查登录后重试。`,
        { cause },
      )
    }
  }

  /** pi-ai's store over DSH's slot, as DSH's own adapter writes it, noting what a sign-in replaces. */
  #slotStore(): CredentialStore {
    const credentials = this.#context.credentials
    return {
      read: async (providerId) => fromRecord(await credentials.readRecord(recordKeyFor(providerId))),
      list: () => Promise.resolve([]),
      modify: async (providerId, mutate) => {
        const replaced = isSubscriptionProvider(providerId) ? this.#replacedSlot.get(providerId) : undefined
        return fromRecord(
          await credentials.modifyRecord(recordKeyFor(providerId), async (current) => {
            const next = await mutate(fromRecord(current))
            if (next === undefined) return undefined
            if (replaced && current !== undefined) replaced.previous = current
            return toRecord(next)
          }),
        )
      },
      delete: (providerId) => credentials.deleteRecord(recordKeyFor(providerId)),
    }
  }

  /** The new sign-in now holds the slot: record it, and park whichever account it displaced. */
  async #adoptSignedIn(provider: SubscriptionProvider, replaced: { previous?: CredentialRecord }): Promise<void> {
    const signedIn = fromRecord(await this.#context.credentials.readRecord(recordKeyFor(provider)))
    const { subject, email } = identityOf(signedIn)
    const previous = fromRecord(replaced.previous)
    await this.#writeVault(provider, (current) => {
      let accounts = current.accounts
      if (current.activeId !== undefined) {
        accounts = accounts.map((account) =>
          account.id === current.activeId ? withParked(account, previous ?? account.parked) : account,
        )
      } else if (previous?.type === 'oauth') {
        // A sign-in made before accounts existed here: keep it as an account rather than drop it.
        accounts = [
          ...accounts,
          withParked(
            { id: randomUUID(), label: identityOf(previous).email ?? nextLabel(accounts), createdAt: Date.now() },
            previous,
          ),
        ]
      }
      // Signing the same account in again refreshes it instead of adding a twin.
      const same =
        subject === undefined && email === undefined
          ? undefined
          : accounts.find((account) => (subject === undefined ? account.email === email : account.subject === subject))
      const id = same?.id ?? randomUUID()
      accounts = same
        ? accounts.map((account) => (account.id === id ? withoutParked(account) : account))
        : [
            ...accounts,
            {
              id,
              label: email ?? nextLabel(accounts),
              ...(email ? { email } : {}),
              ...(subject ? { subject } : {}),
              createdAt: Date.now(),
            },
          ]
      return { ...current, activeId: id, accounts }
    })
    const { value, revision } = this.#options.profile(provider)
    // The installed catalog lists every OpenAI model; an untouched list becomes the ones this account may use.
    let models: readonly { id: string; name: string }[] | undefined
    if (!this.hasModelSelection(provider)) {
      models = await this.discoverModels(provider)
    }
    const ops: ProfileOp[] =
      value === undefined
        ? [
            {
              op: 'set',
              path: ['providers', provider],
              value: { api: 'openai-responses', ...(models?.length ? { models } : {}) },
            },
          ]
        : models?.length
          ? [{ op: 'set', path: ['providers', provider, 'models'], value: models }]
          : []
    if (ops.length > 0) await this.#options.mutateProfile(ops, revision)
  }

  /** Copy the slot into the active account's parked credential; the slot itself is untouched. */
  async #parkCopyOfActive(provider: SubscriptionProvider): Promise<void> {
    const vault = await this.#vault(provider)
    if (vault.activeId === undefined) return
    const current = fromRecord(await this.#context.credentials.readRecord(recordKeyFor(provider)))
    if (current?.type !== 'oauth') return
    await this.#writeVault(provider, (latest) => ({
      ...latest,
      accounts: latest.accounts.map((account) =>
        account.id === latest.activeId ? withParked(account, current) : account,
      ),
    }))
  }

  #ask(attempt: Attempt, prompt: AuthorizationPrompt): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const id = randomUUID()
      const withdraw = () => {
        if (attempt.prompt?.id !== id) return
        attempt.prompt = undefined
        this.#options.changed?.()
        reject(new Error('Prompt withdrawn.'))
      }
      if (prompt.signal?.aborted) return withdraw()
      prompt.signal?.addEventListener('abort', withdraw, { once: true })
      attempt.prompt = {
        id,
        kind: prompt.kind,
        message: promptMessage(prompt),
        ...('placeholder' in prompt && prompt.placeholder !== undefined ? { placeholder: prompt.placeholder } : {}),
        ...(prompt.kind === 'select' ? { options: prompt.options } : {}),
        resolve: (value) => {
          attempt.prompt = undefined
          resolve(value)
        },
        reject: (error) => {
          attempt.prompt = undefined
          reject(error)
        },
      }
      this.#options.changed?.()
    })
  }

  async #vault(provider: SubscriptionProvider): Promise<Vault> {
    const record = await this.#context.credentials.readRecord(vaultKey(provider))
    if (record?.kind === 'grant') {
      const parsed = VaultSchema.safeParse(record.payload)
      if (parsed.success) return parsed.data
    }
    return this.#writeVault(provider, (current) => current)
  }

  async #writeVault(provider: SubscriptionProvider, update: (current: Vault) => Vault): Promise<Vault> {
    let written: Vault | undefined
    await this.#context.credentials.modifyRecord(vaultKey(provider), (record) => {
      const parsed = record?.kind === 'grant' ? VaultSchema.safeParse(record.payload) : undefined
      written = VaultSchema.parse(
        update(parsed?.success ? parsed.data : { version: 1, deviceId: randomUUID(), accounts: [] }),
      )
      return Promise.resolve({ kind: 'grant', payload: written })
    })
    return written!
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation)
    this.#queue = result.catch(() => undefined)
    return result
  }
}

const withParked = (account: Account, credential: Credential | Account['parked'] | undefined): Account =>
  credential?.type === 'oauth' ? { ...account, parked: OAuthCredentialSchema.parse(credential) } : account
const withoutParked = (account: Account): Account => {
  const next = { ...account }
  delete next.parked
  return next
}

const promptMessage = (prompt: AuthorizationPrompt): string =>
  /redirect URL|callback/iu.test(prompt.message)
    ? '如果浏览器登录后没有自动完成，请把浏览器最后跳转到的完整网址粘贴到这里。'
    : prompt.message

/** pi-ai's login events in the seam's notice vocabulary; the page renders the link and code itself. */
function notice(event: AuthEvent): AuthorizationNotice {
  switch (event.type) {
    case 'auth_url':
      return { message: '在浏览器中打开授权页面，登录并允许使用套餐。', url: event.url }
    case 'device_code':
      return { message: '在验证页面输入这个代码完成登录。', url: event.verificationUri, code: event.userCode }
    case 'progress':
      return { message: '正在完成登录…' }
    case 'info':
      return { message: event.message, ...(event.links?.[0] ? { url: event.links[0].url } : {}) }
    default:
      return { message: '正在登录…' }
  }
}

function restate(prompt: AuthPrompt): AuthorizationPrompt {
  const signal = prompt.signal === undefined ? {} : { signal: prompt.signal }
  const placeholder =
    'placeholder' in prompt && prompt.placeholder !== undefined ? { placeholder: prompt.placeholder } : {}
  if (prompt.type === 'select') return { ...signal, kind: 'select', message: prompt.message, options: prompt.options }
  if (prompt.type === 'secret') return { ...signal, kind: 'secret', message: prompt.message, ...placeholder }
  return { ...signal, kind: 'text', message: prompt.message, ...placeholder }
}
