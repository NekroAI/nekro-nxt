export interface ChannelAttachment {
  readonly assetId: string
  readonly name: string
  readonly mediaType: string
  readonly partType: 'image' | 'file'
}
export interface ChannelDraft {
  readonly text: string
  readonly revision: number
  readonly pending?: number
  readonly attachments?: readonly ChannelAttachment[]
}
export const EMPTY_CHANNEL_DRAFT: ChannelDraft = Object.freeze({ text: '', revision: 0 })
export interface ChannelDraftState {
  readonly channelDrafts: Readonly<Record<string, ChannelDraft>>
  setChannelDraft(id: string, text: string): void
  setChannelAttachments(id: string, attachments: readonly ChannelAttachment[]): void
  beginChannelSend(
    id: string,
  ): { text: string; attachments: readonly ChannelAttachment[]; revision: number; request: number } | undefined
  finishChannelSend(id: string, revision: number, request: number, success: boolean): void
  retainChannelDrafts(ids: ReadonlySet<string>): void
}
export function createChannelDraftState(
  set: (update: (state: ChannelDraftState) => Partial<ChannelDraftState>) => void,
  get: () => ChannelDraftState,
): ChannelDraftState {
  let request = 0
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
        return {
          channelDrafts: {
            ...state.channelDrafts,
            [id]: { ...old, attachments, revision: old.revision + 1 },
          },
        }
      }),
    beginChannelSend: (id) => {
      const old = get().channelDrafts[id] ?? EMPTY_CHANNEL_DRAFT
      if ((!old.text.trim() && (old.attachments?.length ?? 0) === 0) || old.pending !== undefined) return undefined
      const token = {
        text: old.text.trim(),
        attachments: old.attachments ?? [],
        revision: old.revision,
        request: ++request,
      }
      set((state) => ({ channelDrafts: { ...state.channelDrafts, [id]: { ...old, pending: token.request } } }))
      return token
    },
    finishChannelSend: (id, revision, pending, success) =>
      set((state) => {
        const old = state.channelDrafts[id]
        if (!old || old.pending !== pending) return state
        const next: ChannelDraft = {
          text: success && old.revision === revision ? '' : old.text,
          revision: old.revision,
          ...(success && old.revision === revision
            ? { attachments: [] }
            : old.attachments
              ? { attachments: old.attachments }
              : {}),
        }
        return { channelDrafts: { ...state.channelDrafts, [id]: next } }
      }),
    retainChannelDrafts: (ids) =>
      set((state) => {
        if (Object.keys(state.channelDrafts).every((id) => ids.has(id))) return state
        return { channelDrafts: Object.fromEntries(Object.entries(state.channelDrafts).filter(([id]) => ids.has(id))) }
      }),
  }
}
