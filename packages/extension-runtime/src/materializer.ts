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

const digestInputSchema = z
  .object({
    manifest: extensionManifestSchema,
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
  const manifest = extensionManifestSchema.parse({
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
  return {
    manifest,
    sources,
    contentDigest: createHash('sha256').update(digestInput).digest('hex'),
  }
}
