import type { ChannelDraft } from './channel-drafts.js'

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
      Object.entries(value).flatMap(([id, text]) =>
        typeof text === 'string' && text.trim() ? [[id, { text, revision: 0 }]] : [],
      ),
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
        .filter(([, draft]) => draft.text.trim())
        .map(([id, draft]) => [id, draft.text]),
    )
    if (Object.keys(entries).length > 0) window.sessionStorage.setItem(key, JSON.stringify(entries))
    else window.sessionStorage.removeItem(key)
    return true
  } catch {
    return false
  }
}
