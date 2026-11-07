/** An upload prepared this recently may be about to be referenced, so 「彻底清除」 keeps its Asset. */
export const HISTORY_PURGE_PREPARED_GRACE_MS = 10 * 60 * 1000

export interface ChannelHistoryPurgeView {
  readonly messages: number
  readonly conversations: number
  readonly attachments: number
  readonly blockedReason?: string
}

export interface ChannelHistoryPurgeOutcome {
  readonly messages: number
  readonly conversations: number
  /** Attachments removed because nothing else used them. */
  readonly attachments: number
}

/** 「彻底清除」 cannot run now; the message says what to wait for. */
export class ChannelHistoryPurgeRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChannelHistoryPurgeRefusedError'
  }
}
