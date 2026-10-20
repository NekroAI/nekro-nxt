import { configSchema } from '@nekro-nxt/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { credentialsView, weatherCredentialId } from '../e2e/fixtures/credentials.ts'
import { ConfigForm, configIssues, secretIssues } from '../src/extension-ui/config-form.tsx'

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
    // Enum options open in a popup; statically the field shows its label and the current choice.
    expect(html).toContain('模式')
    expect(html).toContain('role="combobox"')
    expect(html).toContain('代理地址')
    expect(html).toContain('高级设置')
    expect(html).toContain('aria-expanded="false"')
    // Secrets only render when the caller manages them.
    expect(html).not.toContain('访问令牌')
  })

  it('shows the chosen enum label in the closed field', () => {
    const html = renderToStaticMarkup(
      <ConfigForm schema={schema} value={{ mode: 'quiet' }} onChange={() => undefined} />,
    )
    expect(html).toContain('>安静<')
    expect(html).not.toContain('>详细<')
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

  it('offers named credentials for a secret and shows the bound one instead of a value field', () => {
    const credentials = credentialsView().credentials
    const html = renderToStaticMarkup(
      <ConfigForm
        schema={schema}
        value={{}}
        onChange={() => undefined}
        secrets={{
          value: {},
          onChange: () => undefined,
          credentials: {
            options: credentials,
            usable: () => true,
            bound: { token: weatherCredentialId },
            onBind: () => undefined,
            onCreate: () => undefined,
          },
        }}
      />,
    )
    expect(html).toContain('aria-label="访问令牌"')
    expect(html).toContain('>天气服务<')
    expect(html).not.toContain('type="password"')
  })

  it('counts a bound credential as a filled required secret', () => {
    const required = configSchema.object({ token: configSchema.secret('访问令牌', { required: true }) })
    expect(secretIssues(required, {})).toEqual({ token: '请填写访问令牌。' })
    expect(secretIssues(required, {}, new Set(['token']))).toEqual({})
    expect(configIssues(required, {})).toEqual({})
  })
})
