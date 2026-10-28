import { describe, expect, it } from 'vitest'
import { dshEntryStatus } from '../src/dsh-extension-settings.js'

type Entry = Parameters<typeof dshEntryStatus>[0]

describe('DSH extension status', () => {
  it('keeps active and pending activation counts in a mixed summary', () => {
    const entry = {
      id: 'plugin:dsp_fixture',
      name: 'Fixture',
      description: '',
      group: 'installed',
      plugin: {
        packageName: '@example/dsh-fixture',
        packageVersion: '1.0.0',
        origin: 'installed',
        settingsNamespaces: [],
        entries: [
          {
            id: 'dse_active',
            entryKey: 'active',
            moduleName: '@example/dsh-fixture/active',
            suggestedScope: 'host',
            config: {},
            activations: [
              {
                targetKey: 'host',
                target: 'host',
                activatedAt: 1,
                diagnostic: { status: 'active', phase: 'apply', observedAt: 1 },
              },
            ],
          },
          {
            id: 'dse_pending',
            entryKey: 'pending',
            moduleName: '@example/dsh-fixture/pending',
            suggestedScope: 'agent',
            config: {},
            activations: [
              {
                targetKey: 'agt_one',
                target: 'agent',
                agentId: 'agt_one',
                activatedAt: 1,
                diagnostic: {
                  status: 'pending',
                  phase: 'dependency',
                  message: '等待 skills 服务',
                  observedAt: 1,
                },
              },
              {
                targetKey: 'agt_two',
                target: 'agent',
                agentId: 'agt_two',
                activatedAt: 1,
                diagnostic: {
                  status: 'pending',
                  phase: 'dependency',
                  message: '等待 tools、skills 服务',
                  observedAt: 1,
                },
              },
            ],
          },
        ],
      },
    } satisfies Entry

    expect(dshEntryStatus(entry)).toEqual({ label: '1 个已启用 / 2 个等待 skills、tools 服务', tone: 'warn' })
  })
})
