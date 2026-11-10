import { z } from 'zod'
import { JsonValueSchema, type JsonValue } from '@nekro-nxt/contracts'
import type { SystemSettingRecord } from '@nekro-nxt/storage-sqlite'

const ACCESS_SETTING_KEY = 'access'

const StoredAccessSchema = z.object({ version: z.literal(1), publicOrigin: z.url().optional() }).strict()

interface AccessSettingsRepository {
  getSystemSetting(key: string): SystemSettingRecord | undefined
  putSystemSetting(
    key: string,
    value: JsonValue,
    expectedRevision: number | undefined,
    updatedAt: number,
  ): SystemSettingRecord
}

/** The address people open this instance at from elsewhere, e.g. `https://nxt.example.com`; only the origin. */
export const normalizePublicOrigin = (raw: string): string => {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new TypeError('访问地址要写完整，例如 https://nxt.example.com。')
  }
  if (url.protocol !== 'https:') throw new TypeError('访问地址要以 https:// 开头。')
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new TypeError('访问地址只写协议和域名（可以带端口），不要带路径或参数。')
  }
  return url.origin
}

/** How this instance is reached from outside. Stored with the other system settings. */
export class AccessSettings {
  readonly #repository: AccessSettingsRepository
  readonly #now: () => number

  constructor(repository: AccessSettingsRepository, now: () => number = Date.now) {
    this.#repository = repository
    this.#now = now
  }

  publicOrigin(): string | undefined {
    const record = this.#repository.getSystemSetting(ACCESS_SETTING_KEY)
    return record === undefined ? undefined : StoredAccessSchema.parse(record.value).publicOrigin
  }

  /** `undefined` clears the address. */
  setPublicOrigin(raw: string | undefined): string | undefined {
    const publicOrigin = raw === undefined || raw.trim() === '' ? undefined : normalizePublicOrigin(raw)
    const record = this.#repository.getSystemSetting(ACCESS_SETTING_KEY)
    this.#repository.putSystemSetting(
      ACCESS_SETTING_KEY,
      JsonValueSchema.parse({ version: 1, ...(publicOrigin === undefined ? {} : { publicOrigin }) }),
      record?.revision,
      this.#now(),
    )
    return publicOrigin
  }
}
