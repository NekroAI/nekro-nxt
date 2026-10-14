import { describe, expect, it } from 'vitest'
import { createUiStateStore } from '../src/ui-state.js'

describe('runtime-owned channel drafts', () => {
  it('isolates sends, edits and late completions by channel and request', () => {
    const store = createUiStateStore()
    const actions = store.getState()
    actions.setChannelDraft('a', '频道甲草稿')
    actions.setChannelDraft('b', '频道乙草稿')
    const sent = actions.beginChannelSend('a')!
    expect(actions.beginChannelSend('a')).toBeUndefined()
    actions.setChannelDraft('a', '更新草稿')
    actions.finishChannelSend('a', sent.revision, sent.request, true)
    expect(store.getState().channelDrafts['a']?.text).toBe('更新草稿')
    expect(store.getState().channelDrafts['b']?.text).toBe('频道乙草稿')
    const next = actions.beginChannelSend('a')!
    actions.finishChannelSend('a', sent.revision, sent.request, true)
    expect(store.getState().channelDrafts['a']?.pending).toBe(next.request)
    actions.finishChannelSend('a', next.revision, next.request, false)
    expect(store.getState().channelDrafts['a']?.text).toBe('更新草稿')
  })
  it('clears only the sent revision and never resurrects a deleted channel', () => {
    const store = createUiStateStore()
    const actions = store.getState()
    actions.setChannelDraft('a', '消息')
    const sent = actions.beginChannelSend('a')!
    actions.retainChannelDrafts(new Set())
    actions.finishChannelSend('a', sent.revision, sent.request, true)
    expect(store.getState().channelDrafts).toEqual({})
    actions.setChannelDraft('a', '新消息')
    const next = actions.beginChannelSend('a')!
    actions.finishChannelSend('a', next.revision, next.request, true)
    expect(store.getState().channelDrafts['a']?.text).toBe('')
    expect(createUiStateStore().getState().channelDrafts).toEqual({})
  })

  it('keeps attachments scoped to the channel and retains them after a failed send', () => {
    const store = createUiStateStore()
    const actions = store.getState()
    const attachment = { assetId: 'ast_demo', name: '截图.png', mediaType: 'image/png', partType: 'image' as const }
    actions.setChannelAttachments('a', [attachment])
    actions.setChannelDraft('b', '另一个频道')
    const sent = actions.beginChannelSend('a')!
    expect(sent.attachments).toEqual([attachment])
    actions.finishChannelSend('a', sent.revision, sent.request, false)
    expect(store.getState().channelDrafts['a']?.attachments).toEqual([attachment])
    expect(store.getState().channelDrafts['b']?.attachments).toBeUndefined()
  })
})
