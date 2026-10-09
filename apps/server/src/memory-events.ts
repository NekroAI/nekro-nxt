/** What the agent remembered, looked up or did not get to see; shown to the admin, never to the model. */
export type MemoryEventData =
  | {
      readonly kind: 'backlog-folded'
      readonly admissionId: string
      readonly foldedCount: number
      readonly shownCount: number
      readonly foldedImageCount: number
    }
  | {
      readonly kind: 'history-search'
      readonly query: string
      readonly hits: number
      readonly sender?: string
      readonly since?: number
      readonly until?: number
    }
  | { readonly kind: 'notes-updated'; readonly revision: number; readonly chars: number }
  | { readonly kind: 'idle-review'; readonly quietMinutes: number }

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'nekro-nxt/memory': MemoryEventData
  }
}
