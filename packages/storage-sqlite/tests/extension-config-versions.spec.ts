import { eq } from 'drizzle-orm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentIdSchema, ExtensionIdSchema } from '@nekro-nxt/contracts'
import { localExtensions, openMigratedCoreDatabase, SqliteCoreRepository } from '../src/index.ts'
import { agentDefinitions } from '../src/schema.ts'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const extensionId = ExtensionIdSchema.parse('ext_CONFIGHISTORYFIXTURE00000')
const agentId = AgentIdSchema.parse('agt_CONFIGHISTORYFIXTURE')
const otherAgentId = AgentIdSchema.parse('agt_CONFIGHISTORYOTHER')

const open = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-config-history-'))
  directories.push(directory)
  const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
  database.db
    .insert(localExtensions)
    .values({
      id: extensionId,
      provides: ['agent'],
      slug: 'config-history',
      displayName: '配置历史',
      description: '',
      createdAt: 1,
    })
    .run()
  for (const id of [agentId, otherAgentId]) database.db.insert(agentDefinitions).values({ id, createdAt: 1 }).run()
  return { database, repository: new SqliteCoreRepository(database).extensionConfigVersions }
}

describe('extension configuration versions', () => {
  it('numbers versions per extension, layer and agent and lists them newest first', async () => {
    const { repository } = await open()
    const record = (layer: 'host' | 'agent', owner?: typeof agentId) =>
      repository.recordExtensionConfigVersion({
        extensionId,
        layer,
        ...(owner === undefined ? {} : { agentId: owner }),
        config: { city: '示例市' },
        source: 'console',
        createdAt: 5,
      })
    expect(record('host').version).toBe(1)
    expect(record('agent', agentId).version).toBe(1)
    expect(record('agent', agentId).version).toBe(2)
    expect(record('agent', otherAgentId).version).toBe(1)
    expect(record('host').version).toBe(2)
    expect(
      repository.listExtensionConfigVersions(extensionId, { owner: { layer: 'agent', agentId } }).map((v) => v.version),
    ).toEqual([2, 1])
    expect(repository.listExtensionConfigVersions(extensionId)).toHaveLength(5)
    expect(repository.latestExtensionConfigVersion({ extensionId, layer: 'host' })).toMatchObject({
      version: 2,
      agentId: null,
      source: 'console',
    })
    expect(() =>
      repository.recordExtensionConfigVersion({
        extensionId,
        layer: 'agent',
        config: {},
        source: 'agent',
        createdAt: 1,
      }),
    ).toThrow('Agent config needs an agent.')
  })

  it('goes away with the agent and with the extension', async () => {
    const { database, repository } = await open()
    repository.recordExtensionConfigVersion({
      extensionId,
      layer: 'agent',
      agentId,
      config: {},
      source: 'agent',
      actorAgentId: agentId,
      requesterMemberId: 'mbr_FIXTURE',
      reason: '虚构原因',
      createdAt: 1,
    })
    repository.recordExtensionConfigVersion({ extensionId, layer: 'host', config: {}, source: 'console', createdAt: 1 })
    database.db.delete(agentDefinitions).where(eq(agentDefinitions.id, agentId)).run()
    expect(repository.listExtensionConfigVersions(extensionId).map((version) => version.layer)).toEqual(['host'])
    database.db.delete(localExtensions).where(eq(localExtensions.id, extensionId)).run()
    expect(repository.listExtensionConfigVersions(extensionId)).toEqual([])
  })
})
