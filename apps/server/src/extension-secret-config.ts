import { configSecretKeys, type CredentialId, type ExtensionConfigLayer, type JsonValue } from '@nekro-nxt/contracts'
import { layerConfigSchema, type ExtensionManifest } from '@nekro-nxt/extension-runtime'
import { namedCredentialId, namedCredentialReference } from './credentials-library.js'

const asRecord = (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> =>
  value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value) ? value : {}

const secretKeys = (manifest: ExtensionManifest | undefined, layer: ExtensionConfigLayer): readonly string[] =>
  manifest === undefined ? [] : configSecretKeys(layerConfigSchema(manifest, layer))

/**
 * Client view of one layer's configuration: store references never leave the Host. Fields bound to a named credential
 * are listed with the credential's id.
 */
export const maskExtensionSecrets = (
  manifest: ExtensionManifest | undefined,
  layer: ExtensionConfigLayer,
  config: JsonValue,
): {
  readonly config: JsonValue
  readonly configuredSecrets?: readonly string[]
  readonly boundCredentials?: Readonly<Record<string, CredentialId>>
} => {
  const keys = secretKeys(manifest, layer)
  if (keys.length === 0) return { config }
  const record = asRecord(config)
  const bound = Object.fromEntries(
    keys.flatMap((key) => {
      const id = namedCredentialId(record[key])
      return id === undefined ? [] : [[key, id] as const]
    }),
  )
  return {
    config: Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key))),
    configuredSecrets: keys.filter((key) => typeof record[key] === 'string' && record[key] !== ''),
    ...(Object.keys(bound).length === 0 ? {} : { boundCredentials: bound }),
  }
}

/** Store references a configuration owns; bindings to named credentials belong to the credential library. */
const ownedReference = (value: JsonValue | undefined): string | undefined =>
  typeof value === 'string' && namedCredentialId(value) === undefined ? value : undefined

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
  /** Fields to bind to a named credential (`null` clears the field); a field takes a typed value or a binding. */
  readonly bindings?: Readonly<Record<string, CredentialId | null>> | undefined
  /** Whether the credential exists; bindings to unknown credentials are rejected. */
  readonly credentialExists?: (id: CredentialId) => boolean
  readonly credentials: CredentialWriter
  readonly commit: (config: JsonValue) => Promise<Result>
}): Promise<Result> => {
  const keys = secretKeys(input.manifest, input.layer)
  const previous = asRecord(input.previous)
  const bindings = input.bindings ?? {}
  const unknown = [...Object.keys(input.secrets ?? {}), ...Object.keys(bindings)].filter((key) => !keys.includes(key))
  if (unknown.length > 0) throw new TypeError(`这些字段不是凭据字段：${[...new Set(unknown)].join('、')}`)
  const both = Object.keys(bindings).filter((key) => input.secrets?.[key]?.trim())
  if (both.length > 0) throw new TypeError(`这些字段同时填写了值和绑定的凭据：${both.join('、')}`)
  for (const id of Object.values(bindings)) {
    if (id !== null && input.credentialExists?.(id) !== true) throw new TypeError('绑定的凭据已不存在，请刷新后重试。')
  }
  const created: Record<string, string> = {}
  try {
    for (const key of keys) {
      const draft = input.secrets?.[key]?.trim()
      if (draft) created[key] = await input.credentials.save(draft)
    }
    const bound = Object.fromEntries(
      Object.entries(bindings).flatMap(([key, id]) =>
        id === null ? [] : [[key, namedCredentialReference(id)] as const],
      ),
    )
    const kept = Object.fromEntries(
      keys.flatMap((key) =>
        created[key] === undefined && !Object.hasOwn(bindings, key) && typeof previous[key] === 'string'
          ? [[key, previous[key]] as const]
          : [],
      ),
    )
    const publicConfig = Object.fromEntries(
      Object.entries(asRecord(input.config)).filter(([key]) => !keys.includes(key)),
    )
    const result = await input.commit({ ...publicConfig, ...kept, ...created, ...bound })
    // Typed values the new value or binding replaced are no longer referenced by anything.
    await Promise.allSettled(
      [...Object.keys(created), ...Object.keys(bindings)].flatMap((key) => {
        const replaced = ownedReference(previous[key])
        return replaced === undefined ? [] : [input.credentials.delete(replaced)]
      }),
    )
    return result
  } catch (error) {
    await Promise.allSettled(Object.values(created).map((reference) => input.credentials.delete(reference)))
    throw error
  }
}
