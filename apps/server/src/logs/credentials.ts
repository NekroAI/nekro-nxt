import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import type { CredentialKey, CredentialRecord, CredentialRef } from '@deepseek-ai/dsh-credentials'

/** Grant payloads are owner-defined JSON; any long string in one may be a token. */
const grantSecrets = (value: unknown, found: string[] = []): string[] => {
  if (typeof value === 'string') {
    if (value.length >= 20) found.push(value)
  } else if (Array.isArray(value)) {
    for (const item of value) grantSecrets(item, found)
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) grantSecrets(item, found)
  }
  return found
}

/** Observe only values used through the public provider; never enumerate or read the credential file for logs. */
export function observedCredentialProvider(observe: (value: string) => void): typeof LocalCredentialProvider {
  const remember = (value: string): void => {
    try {
      observe(value)
    } catch {
      /* Diagnostics cannot change credential behavior. */
    }
  }
  const rememberRecord = (record: CredentialRecord | undefined): void => {
    if (record?.kind === 'api-key') {
      if (record.key) remember(record.key)
      for (const value of Object.values(record.env ?? {})) remember(value)
    } else if (record?.kind === 'grant') {
      for (const value of grantSecrets(record.payload)) remember(value)
    }
  }
  return class ObservedLocalCredentialProvider extends LocalCredentialProvider {
    override async resolve(ref: CredentialRef) {
      const resolved = await super.resolve(ref)
      if (resolved) remember(resolved.value)
      return resolved
    }
    override set(ref: CredentialRef, value: string) {
      remember(value)
      return super.set(ref, value)
    }
    override async readRecord(key: CredentialKey) {
      const record = await super.readRecord(key)
      rememberRecord(record)
      return record
    }
    override async modifyRecord(
      key: CredentialKey,
      mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
    ) {
      const record = await super.modifyRecord(key, async (current) => {
        rememberRecord(current)
        return mutate(current)
      })
      rememberRecord(record)
      return record
    }
  }
}
