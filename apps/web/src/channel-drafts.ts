export interface ChannelDraft {
  readonly text: string
  readonly revision: number
  readonly pending?: number
}
export const EMPTY_CHANNEL_DRAFT: ChannelDraft = Object.freeze({ text: '', revision: 0 })
export interface ChannelDraftState {
  readonly channelDrafts: Readonly<Record<string, ChannelDraft>>
  setChannelDraft(id: string, text: string): void
  beginChannelSend(id: string): { text: string; revision: number; request: number } | undefined
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
    beginChannelSend: (id) => {
      const old = get().channelDrafts[id]
      if (!old?.text.trim() || old.pending !== undefined) return undefined
      const token = { text: old.text.trim(), revision: old.revision, request: ++request }
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
