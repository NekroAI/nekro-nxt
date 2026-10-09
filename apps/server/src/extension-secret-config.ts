import { configSecretKeys, type ExtensionConfigLayer, type JsonValue } from '@nekro-nxt/contracts'
import { layerConfigSchema, type ExtensionManifest } from '@nekro-nxt/extension-runtime'

const asRecord = (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> =>
  value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value) ? value : {}

const secretKeys = (manifest: ExtensionManifest | undefined, layer: ExtensionConfigLayer): readonly string[] =>
  manifest === undefined ? [] : configSecretKeys(layerConfigSchema(manifest, layer))

/** Client view of one layer's configuration: secret references never leave the Host. */
export const maskExtensionSecrets = (
  manifest: ExtensionManifest | undefined,
  layer: ExtensionConfigLayer,
  config: JsonValue,
): { readonly config: JsonValue; readonly configuredSecrets?: readonly string[] } => {
  const keys = secretKeys(manifest, layer)
  if (keys.length === 0) return { config }
  const record = asRecord(config)
  return {
    config: Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key))),
    configuredSecrets: keys.filter((key) => typeof record[key] === 'string' && record[key] !== ''),
  }
}

export interface CredentialWriter {
  save(secret: string): Promise<string>
  delete(reference: string): Promise<void>
}

/**
 * Merges a client config with stored and newly typed secrets, then runs `commit`. New credentials are deleted when
 * the commit fails; replaced ones only after it succeeds, so a failed save never loses the working credential.
 */
export const commitExtensionConfigWithSecrets = async <Result>(input: {
  readonly manifest: ExtensionManifest | undefined
  readonly layer: ExtensionConfigLayer
  readonly previous: JsonValue | undefined
  readonly config: JsonValue
  readonly secrets: Readonly<Record<string, string>> | undefined
  readonly credentials: CredentialWriter
  readonly commit: (config: JsonValue) => Promise<Result>
}): Promise<Result> => {
  const keys = secretKeys(input.manifest, input.layer)
  const previous = asRecord(input.previous)
  const unknown = Object.keys(input.secrets ?? {}).filter((key) => !keys.includes(key))
  if (unknown.length > 0) throw new TypeError(`这些字段不是凭据字段：${unknown.join('、')}`)
  const created: Record<string, string> = {}
  try {
    for (const key of keys) {
      const draft = input.secrets?.[key]?.trim()
      if (draft) created[key] = await input.credentials.save(draft)
    }
    const kept = Object.fromEntries(
      keys.flatMap((key) =>
        created[key] === undefined && typeof previous[key] === 'string' ? [[key, previous[key]] as const] : [],
      ),
    )
    const publicConfig = Object.fromEntries(
      Object.entries(asRecord(input.config)).filter(([key]) => !keys.includes(key)),
    )
    const result = await input.commit({ ...publicConfig, ...kept, ...created })
    await Promise.allSettled(
      Object.keys(created).flatMap((key) => {
        const replaced = previous[key]
        return typeof replaced === 'string' ? [input.credentials.delete(replaced)] : []
      }),
    )
    return result
  } catch (error) {
    await Promise.allSettled(Object.values(created).map((reference) => input.credentials.delete(reference)))
    throw error
  }
}
