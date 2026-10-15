import { CHANNEL_COMPOSER_MAX_ATTACHMENTS, CHANNEL_COMPOSER_MAX_BYTES } from '@nekro-nxt/contracts'
import { workspaceApi } from './host-api-client.js'
import type { ChannelAttachment, ChannelDraftState } from './channel-drafts.js'

export interface ChannelAttachmentActions {
  addChannelFiles(channelId: string, files: readonly File[]): void
  retryChannelAttachment(channelId: string, id: string): void
  removeChannelAttachment(channelId: string, id: string): Promise<void>
  cancelChannelUploads(): void
}

/** Uploads belong to the runtime's channel drafts, not a mounted Composer. */
export function createChannelAttachmentActions(get: () => ChannelDraftState): ChannelAttachmentActions {
  const controllers = new Map<string, AbortController>()
  const items = (channelId: string) => get().channelDrafts[channelId]?.attachments ?? []
  const find = (channelId: string, id: string) => items(channelId).find((item) => item.id === id)
  const replace = (channelId: string, old: ChannelAttachment, next: ChannelAttachment | undefined) => {
    if (find(channelId, old.id) !== old) return
    get().setChannelAttachments(
      channelId,
      items(channelId).flatMap((item) => (item === old ? (next ? [next] : []) : [item])),
    )
  }
  const upload = async (channelId: string, item: ChannelAttachment) => {
    if (!item.file || find(channelId, item.id) !== item) return
    const controller = new AbortController()
    controllers.set(item.id, controller)
    try {
      const bytes = new Uint8Array(await item.file.arrayBuffer())
      if (controller.signal.aborted || find(channelId, item.id) !== item) return
      const result = await workspaceApi.uploadChannelAsset(channelId, bytes, item.name, { signal: controller.signal })
      replace(channelId, item, {
        id: item.id,
        assetId: result.assetId,
        name: result.fileName,
        byteSize: result.byteSize,
        mediaType: result.mediaType,
        partType: result.partType,
        status: 'ready',
      })
    } catch (error) {
      replace(channelId, item, {
        ...item,
        status: 'failed',
        error: error instanceof Error ? error.message : '上传失败，请重试。',
      })
    } finally {
      if (controllers.get(item.id) === controller) controllers.delete(item.id)
    }
  }
  return {
    addChannelFiles(channelId, files) {
      if (!files.length || get().channelDrafts[channelId]?.pending !== undefined) return
      const current = items(channelId)
      if (current.length + files.length > CHANNEL_COMPOSER_MAX_ATTACHMENTS)
        throw new Error(`每条消息最多添加 ${CHANNEL_COMPOSER_MAX_ATTACHMENTS} 个附件。`)
      if (files.some((file) => file.size > CHANNEL_COMPOSER_MAX_BYTES)) throw new Error('每个附件不能超过 64 MiB。')
      if (
        current.reduce((sum, item) => sum + item.byteSize, 0) + files.reduce((sum, file) => sum + file.size, 0) >
        CHANNEL_COMPOSER_MAX_BYTES
      )
        throw new Error('附件总大小不能超过 64 MiB。')
      const added: ChannelAttachment[] = files.map((file) => ({
        id: crypto.randomUUID(),
        name: file.name,
        file,
        byteSize: file.size,
        mediaType: file.type,
        partType: file.type.startsWith('image/') ? 'image' : 'file',
        status: 'uploading',
      }))
      // Reserve the entire batch synchronously so multiple paste/drop events cannot bypass limits or reorder items.
      get().setChannelAttachments(channelId, [...current, ...added])
      void (async () => {
        for (const item of added) await upload(channelId, item)
      })()
    },
    retryChannelAttachment(channelId, id) {
      if (get().channelDrafts[channelId]?.pending !== undefined) return
      const item = find(channelId, id)
      if (!item || item.status !== 'failed' || !item.file) return
      const next: ChannelAttachment = {
        id: item.id,
        name: item.name,
        file: item.file,
        byteSize: item.byteSize,
        mediaType: item.mediaType,
        partType: item.partType,
        status: 'uploading',
        ...(item.assetId === undefined ? {} : { assetId: item.assetId }),
      }
      replace(channelId, item, next)
      void upload(channelId, next)
    },
    async removeChannelAttachment(channelId, id) {
      if (get().channelDrafts[channelId]?.pending !== undefined) return
      const item = find(channelId, id)
      if (!item || item.status === 'removing') return
      controllers.get(id)?.abort()
      if (!item.assetId || items(channelId).some((other) => other.id !== id && other.assetId === item.assetId)) {
        replace(channelId, item, undefined)
        return
      }
      const removing: ChannelAttachment = { ...item, status: 'removing' }
      replace(channelId, item, removing)
      try {
        await workspaceApi.deleteChannelAsset(channelId, item.assetId)
        replace(channelId, removing, undefined)
      } catch (error) {
        replace(channelId, removing, {
          ...item,
          error: `移除失败：${error instanceof Error ? error.message : '请重试。'}`,
        })
      }
    },
    cancelChannelUploads() {
      for (const controller of controllers.values()) controller.abort()
      controllers.clear()
      for (const [channelId, draft] of Object.entries(get().channelDrafts)) {
        for (const item of draft.attachments ?? []) {
          if (item.status === 'uploading')
            replace(channelId, item, { ...item, status: 'failed', error: '上传已中断，请重试。' })
        }
      }
    },
  }
}
