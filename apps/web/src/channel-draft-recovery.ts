import { AssetIdSchema } from '@nekro-nxt/contracts'
import type { ChannelDraft, ChannelAttachment } from './channel-drafts.js'

const key = 'nekro-nxt.channel-drafts.v1'
const serializableAttachment = (item: ChannelAttachment) => ({
  id: item.id,
  name: item.name,
  byteSize: item.byteSize,
  mediaType: item.mediaType,
  partType: item.partType,
  status: item.status,
  ...(item.assetId === undefined ? {} : { assetId: item.assetId }),
  ...(item.error === undefined ? {} : { error: item.error }),
})
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const parseAttachments = (value: unknown): readonly ChannelAttachment[] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        if (!isRecord(item)) return []
        const record = item
        if (
          typeof record['name'] !== 'string' ||
          typeof record['mediaType'] !== 'string' ||
          (record['partType'] !== 'image' && record['partType'] !== 'file')
        )
          return []
        const asset = AssetIdSchema.safeParse(record['assetId'])
        return [
          {
            // Regenerate per occurrence: stale or duplicated ids in storage cannot collide.
            id: crypto.randomUUID(),
            name: record['name'],
            mediaType: record['mediaType'],
            partType: record['partType'],
            byteSize:
              typeof record['byteSize'] === 'number' &&
              Number.isSafeInteger(record['byteSize']) &&
              record['byteSize'] >= 0
                ? record['byteSize']
                : 0,
            ...(asset.success
              ? { assetId: asset.data, status: 'ready' as const }
              : {
                  status: 'failed' as const,
                  error: '上传未完成，请移除后重新选择文件。',
                }),
          },
        ]
      })
    : []

/** Tab-local, origin-scoped drafts; pending request identities and File objects are never restored. */
export const readChannelDraftRecovery = (): Readonly<Record<string, ChannelDraft>> => {
  try {
    if (typeof window === 'undefined') return {}
    const text = window.sessionStorage.getItem(key)
    if (!text) return {}
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value).flatMap(([id, draft]) => {
        if (typeof draft === 'string') return draft.trim() ? [[id, { text: draft, revision: 0 }]] : []
        if (!isRecord(draft) || typeof draft['text'] !== 'string') return []
        const text = draft['text']
        const attachments = parseAttachments(draft['attachments'])
        if (!text.trim() && !attachments.length) return []
        return [[id, { text, revision: 0, ...(attachments.length ? { attachments } : {}) }]]
      }),
    )
  } catch {
    return {}
  }
}

export const saveChannelDraftRecovery = (drafts: Readonly<Record<string, ChannelDraft>>): boolean => {
  try {
    if (typeof window === 'undefined') return false
    const entries = Object.fromEntries(
      Object.entries(drafts)
        .filter(([, draft]) => draft.text.trim() || (draft.attachments?.length ?? 0) > 0)
        .map(([id, draft]) => [
          id,
          { text: draft.text, attachments: draft.attachments?.map(serializableAttachment) ?? [] },
        ]),
    )
    if (Object.keys(entries).length > 0) window.sessionStorage.setItem(key, JSON.stringify(entries))
    else window.sessionStorage.removeItem(key)
    return true
  } catch {
    return false
  }
}
