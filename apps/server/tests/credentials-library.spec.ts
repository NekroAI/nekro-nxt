import { mkdtemp, rm } from 'node:fs/promises'
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

const setup = async () => {
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
    const short = await library.create({ name: 'PIN', value: '1234', usage: 'program' })
    expect(library.redactable(short.id)).toBe(false)
    await expect(library.create({ name: 'pin', value: 'another-value', usage: 'program' })).rejects.toThrow(
      CredentialError,
    )
    expect(() => CredentialIdSchema.parse(short.id)).not.toThrow()
    // A request-only credential goes nowhere without a domain.
    await expect(library.create({ name: '无域名', value: 'nowhere-value' })).rejects.toThrow('至少一个允许的域名')
    await expect(library.update(short.id, { usage: 'request' })).rejects.toThrow('至少一个允许的域名')
  })

  it('clears a use only for agents in scope, and program reads only for program credentials', async () => {
    const { library } = await setup()
    const request = await library.create({
      name: '仅请求',
      value: 'request-only-value',
      domains: ['api.example.test'],
      agentScope: { agentIds: [agent] },
    })
    const program = await library.create({ name: '程序', value: 'program-value', usage: 'program' })
    expect(library.usable(request.id, agent, 'request')).toMatchObject({ value: 'request-only-value' })
    expect(library.usable(request.id, agent, 'program')).toHaveProperty('denied')
    expect(library.usable(request.id, otherAgent, 'request')).toHaveProperty('denied')
    // The host instance serves every agent: only a credential open to all agents.
    expect(library.usable(request.id, undefined, 'request')).toHaveProperty('denied')
    expect(library.usable(program.id, undefined, 'program')).toMatchObject({ value: 'program-value' })
  })

  it('gives commands in-scope program credentials with a variable, used automatically or approved', async () => {
    const { library } = await setup()
    const weather = await library.create({
      name: '天气',
      value: 'weather-program-value',
      usage: 'program',
      envName: 'WEATHER_KEY',
      agentScope: { agentIds: [agent] },
    })
    const guarded = await library.create({
      name: '受控',
      value: 'guarded-program-value',
      usage: 'program',
      envName: 'GUARDED_KEY',
      autoUse: false,
    })
    // A program credential without a variable is for extensions only.
    await library.create({ name: '仅扩展', value: 'extension-only-value', usage: 'program' })
    const received = (agentId: AgentId) =>
      library.commandCredentials(agentId).map(({ record, env }) => [record.name, env])
    expect(received(agent)).toEqual([['天气', 'WEATHER_KEY']])
    expect(received(otherAgent)).toEqual([])

    await library.approve(guarded.id, agent)
    expect(library.get(guarded.id)?.approvedAgentIds).toEqual([agent])
    expect(received(agent)).toContainEqual(['受控', 'GUARDED_KEY'])
    expect(received(otherAgent)).toEqual([])

    // Request-only drops the variable.
    await library.update(weather.id, { usage: 'request', domains: ['api.weather.test'] })
    expect(library.get(weather.id)?.envName).toBeUndefined()
  })

  it('refuses a variable another credential already gives the same agents', async () => {
    const { library } = await setup()
    await library.create({
      name: '天气',
      value: 'weather-program-value',
      usage: 'program',
      envName: 'WEATHER_KEY',
      agentScope: { agentIds: [agent] },
    })
    await expect(
      library.create({
        name: '天气二',
        value: 'second-value',
        usage: 'program',
        envName: 'WEATHER_KEY',
      }),
    ).rejects.toThrow('凭据「天气」已经以 WEATHER_KEY')
    // Disjoint scopes may share a variable.
    const other = await library.create({
      name: '天气二',
      value: 'second-value',
      usage: 'program',
      envName: 'WEATHER_KEY',
      agentScope: { agentIds: [otherAgent] },
    })
    await expect(library.update(other.id, { agentScope: { all: true } })).rejects.toThrow('WEATHER_KEY')
    await expect(
      library.create({ name: '保留', value: 'reserved-value', usage: 'program', envName: 'PATH' }),
    ).rejects.toThrow()

    // GH_TOKEN belongs to linked GitHub accounts.
    await expect(
      library.create({ name: 'GitHub 令牌', value: 'gh-like-value', usage: 'program', envName: 'GH_TOKEN' }),
    ).rejects.toThrow()
  })

  it('removes a credential at once and survives a restart without it', async () => {
    const { library, make } = await setup()
    const created = await library.create({ name: '临时', value: 'temporary-value', usage: 'program' })
    const restarted = make()
    await restarted.prepare()
    expect(restarted.usable(created.id, agent, 'request')).toMatchObject({ value: 'temporary-value' })

    await library.remove(created.id)
    expect(library.usable(created.id, agent, 'request')).toBeUndefined()
    const afterRemoval = make()
    await afterRemoval.prepare()
    expect(afterRemoval.list()).toEqual([])
  })
})
