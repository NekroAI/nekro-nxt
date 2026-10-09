import { describe, expect, it } from 'vitest'
import {
  contributionParts,
  extensionUsage,
  lifecyclePosition,
  recordLabels,
  taskGroup,
  proposeSlug,
  SLUG_PATTERN,
  sortTasks,
  type AuthoringAttempt,
  type ExtensionUsageInput,
  type LifecycleInput,
} from '../src/app/workshop/workshop-model.js'

const at = (state: AuthoringAttempt['state'], error?: AuthoringAttempt['error']) =>
  error === undefined ? { state } : { state, error }

const position = (task: LifecycleInput, enabled = false) => lifecyclePosition(task, enabled)

describe('workshop lifecycle', () => {
  it('starts at candidate generation without a candidate', () => {
    expect(position({ status: 'working' })).toEqual({ current: 0, failed: false })
  })

  it('waits on run confirmation, then advances through start and interface verification', () => {
    const step = (state: AuthoringAttempt['state']) =>
      position({ status: 'running', candidateAttempt: at(state) }).current
    expect(step('awaiting-approval')).toBe(1)
    expect(step('starting-host')).toBe(2)
    expect(step('loading-client')).toBe(3)
    expect(step('verifying')).toBe(3)
  })

  it('moves to save once the latest candidate is verified', () => {
    expect(position({ status: 'ready', candidateAttempt: at('active') })).toEqual({ current: 4, failed: false })
  })

  it('marks the failing phase from the attempt error', () => {
    const candidate = at('failed', { phase: 'client-render', message: '示例错误', repairable: true })
    expect(position({ status: 'failed', candidateAttempt: candidate })).toEqual({ current: 3, failed: true })
  })

  it('marks an interrupted task as stopped at its current phase', () => {
    expect(position({ status: 'interrupted', candidateAttempt: at('loading-client') })).toEqual({
      current: 3,
      failed: true,
    })
  })

  it('needs enabling after save and completes once the agent uses it', () => {
    expect(position({ status: 'completed' }).current).toBe(5)
    expect(position({ status: 'completed' }, true).current).toBe(6)
  })
})

describe('workshop helpers', () => {
  it('lists tasks needing the user first, then open work, then finished, newest first', () => {
    const sorted = sortTasks([
      { id: 'done', status: 'completed', updatedAt: 9 },
      { id: 'busy', status: 'working', updatedAt: 8 },
      { id: 'ask', status: 'awaiting-approval', updatedAt: 1 },
      { id: 'busy2', status: 'repairing', updatedAt: 10 },
    ] as const)
    expect(sorted.map((item) => item.id)).toEqual(['ask', 'busy2', 'busy', 'done'])
  })

  it('splits contribution labels', () => {
    expect(contributionParts('工具：weather_lookup')).toEqual({ kind: '工具', name: 'weather_lookup' })
    expect(contributionParts('RPC：forecast')).toEqual({ kind: '数据接口', name: 'forecast' })
    expect(contributionParts('工具视图：weather_lookup')).toEqual({ kind: '工具视图', name: 'weather_lookup' })
    expect(contributionParts('面板：summary')).toEqual({ kind: '面板', name: 'summary' })
    expect(contributionParts('其他')).toEqual({ kind: '内容', name: '其他' })
  })

  it('proposes valid slugs for Latin and non-Latin names', () => {
    expect(proposeSlug('Weather Card!')).toBe('weather-card')
    expect(SLUG_PATTERN.test(proposeSlug('天气卡片', 1_700_000_000_000))).toBe(true)
  })
})

describe('workshop list and records', () => {
  it('groups tasks by what they need from the user', () => {
    expect(taskGroup({ status: 'awaiting-approval' })).toBe('attention')
    expect(taskGroup({ status: 'ready' })).toBe('attention')
    expect(taskGroup({ status: 'working' })).toBe('active')
    expect(taskGroup({ status: 'completed' })).toBe('ended')
    expect(taskGroup({ status: 'interrupted' })).toBe('ended')
  })

  it('labels saved records by save time and adds seconds only when minutes collide', () => {
    const base = new Date(2026, 9, 1, 14, 20, 5).getTime()
    const labels = recordLabels([
      { id: 'a', createdAt: base },
      { id: 'b', createdAt: base + 20_000 },
      { id: 'c', createdAt: base + 3_600_000 },
    ])
    expect(labels.get('a')).toBe('10月1日 14:20:05')
    expect(labels.get('b')).toBe('10月1日 14:20:25')
    expect(labels.get('c')).toBe('10月1日 15:20')
    expect([...labels.values()].some((label) => /\br\d/u.test(label))).toBe(false)
  })
})

describe('extension usage', () => {
  const extension = (patch: Partial<ExtensionUsageInput> = {}): ExtensionUsageInput => ({
    provides: ['agent'],
    revisions: [{ id: 'xrv_A', format: 'current', agentLayer: true }],
    activations: [],
    ...patch,
  })
  const installation = { revisionId: 'xrv_A' }

  it('tells an installed agent-only extension apart from one that is not on this machine yet', () => {
    expect(extensionUsage(extension())).toEqual({ label: '未启用', tone: 'neutral' })
    expect(extensionUsage(extension({ installation }))).toEqual({ label: '已安装 · 未启用', tone: 'neutral' })
    expect(extensionUsage(extension({ provides: ['agent', 'page'], installation }))).toEqual({
      label: '已安装',
      tone: 'ok',
    })
  })
})
