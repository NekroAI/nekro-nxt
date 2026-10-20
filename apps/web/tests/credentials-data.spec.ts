import { describe, expect, it } from 'vitest'
import { credentialsView, githubCredentialId, translateCredentialId } from '../e2e/fixtures/credentials.ts'
import { targetAgentId, sourceAgentId } from '../e2e/fixtures/product-quality.ts'
import {
  commandCredentialsOf,
  credentialDraftIssues,
  credentialUsageText,
  emptyCredentialDraft,
  parseDomains,
} from '../src/credentials/credentials-data.ts'

describe('credentials', () => {
  const { credentials } = credentialsView()

  it('gives commands program credentials open to the agent, used automatically or approved for it', () => {
    expect(commandCredentialsOf(credentials, targetAgentId).map(({ credential, env }) => [credential.id, env])).toEqual(
      [
        [translateCredentialId, 'TRANSLATE_API_KEY'],
        [githubCredentialId, 'GH_TOKEN'],
      ],
    )
    // Not in the translation credential's scope; request-only credentials never reach commands.
    expect(commandCredentialsOf(credentials, sourceAgentId).map(({ env }) => env)).toEqual(['GH_TOKEN'])
  })

  it('says where a credential goes', () => {
    expect(credentials.map(credentialUsageText)).toEqual([
      'api.weather.example.com',
      '程序可读 · TRANSLATE_API_KEY',
      '程序可读 · GH_TOKEN',
    ])
  })

  it('needs a domain for request use and checks domains and variable names', () => {
    expect(parseDomains('a.example.com, B.example.com，c.example.com')).toEqual([
      'a.example.com',
      'b.example.com',
      'c.example.com',
    ])
    expect(credentialDraftIssues({ ...emptyCredentialDraft, name: '天气' }, 'generic')).toEqual({
      domains: '至少填写一个域名。',
    })
    expect(
      credentialDraftIssues({ ...emptyCredentialDraft, name: '天气', domains: 'https://a.example.com' }, 'generic')
        .domains,
    ).toContain('不是有效的域名')
    expect(
      credentialDraftIssues({ ...emptyCredentialDraft, name: '天气', usage: 'program', envName: 'PATH' }, 'generic'),
    ).toEqual({ envName: '这个环境变量名由系统使用，请换一个。' })
    expect(credentialDraftIssues({ ...emptyCredentialDraft, name: '' }, 'github')).toEqual({ name: '名称不能为空。' })
  })
})
