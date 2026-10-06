import { describe, expect, it } from 'vitest'
import {
  contributionParts,
  lifecyclePosition,
  proposeSlug,
  SLUG_PATTERN,
  sortTasks,
  type AuthoringAttempt,
  type AuthoringTask,
} from '../src/app/workshop/workshop-model.js'

const half = { status: 'absent', waitingFor: [] } as const

const attempt = (patch: Partial<AuthoringAttempt> = {}): AuthoringAttempt =>
  ({
    id: 'att_1',
    ordinal: 1,
    name: '天气卡片',
    purpose: '示例用途',
    state: 'drafting',
    riskDigest: 'a'.repeat(64),
    host: half,
    client: half,
    createdAt: 1,
    ...patch,
  }) as AuthoringAttempt

const task = (patch: Partial<AuthoringTask> = {}): AuthoringTask =>
  ({
    id: 'task_1',
    agentId: 'agt_1',
    channelId: 'ch_1',
    episodeId: 'ep_1',
    title: '天气卡片',
    requirementSummary: '',
    status: 'working',
    approvalPolicy: 'risk-stable',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }) as AuthoringTask

describe('workshop lifecycle', () => {
  it('starts at candidate generation without a candidate', () => {
    expect(lifecyclePosition(task(), false)).toEqual({ current: 0, failed: false })
  })

  it('waits on run confirmation, then advances through start and interface verification', () => {
    const at = (state: AuthoringAttempt['state']) =>
      lifecyclePosition(task({ status: 'running', candidateAttempt: attempt({ state }) }), false).current
    expect(at('awaiting-approval')).toBe(1)
    expect(at('starting-host')).toBe(2)
    expect(at('loading-client')).toBe(3)
    expect(at('verifying')).toBe(3)
  })

  it('moves to save once the latest candidate is verified', () => {
    expect(lifecyclePosition(task({ status: 'ready', candidateAttempt: attempt({ state: 'active' }) }), false)).toEqual(
      {
        current: 4,
        failed: false,
      },
    )
  })

  it('marks the failing phase from the attempt error', () => {
    const failed = task({
      status: 'failed',
      candidateAttempt: attempt({
        state: 'failed',
        error: { phase: 'client-render', message: '示例错误', repairable: true },
      }),
    })
    expect(lifecyclePosition(failed, false)).toEqual({ current: 3, failed: true })
  })

  it('needs enabling after save and completes once the agent uses it', () => {
    expect(lifecyclePosition(task({ status: 'completed' }), false).current).toBe(5)
    expect(lifecyclePosition(task({ status: 'completed' }), true).current).toBe(6)
  })
})

describe('workshop helpers', () => {
  it('lists tasks needing the user first, then open work, then finished, newest first', () => {
    const sorted = sortTasks([
      task({ id: 'done', status: 'completed', updatedAt: 9 }),
      task({ id: 'busy', status: 'working', updatedAt: 8 }),
      task({ id: 'ask', status: 'awaiting-approval', updatedAt: 1 }),
      task({ id: 'busy2', status: 'repairing', updatedAt: 10 }),
    ])
    expect(sorted.map((item) => item.id)).toEqual(['ask', 'busy2', 'busy', 'done'])
  })

  it('splits contribution labels', () => {
    expect(contributionParts('工具：weather_lookup')).toEqual({ kind: '工具', name: 'weather_lookup' })
    expect(contributionParts('RPC：forecast')).toEqual({ kind: '数据接口', name: 'forecast' })
    expect(contributionParts('其他')).toEqual({ kind: '内容', name: '其他' })
  })

  it('proposes valid slugs for Latin and non-Latin names', () => {
    expect(proposeSlug('Weather Card!')).toBe('weather-card')
    expect(SLUG_PATTERN.test(proposeSlug('天气卡片', 1_700_000_000_000))).toBe(true)
  })
})

describe('workshop halted tasks', () => {
  it('marks an interrupted task as stopped at its current phase', () => {
    expect(
      lifecyclePosition(task({ status: 'interrupted', candidateAttempt: attempt({ state: 'loading-client' }) }), false),
    ).toEqual({
      current: 3,
      failed: true,
    })
  })
})
