import { AgentIdSchema, ExtensionIdSchema, ExtensionRevisionIdSchema } from '@nekro-nxt/contracts'
import type { Revision } from '@nekro-nxt/extension-runtime'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { PersistentExtensionMounts } from '../src/persistent-extension-mounts.js'
import { SessionRegistry } from '../src/session-registry.js'

it('rejects concurrent duplicate factories and waits for initialization before disposing', async () => {
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
    const mounting = mounts.mount(agentId, revision, artifact, null)
    await expect(mounts.mount(agentId, revision, artifact, null)).rejects.toThrow('already mounting')
    const disposal = mounts.dispose()
    expect(mounts.dispose()).toBe(disposal)
    await mounting
    await disposal
    await expect(mounts.invokeExtensionActivation(agentId, revision.id, 'echo', null)).rejects.toThrow('unavailable')
    await expect(mounts.mount(agentId, revision, artifact, null)).rejects.toThrow('disposed')
  } finally {
    await mounts.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
