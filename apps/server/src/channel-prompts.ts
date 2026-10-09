import {
  EXTENSION_CONTEXT_DYNAMIC_MAX_CHARS,
  promptDocumentFromText,
  promptDocumentPlainText,
  type ChannelId,
  type ChannelPromptView,
  type PromptDocumentV1,
} from '@nekro-nxt/contracts'
import type {
  ChannelPromptAuthor,
  ChannelPromptKind,
  ChannelPromptRecord,
  ChannelPromptRevisionRecord,
} from '@nekro-nxt/storage-sqlite'

/**
 * Plain-text length each part may reach. Instructions sit in every request of the channel; notes join the runtime
 * context snapshot, so they share the per-contribution cap extensions' dynamic context has.
 */
export const CHANNEL_PROMPT_MAX_CHARS: Readonly<Record<ChannelPromptKind, number>> = {
  instructions: 4000,
  notes: EXTENSION_CONTEXT_DYNAMIC_MAX_CHARS,
}

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
  getChannelPrompt(channelId: ChannelId, kind: ChannelPromptKind): ChannelPromptRecord | undefined
  saveChannelPrompt(input: {
    readonly channelId: ChannelId
    readonly kind: ChannelPromptKind
    readonly document: PromptDocumentV1
    readonly locked: boolean
    readonly updatedBy: ChannelPromptAuthor
    readonly updatedAt: number
    readonly expectedRevision: number
  }): ChannelPromptRecord
  listChannelPromptRevisions(channelId: ChannelId, kind: ChannelPromptKind): readonly ChannelPromptRevisionRecord[]
}

const assertLength = (kind: ChannelPromptKind, document: PromptDocumentV1): void => {
  const length = promptDocumentPlainText(document).length
  const max = CHANNEL_PROMPT_MAX_CHARS[kind]
  if (length > max) {
    throw new ChannelPromptError(
      `${kind === 'instructions' ? '频道说明' : '频道笔记'}最多 ${max} 字，当前 ${length} 字。`,
      'too-long',
    )
  }
}

/**
 * What the agent answering a channel reads about it. The admin's instructions carry references and stay in the
 * system prompt; the agent's own notes are plain text in the runtime context, so its frequent edits never disturb
 * the cached prompt prefix (Decision 2026-10-07 §8).
 */
export class ChannelPrompts {
  readonly #repository: ChannelPromptRepository
  readonly #now: () => number

  constructor(repository: ChannelPromptRepository, now: () => number = Date.now) {
    this.#repository = repository
    this.#now = now
  }

  current(channelId: ChannelId, kind: ChannelPromptKind): ChannelPromptRecord | undefined {
    const record = this.#repository.getChannelPrompt(channelId, kind)
    return record === undefined || record.document.segments.length === 0 ? undefined : record
  }

  view(channelId: ChannelId): ChannelPromptView {
    const part = (kind: ChannelPromptKind) => {
      const record = this.#repository.getChannelPrompt(channelId, kind)
      return {
        document: record?.document ?? { version: 1 as const, segments: [] },
        locked: record?.locked ?? false,
        revision: record?.revision ?? 0,
        maxChars: CHANNEL_PROMPT_MAX_CHARS[kind],
        ...(record === undefined ? {} : { updatedBy: record.updatedBy, updatedAt: record.updatedAt }),
        revisions: this.#repository.listChannelPromptRevisions(channelId, kind).map((revision) => ({ ...revision })),
      }
    }
    return { instructions: part('instructions'), notes: part('notes') }
  }

  saveByAdmin(input: {
    readonly channelId: ChannelId
    readonly kind: ChannelPromptKind
    readonly document: PromptDocumentV1
    readonly locked: boolean
    readonly expectedRevision: number
  }): ChannelPromptView {
    assertLength(input.kind, input.document)
    if (input.kind === 'notes' && input.document.segments.some((segment) => segment.type === 'reference')) {
      throw new ChannelPromptError('频道笔记只能是纯文本。', 'has-references')
    }
    this.#repository.saveChannelPrompt({
      ...input,
      // Only notes can be locked: instructions are the admin's alone.
      locked: input.kind === 'notes' && input.locked,
      updatedBy: 'admin',
      updatedAt: this.#now(),
    })
    return this.view(input.channelId)
  }

  /** The agent replaces its whole notes with plain text; an empty text clears them. */
  updateNotesByAgent(channelId: ChannelId, text: string): ChannelPromptRecord {
    const current = this.#repository.getChannelPrompt(channelId, 'notes')
    if (current?.locked === true) {
      throw new ChannelPromptError('管理员已锁定本频道的笔记，不能修改。', 'locked')
    }
    const document = promptDocumentFromText(text.trim())
    assertLength('notes', document)
    if (current !== undefined && JSON.stringify(current.document) === JSON.stringify(document)) return current
    return this.#repository.saveChannelPrompt({
      channelId,
      kind: 'notes',
      document,
      locked: false,
      updatedBy: 'agent',
      updatedAt: this.#now(),
      expectedRevision: current?.revision ?? 0,
    })
  }
}
