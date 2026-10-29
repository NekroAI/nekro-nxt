import { DshPluginCatalogEntrySchema } from '@nekro-nxt/contracts'
import { describe, expect, it } from 'vitest'
import { dshEntryStatus, dshRestrictedReason, type DshSettingsCatalogEntry } from '../src/dsh-extension-settings.js'

const pending = (targetKey: string, waitingFor: string[], restrictedServices: string[] = []) => ({
  targetKey,
  target: 'agent',
  agentId: targetKey,
  activatedAt: 1,
  diagnostic: { status: 'pending', phase: 'dependency', waitingFor, restrictedServices, observedAt: 1 },
})

const active = {
  targetKey: 'host',
  target: 'host',
  activatedAt: 1,
  diagnostic: { status: 'active', phase: 'apply', observedAt: 1 },
}

const catalogEntry = (entries: readonly { readonly id: string; readonly activations: readonly unknown[] }[]) =>
  ({
    id: 'plugin:dsp_fixture',
    label: '@example/dsh-fixture',
    version: '1.0.0',
    group: 'installed',
    namespaces: [],
    plugin: DshPluginCatalogEntrySchema.parse({
      packageName: '@example/dsh-fixture',
      packageVersion: '1.0.0',
      origin: 'installed',
      official: false,
      settingsNamespaces: [],
      entries: entries.map(({ id, activations }) => ({
        id,
        entryKey: id,
        moduleName: `@example/dsh-fixture/${id}`,
        suggestedScope: 'agent',
        config: {},
        activations,
      })),
    }),
  }) satisfies DshSettingsCatalogEntry

describe('DSH extension status', () => {
  it('keeps active and pending activation counts in a mixed summary', () => {
    const entry = catalogEntry([
      { id: 'dse_active', activations: [active] },
      {
        id: 'dse_pending',
        activations: [pending('agt_one', ['skills']), pending('agt_two', ['tools', 'skills'])],
      },
    ])
    expect(dshEntryStatus(entry)).toEqual({ label: '1 个已启用 / 2 个等待 skills、tools 服务', tone: 'warn' })
  })

  it('names services that only official plugins receive', () => {
    expect(
      dshEntryStatus(catalogEntry([{ id: 'dse_one', activations: [pending('agt_one', ['agents'], ['agents'])] }])),
    ).toEqual({ label: '缺少服务', tone: 'warn' })
    expect(
      dshEntryStatus(
        catalogEntry([
          {
            id: 'dse_one',
            activations: [pending('agt_one', ['agents'], ['agents']), pending('agt_two', ['fixtureShared'])],
          },
        ]),
      ),
    ).toEqual({ label: '1 个缺少服务 / 1 个等待 fixtureShared 服务', tone: 'warn' })
    expect(dshRestrictedReason(['agents', 'sessions'])).toBe('需要 agents、sessions 服务，只对官方插件开放。')
  })
})
