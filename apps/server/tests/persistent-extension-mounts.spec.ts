import { AgentIdSchema, ExtensionIdSchema, ExtensionRevisionIdSchema } from '@nekro-nxt/contracts'
import { extensionManifestSchema, type Revision } from '@nekro-nxt/extension-runtime'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { PersistentExtensionMounts } from '../src/persistent-extension-mounts.js'
import { SessionRegistry } from '../src/session-registry.js'

it('rejects duplicate live instances and retains RPC after disabling an attachment', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nxt-extension-mount-'))
  const mounts = new PersistentExtensionMounts(new SessionRegistry())
  const agentId = AgentIdSchema.parse('agt_FIXTURE')
  const revision: Revision = {
    id: ExtensionRevisionIdSchema.parse('xrv_FIXTURE'),
    extensionId: ExtensionIdSchema.parse('ext_FIXTURE'),
    revisionNumber: 1,
    contentDigest: 'a'.repeat(64),
    payloadDigest: 'b'.repeat(64),
    createdAt: 1,
  }
  const hostEntry = path.join(directory, 'host.mjs')
  try {
    await writeFile(
      hostEntry,
      `export default async ({ harness }) => {
      await new Promise(resolve => setTimeout(resolve, 20))
      harness.handle('echo', input => input)
      return { apply() {} }
    }`,
    )
    const artifact = { revisionId: revision.id, buildKey: 'c'.repeat(64), directory, hostEntry }
    const manifest = extensionManifestSchema.parse({
      schemaVersion: 7,
      extensionId: revision.extensionId,
      revisionId: revision.id,
      entrypoints: { host: 'source/host.ts' },
      contributions: [{ kind: 'rpc', method: 'echo' }],
    })
    const input = { revision, manifest, artifact, config: {} }
    const mounting = mounts.load(input)
    const loaded = await mounting
    await expect(mounts.load(input)).rejects.toThrow('已经在本机运行')
    const attachment = await loaded.attach(agentId, {})
    await expect(loaded.call('echo', 'fixture', { surface: 'verification' })).resolves.toBe('fixture')
    await attachment.dispose()
    await expect(loaded.call('echo', 'still installed', { surface: 'verification' })).resolves.toBe('still installed')
    const disposal = mounts.dispose()
    expect(mounts.dispose()).toBe(disposal)
    await disposal
    await expect(loaded.call('echo', null, { surface: 'verification' })).rejects.toThrow('没有在本机运行')
    await expect(mounts.load(input)).rejects.toThrow('disposed')
  } finally {
    await mounts.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it('waits for an initializing host factory before disposing', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nxt-extension-init-'))
  const mounts = new PersistentExtensionMounts(new SessionRegistry())
  const revision: Revision = {
    id: ExtensionRevisionIdSchema.parse('xrv_INIT'),
    extensionId: ExtensionIdSchema.parse('ext_INIT'),
    revisionNumber: 1,
    contentDigest: 'a'.repeat(64),
    payloadDigest: 'b'.repeat(64),
    createdAt: 1,
  }
  const hostEntry = path.join(directory, 'host.mjs')
  try {
    await writeFile(
      hostEntry,
      `export default async ({ harness }) => {
      await new Promise(resolve => setTimeout(resolve, 20))
      harness.handle('echo', input => input)
      return { apply() {} }
    }`,
    )
    const manifest = extensionManifestSchema.parse({
      schemaVersion: 7,
      extensionId: revision.extensionId,
      revisionId: revision.id,
      entrypoints: { host: 'source/host.ts' },
      contributions: [{ kind: 'rpc', method: 'echo' }],
    })
    const loading = mounts.load({
      revision,
      manifest,
      artifact: { revisionId: revision.id, buildKey: 'c'.repeat(64), directory, hostEntry },
      config: {},
    })
    const disposal = mounts.dispose()
    expect(mounts.dispose()).toBe(disposal)
    const loaded = await loading
    await disposal
    await expect(loaded.call('echo', null, { surface: 'verification' })).rejects.toThrow('没有在本机运行')
  } finally {
    await mounts.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it('rejects a concurrent load before executing a second host factory', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nxt-extension-concurrent-'))
  const mounts = new PersistentExtensionMounts(new SessionRegistry())
  const revision: Revision = {
    id: ExtensionRevisionIdSchema.parse('xrv_CONCURRENT'),
    extensionId: ExtensionIdSchema.parse('ext_CONCURRENT'),
    revisionNumber: 1,
    contentDigest: 'a'.repeat(64),
    payloadDigest: 'b'.repeat(64),
    createdAt: 1,
  }
  const hostEntry = path.join(directory, 'host.mjs')
  try {
    await writeFile(
      hostEntry,
      `export default async ({ harness }) => {
      await new Promise(resolve => setTimeout(resolve, 20))
      harness.handle('echo', input => input)
      return { apply() {} }
    }`,
    )
    const manifest = extensionManifestSchema.parse({
      schemaVersion: 7,
      extensionId: revision.extensionId,
      revisionId: revision.id,
      entrypoints: { host: 'source/host.ts' },
      contributions: [{ kind: 'rpc', method: 'echo' }],
    })
    const input = {
      revision,
      manifest,
      artifact: { revisionId: revision.id, buildKey: 'c'.repeat(64), directory, hostEntry },
      config: {},
    }
    const results = await Promise.allSettled([mounts.load(input), mounts.load(input)])
    for (const result of results) if (result.status === 'fulfilled') await result.value.dispose()
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
  } finally {
    await mounts.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
