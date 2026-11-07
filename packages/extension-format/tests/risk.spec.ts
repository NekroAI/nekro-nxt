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
})
