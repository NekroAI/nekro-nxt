import { describe, expect, it } from 'vitest'
import { ConnectionLogObserver } from '../src/logs/connection.js'
import { normalizeLog } from '../src/logs/redact.js'

const source = { kind: 'connection' as const, id: 'fictional', name: '示例连接' }
const connected = { status: 'connected' as const }
const retry = { status: 'reconnecting' as const, message: '网络不可用', details: { closeCode: 1006 } }
describe('connection observability', () => {
  it('summarizes a continuing outage and reports its actual recovery duration', () => {
    const logs = new ConnectionLogObserver()
    const observe = (
      value: typeof retry | typeof connected | { status: 'connecting' },
      previous: typeof retry | typeof connected | undefined,
      now: number,
    ) => logs.observe(source.id, source.name, { connectionId: source.id }, value, previous, now)
    expect(observe(retry, connected, 1000)).toMatchObject({
      level: 'warn',
      message: '连接中断，正在重连：网络不可用',
      details: { closeCode: 1006 },
    })
    expect(observe({ status: 'connecting' }, retry, 2000)).toBeUndefined()
    expect(observe(retry, retry, 3000)).toBeUndefined()
    expect(observe(retry, retry, 301000)).toMatchObject({
      level: 'warn',
      details: { durationMs: 300000, diagnosticUpdates: 3 },
    })
    expect(observe(connected, retry, 302000)).toMatchObject({
      level: 'info',
      message: '连接已恢复，中断 301 秒',
      details: { durationMs: 301000 },
    })
    expect(observe(connected, connected, 303000)).toBeUndefined()
    expect(observe(retry, connected, 304000)?.message).toBe('连接中断，正在重连：网络不可用')
  })
  it('reports a changed cause immediately and clears the outage when stopped', () => {
    const logs = new ConnectionLogObserver()
    logs.observe(source.id, source.name, {}, retry, connected, 0)
    expect(
      logs.observe(source.id, source.name, {}, { status: 'failed', message: '凭据已过期' }, retry, 1000),
    ).toMatchObject({ level: 'error', message: '连接仍未恢复，已中断 1 秒：凭据已过期' })
    logs.observe(source.id, source.name, {}, { status: 'stopped' }, retry, 2000)
    expect(logs.observe(source.id, source.name, {}, connected, { status: 'stopped' }, 3000)?.message).toBe('连接已建立')
  })
  it('keeps connected capability failures and their diagnostics observable', () => {
    const logs = new ConnectionLogObserver()
    expect(
      logs.observe(
        source.id,
        source.name,
        {},
        { status: 'connected', message: '频道查询失败', details: { code: 'DENIED' } },
        connected,
        0,
      ),
    ).toMatchObject({ level: 'warn', message: '频道查询失败', details: { code: 'DENIED' } })
  })
  it('removes the summary full stop without changing error stacks or structured evidence', () => {
    const entry = normalizeLog(
      {
        level: 'error',
        source,
        message: '请求失败。\n',
        details: { stack: 'Error: failed.\n    at demo.ts:2:4', reason: 'timeout.' },
      },
      'demo',
      0,
    )
    expect(entry.message).toBe('请求失败')
    expect(entry.details).toEqual({ stack: 'Error: failed.\n    at demo.ts:2:4', reason: 'timeout.' })
  })
})
