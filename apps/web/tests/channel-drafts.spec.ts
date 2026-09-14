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
})
