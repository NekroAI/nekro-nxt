import { describe, expect, it } from 'vitest'
import { connectionStatus, explainMessage, testOutcome } from '../src/app/model/connection-status.js'

const connection = (patch: Partial<Parameters<typeof connectionStatus>[0]> = {}) => ({
  runtimeState: 'connected',
  lastError: '',
  credentialConfigured: true,
  userManaged: true,
  ...patch,
})

describe('connection status dictionary', () => {
  it('maps runtime states to the four user-facing states', () => {
    expect(connectionStatus(connection())).toMatchObject({ health: 'ok', label: '正常', tone: 'ok' })
    expect(connectionStatus(connection({ runtimeState: 'reconnecting' }))).toMatchObject({
      label: '正在连接',
      reason: '连接中断，正在重连',
    })
    expect(connectionStatus(connection({ runtimeState: 'failed', lastError: '鉴权失败' }))).toMatchObject({
      health: 'attention',
      label: '需要处理',
      reason: '鉴权失败',
    })
    expect(connectionStatus(connection({ runtimeState: 'stopped', credentialConfigured: false }))).toMatchObject({
      label: '需要处理',
      reason: '还没有保存登录凭据',
    })
    expect(connectionStatus(connection({ runtimeState: 'stopped', userManaged: false }))).toMatchObject({
      label: '已停用',
    })
  })

  it('keeps a connected account normal while surfacing a passing notice in plain words', () => {
    const view = connectionStatus(connection({ lastError: '引用未解析：platform-reference-unresolved' }))
    expect(view.label).toBe('正常')
    expect(view.reason).toBe('收到的消息引用了一条平台未能提供的原消息')
    expect(view.reason).not.toContain('platform-reference-unresolved')
    expect(view.detail).toBe('引用未解析：platform-reference-unresolved')
  })
})

describe('message explanations', () => {
  it('passes Chinese prose through unchanged', () => {
    expect(explainMessage('这个连接的适配器未安装。')).toEqual({
      reason: '这个连接的适配器未安装。',
      raw: '这个连接的适配器未安装。',
    })
  })

  it('keeps unknown codes and English internals out of the reason', () => {
    expect(explainMessage('Delivery targets another Connection.')).toMatchObject({
      reason: '平台返回了一个未识别的问题',
      raw: 'Delivery targets another Connection.',
    })
    const embedded = explainMessage('同步失败：fixture-unknown-code')
    expect(embedded).toMatchObject({ reason: '同步失败', code: 'fixture-unknown-code' })
  })

  it('summarizes connection test results', () => {
    expect(testOutcome('通过')).toEqual({ label: '通过', tone: 'ok' })
    expect(testOutcome('未测试')).toEqual({ label: '未测试', tone: 'neutral' })
    expect(testOutcome('请先从平台发送一条消息，再重新测试接收。').label).toBe(
      '请先从平台发送一条消息，再重新测试接收。',
    )
  })
})
