export interface ChannelAttachment {
  /** Each selection is distinct, even when content-addressed assets are identical. */
  readonly id: string
  readonly name: string
  readonly byteSize: number
  readonly mediaType: string
  readonly partType: 'image' | 'file'
  readonly status: 'uploading' | 'failed' | 'ready' | 'removing'
  readonly assetId?: string
  readonly error?: string
  /** Memory only. Recovery keeps metadata but never serializes browser files. */
  readonly file?: File
}
export type ReadyChannelAttachment = ChannelAttachment & { readonly assetId: string }
export interface ChannelDraft {
  readonly text: string
  readonly revision: number
  readonly pending?: number
  readonly attachments?: readonly ChannelAttachment[]
}
export const EMPTY_CHANNEL_DRAFT: ChannelDraft = Object.freeze({ text: '', revision: 0 })
export const isReadyAttachment = (item: ChannelAttachment): item is ReadyChannelAttachment =>
  item.status === 'ready' && Boolean(item.assetId)
export interface ChannelDraftState {
  readonly channelDrafts: Readonly<Record<string, ChannelDraft>>
  setChannelDraft(id: string, text: string): void
  setChannelAttachments(id: string, attachments: readonly ChannelAttachment[]): void
  beginChannelSend(
    id: string,
  ): { text: string; attachments: readonly ReadyChannelAttachment[]; revision: number; request: number } | undefined
  finishChannelSend(id: string, revision: number, request: number, success: boolean): void
  retainChannelDrafts(ids: ReadonlySet<string>): void
}
export function createChannelDraftState(
  set: (update: (state: ChannelDraftState) => Partial<ChannelDraftState>) => void,
  get: () => ChannelDraftState,
): ChannelDraftState {
  let request = 0
  const sends = new Map<number, { text: string; attachments: readonly ChannelAttachment[] }>()
  return {
    channelDrafts: {},
    setChannelDraft: (id, text) =>
      set((state) => {
        const old = state.channelDrafts[id] ?? EMPTY_CHANNEL_DRAFT
        if (old.text === text) return state
        return { channelDrafts: { ...state.channelDrafts, [id]: { ...old, text, revision: old.revision + 1 } } }
      }),
    setChannelAttachments: (id, attachments) =>
      set((state) => {
        const old = state.channelDrafts[id] ?? EMPTY_CHANNEL_DRAFT
        if (old.pending !== undefined) return state
        return { channelDrafts: { ...state.channelDrafts, [id]: { ...old, attachments, revision: old.revision + 1 } } }
      }),
    beginChannelSend: (id) => {
      const old = get().channelDrafts[id] ?? EMPTY_CHANNEL_DRAFT
      const attachments = old.attachments ?? []
      if (
        (!old.text.trim() && !attachments.length) ||
        old.pending !== undefined ||
        !attachments.every(isReadyAttachment)
      )
        return undefined
      const token = { text: old.text.trim(), attachments, revision: old.revision, request: ++request }
      sends.set(token.request, { text: old.text, attachments })
      set((state) => ({ channelDrafts: { ...state.channelDrafts, [id]: { ...old, pending: token.request } } }))
      return token
    },
    finishChannelSend: (id, _revision, pending, success) => {
      const sent = sends.get(pending)
      sends.delete(pending)
      set((state) => {
        const old = state.channelDrafts[id]
        if (!old || old.pending !== pending) return state
        const sentIds = new Set(success ? sent?.attachments.map((item) => item.id) : [])
        const next: ChannelDraft = {
          text: success && old.text === sent?.text ? '' : old.text,
          revision: old.revision,
          ...(old.attachments ? { attachments: old.attachments.filter((item) => !sentIds.has(item.id)) } : {}),
        }
        return { channelDrafts: { ...state.channelDrafts, [id]: next } }
      })
    },
    retainChannelDrafts: (ids) =>
      set((state) => {
        if (Object.keys(state.channelDrafts).every((id) => ids.has(id))) return state
        return { channelDrafts: Object.fromEntries(Object.entries(state.channelDrafts).filter(([id]) => ids.has(id))) }
      }),
  }
}
