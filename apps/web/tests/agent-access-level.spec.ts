import { describe, expect, it } from 'vitest'
import {
  agentAccessCapabilities,
  agentAccessPresentation,
  agentAccessPreset,
  nearestAgentAccessLevel,
  type AgentAccessLevel,
} from '../src/agent-access-level.js'
import type { AgentSummary } from '../src/product-store.js'

const capabilities = (
  access: Pick<AgentSummary['capabilities'], 'fileTools' | 'developmentShell' | 'unrestrictedFileAccess'>,
): AgentSummary['capabilities'] => ({
  subagents: false,
  webSearch: false,
  dynamicCreation: false,
  ...access,
})

describe('agent system access presets', () => {
  it.each([0, 1, 2, 3] as const)('round-trips preset %s', (level) => {
    expect(agentAccessPreset(capabilities(agentAccessCapabilities(level)))).toBe(level)
  })

  it('marks granular combinations outside the four presets as custom', () => {
    const customCases: readonly Pick<
      AgentSummary['capabilities'],
      'fileTools' | 'developmentShell' | 'unrestrictedFileAccess'
    >[] = [
      { fileTools: false, developmentShell: true, unrestrictedFileAccess: false },
      { fileTools: false, developmentShell: false, unrestrictedFileAccess: true },
      { fileTools: true, developmentShell: false, unrestrictedFileAccess: true },
    ]
    for (const item of customCases) {
      const value = capabilities(item)
      expect(agentAccessPreset(value)).toBe('custom')
      expect(agentAccessPresentation(value).label).toBe('自定义权限')
      expect(agentAccessPresentation(value).code).toBe('Lv.C')
    }
  })

  it.each([
    [0, 'Lv.0', '基础权限'],
    [1, 'Lv.1', '文件读写'],
    [2, 'Lv.2', '运行命令'],
    [3, 'Lv.3', '完整访问'],
  ] as const)('presents preset %s as %s', (level, code, label) => {
    expect(agentAccessPresentation(capabilities(agentAccessCapabilities(level)))).toMatchObject({ code, label })
  })

  it('keeps each preset cumulative', () => {
    const expected: Record<AgentAccessLevel, ReturnType<typeof agentAccessCapabilities>> = {
      0: { fileTools: false, developmentShell: false, unrestrictedFileAccess: false },
      1: { fileTools: true, developmentShell: false, unrestrictedFileAccess: false },
      2: { fileTools: true, developmentShell: true, unrestrictedFileAccess: false },
      3: { fileTools: true, developmentShell: true, unrestrictedFileAccess: true },
    }
    for (const level of [0, 1, 2, 3] as const) {
      expect(agentAccessCapabilities(level)).toEqual(expected[level])
    }
  })

  it('previews and snaps continuous drag positions to the nearest preset', () => {
    expect(nearestAgentAccessLevel(Number.NaN)).toBe(0)
    expect(nearestAgentAccessLevel(-1)).toBe(0)
    expect(nearestAgentAccessLevel(0.49)).toBe(0)
    expect(nearestAgentAccessLevel(0.5)).toBe(1)
    expect(nearestAgentAccessLevel(1.49)).toBe(1)
    expect(nearestAgentAccessLevel(1.5)).toBe(2)
    expect(nearestAgentAccessLevel(2.5)).toBe(3)
    expect(nearestAgentAccessLevel(4)).toBe(3)
  })
})
