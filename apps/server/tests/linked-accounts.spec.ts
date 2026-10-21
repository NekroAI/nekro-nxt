import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AgentIdSchema, CredentialIdSchema, LinkedAccountIdSchema } from '@nekro-nxt/contracts'
import type { CommandAccountGrant } from '@nekro-nxt/core'
import {
  credentials,
  credentialUses,
  openMigratedCoreDatabase,
  SqliteCoreRepository,
  type CoreDatabase,
} from '@nekro-nxt/storage-sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { commandCredentialEnvironment, commandCredentialPrompt } from '../src/command-account-env.ts'
import { LocalCredentialStore } from '../src/credentials.ts'
import { createGithubPlatform } from '../src/linked-accounts/github.ts'
import { commandAccountsOf, LinkedAccountLibrary, linkedAccountIdOfGrant } from '../src/linked-accounts/library.ts'
import { LinkedAccountError, LinkedAccountPlatforms } from '../src/linked-accounts/platform.ts'
import { SecretRegistry } from '../src/secret-registry.ts'

const directories: string[] = []
const databases: CoreDatabase[] = []
afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const agent = AgentIdSchema.parse('agt_FIXTURE')
const otherAgent = AgentIdSchema.parse('agt_OTHER')

/** GitHub as the platform sees it: token → login (and scopes for classic tokens), anything else is rejected. */
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
    readonly gh?: string
    readonly before?: (input: {
      readonly database: CoreDatabase
      readonly repository: SqliteCoreRepository
      readonly store: LocalCredentialStore
    }) => Promise<void>
  } = {},
) => {
  const root = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-linked-accounts-'))
  directories.push(root)
  const database = await openMigratedCoreDatabase(path.join(root, 'core.sqlite'))
  databases.push(database)
  const repository = new SqliteCoreRepository(database)
  const store = new LocalCredentialStore(path.join(root, 'credentials'))
  await options.before?.({ database, repository, store })
  let sequence = 0
  let now = 1_000
  const platforms = new LinkedAccountPlatforms([
    createGithubPlatform({
      fetch: github(options.accounts ?? {}),
      cli: {
        executable: () => options.gh,
        directoryForPath: () => undefined,
        status: () => ({ available: options.gh !== undefined }),
      },
    }),
  ])
  const make = (secrets = new SecretRegistry()) =>
    new LinkedAccountLibrary(repository, store, {
      secrets,
      platforms,
      now: () => now,
      nextId: () => `FIXTURE${(sequence += 1)}`,
    })
  const secrets = new SecretRegistry()
  const library = make(secrets)
  await library.prepare()
  const advance = (ms: number) => {
    now += ms
  }
  return { library, repository, store, make, secrets, database, advance }
}

const grantOf = (accountId: string, usage: CommandAccountGrant['usage'] = []): CommandAccountGrant => ({
  service: 'github',
  accountId,
  usage,
})

describe('linked account platforms', () => {
  it('keeps one platform per id and names the unsupported ones', () => {
    const cli = { executable: () => undefined, directoryForPath: () => undefined, status: () => ({ available: false }) }
    expect(() => new LinkedAccountPlatforms([createGithubPlatform({ cli }), createGithubPlatform({ cli })])).toThrow()
    const platforms = new LinkedAccountPlatforms([createGithubPlatform({ cli })])
    expect(platforms.list().map((platform) => [platform.id, platform.name, platform.addMethods])).toEqual([
      ['github', 'GitHub', ['token', 'gh-login']],
    ])
    expect(() => platforms.require('gitlab')).toThrow(LinkedAccountError)
  })

  it('resolves grants saved before the acc_ prefix to the same account', () => {
    expect(linkedAccountIdOfGrant('a1b2c3d4')).toBe('acc_a1b2c3d4')
    expect(linkedAccountIdOfGrant('acc_a1b2c3d4')).toBe('acc_a1b2c3d4')
    expect(linkedAccountIdOfGrant('not valid')).toBeUndefined()
  })
})

describe('linked account library', () => {
  it('links a GitHub account under the login GitHub reports and hides its token as GitHub <login>', async () => {
    const { library, secrets, repository } = await setup({
      accounts: { 'tok-classic-fixture': { login: 'octo-fixture', scopes: 'repo, read:org' } },
    })
    const added = await library.add({ platform: 'github', method: 'token', token: ' tok-classic-fixture ' })
    expect(added).toMatchObject({
      id: 'acc_FIXTURE1',
      platform: 'github',
      login: 'octo-fixture',
      scopes: ['repo', 'read:org'],
      source: 'token',
    })
    expect(JSON.stringify(library.list())).not.toContain('tok-classic-fixture')
    expect(JSON.stringify(repository.linkedAccounts.listAccounts())).not.toContain('tok-classic-fixture')
    expect(secrets.redact('token=tok-classic-fixture')).toBe('token=[凭据:GitHub octo-fixture]')

    // The same account is linked once; tokens GitHub does not accept are not linked at all.
    await expect(library.add({ platform: 'github', method: 'token', token: 'tok-classic-fixture' })).rejects.toThrow(
      '已经关联了 GitHub 账号 octo-fixture',
    )
    await expect(library.add({ platform: 'github', method: 'token', token: 'nope' })).rejects.toThrow(
      'GitHub 不接受这个 token',
    )
    expect(library.list()).toHaveLength(1)
  })

  it('replaces a token only with one of the same account', async () => {
    const { library, make, secrets } = await setup({
      accounts: {
        old: { login: 'octo-fixture', scopes: 'repo' },
        'fresh-fixture-token': { login: 'Octo-Fixture' },
        other: { login: 'someone-else' },
      },
    })
    const added = await library.add({ platform: 'github', method: 'token', token: 'old' })
    const replaced = await library.replaceToken(added.id, { method: 'token', token: 'fresh-fixture-token' })
    expect(replaced).toMatchObject({ id: added.id, login: 'Octo-Fixture' })
    // A fine-grained token reports no scopes; the old ones do not linger.
    expect(replaced.scopes).toBeUndefined()
    expect(secrets.redact('fresh-fixture-token')).toBe('[凭据:GitHub Octo-Fixture]')
    await expect(library.replaceToken(added.id, { method: 'token', token: 'other' })).rejects.toThrow(
      '新的 token 属于 someone-else',
    )
    const restarted = make()
    await restarted.prepare()
    expect(
      commandCredentialEnvironment(agent, [grantOf(added.id)], {
        credentials: () => [],
        accounts: commandAccountsOf(restarted),
      })['GH_TOKEN'],
    ).toBe('fresh-fixture-token')
  })

  it.skipIf(process.platform === 'win32')('lists the logins of the local gh and takes one as a snapshot', async () => {
    const gh = await fakeGh()
    const { library } = await setup({ accounts: { 'tok-from-gh': { login: 'octo-fixture', scopes: 'repo' } }, gh })
    expect(await library.localGithubLogins()).toEqual([
      { login: 'octo-fixture', active: true },
      { login: 'second-fixture', active: false },
    ])
    const added = await library.add({ platform: 'github', method: 'gh-login', login: 'octo-fixture' })
    expect(added).toMatchObject({ login: 'octo-fixture', source: 'gh-login' })
    await expect(library.add({ platform: 'github', method: 'gh-login', login: 'second-fixture' })).rejects.toThrow(
      '没有取到 second-fixture 的登录',
    )
  })

  it('gives the account only to agents whose grant names it, and stops at the next command once removed', async () => {
    const { library, advance } = await setup({ accounts: { 'tok-granted-fixture': { login: 'octo-fixture' } } })
    const added = await library.add({ platform: 'github', method: 'token', token: 'tok-granted-fixture' })
    const sources = {
      credentials: () => [],
      accounts: commandAccountsOf(library),
      accountUsed: (accountId: typeof added.id, agentId: typeof agent) =>
        library.recordUse({ accountId, agentId, consumerId: 'shell' }),
    }
    const granted = [grantOf(added.id, ['issues'])]
    expect(commandCredentialEnvironment(agent, granted, sources)['GH_TOKEN']).toBe('tok-granted-fixture')
    expect(commandCredentialEnvironment(otherAgent, [], sources)).toEqual({})
    expect(commandCredentialPrompt(agent, granted, sources)).toContain('octo-fixture')
    expect(commandCredentialPrompt(agent, granted, sources)).toContain('创建和评论 issue')
    expect(commandCredentialPrompt(agent, granted, sources)).not.toContain('tok-granted-fixture')
    // A grant for an account that is not there gives nothing.
    expect(commandCredentialEnvironment(agent, [grantOf('acc_missing')], sources)).toEqual({})

    // Every command reads the account; a use is recorded at most every ten minutes per agent.
    commandCredentialEnvironment(agent, granted, sources)
    expect(library.uses(added.id)).toHaveLength(1)
    advance(10 * 60 * 1000)
    commandCredentialEnvironment(agent, granted, sources)
    expect(library.uses(added.id).map((use) => [use.agentId, use.consumerKind])).toEqual([
      [agent, 'command'],
      [agent, 'command'],
    ])
    expect(library.get(added.id)?.lastUsedAt).toBe(1_000 + 10 * 60 * 1000)
    expect(
      library.grantedAgentIds(added.id, [
        { agentId: agent, grants: granted },
        { agentId: otherAgent, grants: [] },
      ]),
    ).toEqual([agent])

    await library.remove(added.id)
    expect(commandCredentialEnvironment(agent, granted, sources)).toEqual({})
    expect(library.uses(added.id)).toEqual([])
  })

  it('moves the first command account library in once, under acc_<id>, and grants keep resolving', async () => {
    const { library, repository, make } = await setup({
      before: async ({ repository, store }) => {
        const reference = await store.save('tok-migrated-fixture')
        const second = await store.save('tok-second-fixture')
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
                login: 'second-fixture',
                source: 'gh-login',
                credentialRef: second,
                createdAt: 600,
              },
            ],
          },
          undefined,
          700,
        )
      },
    })
    expect(library.list().map((record) => [record.id, record.login, record.source, record.createdAt])).toEqual([
      ['acc_a1b2c3d4e5f60718', 'octo-fixture', 'token', 500],
      ['acc_0f1e2d3c4b5a6978', 'second-fixture', 'gh-login', 600],
    ])
    expect(repository.getSystemSetting('command-accounts')?.value).toEqual({ version: 1, accounts: [] })
    const env = commandCredentialEnvironment(agent, [grantOf('a1b2c3d4e5f60718')], {
      credentials: () => [],
      accounts: commandAccountsOf(library),
    })
    expect(env['GH_TOKEN']).toBe('tok-migrated-fixture')

    // Running again changes nothing; a removed account is not brought back.
    await library.remove(LinkedAccountIdSchema.parse('acc_0f1e2d3c4b5a6978'))
    const again = make()
    await again.prepare()
    expect(again.list().map((record) => record.id)).toEqual(['acc_a1b2c3d4e5f60718'])
  })

  it('turns GitHub credentials of the credential library into accounts, keeping the token file and uses', async () => {
    let reference = ''
    const legacyCredentialId = CredentialIdSchema.parse('crd_9a8b7c6d')
    const { library, repository, store, database, make, secrets } = await setup({
      before: async ({ database, store }) => {
        reference = await store.save('tok-credential-fixture')
        database.db
          .insert(credentials)
          .values({
            id: legacyCredentialId,
            name: 'GitHub octo-fixture',
            description: '',
            kind: 'github',
            usage: 'program',
            domains: ['github.com', 'api.github.com'],
            // The scope older builds kept equal to the agents holding a grant; `otherAgent` never had one.
            agentScope: { agentIds: [agent, otherAgent] },
            autoUse: true,
            envName: null,
            approvedAgentIds: [],
            credentialRef: reference,
            metadata: { login: 'octo-fixture', source: 'token', scopes: ['repo'] },
            createdAt: 400,
            updatedAt: 450,
            lastUsedAt: 480,
          })
          .run()
        database.db
          .insert(credentialUses)
          .values([
            {
              credentialId: legacyCredentialId,
              at: 480,
              agentId: agent,
              consumerKind: 'command',
              consumerId: 'shell',
            },
          ])
          .run()
      },
    })
    const id = LinkedAccountIdSchema.parse('acc_9a8b7c6d')
    expect(library.list()).toEqual([
      {
        id,
        platform: 'github',
        login: 'octo-fixture',
        scopes: ['repo'],
        source: 'token',
        credentialRef: reference,
        createdAt: 400,
        updatedAt: 450,
        lastUsedAt: 480,
      },
    ])
    expect(library.uses(id).map((use) => [use.at, use.agentId, use.consumerKind])).toEqual([[480, agent, 'command']])
    // The credential row is gone; the token file stays, now the account's.
    expect(database.db.select().from(credentials).all()).toEqual([])
    expect(repository.credentials.listCredentials()).toEqual([])
    await expect(store.resolve(reference)).resolves.toBe('tok-credential-fixture')
    expect(secrets.redact('tok-credential-fixture')).toBe('[凭据:GitHub octo-fixture]')

    // The grant that named the older account id keeps working; being in the old scope without a grant gives nothing.
    const sources = { credentials: () => [], accounts: commandAccountsOf(library) }
    expect(commandCredentialEnvironment(agent, [grantOf('9a8b7c6d')], sources)['GH_TOKEN']).toBe(
      'tok-credential-fixture',
    )
    expect(commandCredentialEnvironment(otherAgent, [], sources)).toEqual({})

    const again = make()
    await again.prepare()
    expect(again.list().map((record) => record.id)).toEqual([id])
  })
})
