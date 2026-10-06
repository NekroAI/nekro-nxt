import { configSchema } from '@nekro-nxt/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ConfigForm } from '../src/extension-ui/config-form.tsx'

const schema = configSchema.object({
  endpoint: configSchema.string('服务地址', { required: true, group: '连接' }),
  mode: configSchema.enum('模式', [
    { value: 'quiet', label: '安静' },
    { value: 'verbose', label: '详细' },
  ]),
  verbose: configSchema.boolean('详细日志', { advanced: true }),
  proxy: {
    type: 'object',
    dict: { host: configSchema.string('代理地址') },
    meta: { description: '代理' },
  },
  token: configSchema.secret('访问令牌'),
})

describe('ConfigForm', () => {
  it('renders groups, enum labels, nested objects and a collapsed advanced section', () => {
    const html = renderToStaticMarkup(<ConfigForm schema={schema} value={{}} onChange={() => undefined} />)
    expect(html).toContain('连接')
    expect(html).toContain('服务地址 *')
    expect(html).toContain('>安静<')
    expect(html).toContain('>详细<')
    expect(html).toContain('代理地址')
    expect(html).toContain('高级设置')
    expect(html).toContain('aria-expanded="false"')
    // Secrets only render when the caller manages them.
    expect(html).not.toContain('访问令牌')
  })

  it('shows secrets as write-only fields when secrets are managed', () => {
    const html = renderToStaticMarkup(
      <ConfigForm
        schema={schema}
        value={{}}
        onChange={() => undefined}
        secrets={{ value: {}, onChange: () => undefined, configured: new Set(['token']) }}
      />,
    )
    expect(html).toContain('访问令牌')
    expect(html).toContain('type="password"')
  })
})
