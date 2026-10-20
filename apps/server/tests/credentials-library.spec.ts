import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AgentIdSchema, CredentialIdSchema, type AgentId } from '@nekro-nxt/contracts'
import { openMigratedCoreDatabase, SqliteCoreRepository, type CoreDatabase } from '@nekro-nxt/storage-sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { CredentialError, CredentialLibrary } from '../src/credentials-library.ts'
import { LocalCredentialStore } from '../src/credentials.ts'
import { SecretRegistry } from '../src/secret-registry.ts'

const directories: string[] = []
const databases: CoreDatabase[] = []
afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const agent = AgentIdSchema.parse('agt_FIXTURE')
const otherAgent = AgentIdSchema.parse('agt_OTHER')

/** GitHub as the library sees it: token → login (and scopes for classic tokens), anything else is rejected. */
const github = (accounts: Record<string, { login: string; scopes?: string }>) =>
  ((_url: unknown, init?: RequestInit) => {
    const header = new Headers(init?.headers).get('authorization') ?? ''
    const account = accounts[header.replace(/^Bearer /u, '')]
    if (account === undefined) return Promise.resolve(new Response('{}', { status: 401 }))
    return Promise.resolve(
      new Response(JSON.stringify({ login: account.login }), {
        headers: account.scopes === undefined ? {} : { 'x-oauth-scopes': account.scopes },
      }),
    )
  }) as typeof fetch

/** A `gh` that answers `auth status --json hosts` and `auth token --user` for two fictional logins. */
const fakeGh = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-fake-gh-'))
  directories.push(root)
  const executable = path.join(root, 'gh')
  await writeFile(
    executable,
    [
      '#!/bin/sh',
      'case "$*" in',
      '  *"auth status"*) echo \'{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"octo-fixture"},{"state":"success","active":false,"host":"github.com","login":"second-fixture"}]}}\' ;;',
      '  *"--user octo-fixture"*) echo tok-from-gh ;;',
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
  )
  await chmod(executable, 0o755)
  return executable
}

const setup = async (
  options: {
    readonly accounts?: Record<string, { login: string; scopes?: string }>
    readonly githubCli?: () => string | undefined
    readonly accountGrants?: ReadonlyMap<string, readonly AgentId[]>
  } = {},
) => {
  const root = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-credentials-'))
  directories.push(root)
  const database = await openMigratedCoreDatabase(path.join(root, 'core.sqlite'))
  databases.push(database)
  const repository = new SqliteCoreRepository(database)
  const store = new LocalCredentialStore(path.join(root, 'credentials'))
  let sequence = 0
  const make = (secrets = new SecretRegistry()) =>
    new CredentialLibrary(repository, store, {
      secrets,
      now: () => 1_000,
      nextId: () => `FIXTURE${(sequence += 1)}`,
      fetch: github(options.accounts ?? {}),
      ...(options.githubCli === undefined ? {} : { githubCli: options.githubCli }),
      ...(options.accountGrants === undefined ? {} : { accountGrants: () => options.accountGrants! }),
    })
  const secrets = new SecretRegistry()
  const library = make(secrets)
  await library.prepare()
  return { library, repository, store, make, secrets }
}

describe('credential library', () => {
  it('stores the value write-only and hides it under the credential name', async () => {
    const { library, secrets, repository } = await setup()
    const created = await library.create({
      kind: 'generic',
      name: '示例天气',
      description: '天气查询',
      domains: ['api.weather.test'],
      value: 'weather-fixture-key-123',
    })
    expect(created).toMatchObject({
      name: '示例天气',
      usage: 'request',
      agentScope: { all: true },
      autoUse: true,
      domains: ['api.weather.test'],
    })
    expect(JSON.stringify(library.list())).not.toContain('weather-fixture-key-123')
    expect(JSON.stringify(repository.credentials.listCredentials())).not.toContain('weather-fixture-key-123')
    expect(secrets.redact('key=weather-fixture-key-123')).toBe('key=[凭据:示例天气]')
    expect(library.redactable(created.id)).toBe(true)

    // A rename moves the redaction label with it.
    await library.update(created.id, { name: '天气服务' })
    expect(secrets.redact('weather-fixture-key-123')).toBe('[凭据:天气服务]')
  })

  it('flags values too short to hide and rejects names already taken, ignoring case', async () => {
    const { library } = await setup()
    const short = await library.create({ kind: 'generic', name: 'PIN', value: '1234', usage: 'program' })
    expect(library.redactable(short.id)).toBe(false)
    await expect(
      library.create({ kind: 'generic', name: 'pin', value: 'another-value', usage: 'program' }),
    ).rejects.toThrow(CredentialError)
    expect(() => CredentialIdSchema.parse(short.id)).not.toThrow()
    // A request-only credential goes nowhere without a domain.
    await expect(library.create({ kind: 'generic', name: '无域名', value: 'nowhere-value' })).rejects.toThrow(
      '至少一个允许的域名',
    )
    await expect(library.update(short.id, { usage: 'request' })).rejects.toThrow('至少一个允许的域名')
  })

  it('clears a use only for agents in scope, and program reads only for program credentials', async () => {
    const { library } = await setup()
    const request = await library.create({
      kind: 'generic',
      name: '仅请求',
      value: 'request-only-value',
      domains: ['api.example.test'],
      agentScope: { agentIds: [agent] },
    })
    const program = await library.create({ kind: 'generic', name: '程序', value: 'program-value', usage: 'program' })
    expect(library.usable(request.id, agent, 'request')).toMatchObject({ value: 'request-only-value' })
    expect(library.usable(request.id, agent, 'program')).toHaveProperty('denied')
    expect(library.usable(request.id, otherAgent, 'request')).toHaveProperty('denied')
    // The host instance serves every agent: only a credential open to all agents.
    expect(library.usable(request.id, undefined, 'request')).toHaveProperty('denied')
    expect(library.usable(program.id, undefined, 'program')).toMatchObject({ value: 'program-value' })
  })

  it('removes a credential at once and survives a restart without it', async () => {
    const { library, make } = await setup()
    const created = await library.create({ kind: 'generic', name: '临时', value: 'temporary-value', usage: 'program' })
    const restarted = make()
    await restarted.prepare()
    expect(restarted.usable(created.id, agent, 'request')).toMatchObject({ value: 'temporary-value' })

    await library.remove(created.id)
    expect(library.usable(created.id, agent, 'request')).toBeUndefined()
    const afterRemoval = make()
    await afterRemoval.prepare()
    expect(afterRemoval.list()).toEqual([])
  })

  it('keeps a GitHub token under the login GitHub reports, and replaces it only with the same account', async () => {
    const { library } = await setup({
      accounts: {
        old: { login: 'octo-fixture', scopes: 'repo, read:org' },
        fresh: { login: 'octo-fixture' },
        other: { login: 'someone-else' },
      },
    })
    const created = await library.create({ kind: 'github', github: { source: 'token', token: ' old ' } })
    expect(created).toMatchObject({
      name: 'GitHub octo-fixture',
      kind: 'github',
      usage: 'program',
      domains: ['github.com', 'api.github.com'],
      metadata: { login: 'octo-fixture', source: 'token', scopes: ['repo', 'read:org'] },
    })
    await library.replaceValue(created.id, { github: { source: 'token', token: 'fresh' } })
    expect(library.usable(created.id, agent, 'program')).toMatchObject({ value: 'fresh' })
    await expect(library.replaceValue(created.id, { github: { source: 'token', token: 'other' } })).rejects.toThrow(
      '请添加为新的凭据',
    )
    await expect(library.update(created.id, { usage: 'request' })).rejects.toThrow(CredentialError)
    await expect(library.create({ kind: 'github', github: { source: 'token', token: 'nope' } })).rejects.toThrow(
      'GitHub 不接受这个 token',
    )
    expect(library.list()).toHaveLength(1)
  })

  it.skipIf(process.platform === 'win32')('lists the logins of the local gh and takes one as a snapshot', async () => {
    const executable = await fakeGh()
    const { library } = await setup({
      accounts: { 'tok-from-gh': { login: 'octo-fixture', scopes: 'repo' } },
      githubCli: () => executable,
    })
    expect(await library.localGithubLogins()).toEqual([
      { login: 'octo-fixture', active: true },
      { login: 'second-fixture', active: false },
    ])
    const created = await library.create({ kind: 'github', github: { source: 'gh-login', login: 'octo-fixture' } })
    expect(created.metadata).toMatchObject({ login: 'octo-fixture', source: 'gh-login' })
    expect(library.usable(created.id, agent, 'program')).toMatchObject({ value: 'tok-from-gh' })
    await expect(
      library.create({ kind: 'github', github: { source: 'gh-login', login: 'second-fixture' } }),
    ).rejects.toThrow('没有取到 second-fixture 的登录')
  })

  it('moves the older command accounts in once, open to the agents that had a grant', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-account-migration-'))
    directories.push(root)
    const database = await openMigratedCoreDatabase(path.join(root, 'core.sqlite'))
    databases.push(database)
    const repository = new SqliteCoreRepository(database)
    const store = new LocalCredentialStore(path.join(root, 'credentials'))
    const reference = await store.save('tok-migrated-fixture')
    const unusedReference = await store.save('tok-unused-fixture')
    repository.putSystemSetting(
      'command-accounts',
      {
        version: 1,
        accounts: [
          {
            id: 'a1b2c3d4e5f60718',
            service: 'github',
            login: 'octo-fixture',
            source: 'token',
            scopes: ['repo'],
            credentialRef: reference,
            createdAt: 500,
          },
          {
            id: '0f1e2d3c4b5a6978',
            service: 'github',
            login: 'octo-fixture',
            source: 'gh-login',
            credentialRef: unusedReference,
            createdAt: 600,
          },
        ],
      },
      undefined,
      700,
    )
    const make = () =>
      new CredentialLibrary(repository, store, {
        secrets: new SecretRegistry(),
        now: () => 1_000,
        accountGrants: () => new Map([['a1b2c3d4e5f60718', [agent]]]),
      })
    const library = make()
    await library.prepare()
    const migrated = CredentialIdSchema.parse('crd_a1b2c3d4e5f60718')
    expect(library.list().map((record) => [record.id, record.name, record.agentScope])).toEqual([
      [migrated, 'GitHub octo-fixture', { agentIds: [agent] }],
      [CredentialIdSchema.parse('crd_0f1e2d3c4b5a6978'), 'GitHub octo-fixture (2)', { agentIds: [] }],
    ])
    expect(library.get(migrated)).toMatchObject({
      kind: 'github',
      usage: 'program',
      autoUse: true,
      createdAt: 500,
      metadata: { login: 'octo-fixture', source: 'token', scopes: ['repo'] },
    })
    expect(library.usable(migrated, agent, 'program')).toMatchObject({ value: 'tok-migrated-fixture' })
    expect(repository.getSystemSetting('command-accounts')?.value).toEqual({ version: 1, accounts: [] })

    // Running again changes nothing; a removed credential is not brought back.
    await library.remove(CredentialIdSchema.parse('crd_0f1e2d3c4b5a6978'))
    const again = make()
    await again.prepare()
    expect(again.list().map((record) => record.id)).toEqual([migrated])
  })
})
