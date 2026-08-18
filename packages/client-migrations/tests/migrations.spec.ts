import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  HostUpgradeCoordinator,
  MigrationError,
  MigrationRegistry,
  runUpgradePlan,
  type PersistedEnvelope,
} from '../src/index.ts'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const parsePersistedEnvelope = (value: unknown): PersistedEnvelope => {
  if (
    !isRecord(value) ||
    typeof value['format'] !== 'string' ||
    typeof value['version'] !== 'number' ||
    !Number.isSafeInteger(value['version']) ||
    value['version'] < 0 ||
    !('data' in value)
  ) {
    throw new Error('invalid persisted envelope')
  }
  return { format: value['format'], version: value['version'], data: value['data'] }
}

const parseV1Data = (data: unknown): { readonly name: string } => {
  if (!isRecord(data) || typeof data['name'] !== 'string') throw new Error('invalid v1 data')
  return { name: data['name'] }
}

const parseItems = (data: unknown): { readonly items: string[] } => {
  if (!isRecord(data) || !Array.isArray(data['items']) || !data['items'].every((item) => typeof item === 'string')) {
    throw new Error('invalid items data')
  }
  return { items: data['items'] }
}

const readFixture = async (name: string): Promise<PersistedEnvelope> =>
  parsePersistedEnvelope(JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')))

const parseV2 = (data: unknown): { readonly name: string; readonly enabled: boolean } => {
  if (typeof data !== 'object' || data === null || !('name' in data) || !('enabled' in data)) {
    throw new Error('invalid v2 data')
  }
  const { name, enabled } = data
  if (typeof name !== 'string' || typeof enabled !== 'boolean') throw new Error('invalid v2 fields')
  return { name, enabled }
}

const registry = () =>
  new MigrationRegistry({
    format: 'nxt.client.preferences',
    currentVersion: 2,
    steps: [
      { from: 0, migrate: (data) => ({ name: String(data) }) },
      { from: 1, migrate: (data) => ({ ...parseV1Data(data), enabled: true }) },
    ],
    parseCurrent: parseV2,
  })

describe('MigrationRegistry', () => {
  it('migrates every tracked historical fixture through the continuous chain', async () => {
    expect(registry().migrate(await readFixture('preferences-v0.json'))).toEqual({
      format: 'nxt.client.preferences',
      version: 2,
      data: { name: '小奈', enabled: true },
    })
    expect(registry().migrate(await readFixture('preferences-v1.json')).data).toEqual({
      name: '小奈',
      enabled: true,
    })
  })

  it('validates current data without running a migration', () => {
    const current = new MigrationRegistry({
      format: 'current',
      currentVersion: 0,
      steps: [],
      parseCurrent: (data) => String(data),
    })
    expect(current.migrate({ format: 'current', version: 0, data: 'ok' })).toEqual({
      format: 'current',
      version: 0,
      data: 'ok',
    })
  })

  it('rejects unknown formats, future versions and invalid versions', () => {
    expect(() => registry().migrate({ format: 'other', version: 0, data: null })).toThrowError(
      expect.objectContaining({ code: 'unknown-format' }),
    )
    expect(() => registry().migrate({ format: 'nxt.client.preferences', version: 3, data: null })).toThrowError(
      expect.objectContaining({ code: 'future-version' }),
    )
    expect(() => registry().migrate({ format: 'nxt.client.preferences', version: -1, data: null })).toThrowError(
      expect.objectContaining({ code: 'invalid-envelope' }),
    )
  })

  it('rejects missing and duplicate steps when the registry is created', () => {
    expect(
      () => new MigrationRegistry({ format: 'x', currentVersion: 1, steps: [], parseCurrent: (data) => data }),
    ).toThrowError(expect.objectContaining({ code: 'invalid-registry' }))
    expect(
      () =>
        new MigrationRegistry({
          format: 'x',
          currentVersion: 1,
          steps: [
            { from: 0, migrate: (data) => data },
            { from: 0, migrate: (data) => data },
          ],
          parseCurrent: (data) => data,
        }),
    ).toThrowError(expect.objectContaining({ code: 'invalid-registry' }))
  })

  it('preserves the caller input when a migration mutates and then fails', () => {
    const original = { items: ['a'] }
    const failing = new MigrationRegistry({
      format: 'failing',
      currentVersion: 1,
      steps: [
        {
          from: 0,
          migrate: (data) => {
            const mutable = parseItems(data)
            mutable.items.push('b')
            throw new Error('boom')
          },
        },
      ],
      parseCurrent: (data) => data,
    })
    expect(() => failing.migrate({ format: 'failing', version: 0, data: original })).toThrowError(MigrationError)
    expect(original).toEqual({ items: ['a'] })
  })
})

describe('runUpgradePlan', () => {
  it('journals ordered completion at each commit point', async () => {
    const events: string[] = []
    await runUpgradePlan(
      [
        {
          id: 'core-1',
          run: () => {
            events.push('run:core-1')
            return Promise.resolve()
          },
        },
        {
          id: 'dsh-1',
          run: () => {
            events.push('run:dsh-1')
            return Promise.resolve()
          },
        },
      ],
      {
        begin: (id) => {
          events.push(`begin:${id}`)
          return Promise.resolve()
        },
        complete: (id) => {
          events.push(`complete:${id}`)
          return Promise.resolve()
        },
        fail: (id) => {
          events.push(`fail:${id}`)
          return Promise.resolve()
        },
      },
    )
    expect(events).toEqual([
      'begin:core-1',
      'run:core-1',
      'complete:core-1',
      'begin:dsh-1',
      'run:dsh-1',
      'complete:dsh-1',
    ])
  })

  it('records failure and does not start later steps', async () => {
    const events: string[] = []
    await expect(
      runUpgradePlan(
        [
          { id: 'broken', run: () => Promise.reject(new Error('boom')) },
          {
            id: 'later',
            run: () => {
              events.push('run:later')
              return Promise.resolve()
            },
          },
        ],
        {
          begin: (id) => {
            events.push(`begin:${id}`)
            return Promise.resolve()
          },
          complete: (id) => {
            events.push(`complete:${id}`)
            return Promise.resolve()
          },
          fail: (id) => {
            events.push(`fail:${id}`)
            return Promise.resolve()
          },
        },
      ),
    ).rejects.toThrow('boom')
    expect(events).toEqual(['begin:broken', 'fail:broken'])
  })

  it('locks, preflights, backs up and enters recovery without publishing ready after failure', async () => {
    const lifecycle: string[] = []
    const coordinator = new HostUpgradeCoordinator({
      lock: {
        acquire: () => {
          lifecycle.push('lock')
          return Promise.resolve(() => {
            lifecycle.push('unlock')
            return Promise.resolve()
          })
        },
      },
      preflight: () => {
        lifecycle.push('preflight')
        return Promise.resolve()
      },
      createBackup: () => {
        lifecycle.push('backup')
        return Promise.resolve({ id: 'backup-1' })
      },
      steps: [
        { id: 'core', run: () => Promise.resolve() },
        { id: 'extensions', run: () => Promise.reject(new Error('extension migration failed')) },
      ],
      journal: {
        begin: (id) => {
          lifecycle.push(`begin:${id}`)
          return Promise.resolve()
        },
        complete: (id) => {
          lifecycle.push(`complete:${id}`)
          return Promise.resolve()
        },
        fail: (id) => {
          lifecycle.push(`fail:${id}`)
          return Promise.resolve()
        },
      },
    })
    const phases: string[] = []
    coordinator.subscribe(() => phases.push(coordinator.getSnapshot().phase))
    await expect(coordinator.run()).resolves.toEqual({
      phase: 'recovery',
      backupId: 'backup-1',
      errorSummary: 'extension migration failed',
    })
    expect(phases).toEqual(['preflight', 'backup', 'migrating', 'migrating', 'migrating', 'recovery'])
    expect(lifecycle).toEqual([
      'lock',
      'preflight',
      'backup',
      'begin:core',
      'complete:core',
      'begin:extensions',
      'fail:extensions',
      'unlock',
    ])
  })
})
