import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import type { CredentialKey, CredentialRef } from '@deepseek-ai/dsh-credentials'

/** Observe only values used through the public provider; never enumerate or read the credential file for logs. */
export function observedCredentialProvider(observe: (value: string) => void): typeof LocalCredentialProvider {
  const remember = (value: string): void => {
    try {
      observe(value)
    } catch {
      /* Diagnostics cannot change credential behavior. */
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
      if (record?.kind === 'api-key') {
        if (record.key) remember(record.key)
        for (const value of Object.values(record.env ?? {})) remember(value)
      }
      return record
    }
  }
}
