import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AgentIdSchema } from '@nekro-nxt/contracts'
import type { SystemSettingRecord } from '@nekro-nxt/storage-sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { CommandAccountError, CommandAccountService } from '../src/command-accounts.ts'
import { LocalCredentialStore } from '../src/credentials.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

class MemorySettings {
  readonly records = new Map<string, SystemSettingRecord>()
  getSystemSetting(key: string) {
    return this.records.get(key)
  }
  putSystemSetting(
    key: string,
    value: SystemSettingRecord['value'],
    expectedRevision: number | undefined,
    updatedAt: number,
  ) {
    const current = this.records.get(key)
    if (current?.revision !== expectedRevision) throw new Error('revision conflict')
    const record = { key, value, revision: (current?.revision ?? 0) + 1, updatedAt } as SystemSettingRecord
    this.records.set(key, record)
    return record
  }
}

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
  accounts: Record<string, { login: string; scopes?: string }>,
  githubCli?: () => string | undefined,
) => {
  const root = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-accounts-'))
  directories.push(root)
  const settings = new MemorySettings()
  const credentials = new LocalCredentialStore(path.join(root, 'credentials'))
  const make = () =>
    new CommandAccountService(settings, credentials, {
      fetch: github(accounts),
      now: () => 1_000,
      ...(githubCli === undefined ? {} : { githubCli }),
    })
  const service = make()
  await service.prepare()
  return { service, settings, credentials, make }
}

describe('command accounts', () => {
  it('keeps a token account under the login GitHub reports, with the scopes of a classic token', async () => {
    const { service } = await setup({ 'tok-classic': { login: 'octo-fixture', scopes: 'repo, read:org' } })
    await service.add({ source: 'token', service: 'github', token: ' tok-classic ' })
    const [account] = service.list()
    expect(account).toMatchObject({ login: 'octo-fixture', source: 'token', scopes: ['repo', 'read:org'], usedBy: [] })
    expect(service.tokenFor(account!.id)).toBe('tok-classic')
    expect(service.loginOf(account!.id)).toBe('octo-fixture')
  })

  it('leaves scopes out for a token GitHub does not report them for', async () => {
    const { service } = await setup({ 'tok-fine': { login: 'octo-fixture' } })
    await service.add({ source: 'token', service: 'github', token: 'tok-fine' })
    expect(service.list()[0]).not.toHaveProperty('scopes')
  })

  it('rejects a token GitHub does not accept and stores nothing', async () => {
    const { service, settings } = await setup({})
    await expect(service.add({ source: 'token', service: 'github', token: 'nope' })).rejects.toThrow(
      CommandAccountError,
    )
    expect(service.list()).toEqual([])
    expect(settings.records.size).toBe(0)
  })

  it('reports which agents use an account', async () => {
    const { service } = await setup({ t: { login: 'octo-fixture' } })
    await service.add({ source: 'token', service: 'github', token: 't' })
    const id = service.list()[0]!.id
    expect(service.list(new Map([[id, [AgentIdSchema.parse('agt_fixture')]]]))[0]!.usedBy).toEqual(['agt_fixture'])
  })

  it('stops handing out the token the moment the account is removed, and survives a restart without it', async () => {
    const { service, make } = await setup({ t: { login: 'octo-fixture' } })
    await service.add({ source: 'token', service: 'github', token: 't' })
    const id = service.list()[0]!.id

    const restarted = make()
    await restarted.prepare()
    expect(restarted.tokenFor(id)).toBe('t')

    await service.remove(id)
    expect(service.tokenFor(id)).toBeUndefined()
    expect(service.has(id)).toBe(false)
    const afterRemoval = make()
    await afterRemoval.prepare()
    expect(afterRemoval.list()).toEqual([])
  })

  it('replaces the token only with one from the same GitHub account', async () => {
    const { service } = await setup({
      old: { login: 'octo-fixture' },
      fresh: { login: 'octo-fixture' },
      other: { login: 'someone-else' },
    })
    await service.add({ source: 'token', service: 'github', token: 'old' })
    const id = service.list()[0]!.id
    await service.replaceToken(id, { source: 'token', service: 'github', token: 'fresh' })
    expect(service.tokenFor(id)).toBe('fresh')
    await expect(service.replaceToken(id, { source: 'token', service: 'github', token: 'other' })).rejects.toThrow(
      '请添加为新账号',
    )
    expect(service.tokenFor(id)).toBe('fresh')
  })

  it.skipIf(process.platform === 'win32')('lists the logins of the local gh and takes one as a snapshot', async () => {
    const executable = await fakeGh()
    const { service } = await setup({ 'tok-from-gh': { login: 'octo-fixture', scopes: 'repo' } }, () => executable)
    expect(await service.localLogins()).toEqual([
      { login: 'octo-fixture', active: true },
      { login: 'second-fixture', active: false },
    ])
    await service.add({ source: 'gh-login', service: 'github', login: 'octo-fixture' })
    const account = service.list()[0]!
    expect(account).toMatchObject({ login: 'octo-fixture', source: 'gh-login', scopes: ['repo'] })
    expect(service.tokenFor(account.id)).toBe('tok-from-gh')
    await expect(service.add({ source: 'gh-login', service: 'github', login: 'second-fixture' })).rejects.toThrow(
      '没有取到 second-fixture 的登录',
    )
  })

  it('offers no local logins and cannot import one without a GitHub CLI', async () => {
    const { service } = await setup({})
    expect(await service.localLogins()).toEqual([])
    await expect(service.add({ source: 'gh-login', service: 'github', login: 'octo-fixture' })).rejects.toThrow(
      '没有 GitHub CLI',
    )
  })
})
