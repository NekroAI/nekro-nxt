import { configSchema } from '@nekro-nxt/contracts'
import { describe, expect, it } from 'vitest'
import { configDefaults, configIssues, secretIssues } from '../src/extension-ui/config-form.tsx'

const schema = configSchema.object({
  endpoint: configSchema.string('服务地址', { required: true, default: 'wss://chat.example.invalid' }),
  token: configSchema.secret('访问令牌', { required: true }),
  retries: configSchema.number('重试次数', { default: 3, min: 0, max: 10, integer: true }),
  mode: configSchema.enum('模式', [
    { value: 'quiet', label: '安静' },
    { value: 'verbose', label: '详细' },
  ]),
})

describe('ConfigForm helpers', () => {
  it('starts from declared defaults and never includes secrets', () => {
    expect(configDefaults(schema)).toEqual({ endpoint: 'wss://chat.example.invalid', retries: 3 })
  })

  it('reports issues per top-level field with readable messages', () => {
    expect(configIssues(schema, { endpoint: '', retries: 11, mode: 'loud' })).toEqual({
      endpoint: '请填写服务地址。',
      retries: '重试次数不能大于 10。',
      mode: '模式的取值无效。',
    })
    expect(configIssues(schema, configDefaults(schema))).toEqual({})
  })

  it('requires a secret unless the Host already stores one', () => {
    expect(secretIssues(schema, {})).toEqual({ token: '请填写访问令牌。' })
    expect(secretIssues(schema, { token: '  ' })).toEqual({ token: '请填写访问令牌。' })
    expect(secretIssues(schema, {}, new Set(['token']))).toEqual({})
    expect(secretIssues(schema, { token: 'synthetic' })).toEqual({})
  })
})
