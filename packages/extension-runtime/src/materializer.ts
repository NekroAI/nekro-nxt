import type { ExtensionId, ExtensionRevisionId, JsonValue } from '@nekro-nxt/contracts'
import { canonicalJson } from '@nekro-nxt/core'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type {
  DraftPackageRecord,
  ExtensionManifestV1,
  ExtensionSourceInputV1,
  MaterializedExtensionRevision,
} from './types.js'

const metadataSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    requestedCapabilities: z.array(z.string().trim().min(1).max(80)).max(32).default([]),
  })
  .strict()

const normalizeSource = (source: string): string => source.replaceAll('\r\n', '\n').trim() + '\n'

const wrapHost = (body: string): string =>
  normalizeSource(`import { defineHostExtension } from '@nekro-nxt/extension-sdk'

export default defineHostExtension(async ({ harness }) => {
${body}
})`)

const wrapClient = (body: string): string =>
  normalizeSource(`import { defineClientExtension } from '@nekro-nxt/extension-sdk'

export default defineClientExtension(async ({ React, host, styles }) => {
${body}
})`)

export function materializeDynamicPackage(input: {
  readonly extensionId: ExtensionId
  readonly revisionId: ExtensionRevisionId
  readonly draftPackage: DraftPackageRecord
  readonly displayName: string
  readonly requestedCapabilities?: readonly string[]
}): MaterializedExtensionRevision {
  const metadata = metadataSchema.parse({
    displayName: input.displayName,
    requestedCapabilities: input.requestedCapabilities ?? [],
  })
  if (input.draftPackage.hostCode === undefined && input.draftPackage.clientCode === undefined) {
    throw new TypeError('A DraftPackage must contain a Host or Client source half.')
  }
  const sources = {
    ...(input.draftPackage.hostCode === undefined ? {} : { host: wrapHost(input.draftPackage.hostCode) }),
    ...(input.draftPackage.clientCode === undefined ? {} : { client: wrapClient(input.draftPackage.clientCode) }),
  }
  const manifest: ExtensionManifestV1 = {
    schemaVersion: 1,
    extensionId: input.extensionId,
    revisionId: input.revisionId,
    name: metadata.displayName,
    apiVersion: '1',
    entrypoints: {
      ...(sources.host === undefined ? {} : { host: 'source/host.ts' }),
      ...(sources.client === undefined ? {} : { client: 'source/client.ts' }),
    },
    contributions: [
      ...(sources.host === undefined ? [] : [{ type: 'host' as const, id: 'host' }]),
      ...(sources.client === undefined ? [] : [{ type: 'client' as const, id: 'client' }]),
    ],
    requestedCapabilities: [...new Set(metadata.requestedCapabilities)].sort(),
    compatible: { nekroNxt: '^0.1.0', dsh: '^0.1.0-rc.6' },
  }
  const sourceInput: ExtensionSourceInputV1 = {
    schemaVersion: 1,
    sdk: '@nekro-nxt/extension-sdk@0.1.0',
    builderProtocol: 'nekro-nxt-esbuild-v1',
    allowedDependencies: ['@nekro-nxt/extension-sdk'],
  }
  const digestInput = canonicalJson({ manifest, sourceInput, sources } as unknown as JsonValue)
  return {
    manifest,
    sourceInput,
    sources,
    contentDigest: createHash('sha256').update(digestInput).digest('hex'),
  }
}
