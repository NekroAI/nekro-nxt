import { describe, expect, it } from 'vitest'
import {
  commandOutput,
  finishOutcome,
  messageText,
  readArguments,
  searchQueries,
  searchSources,
  toolKind,
  toolSummary,
} from '../src/app/channels/tool-presenter.ts'

describe('tool presenter', () => {
  it('summarises each kind of step without JSON punctuation', () => {
    expect(toolSummary('web_search', '{"queries":["示例 视频模型","示例 AI 生成"]}', false)).toBe(
      '示例 视频模型 / 示例 AI 生成',
    )
    expect(toolSummary('bash', '{"command":"true","description":"占位命令"}', false)).toBe('占位命令')
    expect(toolSummary('bash', '{"command":"ls -la\\npwd"}', false)).toBe('ls -la')
    expect(toolSummary('finish_channel_turn', '{"outcome":"no-response-needed","reason":"只是打招呼"}', false)).toBe(
      '只是打招呼',
    )
    expect(
      toolSummary('send_channel_message', '{"target":{"type":"current"},"parts":[{"text":"你好\\n世界"}]}', true),
    ).toBe('你好\n世界')
  })

  it('recovers readable fields from a preview cut mid-string', () => {
    const cut = '{"command":"curl -sL --max-time 20 \\"https://example.com/a\\" | head -80","descr…'
    expect(readArguments(cut)?.['command']).toBe('curl -sL --max-time 20 "https://example.com/a" | head -80')
    expect(toolSummary('bash', cut, false)).toBe('curl -sL --max-time 20 "https://example.com/a" | head -80')
    expect(searchQueries(readArguments('{"queries":["甲","乙","丙…'))).toEqual(['甲', '乙', '丙…'])
    expect(messageText(undefined, '{"parts":[{"text":"很长的一段话被截')).toBe('很长的一段话被截')
  })

  it('classifies tools and reads search sources and command output', () => {
    expect(toolKind('web_search')).toBe('search')
    expect(toolKind('bash')).toBe('command')
    expect(toolKind('web_fetch')).toBe('fetch')
    expect(toolKind('lookup_weather')).toBe('other')
    const sources = searchSources(
      'Sources:\n- [示例页面 - Skip to content](https://www.example.com/page#1)\n- [第二篇](https://docs.example.org/x)',
    )
    expect(sources).toEqual([
      { title: '示例页面', url: 'https://www.example.com/page#1', host: 'example.com' },
      { title: '第二篇', url: 'https://docs.example.org/x', host: 'docs.example.org' },
    ])
    expect(commandOutput('(no output)')).toBe('')
    expect(commandOutput('  ok  ')).toBe('ok')
    expect(commandOutput(undefined)).toBeUndefined()
    expect(finishOutcome('cannot-respond')).toBe('无法回复')
  })
})
