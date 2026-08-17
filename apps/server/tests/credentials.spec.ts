import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalCredentialStore } from '../src/credentials.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('LocalCredentialStore', () => {
  it('atomically stores an opaque reference with private permissions and resolves it after reconstruction', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-credentials-'))
    temporaryDirectories.push(directory)
    const root = path.join(directory, 'credentials')
    const reference = await new LocalCredentialStore(root).save('real-test-secret')

    expect(reference).toMatch(/^credential:local:[a-f0-9]{32}$/u)
    expect((await stat(root)).mode & 0o777).toBe(0o700)
    const files = await import('node:fs/promises').then(({ readdir }) => readdir(root))
    expect(files).toHaveLength(1)
    expect((await stat(path.join(root, files[0]!))).mode & 0o777).toBe(0o600)
    expect(await readFile(path.join(root, files[0]!), 'utf8')).toBe('real-test-secret')
    expect(await new LocalCredentialStore(root).resolve(reference)).toBe('real-test-secret')
  })

  it('rejects forged references and deletes a committed credential', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-credentials-'))
    temporaryDirectories.push(directory)
    const store = new LocalCredentialStore(path.join(directory, 'credentials'))
    const reference = await store.save('secret')
    await expect(store.resolve('../outside')).rejects.toThrow('Invalid local credential reference')
    await store.delete(reference)
    await expect(store.resolve(reference)).rejects.toThrow('unavailable')
  })
})
