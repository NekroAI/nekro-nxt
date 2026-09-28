import { describe, expect, it } from 'vitest'
import { HostUpgradeCoordinator, runUpgradePlan, type UpgradeJournal, type UpgradeStep } from '../src/index.js'

const checkpointJournal = () => {
  const checkpoints = new Map<string, NonNullable<UpgradeStep['checkpoint']>>()
  const events: string[] = []
  const journal: UpgradeJournal = {
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
    readCheckpoint: (id) => Promise.resolve(checkpoints.get(id)),
    commitCheckpoint: (id, value) => {
      checkpoints.set(id, value)
      return Promise.resolve()
    },
  }
  return { journal, events, checkpoints }
}

describe('reusable Host upgrade steps', () => {
  it('keeps compatible sessions and applies A → B → C exactly once while reconstructing each runtime', async () => {
    const { journal } = checkpointJournal()
    let generation = 'A'
    let sessions = ['old-session']
    let resets = 0
    let starts = 0
    const step = (input: string, output: string, reset: boolean): UpgradeStep => ({
      id: `storage-${input}-${output}`,
      checkpoint: { inputVersion: input, outputVersion: output },
      verify: () => Promise.resolve(generation === output),
      run: () => {
        expect(generation).toBe(input)
        generation = output
        if (reset) {
          sessions = []
          resets += 1
        }
        return Promise.resolve()
      },
    })
    const runtime: UpgradeStep = {
      id: 'runtime',
      run: () => {
        starts += 1
        return Promise.resolve()
      },
    }
    const ab = [step('A', 'B', false), runtime]
    await runUpgradePlan(ab, journal)
    await runUpgradePlan(ab, journal)
    expect(sessions).toEqual(['old-session'])
    const bc = [step('B', 'C', true), runtime]
    await runUpgradePlan(bc, journal)
    sessions.push('new-session')
    await runUpgradePlan(bc, journal)
    expect(sessions).toEqual(['new-session'])
    expect(resets).toBe(1)
    expect(starts).toBe(4)
  })

  it('does not trust a journal receipt when the owned artifact no longer verifies', async () => {
    const { journal, checkpoints } = checkpointJournal()
    checkpoints.set('config', { inputVersion: '1', outputVersion: '2' })
    let valid = false
    let executions = 0
    await runUpgradePlan(
      [
        {
          id: 'config',
          checkpoint: { inputVersion: '1', outputVersion: '2' },
          verify: () => Promise.resolve(valid),
          run: () => {
            executions += 1
            valid = true
            return Promise.resolve()
          },
        },
      ],
      journal,
    )
    expect(executions).toBe(1)
  })

  it('retries a failed verification without recording completion', async () => {
    const { journal, events, checkpoints } = checkpointJournal()
    let valid = false
    const steps: UpgradeStep[] = [
      {
        id: 'session',
        checkpoint: { inputVersion: '1', outputVersion: '2' },
        run: () => Promise.resolve(),
        verify: () => Promise.resolve(valid),
      },
    ]
    await expect(runUpgradePlan(steps, journal)).rejects.toThrow('did not verify')
    expect(checkpoints.size).toBe(0)
    expect(events).toEqual(['begin:session', 'fail:session'])
    valid = true
    await runUpgradePlan(steps, journal)
    expect(checkpoints.get('session')?.outputVersion).toBe('2')
  })

  it('stops at a cancellation boundary without opening the runtime', async () => {
    const { journal, events } = checkpointJournal()
    const abort = new AbortController()
    await expect(
      runUpgradePlan(
        [
          {
            id: 'backup',
            run: () => {
              abort.abort(new Error('cancelled'))
              return Promise.resolve()
            },
          },
          { id: 'runtime', run: () => Promise.reject(new Error('must not open')) },
        ],
        journal,
        abort.signal,
      ),
    ).rejects.toThrow('cancelled')
    expect(events).toEqual(['begin:backup', 'complete:backup'])
  })

  it('reports an occupied data root without starting backup or migrations', async () => {
    const { journal, events } = checkpointJournal()
    const host = new HostUpgradeCoordinator({
      lock: { acquire: () => Promise.reject(new Error('data root occupied')) },
      preflight: () => Promise.reject(new Error('must not preflight')),
      createBackup: () => Promise.reject(new Error('must not back up')),
      steps: [],
      journal,
    })
    expect(await host.run()).toEqual({ phase: 'recovery', errorSummary: 'data root occupied' })
    expect(events).toEqual([])
  })
})
