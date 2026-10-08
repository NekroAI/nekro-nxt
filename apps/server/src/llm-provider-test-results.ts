import { createHash } from 'node:crypto'
import { parseJsonValue, type JsonValue, type LlmProviderTestResultSchema } from '@nekro-nxt/contracts'
import type { SystemSettingRecord } from '@nekro-nxt/storage-sqlite'
import { z } from 'zod'

export type LlmProviderTestResult = z.output<typeof LlmProviderTestResultSchema>

export interface LlmProviderTestResultRepository {
  getSystemSetting(key: string): SystemSettingRecord | undefined
  putSystemSetting(
    key: string,
    value: JsonValue,
    expectedRevision: number | undefined,
    updatedAt: number,
  ): SystemSettingRecord
}

/** The connection a test exercised. Only its digest is stored; the key itself never leaves this call. */
export interface LlmProviderConnection {
  readonly provider: string
  readonly baseURL?: string | undefined
  readonly api?: string | undefined
  readonly apiKey?: string | undefined
}

const SETTING_KEY_PREFIX = 'llm.provider-test.'
/** A few recent connections, so testing an unsaved draft does not erase the result of the saved one. */
const MAX_ENTRIES = 4
const MAX_MESSAGE_LENGTH = 160

const StoredEntrySchema = z
  .object({
    fingerprint: z.string().min(1),
    at: z.number().int().nonnegative(),
    ok: z.boolean(),
    message: z.string().optional(),
    model: z.string().min(1).optional(),
  })
  .strict()

const StoredSchema = z.object({ version: z.literal(1), entries: z.array(StoredEntrySchema) }).strict()

type StoredEntry = z.output<typeof StoredEntrySchema>

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')

/**
 * Identifies the address, protocol and API key a provider talks to. Any change gives a different value, which retires
 * earlier results. The key enters only as its own digest inside the hashed tuple.
 */
export function llmConnectionFingerprint(connection: LlmProviderConnection): string {
  return digest(
    JSON.stringify([
      connection.provider,
      connection.baseURL?.trim() || null,
      connection.api?.trim() || null,
      connection.apiKey ? digest(connection.apiKey) : null,
    ]),
  )
}

/** Keeps a failure reason short and free of the key that was tested. */
export function llmTestFailureMessage(cause: unknown, apiKey: string | undefined): string {
  let message = (cause instanceof Error ? cause.message : String(cause)).replace(/\s+/gu, ' ').trim()
  if (apiKey && message.includes(apiKey)) message = message.replaceAll(apiKey, '***')
  if (!message) message = '模型供应商连接测试失败。'
  return message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : message
}

/** Host-local record of provider connection tests, stored in the core database's system settings. */
export class LlmProviderTestResults {
  constructor(
    readonly repository: LlmProviderTestResultRepository,
    readonly now: () => number = Date.now,
  ) {}

  #read(provider: string): { readonly entries: readonly StoredEntry[]; readonly revision: number | undefined } {
    const record = this.repository.getSystemSetting(SETTING_KEY_PREFIX + provider)
    const parsed = StoredSchema.safeParse(record?.value)
    return { entries: parsed.success ? parsed.data.entries : [], revision: record?.revision }
  }

  record(
    connection: LlmProviderConnection,
    result: { readonly ok: boolean; readonly message?: string; readonly model?: string },
  ): LlmProviderTestResult {
    const fingerprint = llmConnectionFingerprint(connection)
    const at = this.now()
    const entry: StoredEntry = {
      fingerprint,
      at,
      ok: result.ok,
      ...(result.ok || result.message === undefined ? {} : { message: result.message }),
      ...(result.model ? { model: result.model } : {}),
    }
    const { entries, revision } = this.#read(connection.provider)
    const next = [entry, ...entries.filter((candidate) => candidate.fingerprint !== fingerprint)].slice(0, MAX_ENTRIES)
    this.repository.putSystemSetting(
      SETTING_KEY_PREFIX + connection.provider,
      parseJsonValue({ version: 1, entries: next }),
      revision,
      at,
    )
    return publicResult(entry)
  }

  /** The latest result for exactly this connection, or `null` when it was never tested. */
  latest(connection: LlmProviderConnection): LlmProviderTestResult | null {
    const fingerprint = llmConnectionFingerprint(connection)
    const entry = this.#read(connection.provider).entries.find((candidate) => candidate.fingerprint === fingerprint)
    return entry ? publicResult(entry) : null
  }

  forget(provider: string): void {
    const { entries, revision } = this.#read(provider)
    if (entries.length === 0) return
    this.repository.putSystemSetting(
      SETTING_KEY_PREFIX + provider,
      parseJsonValue({ version: 1, entries: [] }),
      revision,
      this.now(),
    )
  }
}

const publicResult = (entry: StoredEntry): LlmProviderTestResult => ({
  at: entry.at,
  ok: entry.ok,
  ...(entry.message === undefined ? {} : { message: entry.message }),
  ...(entry.model === undefined ? {} : { model: entry.model }),
})
