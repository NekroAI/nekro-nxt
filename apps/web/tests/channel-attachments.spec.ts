import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssetIdSchema, CHANNEL_COMPOSER_MAX_BYTES } from '@nekro-nxt/contracts'
import { createUiStateStore } from '../src/ui-state.js'
import { workspaceApi } from '../src/host-api-client.js'
import { readChannelDraftRecovery, saveChannelDraftRecovery } from '../src/channel-draft-recovery.js'

const asset = {
  assetId: AssetIdSchema.parse('ast_attachment'),
  fileName: '样本.txt',
  mediaType: 'text/plain',
  partType: 'file' as const,
  byteSize: 3,
}
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const file = () => new File(['abc'], '样本.txt', { type: 'text/plain' })

describe('channel attachment ownership and limits', () => {
  it('reserves uploads synchronously, blocks sends, retries in place and isolates channels', async () => {
    const upload = vi
      .spyOn(workspaceApi, 'uploadChannelAsset')
      .mockRejectedValueOnce(new Error('虚构上传失败'))
      .mockResolvedValue(asset)
    const store = createUiStateStore(),
      actions = store.getState()
    actions.setChannelDraft('b', '频道乙')
    actions.addChannelFiles('a', [file()])
    expect(actions.beginChannelSend('a')).toBeUndefined()
    await vi.waitFor(() => expect(store.getState().channelDrafts['a']?.attachments?.[0]?.status).toBe('failed'))
    expect(actions.beginChannelSend('a')).toBeUndefined()
    const id = store.getState().channelDrafts['a']!.attachments![0]!.id
    actions.retryChannelAttachment('a', id)
    await vi.waitFor(() => expect(store.getState().channelDrafts['a']?.attachments?.[0]?.status).toBe('ready'))
    expect(store.getState().channelDrafts['a']?.attachments?.[0]?.id).toBe(id)
    expect(store.getState().channelDrafts['b']?.text).toBe('频道乙')
    expect(upload).toHaveBeenCalledTimes(2)
    const token = actions.beginChannelSend('a')!
    await actions.removeChannelAttachment('a', id)
    actions.setChannelAttachments('a', [])
    expect(store.getState().channelDrafts['a']?.attachments).toHaveLength(1)
    actions.setChannelDraft('a', '发送期间新写的文字')
    actions.finishChannelSend('a', token.revision, token.request, true)
    expect(store.getState().channelDrafts['a']).toMatchObject({ text: '发送期间新写的文字', attachments: [] })
  })
  it.each(['remove', 'delete-channel', 'dispose'] as const)(
    'ignores late upload completion after %s',
    async (action) => {
      const waiting = deferred<typeof asset>()
      const upload = vi.spyOn(workspaceApi, 'uploadChannelAsset').mockReturnValue(waiting.promise)
      const store = createUiStateStore(),
        actions = store.getState()
      actions.addChannelFiles('a', [file()])
      await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
      const id = store.getState().channelDrafts['a']!.attachments![0]!.id
      if (action === 'remove') await actions.removeChannelAttachment('a', id)
      else if (action === 'delete-channel') actions.retainChannelDrafts(new Set())
      else actions.cancelChannelUploads()
      waiting.resolve(asset)
      await waiting.promise
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(store.getState().channelDrafts['a']?.attachments?.some((item) => item.status === 'ready')).not.toBe(true)
      if (action === 'delete-channel') expect(store.getState().channelDrafts['a']).toBeUndefined()
    },
  )
  it('removes duplicate selections independently and retains the last item after a deletion failure', async () => {
    vi.spyOn(workspaceApi, 'uploadChannelAsset').mockResolvedValue(asset)
    const remove = vi
      .spyOn(workspaceApi, 'deleteChannelAsset')
      .mockRejectedValueOnce(new Error('虚构删除失败'))
      .mockResolvedValue({ assetId: asset.assetId, revoked: true })
    const store = createUiStateStore(),
      actions = store.getState()
    actions.addChannelFiles('a', [file(), file()])
    await vi.waitFor(() =>
      expect(store.getState().channelDrafts['a']?.attachments?.every((item) => item.status === 'ready')).toBe(true),
    )
    const items = store.getState().channelDrafts['a']!.attachments!
    expect(items[0]!.id).not.toBe(items[1]!.id)
    await actions.removeChannelAttachment('a', items[0]!.id)
    expect(remove).not.toHaveBeenCalled()
    await actions.removeChannelAttachment('a', items[1]!.id)
    expect(store.getState().channelDrafts['a']?.attachments?.[0]?.error).toContain('删除失败')
    await actions.removeChannelAttachment('a', items[1]!.id)
    expect(store.getState().channelDrafts['a']?.attachments).toEqual([])
    expect(remove).toHaveBeenCalledTimes(2)
  })
  it('checks count, single and aggregate byte limits before reading bytes, while accepting empty files', async () => {
    const upload = vi.spyOn(workspaceApi, 'uploadChannelAsset').mockResolvedValue({ ...asset, byteSize: 0 })
    const store = createUiStateStore(),
      actions = store.getState()
    const sized = (size: number) => Object.defineProperty(file(), 'size', { value: size })
    expect(() => actions.addChannelFiles('a', Array.from({ length: 21 }, file))).toThrow('20')
    expect(() => actions.addChannelFiles('a', [sized(CHANNEL_COMPOSER_MAX_BYTES + 1)])).toThrow('每个附件')
    expect(() => actions.addChannelFiles('a', [sized(CHANNEL_COMPOSER_MAX_BYTES), file()])).toThrow('总大小')
    expect(upload).not.toHaveBeenCalled()
    actions.addChannelFiles('a', [new File([], '空文件.txt')])
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
    expect(store.getState().channelDrafts['a']?.attachments?.[0]?.byteSize).toBe(0)
  })
  it('restores attachment-only drafts and preserves interrupted uploads as actionable failures', () => {
    const storage = new Map<string, string>()
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: (key: string) => storage.get(key),
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    })
    saveChannelDraftRecovery({
      a: {
        text: '',
        revision: 5,
        pending: 2,
        attachments: [
          { ...asset, name: asset.fileName, id: 'one', status: 'ready' },
          {
            name: '未完成.txt',
            id: 'two',
            status: 'uploading',
            byteSize: 3,
            mediaType: 'text/plain',
            partType: 'file',
            file: file(),
          },
        ],
      },
    })
    const restored = readChannelDraftRecovery()['a']!
    expect(restored.pending).toBeUndefined()
    expect(restored.attachments?.[0]).toMatchObject({ assetId: asset.assetId, status: 'ready' })
    expect(restored.attachments?.[1]?.status).toBe('failed')
    expect(restored.attachments?.[1]?.error).toContain('重新选择')
    expect(restored.attachments?.[1]?.file).toBeUndefined()
  })
})
