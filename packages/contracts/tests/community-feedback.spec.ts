import { describe, expect, it } from 'vitest'
import {
  CommunityAccountSchema,
  CommunityFeedbackCreateSchema,
  CommunityFeedbackDiagnosticsSchema,
  CommunityFeedbackEventDataSchema,
} from '../src/index.js'

describe('community feedback wire contracts', () => {
  it('reads accounts from both old communities and communities with stable user IDs', () => {
    const old = { handle: 'sample-author', displayName: '示例作者', avatarUrl: null }
    expect(CommunityAccountSchema.parse(old).id).toBeUndefined()
    expect(CommunityAccountSchema.parse({ ...old, id: 'usr_fixture' }).id).toBe('usr_fixture')
  })

  it('rejects arbitrary diagnostic configuration and inline credentials', () => {
    expect(CommunityFeedbackDiagnosticsSchema.safeParse({ credentials: { token: 'fixture-token' } }).success).toBe(
      false,
    )
    expect(
      CommunityFeedbackDiagnosticsSchema.safeParse({
        extensions: [{ extensionId: 'ext_fixture', version: '1', apiKey: 'fixture' }],
      }).success,
    ).toBe(false)
    expect(CommunityFeedbackDiagnosticsSchema.parse({ nxtVersion: '0.5.0', hostKind: 'desktop' })).toEqual({
      nxtVersion: '0.5.0',
      hostKind: 'desktop',
    })
  })

  it('limits excerpts and rejects undeclared request fields and free text in immutable events', () => {
    const valid = {
      clientRequestId: 'fixture-request',
      kind: 'bug',
      target: 'nxt',
      title: '反馈样例',
      body: '保存后状态没有刷新。',
      source: 'form',
    }
    expect(CommunityFeedbackCreateSchema.parse(valid).excerptSharedWithAuthor).toBe(false)
    expect(
      CommunityFeedbackCreateSchema.safeParse({
        ...valid,
        excerpt: Array.from({ length: 9 }, () => ({ speaker: '成员甲', text: '样例' })),
      }).success,
    ).toBe(false)
    expect(CommunityFeedbackCreateSchema.safeParse({ ...valid, status: 'fixed' }).success).toBe(false)
    expect(CommunityFeedbackEventDataSchema.safeParse({ body: '不应保存在历史中的说明' }).success).toBe(false)
  })
})
