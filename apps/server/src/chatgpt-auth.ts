import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { z } from 'zod'

const ISSUER = 'https://auth.openai.com'
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1'
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`
const DIRECT_SCOPE = 'chatgpt.tokens.use.direct'
const randomValue = () => randomBytes(32).toString('base64url')
const ModelSchema = z.object({ id: z.string().min(1), name: z.string().min(1) })
const TokensSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
  token_type: z.string().refine((value) => value.toLowerCase() === 'bearer'),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
})
const AccountSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  clientId: z.string().min(1),
  subject: z.string().min(1),
  email: z.string().optional(),
  tokens: TokensSchema.extend({ expiresAt: z.number(), scope: z.string() }).optional(),
  models: z.array(ModelSchema).default([]),
})
const StateSchema = z.object({
  version: z.literal(1),
  hostId: z.string().startsWith('urn:uuid:'),
  activeId: z.string().optional(),
  pendingClientId: z.string().optional(),
  welcomed: z.boolean().default(false),
  accounts: z.array(AccountSchema),
})
type Account = z.output<typeof AccountSchema>
const nextLabel = (accounts: readonly Account[]): string => {
  const labels = new Set(accounts.map((account, index) => account.label ?? `账号 ${index + 1}`))
  let number = 1
  while (labels.has(`账号 ${number}`)) number++
  return `账号 ${number}`
}
type State = z.output<typeof StateSchema>
type Identity = { subject: string; email?: string }
export async function verifyChatGptIdentity(
  token: string,
  clientId: string,
  nonce: string | undefined,
  jwks: JWTVerifyGetKey,
): Promise<Identity> {
  const { payload } = await jwtVerify(token, jwks, {
    issuer: ISSUER,
    audience: clientId,
    requiredClaims: ['sub', 'exp', 'iat'],
    clockTolerance: 5,
  })
  if (!payload.sub || (nonce !== undefined && payload['nonce'] !== nonce))
    throw new Error('ChatGPT 账号校验失败，请重新登录。')
  return { subject: payload.sub, ...(typeof payload['email'] === 'string' ? { email: payload['email'] } : {}) }
}
type Login = {
  id: string
  state: string
  nonce: string
  verifier: string
  redirectUri: string
  clientId: string
  accountId?: string
  status: 'waiting' | 'exchanging' | 'completed' | 'failed' | 'cancelled'
  message?: string
  server: Server
  timer: ReturnType<typeof setTimeout>
  task?: Promise<void>
}

export interface ChatGptAuthOptions {
  /** Tests inject transport and signed identity verification; production always uses OpenAI JWKS. */
  fetch?: typeof fetch
  verifyIdentity?: (token: string, clientId: string, nonce?: string) => Promise<Identity>
  onSecret?: (value: string) => void
}

/** Host-owned OAuth registrations. Neither token sets nor ID-token hints enter product responses. */
export class ChatGptAuth {
  readonly #file: string
  readonly #fetch: typeof fetch
  readonly #verify: NonNullable<ChatGptAuthOptions['verifyIdentity']>
  readonly #onSecret: (value: string) => void
  #state: State
  #tail = Promise.resolve()
  #login: Login | undefined
  #disposed = false
  #stopping = false
  #disposePromise: Promise<void> | undefined
  readonly #abort = new AbortController()
  readonly #modelRequests = new Set<Promise<void>>()

  private constructor(file: string, state: State, options: ChatGptAuthOptions) {
    this.#file = file
    this.#state = state
    this.#fetch = options.fetch ?? fetch
    this.#onSecret = (value) => {
      try {
        options.onSecret?.(value)
      } catch {
        /* Diagnostics cannot interrupt auth. */
      }
    }
    for (const account of state.accounts) {
      for (const value of [account.tokens?.access_token, account.tokens?.refresh_token, account.tokens?.id_token])
        if (value) this.#onSecret(value)
    }
    const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`))
    this.#verify =
      options.verifyIdentity ?? ((token, clientId, nonce) => verifyChatGptIdentity(token, clientId, nonce, jwks))
  }

  static async open(root: string, options: ChatGptAuthOptions = {}): Promise<ChatGptAuth> {
    await mkdir(root, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') await chmod(root, 0o700)
    const file = path.join(root, 'accounts.json')
    let state: State
    try {
      state = StateSchema.parse(JSON.parse(await readFile(file, 'utf8')))
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
        throw new Error('ChatGPT 账号文件无法读取，请恢复备份后重试。')
      state = { version: 1, hostId: `urn:uuid:${randomUUID()}`, welcomed: false, accounts: [] }
    }
    const auth = new ChatGptAuth(file, state, options)
    await auth.#save(state)
    const transfer = path.join(root, 'import-accounts.json')
    try {
      // Explicit one-shot transfer of this app's protected file, as documented for self-hosted VMs.
      // The receiving runtime keeps its own host ID and owns all subsequent refreshes.
      const imported = StateSchema.parse(JSON.parse(await readFile(transfer, 'utf8')))
      const accounts = [...state.accounts]
      let selected = state.activeId
      for (const account of imported.accounts) {
        const index = accounts.findIndex(
          (item) => item.clientId === account.clientId && item.subject === account.subject,
        )
        const id =
          index >= 0 ? accounts[index]!.id : accounts.some((item) => item.id === account.id) ? randomUUID() : account.id
        if (index >= 0) accounts[index] = { ...account, id, label: accounts[index]!.label ?? `账号 ${index + 1}` }
        else accounts.push({ ...account, id, label: nextLabel(accounts) })
        if (account.id === imported.activeId) selected = id
      }
      await auth.#save({ ...state, accounts, ...(selected ? { activeId: selected } : {}) })
      await rm(transfer)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
        throw new Error('ChatGPT 账号导入失败，请检查传入的账号文件。')
    }
    return auth
  }

  view() {
    const active = this.#state.accounts.find((account) => account.id === this.#state.activeId)
    return {
      activeId: active?.id ?? null,
      accounts: this.#state.accounts.map((account, index) => ({
        id: account.id,
        label: account.label ?? `账号 ${index + 1}`,
        email: account.email ?? null,
        signedIn: account.tokens !== undefined,
        planEnabled: account.tokens?.scope.split(' ').includes(DIRECT_SCOPE) ?? false,
      })),
      models: active?.tokens?.scope.split(' ').includes(DIRECT_SCOPE) ? active.models : [],
      welcome: !this.#state.welcomed && active?.tokens?.scope.split(' ').includes(DIRECT_SCOPE) === true,
      login: this.#login
        ? {
            id: this.#login.id,
            status: this.#login.status,
            message: this.#login.message ?? null,
          }
        : null,
    }
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(() => {
      if (this.#disposed || this.#stopping) throw new Error('ChatGPT 登录已停止。')
      return operation()
    })
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async #save(state: State): Promise<void> {
    const temporary = `${this.#file}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    try {
      try {
        await file.writeFile(JSON.stringify(state))
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, this.#file)
    } finally {
      await rm(temporary, { force: true })
    }
    this.#state = state
    for (const account of state.accounts) {
      for (const value of [account.tokens?.access_token, account.tokens?.refresh_token, account.tokens?.id_token])
        if (value) this.#onSecret(value)
    }
  }

  #signal(timeout: number): AbortSignal {
    return AbortSignal.any([this.#abort.signal, AbortSignal.timeout(timeout)])
  }

  async start(accountId?: string) {
    return this.#exclusive(async () => {
      await this.#cancel()
      const account = accountId ? this.#state.accounts.find((item) => item.id === accountId) : undefined
      if (accountId && !account) throw new Error('ChatGPT 账号已不存在，请刷新列表。')
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (req.method !== 'GET' || url.pathname !== '/auth/callback') {
          res.writeHead(404).end()
          return
        }
        const login = this.#login
        if (
          !login ||
          login.server !== server ||
          login.status !== 'waiting' ||
          url.searchParams.get('state') !== login.state
        ) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('登录请求无效或已过期。')
          return
        }
        login.status = 'exchanging'
        clearTimeout(login.timer)
        login.task = this.#exclusive(() => this.#complete(login, url))
          .then(
            () => {
              res.writeHead(200, {
                'content-type': 'text/plain; charset=utf-8',
                'cache-control': 'no-store',
                'referrer-policy': 'no-referrer',
              })
              res.end('ChatGPT 登录已完成，可以关闭此页面并返回 NekroNXT。')
            },
            (cause: unknown) => {
              login.status = 'failed'
              login.message =
                cause instanceof Error && /^ChatGPT .*[。]$/u.test(cause.message)
                  ? cause.message
                  : 'ChatGPT 登录未完成，请重试。'
              res
                .writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
                .end(login.message)
            },
          )
          .finally(() => {
            server.close()
            server.closeIdleConnections()
          })
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('ChatGPT 登录页面无法启动，请重试。')
      const login: Login = {
        id: randomUUID(),
        state: randomValue(),
        nonce: randomValue(),
        verifier: randomValue(),
        redirectUri: `http://127.0.0.1:${address.port}/auth/callback`,
        clientId: account?.clientId ?? this.#state.pendingClientId ?? 'dynamic_agent_client',
        ...(accountId ? { accountId } : {}),
        status: 'waiting',
        server,
        timer: setTimeout(() => {
          login.status = 'failed'
          login.message = 'ChatGPT 登录已超时，请重试。'
          server.close()
        }, 5 * 60_000),
      }
      login.timer.unref()
      this.#login = login
      const url = new URL(`${ISSUER}/api/accounts/authorize`)
      url.search = new URLSearchParams({
        client_id: login.clientId,
        ext_agent_host_id: this.#state.hostId,
        ...(login.clientId === 'dynamic_agent_client' ? { agent_name_hint: 'NekroNXT' } : {}),
        ...(account?.tokens?.id_token ? { id_token_hint: account.tokens.id_token } : {}),
        ...(account?.email ? { login_hint: account.email } : {}),
        response_type: 'code',
        redirect_uri: login.redirectUri,
        scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
        resource: CHATGPT_RESOURCE,
        state: login.state,
        nonce: login.nonce,
        code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(login.verifier).digest('base64url'),
      }).toString()
      return { authorizeUrl: url.toString() }
    })
  }

  async #complete(login: Login, url: URL): Promise<void> {
    if (url.searchParams.has('error')) throw new Error('ChatGPT 登录已取消。')
    const existing = this.#state.accounts.find((account) => account.id === login.accountId)
    const clientId =
      url.searchParams.get('client_id') ?? (login.clientId !== 'dynamic_agent_client' ? login.clientId : undefined)
    const code = url.searchParams.get('code')
    if (
      !code ||
      !clientId ||
      clientId === 'dynamic_agent_client' ||
      (login.clientId !== 'dynamic_agent_client' && clientId !== login.clientId)
    )
      throw new Error('ChatGPT 注册未完成，请重新登录。')
    if (login.clientId === 'dynamic_agent_client') await this.#save({ ...this.#state, pendingClientId: clientId })
    const tokens = await this.#exchange({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: login.verifier,
      redirect_uri: login.redirectUri,
    })
    if (!tokens.id_token) throw new Error('ChatGPT 账号校验失败，请重新登录。')
    const identity = await this.#verify(tokens.id_token, clientId, login.nonce)
    if (existing && identity.subject !== existing.subject) throw new Error('ChatGPT 账号与原账号不一致，请重新登录。')
    const duplicate = this.#state.accounts.find(
      (account) => account.clientId === clientId && account.subject === identity.subject,
    )
    const account: Account = {
      id: existing?.id ?? duplicate?.id ?? randomUUID(),
      label: existing?.label ?? duplicate?.label ?? nextLabel(this.#state.accounts),
      clientId,
      subject: identity.subject,
      ...(identity.email ? { email: identity.email } : {}),
      tokens: { ...tokens, scope: tokens.scope ?? '', expiresAt: Date.now() + tokens.expires_in * 1000 },
      models: [],
    }
    // Identity-only consent is saved honestly; inference checks the actual grant.
    const state = { ...this.#state }
    delete state.pendingClientId
    await this.#save({
      ...state,
      activeId: account.id,
      accounts: this.#state.accounts.some((item) => item.id === account.id)
        ? this.#state.accounts.map((item) => (item.id === account.id ? account : item))
        : [...this.#state.accounts, account],
    })
    login.status = 'completed'
  }

  async #exchange(form: Record<string, string>) {
    const response = await this.#fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...form, resource: CHATGPT_RESOURCE }),
      signal: this.#signal(30_000),
    })
    if (!response.ok) {
      if (response.status === 400 || response.status === 401) throw new Error('ChatGPT 授权已失效，请重新登录。')
      throw new Error('ChatGPT 暂时无法连接，请稍后重试。')
    }
    const tokens = TokensSchema.parse(await response.json())
    for (const value of [tokens.access_token, tokens.refresh_token, tokens.id_token]) if (value) this.#onSecret(value)
    return tokens
  }

  async accessToken(accountId: string): Promise<string> {
    return this.#exclusive(async () => {
      const account = this.#state.accounts.find((item) => item.id === accountId)
      if (!account?.tokens) throw new Error('ChatGPT 账号已退出，请重新登录。')
      let tokens = account.tokens
      if (!tokens.scope.split(' ').includes(DIRECT_SCOPE))
        throw new Error('请在 ChatGPT 中允许 NekroNXT 使用套餐额度。')
      if (tokens.expiresAt <= Date.now() + 60_000) {
        if (!tokens.refresh_token) throw new Error('ChatGPT 授权已过期，请重新登录。')
        const refreshed = await this.#exchange({
          grant_type: 'refresh_token',
          client_id: account.clientId,
          refresh_token: tokens.refresh_token,
        })
        if (refreshed.id_token) {
          const identity = await this.#verify(refreshed.id_token, account.clientId)
          if (identity.subject !== account.subject) throw new Error('ChatGPT 账号校验失败，请重新登录。')
        }
        tokens = {
          ...tokens,
          ...refreshed,
          scope: refreshed.scope ?? tokens.scope,
          expiresAt: Date.now() + refreshed.expires_in * 1000,
        }
        await this.#save({
          ...this.#state,
          accounts: this.#state.accounts.map((item) => (item.id === accountId ? { ...item, tokens } : item)),
        })
      }
      if (!tokens.scope.split(' ').includes(DIRECT_SCOPE))
        throw new Error('请在 ChatGPT 中允许 NekroNXT 使用套餐额度。')
      return tokens.access_token
    })
  }

  refreshModels(): Promise<void> {
    const request = this.#refreshModels()
    this.#modelRequests.add(request)
    void request.finally(() => this.#modelRequests.delete(request)).catch(() => undefined)
    return request
  }

  async #refreshModels(): Promise<void> {
    const id = this.#state.activeId
    if (!id) throw new Error('请先登录 ChatGPT。')
    const token = await this.accessToken(id)
    const response = await this.#fetch(`${CHATGPT_RESOURCE}/models`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: this.#signal(30_000),
    })
    if (!response.ok) throw new Error('ChatGPT 模型列表获取失败，请检查授权后重试。')
    const catalog = z
      .object({
        models: z.array(z.object({ slug: z.string().min(1), display_name: z.string().min(1), visibility: z.string() })),
      })
      .parse(await response.json())
    const models = catalog.models
      .filter((model) => model.visibility === 'list')
      .map((model) => ({ id: model.slug, name: model.display_name }))
    await this.#exclusive(async () => {
      const account = this.#state.accounts.find((item) => item.id === id)
      if (!account?.tokens) return
      await this.#save({
        ...this.#state,
        accounts: this.#state.accounts.map((item) => (item.id === id ? { ...item, models } : item)),
      })
    })
  }

  async select(accountId: string): Promise<void> {
    await this.#exclusive(async () => {
      if (!this.#state.accounts.some((account) => account.id === accountId && account.tokens))
        throw new Error('请先登录这个 ChatGPT 账号。')
      await this.#save({ ...this.#state, activeId: accountId })
    })
  }

  async logout(accountId: string): Promise<{ revoked: boolean }> {
    return this.#exclusive(async () => {
      const account = this.#state.accounts.find((item) => item.id === accountId)
      if (!account) throw new Error('ChatGPT 账号已不存在，请刷新列表。')
      let revoked = !account.tokens?.refresh_token
      if (account.tokens?.refresh_token) {
        for (let attempt = 0; attempt < 2 && !revoked; attempt++) {
          try {
            const discovery = z
              .object({ revocation_endpoint: z.string().url() })
              .parse(
                await (
                  await this.#fetch(`${ISSUER}/.well-known/openid-configuration`, { signal: this.#signal(10_000) })
                ).json(),
              )
            if (new URL(discovery.revocation_endpoint).origin !== ISSUER) throw new Error('Invalid revocation origin.')
            const response = await this.#fetch(discovery.revocation_endpoint, {
              method: 'POST',
              body: new URLSearchParams({
                token: account.tokens.refresh_token,
                token_type_hint: 'refresh_token',
                client_id: account.clientId,
              }),
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              signal: this.#signal(10_000),
            })
            revoked = response.status === 200
            if (!revoked && response.status < 500) break
          } catch {
            revoked = false
          }
          if (!revoked && attempt === 0 && !this.#stopping)
            await new Promise<void>((resolve) => setTimeout(resolve, 200))
        }
      }
      const { activeId, ...rest } = this.#state
      await this.#save({
        ...rest,
        ...(activeId && activeId !== accountId ? { activeId } : {}),
        accounts: this.#state.accounts.map((item) => {
          if (item.id !== accountId) return item
          const registration = { ...item }
          delete registration.tokens
          return { ...registration, models: [] }
        }),
      })
      return { revoked }
    })
  }

  async acknowledge(): Promise<void> {
    await this.#exclusive(() => this.#save({ ...this.#state, welcomed: true }))
  }
  async cancel(): Promise<void> {
    await this.#exclusive(() => this.#cancel())
  }
  async #cancel(): Promise<void> {
    const login = this.#login
    if (!login || login.status !== 'waiting') return
    clearTimeout(login.timer)
    login.status = 'cancelled'
    await new Promise<void>((resolve) => login.server.close(() => resolve()))
    login.server.closeIdleConnections()
  }

  dispose(): Promise<void> {
    return (this.#disposePromise ??= this.#dispose())
  }
  async #dispose(): Promise<void> {
    this.#stopping = true
    this.#abort.abort()
    await this.#tail
    await this.#cancel()
    await this.#login?.task
    await Promise.allSettled(this.#modelRequests)
    this.#disposed = true
  }
}
