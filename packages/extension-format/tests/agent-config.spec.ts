import { describe, expect, it } from 'vitest'
import { ExtensionLayeredConfigSchema, configFieldLevel, configFields, configSchema } from '@nekro-nxt/contracts'
import { assertAgentAuthoredConfig, materializeImportedRevision } from '../src/index.js'

const manifest = (dict: Record<string, unknown>) => ({
  schemaVersion: 7,
  extensionId: 'ext_01AGENTCONFIGFIXTURE00000',
  revisionId: 'xrv_01AGENTCONFIGFIXTURE00000',
  entrypoints: { host: 'source/host.ts' },
  permissions: { permissions: [], networkOrigins: [] },
  contributions: [{ kind: 'tool', name: 'forecast', description: '查询示例天气' }],
  config: { agent: { schema: { type: 'object', dict } } },
})

const take = (dict: Record<string, unknown>) =>
  materializeImportedRevision({ manifest: manifest(dict), sources: { host: 'export default 1\n' } })

const layered = (dict: Record<string, unknown>) =>
  ExtensionLayeredConfigSchema.parse({ agent: { schema: { type: 'object', dict } } })

describe('agent configuration of a new revision', () => {
  it('accepts required fields without defaults, which the agent provides when enabling', () => {
    expect(() =>
      take({
        city: { type: 'string', meta: { required: true } },
        apiKey: { type: 'string', meta: { required: true, role: 'secret' } },
      }),
    ).not.toThrow()
  })

  it('lets imported extensions keep fields for administrators only', () => {
    const imported = take({ plan: { type: 'string', meta: { agentWritable: false, default: '免费' } } })
    expect(imported.manifest.config?.agent?.schema.dict['plan']?.meta?.agentWritable).toBe(false)
  })
})

describe('field levels', () => {
  const document = configSchema.object({
    city: configSchema.string('城市'),
    baseUrl: configSchema.string('服务地址'),
    apiKey: configSchema.secret('API Key'),
    plan: configSchema.enum('套餐', [{ value: 'free', label: '免费' }], { agentWritable: false }),
    gateway: { type: 'string', meta: { description: '网关', agentWritable: false } },
  })

  it('derives normal, network, secret and admin from the declaration', () => {
    expect(
      Object.fromEntries(
        configFields(document).map((field) => [field.key, configFieldLevel(field, ['baseUrl', 'gateway'])]),
      ),
    ).toEqual({
      city: 'normal',
      baseUrl: 'network',
      apiKey: 'secret',
      plan: 'admin',
      // Administrators only, even though it also decides an address.
      gateway: 'admin',
    })
  })
})

describe('configuration an agent writes', () => {
  it('cannot keep a field away from the agent in an extension it creates', () => {
    expect(() =>
      assertAgentAuthoredConfig(layered({ plan: { type: 'string', meta: { agentWritable: false } } })),
    ).toThrow('动态创造的扩展不能把配置项标记为 agentWritable: false：config.agent.plan')
    expect(() =>
      assertAgentAuthoredConfig(layered({ city: { type: 'string', meta: { agentWritable: true } } })),
    ).not.toThrow()
  })

  it('keeps the marks of the version it revises, neither adding nor removing one', () => {
    const base = layered({ plan: { type: 'string', meta: { agentWritable: false } }, city: { type: 'string' } })
    expect(() => assertAgentAuthoredConfig(base, base)).not.toThrow()
    expect(() =>
      assertAgentAuthoredConfig(layered({ plan: { type: 'string' }, city: { type: 'string' } }), base),
    ).toThrow('修改扩展时要保留 agentWritable: false：config.agent.plan')
    expect(() =>
      assertAgentAuthoredConfig(
        layered({
          plan: { type: 'string', meta: { agentWritable: false } },
          city: { type: 'string', meta: { agentWritable: false } },
        }),
        base,
      ),
    ).toThrow('config.agent.city')
  })
})
