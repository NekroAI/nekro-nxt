import {
  promptDocumentFromText,
  promptDocumentPlainText,
  type ChannelId,
  type ChannelPromptView,
  type PromptDocumentV1,
} from '@nekro-nxt/contracts'
import type { ChannelPromptAuthor, ChannelPromptRecord, ChannelPromptRevisionRecord } from '@nekro-nxt/storage-sqlite'

/** Plain-text length a channel prompt may reach; it is in every request of that channel. */
export const CHANNEL_PROMPT_MAX_CHARS = 4000

export class ChannelPromptError extends Error {
  constructor(
    message: string,
    readonly code: 'too-long' | 'locked' | 'has-references',
  ) {
    super(message)
    this.name = 'ChannelPromptError'
  }
}

export interface ChannelPromptRepository {
  getChannelPrompt(channelId: ChannelId): ChannelPromptRecord | undefined
  saveChannelPrompt(input: {
    readonly channelId: ChannelId
    readonly document: PromptDocumentV1
    readonly locked: boolean
    readonly updatedBy: ChannelPromptAuthor
    readonly updatedAt: number
    readonly expectedRevision: number
  }): ChannelPromptRecord
  listChannelPromptRevisions(channelId: ChannelId): readonly ChannelPromptRevisionRecord[]
}

const assertLength = (document: PromptDocumentV1): void => {
  const length = promptDocumentPlainText(document).length
  if (length > CHANNEL_PROMPT_MAX_CHARS) {
    throw new ChannelPromptError(`频道说明最多 ${CHANNEL_PROMPT_MAX_CHARS} 字，当前 ${length} 字。`, 'too-long')
  }
}

/**
 * Channel-specific instructions for whoever answers a channel. Admins write them with references; the agent may
 * rewrite them as plain text unless an admin locked them or they carry references the agent cannot reproduce.
 */
export class ChannelPrompts {
  readonly #repository: ChannelPromptRepository
  readonly #now: () => number

  constructor(repository: ChannelPromptRepository, now: () => number = Date.now) {
    this.#repository = repository
    this.#now = now
  }

  current(channelId: ChannelId): ChannelPromptRecord | undefined {
    const record = this.#repository.getChannelPrompt(channelId)
    return record === undefined || record.document.segments.length === 0 ? undefined : record
  }

  view(channelId: ChannelId): ChannelPromptView {
    const record = this.#repository.getChannelPrompt(channelId)
    return {
      document: record?.document ?? { version: 1, segments: [] },
      locked: record?.locked ?? false,
      revision: record?.revision ?? 0,
      maxChars: CHANNEL_PROMPT_MAX_CHARS,
      ...(record === undefined ? {} : { updatedBy: record.updatedBy, updatedAt: record.updatedAt }),
      revisions: this.#repository.listChannelPromptRevisions(channelId).map((revision) => ({ ...revision })),
    }
  }

  saveByAdmin(input: {
    readonly channelId: ChannelId
    readonly document: PromptDocumentV1
    readonly locked: boolean
    readonly expectedRevision: number
  }): ChannelPromptView {
    assertLength(input.document)
    this.#repository.saveChannelPrompt({ ...input, updatedBy: 'admin', updatedAt: this.#now() })
    return this.view(input.channelId)
  }

  /** The agent replaces the whole prompt with plain text; an empty text clears it. */
  updateByAgent(channelId: ChannelId, text: string): ChannelPromptRecord {
    const current = this.#repository.getChannelPrompt(channelId)
    if (current?.locked === true) {
      throw new ChannelPromptError('管理员已锁定本频道的说明，不能修改。', 'locked')
    }
    if (current?.document.segments.some((segment) => segment.type === 'reference') === true) {
      throw new ChannelPromptError(
        '本频道说明里有管理员插入的成员、频道或扩展引用，智能体不能改写；需要修改时请告知管理员。',
        'has-references',
      )
    }
    const document = promptDocumentFromText(text.trim())
    assertLength(document)
    return this.#repository.saveChannelPrompt({
      channelId,
      document,
      locked: false,
      updatedBy: 'agent',
      updatedAt: this.#now(),
      expectedRevision: current?.revision ?? 0,
    })
  }
}
