import { describe, expect, it } from 'vitest'
import { PlatformIdentityIdSchema, normalizePromptDocument, promptDocumentPlainText } from '../src/index.ts'

describe('PromptDocumentV1', () => {
  it('normalizes adjacent text while preserving stable references', () => {
    const identityId = PlatformIdentityIdSchema.parse('pid_membera')
    const normalized = normalizePromptDocument({
      version: 1,
      segments: [
        { type: 'text', text: '优先听取' },
        { type: 'text', text: '' },
        { type: 'text', text: '以下成员：' },
        { type: 'reference', kind: 'platform-user', targetId: identityId, labelSnapshot: '成员甲' },
        { type: 'text', text: '。' },
      ],
    })
    expect(normalized.segments).toEqual([
      { type: 'text', text: '优先听取以下成员：' },
      { type: 'reference', kind: 'platform-user', targetId: identityId, labelSnapshot: '成员甲' },
      { type: 'text', text: '。' },
    ])
    expect(promptDocumentPlainText(normalized)).toBe('优先听取以下成员：@成员甲。')
  })

  it('rejects unknown segments and the reference limit', () => {
    expect(() => normalizePromptDocument({ version: 1, segments: [{ type: 'variable', name: 'now' }] })).toThrow()
    const identityId = PlatformIdentityIdSchema.parse('pid_many')
    expect(() =>
      normalizePromptDocument({
        version: 1,
        segments: Array.from({ length: 129 }, () => ({
          type: 'reference' as const,
          kind: 'platform-user' as const,
          targetId: identityId,
          labelSnapshot: '成员',
        })),
      }),
    ).toThrow()
  })
})
