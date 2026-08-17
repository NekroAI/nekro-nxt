import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultWebDistIndex, parseLlmProviderRoutes } from '../src/main.js'

describe('Server executable defaults', () => {
  it('resolves the Web build independently from the workspace command cwd', () => {
    expect(defaultWebDistIndex()).toBe(path.resolve(import.meta.dirname, '../../web/dist/index.html'))
  })

  it('parses an explicit, deduplicated DSH provider route allowlist', () => {
    expect(parseLlmProviderRoutes(undefined)).toEqual([])
    expect(parseLlmProviderRoutes(' opencode-go,deepseek,opencode-go ')).toEqual(['opencode-go', 'deepseek'])
    expect(() => parseLlmProviderRoutes('opencode-go,../forged')).toThrow('无效路由')
  })
})
