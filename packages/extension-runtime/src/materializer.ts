import {
  ExtensionIdSchema,
  ExtensionRevisionIdSchema,
  JsonValueSchema,
  type ExtensionId,
  type ExtensionRevisionId,
  type JsonValue,
} from '@nekro-nxt/contracts'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { DynamicPackageSnapshot, MaterializedExtensionRevision } from './types.js'

const inputSchema = z
  .object({
    snapshot: z
      .object({
        name: z.string().trim().min(1).max(80),
        purpose: z.string().trim().min(1).max(500),
        hostCode: z
          .string()
          .max(1024 * 1024)
          .optional(),
        clientCode: z
          .string()
          .max(1024 * 1024)
          .optional(),
        contributions: z
          .array(
            z.discriminatedUnion('kind', [
              z.object({ kind: z.literal('tool'), name: z.string(), description: z.string() }).strict(),
              z.object({ kind: z.literal('rpc'), method: z.string() }).strict(),
              z
                .object({
                  kind: z.literal('client-slot'),
                  name: z.enum(['agent.workbench.sections', 'extension.details.panels']),
                })
                .strict(),
              z
                .object({
                  kind: z.literal('adapter'),
                  apiVersion: z.literal(1),
                  key: z.string().trim().min(1),
                  descriptorDigest: z.string().regex(/^[a-f0-9]{64}$/u),
                })
                .strict(),
              z
                .object({
                  kind: z.literal('host-client-slot'),
                  name: z.literal('conversation.message.rich'),
                  key: z.string().trim().min(1),
                })
                .strict(),
            ]),
          )
          .default([]),
      })
      .strict()
      .refine(({ hostCode, clientCode }) => hostCode !== undefined || clientCode !== undefined, {
        message: 'A dynamic Package snapshot needs a Host or Client source half.',
      }),
  })
  .strict()

const normalizeSource = (source: string): string => source.replaceAll('\r\n', '\n').trim() + '\n'

const sourcesSchema = z.union([
  z.object({ host: z.string(), client: z.string() }).strict(),
  z.object({ host: z.string() }).strict(),
  z.object({ client: z.string() }).strict(),
])

const extensionEntrypointsSchema = z.union([
  z.object({ host: z.literal('source/host.ts'), client: z.literal('source/client.ts') }).strict(),
  z.object({ host: z.literal('source/host.ts') }).strict(),
  z.object({ client: z.literal('source/client.ts') }).strict(),
])

const extensionManifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    extensionId: ExtensionIdSchema,
    revisionId: ExtensionRevisionIdSchema,
    entrypoints: extensionEntrypointsSchema,
    contributions: inputSchema.shape.snapshot.shape.contributions,
  })
  .strict()

const hostAdapterManifestSchema = extensionManifestSchema
  .omit({ schemaVersion: true, entrypoints: true, contributions: true })
  .extend({
    schemaVersion: z.literal(3),
    scope: z.literal('host-adapter'),
    entrypoints: z.union([
      z.object({ host: z.literal('source/host.ts'), client: z.literal('source/client.ts') }).strict(),
      z.object({ host: z.literal('source/host.ts') }).strict(),
    ]),
    contributions: inputSchema.shape.snapshot.shape.contributions,
  })
  .strict()

const digestInputSchema = z
  .object({
    manifest: z.union([extensionManifestSchema, hostAdapterManifestSchema]),
    sources: sourcesSchema,
  })
  .strict()

const payloadDigestInputSchema = z
  .object({
    manifest: z
      .object({
        schemaVersion: z.union([z.literal(2), z.literal(3)]),
        scope: z.literal('host-adapter').optional(),
        entrypoints: extensionEntrypointsSchema,
        contributions: inputSchema.shape.snapshot.shape.contributions,
      })
      .strict(),
    sources: sourcesSchema,
  })
  .strict()

const canonicalJson = (value: JsonValue): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`
}

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
  readonly snapshot: DynamicPackageSnapshot
}): MaterializedExtensionRevision {
  const parsed = inputSchema.parse({
    snapshot: input.snapshot,
  })
  const sources = sourcesSchema.parse({
    ...(parsed.snapshot.hostCode === undefined ? {} : { host: wrapHost(parsed.snapshot.hostCode) }),
    ...(parsed.snapshot.clientCode === undefined ? {} : { client: wrapClient(parsed.snapshot.clientCode) }),
  })
  const adapters = parsed.snapshot.contributions.filter(({ kind }) => kind === 'adapter')
  const hostSlots = parsed.snapshot.contributions.filter(({ kind }) => kind === 'host-client-slot')
  const agentContributions = parsed.snapshot.contributions.filter(
    ({ kind }) => kind !== 'adapter' && kind !== 'host-client-slot',
  )
  const isHostAdapter = adapters.length > 0 || hostSlots.length > 0
  if (isHostAdapter && (adapters.length !== 1 || agentContributions.length > 0 || !('host' in sources))) {
    throw new Error('适配器 Revision 必须包含一个 Host Adapter，且不能混装智能体工具、RPC 或 Slot。')
  }
  const manifest = isHostAdapter
    ? hostAdapterManifestSchema.parse({
        schemaVersion: 3,
        scope: 'host-adapter',
        extensionId: input.extensionId,
        revisionId: input.revisionId,
        entrypoints: {
          host: 'source/host.ts',
          ...('client' in sources ? { client: 'source/client.ts' } : {}),
        },
        contributions: parsed.snapshot.contributions,
      })
    : extensionManifestSchema.parse({
        schemaVersion: 2,
        extensionId: input.extensionId,
        revisionId: input.revisionId,
        entrypoints: {
          ...('host' in sources ? { host: 'source/host.ts' } : {}),
          ...('client' in sources ? { client: 'source/client.ts' } : {}),
        },
        contributions: parsed.snapshot.contributions,
      })
  const digestInput = canonicalJson(JsonValueSchema.parse(digestInputSchema.parse({ manifest, sources })))
  const payloadManifest = {
    schemaVersion: manifest.schemaVersion,
    ...('scope' in manifest ? { scope: manifest.scope } : {}),
    entrypoints: manifest.entrypoints,
    contributions: manifest.contributions,
  }
  const payloadDigestInput = canonicalJson(
    JsonValueSchema.parse(payloadDigestInputSchema.parse({ manifest: payloadManifest, sources })),
  )
  return {
    manifest,
    sources,
    contentDigest: createHash('sha256').update(digestInput).digest('hex'),
    payloadDigest: createHash('sha256').update(payloadDigestInput).digest('hex'),
    scope: isHostAdapter ? 'host-adapter' : 'agent',
  }
}

/** Recomputes canonical digests for a transferred immutable Revision without trusting archive metadata. */
export function materializeImportedRevision(input: {
  readonly manifest: unknown
  readonly sources: { readonly host?: string; readonly client?: string }
}): MaterializedExtensionRevision {
  const manifest = z.union([extensionManifestSchema, hostAdapterManifestSchema]).parse(input.manifest)
  const sources = sourcesSchema.parse({
    ...(input.sources.host === undefined ? {} : { host: normalizeSource(input.sources.host) }),
    ...(input.sources.client === undefined ? {} : { client: normalizeSource(input.sources.client) }),
  })
  if (
    'host' in manifest.entrypoints !== 'host' in sources ||
    'client' in manifest.entrypoints !== 'client' in sources
  ) {
    throw new Error('导入扩展的 Manifest entrypoints 与源码文件不一致。')
  }
  const digestInput = canonicalJson(JsonValueSchema.parse(digestInputSchema.parse({ manifest, sources })))
  const payloadManifest = {
    schemaVersion: manifest.schemaVersion,
    ...('scope' in manifest ? { scope: manifest.scope } : {}),
    entrypoints: manifest.entrypoints,
    contributions: manifest.contributions,
  }
  const payloadDigestInput = canonicalJson(
    JsonValueSchema.parse(payloadDigestInputSchema.parse({ manifest: payloadManifest, sources })),
  )
  return {
    manifest,
    sources,
    contentDigest: createHash('sha256').update(digestInput).digest('hex'),
    payloadDigest: createHash('sha256').update(payloadDigestInput).digest('hex'),
    scope: manifest.schemaVersion === 3 ? 'host-adapter' : 'agent',
  }
}
