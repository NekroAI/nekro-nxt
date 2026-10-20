import { z } from 'zod'
import type { JsonValue } from '@nekro-nxt/contracts'
import type { NxtModelOption } from '@nekro-nxt/extension-sdk'
import type { SystemSettingRecord } from '@nekro-nxt/storage-sqlite'

const SETTING_KEY = 'model-provider-access'

const StoredSchema = z.object({ version: z.literal(1), open: z.array(z.string()) }).strict()

interface SettingsRepository {
  getSystemSetting(key: string): SystemSettingRecord | undefined
  putSystemSetting(
    key: string,
    value: JsonValue,
    expectedRevision: number | undefined,
    updatedAt: number,
  ): SystemSettingRecord
}

/**
 * Which model providers agents and extensions may call through the host (智能体扩展配置与凭据 C4). The first start with
 * this setting opens every provider configured at that moment, so existing setups keep working; providers added
 * afterwards stay closed until someone opens them. Keys never leave the host either way.
 */
export class ModelProviderAccess {
  readonly #repository: SettingsRepository
  readonly #now: () => number
  #open = new Set<string>()

  constructor(repository: SettingsRepository, now: () => number = Date.now) {
    this.#repository = repository
    this.#now = now
  }

  /** Reads the setting, recording `current` as open the first time. */
  async prepare(current: () => Promise<readonly string[]>): Promise<void> {
    const record = this.#repository.getSystemSetting(SETTING_KEY)
    const parsed = record === undefined ? undefined : StoredSchema.safeParse(record.value)
    if (parsed?.success) {
      this.#open = new Set(parsed.data.open)
      return
    }
    // A missing or unreadable setting is the first start: what is configured now stays usable.
    this.#write([...new Set(await current())], record?.revision)
  }

  isOpen(provider: string): boolean {
    return this.#open.has(provider)
  }

  set(provider: string, open: boolean): void {
    const next = new Set(this.#open)
    if (open) next.add(provider)
    else next.delete(provider)
    this.#write([...next], this.#repository.getSystemSetting(SETTING_KEY)?.revision)
  }

  #write(open: readonly string[], revision: number | undefined): void {
    this.#repository.putSystemSetting(SETTING_KEY, { version: 1, open: [...open].sort() }, revision, this.#now())
    this.#open = new Set(open)
  }
}

/** What `openModelOptions` reads from the model settings. */
export interface ModelCatalog {
  getLlmProviderSettings(): Promise<{
    readonly providers: readonly {
      readonly provider: string
      readonly active: boolean
      readonly credential?: { readonly configured: boolean }
    }[]
  }>
  listAvailableLlmModels(): Promise<
    readonly {
      readonly provider: string
      readonly providerName: string
      readonly id: string
      readonly name: string
      readonly inputModalities?: readonly string[]
    }[]
  >
}

/**
 * Models extensions may call through `nxt.models`: of providers that can answer (active and, when they take a key,
 * with one set) and are open to agents and extensions.
 */
export const openModelOptions = async (
  catalog: ModelCatalog,
  access: Pick<ModelProviderAccess, 'isOpen'>,
): Promise<NxtModelOption[]> => {
  const usable = new Set(
    (await catalog.getLlmProviderSettings()).providers
      .filter(
        (provider) => provider.active && provider.credential?.configured !== false && access.isOpen(provider.provider),
      )
      .map((provider) => provider.provider),
  )
  return (await catalog.listAvailableLlmModels())
    .filter((model) => usable.has(model.provider))
    .map((model) => ({
      ref: `${model.provider}:${model.id}`,
      provider: model.provider,
      providerName: model.providerName,
      model: model.id,
      name: model.name,
      vision: model.inputModalities?.includes('image') === true,
    }))
}
