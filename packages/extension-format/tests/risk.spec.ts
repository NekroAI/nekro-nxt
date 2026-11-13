import { describe, expect, it } from 'vitest'
import { combinationFindings, summarizePermissions } from '../src/index.js'

describe('permission summary', () => {
  it('describes files, tool images, media, commands and speech instead of calling them unknown (#149)', () => {
    const capabilities = {
      files: {},
      toolImages: { highDetail: true },
      media: true,
      commands: { profiles: ['ffmpeg', 'ffprobe'] },
      speech: { maxCallsPerMinute: 10 },
    }
    const items = summarizePermissions({
      permissions: { host: { files: {}, media: true }, agent: capabilities },
    })
    expect(items.filter((item) => item.label.startsWith('未知'))).toEqual([])
    expect(items.filter((item) => item.layer === 'agent').map(({ key, level }) => [key, level])).toEqual([
      ['files', 'normal'],
      ['toolImages', 'normal'],
      ['media', 'normal'],
      ['commands', 'elevated'],
      ['speech', 'elevated'],
    ])
    expect(items.find((item) => item.key === 'commands')?.detail).toBe('ffmpeg、ffprobe')
    expect(items.filter((item) => item.layer === 'host').map(({ key }) => key)).toEqual(['files', 'media'])
  })

  it('describes declared member identities as sensitive account access (#156)', () => {
    expect(summarizePermissions({ permissions: { agent: { members: { identities: true } } } })).toEqual([
      { key: 'members.identities', level: 'high', label: '读取成员的平台账号和身份', layer: 'agent' },
    ])
    expect(summarizePermissions({ permissions: { host: { members: { identities: true } } } })).toEqual([
      { key: 'members', level: 'elevated', label: '未知能力：members', layer: 'host' },
    ])
  })
})

describe('member identity combination risks', () => {
  const identities = { members: { identities: true } }

  it.each([
    { agent: { ...identities, network: { mode: 'domains', domains: ['api.example.com'] } } },
    { agent: identities, host: { network: { mode: 'config', fields: ['endpoint'] } } },
    { agent: identities, permissions: ['network.request'], networkOrigins: ['https://ui.example.com'] },
  ])('warns when identities can leave through declared network access', (permissions) => {
    expect(combinationFindings({ permissions })).toContainEqual({
      id: 'combo.identities-network',
      severity: 'risk',
      title: '可外传成员账号',
      detail: '扩展可以读取成员的平台账号并访问网络，请确认账号信息的用途。',
    })
  })

  it.each([
    { agent: identities },
    { agent: { network: { mode: 'domains', domains: ['api.example.com'] } } },
    { agent: { members: { identities: false }, network: { mode: 'domains', domains: ['api.example.com'] } } },
  ])('requires both identity access and network access for the account warning', (permissions) => {
    expect(combinationFindings({ permissions }).some(({ id }) => id === 'combo.identities-network')).toBe(false)
  })
})
