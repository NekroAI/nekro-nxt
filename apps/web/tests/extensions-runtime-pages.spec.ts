import { describe, expect, it } from 'vitest'
import { contractVersionLabel, contributionLabel, extensionDescription } from '../src/pages/extensions-runtime-pages.js'

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
