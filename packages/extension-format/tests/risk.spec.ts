import { describe, expect, it } from 'vitest'
import { summarizePermissions } from '../src/index.js'

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

  it('names the address fields of unrestricted network access', () => {
    const [plain] = summarizePermissions({
      permissions: { agent: { network: { mode: 'unrestricted', purpose: '下载生成的图片' } } },
    })
    expect(plain).toMatchObject({ level: 'high', label: '访问任意网站', detail: '下载生成的图片' })
    const [withFields] = summarizePermissions({
      permissions: { agent: { network: { mode: 'unrestricted', purpose: '下载生成的图片', fields: ['baseUrl'] } } },
    })
    expect(withFields).toMatchObject({
      level: 'high',
      label: '访问任意网站和你在配置中填写的地址',
      detail: '下载生成的图片；配置地址：baseUrl',
    })
  })

  it('joins the purpose and address fields without doubled punctuation and shows field titles', () => {
    const [item] = summarizePermissions({
      permissions: {
        agent: { network: { mode: 'unrestricted', purpose: '下载生成的图片。', fields: ['endpoint'] } },
      },
      config: {
        agent: {
          schema: { type: 'object', dict: { endpoint: { type: 'string', meta: { description: '服务地址' } } } },
        },
      },
    })
    expect(item?.detail).toBe('下载生成的图片；配置地址：服务地址')
    const [untitled] = summarizePermissions({
      permissions: { agent: { network: { mode: 'unrestricted', purpose: '下载图片', fields: ['endpoint'] } } },
    })
    expect(untitled?.detail).toBe('下载图片；配置地址：endpoint')
  })
})
