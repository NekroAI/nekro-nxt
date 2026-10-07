import { AgentIdSchema, ChannelIdSchema } from '@nekro-nxt/contracts'
import { describe, expect, it } from 'vitest'
import {
  allowedActions,
  describeCron,
  formatWhen,
  type ScheduledTaskView,
} from '../src/app/agents/scheduled-task-model.js'

const task = (overrides: Partial<ScheduledTaskView>): ScheduledTaskView => ({
  id: 'job_fixture',
  agentId: AgentIdSchema.parse('agt_fixture'),
  channelId: ChannelIdSchema.parse('chn_fixture'),
  source: 'chat',
  label: '示例任务',
  schedule: { kind: 'cron', cron: '0 8 * * *', timezone: 'UTC' },
  state: 'scheduled',
  createdAt: 0,
  ...overrides,
})

describe('scheduled task wording', () => {
  it('names common cron shapes and keeps the rest as the expression', () => {
    expect(describeCron('0 8 * * *')).toBe('每天 08:00')
    expect(describeCron('30 9 * * 1-5')).toBe('工作日 09:30')
    expect(describeCron('0 10 * * 1,3')).toBe('每周一、三 10:00')
    expect(describeCron('0 20 1 * *')).toBe('每月 1 日 20:00')
    expect(describeCron('*/15 * * * *')).toBe('每 15 分钟')
    expect(describeCron('0 */2 * * *')).toBe('每 2 小时')
    expect(describeCron('0 8 1-7 * 1')).toBe('cron 0 8 1-7 * 1')
  })

  it('says today and tomorrow relative to now', () => {
    const now = new Date(2026, 9, 7, 9, 0).getTime()
    expect(formatWhen(new Date(2026, 9, 7, 18, 5).getTime(), now)).toBe('今天 18:05')
    expect(formatWhen(new Date(2026, 9, 8, 8, 0).getTime(), now)).toBe('明天 08:00')
    expect(formatWhen(new Date(2026, 11, 1, 8, 0).getTime(), now)).toBe('12月1日 08:00')
    expect(formatWhen(new Date(2027, 0, 2, 8, 0).getTime(), now)).toBe('2027年1月2日 08:00')
  })

  it('offers only what the source allows', () => {
    expect(allowedActions(task({}))).toEqual(['pause', 'run', 'delete'])
    expect(allowedActions(task({ source: 'declared', state: 'paused' }))).toEqual(['resume', 'run'])
    expect(allowedActions(task({ source: 'runtime', state: 'inactive' }))).toEqual(['pause', 'delete'])
    expect(allowedActions(task({ state: 'finished' }))).toEqual(['delete'])
  })
})
