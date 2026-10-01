import { describe, expect, it } from 'vitest'
import {
  contractVersionLabel,
  contributionLabel,
  creatorSaveBlockedReason,
  extensionDescription,
} from '../src/pages/extensions-runtime-pages.js'

describe('extension details product copy', () => {
  it('keeps implementation terms secondary and names product-facing results', () => {
    expect(extensionDescription('由官方 DeepSeek V4 Flash 创建，已验证 Host Tool、RPC 与两个产品 Slot。')).toBe(
      '由 DeepSeek V4 Flash 创建，已验证智能体工具、界面数据接口与两个产品界面。',
    )
    expect(contributionLabel('工具：agent_identity_probe')).toBe('智能体工具 · agent_identity_probe')
    expect(contributionLabel('RPC：identity.current')).toBe('界面数据接口 · identity.current')
    expect(contributionLabel('界面：agent.workbench.sections')).toBe('智能体工作台面板')
    expect(contributionLabel('界面：extension.details.panels')).toBe('扩展详情面板')
    expect(contractVersionLabel('nekro-nxt-extension-v1')).toBe('NekroNXT 扩展 v1')
  })
})

describe('creator save gate', () => {
  const base = { runStatus: 'running', packageAvailable: true, agentIsSettling: false }

  it('allows saving only the latest verified candidate', () => {
    expect(
      creatorSaveBlockedReason({
        ...base,
        task: { status: 'ready', candidateAttempt: { ordinal: 2, state: 'active' }, activeAttempt: { ordinal: 2 } },
      }),
    ).toBeUndefined()
  })

  it('explains that a newer unverified candidate replaced the running one', () => {
    expect(
      creatorSaveBlockedReason({
        ...base,
        task: {
          status: 'repairing',
          candidateAttempt: { ordinal: 6, state: 'drafting' },
          activeAttempt: { ordinal: 5 },
        },
      }),
    ).toContain('最新的第 6 次尝试尚未通过验证')
  })

  it('waits for the agent to settle before saving', () => {
    expect(
      creatorSaveBlockedReason({
        ...base,
        agentIsSettling: true,
        task: { status: 'ready', candidateAttempt: { ordinal: 1, state: 'active' } },
      }),
    ).toContain('收尾完成后')
  })
})
