import LocalCredentialProvider, { parseCredentialsDocument } from '@deepseek-ai/dsh-credentials-local'
import { readFile } from 'node:fs/promises'
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

const observeRecord = (record: CredentialRecord | undefined, remember: (value: string) => void): void => {
  if (record?.kind === 'api-key') {
    if (record.key) remember(record.key)
    for (const value of Object.values(record.env ?? {})) remember(value)
  } else if (record?.kind === 'grant') {
    for (const value of grantSecrets(record.payload)) remember(value)
  }
}

/** Observe values as they pass through the public provider: saved, resolved, read or rotated. */
export function observedCredentialProvider(observe: (value: string) => void): typeof LocalCredentialProvider {
  const remember = (value: string): void => {
    try {
      observe(value)
    } catch {
      /* Diagnostics cannot change credential behavior. */
    }
  }
  const rememberRecord = (record: CredentialRecord | undefined): void => observeRecord(record, remember)
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

/**
 * Report every value already stored in the DSH credential document, so model keys are hidden before a request first
 * resolves them. Values from the process environment or `.env` fallbacks are only seen when resolved. A missing or
 * unparsable document reports nothing; the provider surfaces its own errors.
 */
export async function preloadCredentialDocument(filename: string, observe: (value: string) => void): Promise<void> {
  let document
  try {
    document = parseCredentialsDocument(await readFile(filename, 'utf8'), filename)
  } catch {
    return
  }
  for (const value of document.refs.values()) observe(value)
  for (const record of document.records.values()) observeRecord(record, observe)
}
