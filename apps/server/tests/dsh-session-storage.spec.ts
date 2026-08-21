import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  completeDshSessionStoragePreparation,
  DSH_SESSION_APPLICATION_ID,
  DSH_SESSION_SCHEMA_CURRENT,
  DSH_SESSION_SCHEMA_PREVIOUS,
  prepareDshSessionStorage,
} from '@nekro-nxt/storage-sqlite'

const temporaryDirectories: string[] = []
const archiveDate = new Date('2026-08-21T08:00:00.000Z')

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const createDatabase = (
  target: string,
  input: { readonly schema: number; readonly applicationId: number; readonly withUserTable?: boolean },
): DatabaseSync => {
  const database = new DatabaseSync(target)
  database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
  if (input.withUserTable !== false) {
    database.exec('CREATE TABLE synthetic_events (id INTEGER PRIMARY KEY, value TEXT NOT NULL);')
    database.prepare('INSERT INTO synthetic_events (value) VALUES (?)').run('synthetic-session-event')
  }
  database.exec(`PRAGMA application_id = ${input.applicationId}; PRAGMA user_version = ${input.schema};`)
  return database
}

describe('DSH Session storage preparation', () => {
  it('leaves an absent database for the rc.1 provider to initialize', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-dsh-session-new-'))
    temporaryDirectories.push(directory)
    const databasePath = path.join(directory, 'sessions.sqlite')

    await expect(prepareDshSessionStorage({ databasePath })).resolves.toEqual({ kind: 'new' })
  })

  it('accepts the owned schema 17 database without creating an archive', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-dsh-session-current-'))
    temporaryDirectories.push(directory)
    const databasePath = path.join(directory, 'sessions.sqlite')
    createDatabase(databasePath, {
      schema: DSH_SESSION_SCHEMA_CURRENT,
      applicationId: DSH_SESSION_APPLICATION_ID,
    }).close()

    await expect(prepareDshSessionStorage({ databasePath })).resolves.toEqual({
      kind: 'compatible',
      schemaVersion: DSH_SESSION_SCHEMA_CURRENT,
    })
  })

  it('publishes one verified schema 15 archive before retiring the source and is restart-idempotent', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-dsh-session-archive-'))
    temporaryDirectories.push(directory)
    const databasePath = path.join(directory, 'sessions.sqlite')
    const source = createDatabase(databasePath, {
      schema: DSH_SESSION_SCHEMA_PREVIOUS,
      applicationId: DSH_SESSION_APPLICATION_ID,
    })
    const result = await prepareDshSessionStorage({ databasePath, now: () => archiveDate })
    source.close()

    expect(result.kind).toBe('archived')
    if (result.kind !== 'archived') throw new Error('Expected an archived DSH Session database.')
    await expect(stat(databasePath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(result.archivePath).toBe(path.join(directory, 'dsh', 'session-archives', '20260821T080000000Z-schema15'))
    const manifestFile: unknown = JSON.parse(await readFile(path.join(result.archivePath, 'manifest.json'), 'utf8'))
    expect(manifestFile).toMatchObject({
      originalPath: databasePath,
      originalSchema: 15,
      targetSchema: 17,
      originalDshVersion: '0.1.0-rc.6',
      targetDshVersion: '0.1.1-rc.1',
    })
    expect(result.manifest.databaseSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(result.manifest.sourceSha256).toMatch(/^[a-f0-9]{64}$/u)

    const snapshot = new DatabaseSync(path.join(result.archivePath, 'sessions.sqlite'), { readOnly: true })
    expect(snapshot.prepare('SELECT value FROM synthetic_events').get()).toEqual({ value: 'synthetic-session-event' })
    snapshot.close()
    await expect(stat(path.join(result.archivePath, 'original-sessions.sqlite'))).resolves.toBeDefined()

    const retry = await prepareDshSessionStorage({ databasePath, now: () => archiveDate })
    expect(retry).toMatchObject({ kind: 'archived', archivePath: result.archivePath })
    await completeDshSessionStoragePreparation(databasePath)
    await expect(prepareDshSessionStorage({ databasePath, now: () => archiveDate })).resolves.toEqual({ kind: 'new' })
  })

  it.each([
    { label: 'unknown schema', schema: 16, applicationId: DSH_SESSION_APPLICATION_ID },
    { label: 'foreign application id', schema: 15, applicationId: 42 },
    { label: 'non-empty unversioned database', schema: 0, applicationId: 0 },
  ])('rejects $label without moving the source database', async ({ schema, applicationId }) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-dsh-session-reject-'))
    temporaryDirectories.push(directory)
    const databasePath = path.join(directory, 'sessions.sqlite')
    createDatabase(databasePath, { schema, applicationId }).close()
    const before = await stat(databasePath)

    await expect(prepareDshSessionStorage({ databasePath, now: () => archiveDate })).rejects.toThrow(
      /DSH Session database/u,
    )
    await expect(stat(databasePath)).resolves.toMatchObject({ size: before.size })
  })
})
