import type { ChannelDraft, ChannelAttachment } from './channel-drafts.js'

const key = 'nekro-nxt.channel-drafts.v1'

/** Tab-local, origin-scoped drafts; pending request identities are never restored. */
export const readChannelDraftRecovery = (): Readonly<Record<string, ChannelDraft>> => {
  try {
    if (typeof window === 'undefined') return {}
    const text = window.sessionStorage.getItem(key)
    if (!text) return {}
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value).flatMap(([id, draft]) =>
        typeof draft === 'object' &&
        draft !== null &&
        !Array.isArray(draft) &&
        typeof draft['text'] === 'string' &&
        draft['text'].trim()
          ? [[id, { text: draft['text'], attachments: parseAttachments(draft['attachments']), revision: 0 }]]
          : typeof draft === 'string' && draft.trim()
            ? [[id, { text: draft, revision: 0 }]]
            : [],
      ),
    )
  } catch {
    return {}
  }
}

const parseAttachments = (value: unknown): readonly ChannelAttachment[] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
        const record = item as Record<string, unknown>
        return typeof record['assetId'] === 'string' &&
          typeof record['name'] === 'string' &&
          typeof record['mediaType'] === 'string' &&
          (record['partType'] === 'image' || record['partType'] === 'file')
          ? [
              {
                assetId: record['assetId'],
                name: record['name'],
                mediaType: record['mediaType'],
                partType: record['partType'],
              },
            ]
          : []
      })
    : []

export const saveChannelDraftRecovery = (drafts: Readonly<Record<string, ChannelDraft>>): boolean => {
  try {
    if (typeof window === 'undefined') return false
    const entries = Object.fromEntries(
      Object.entries(drafts)
        .filter(([, draft]) => draft.text.trim() || (draft.attachments?.length ?? 0) > 0)
        .map(([id, draft]) => [id, { text: draft.text, attachments: draft.attachments ?? [] }]),
    )
    if (Object.keys(entries).length > 0) window.sessionStorage.setItem(key, JSON.stringify(entries))
    else window.sessionStorage.removeItem(key)
    return true
  } catch {
    return false
  }
}
