import {
  ExtensionIdSchema,
  ExtensionRevisionIdSchema,
  type ExtensionId,
  type ExtensionRevisionId,
} from '@nekro-nxt/contracts'
import { EXTENSION_SDK_BUNDLE_SOURCE } from '@nekro-nxt/extension-sdk'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { build, type Plugin } from 'esbuild'
import { z } from 'zod'
import type { ExtensionBuildArtifact } from './types.js'

const BUILDER_VERSION = 'nekro-nxt-esbuild-v2'

const getNodeErrorCode = (error: unknown): string | undefined => {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') return undefined
  return error.code
}

const extensionBuildCacheSchema = z
  .object({
    revisionId: ExtensionRevisionIdSchema,
    buildKey: z.string().regex(/^[a-f0-9]{64}$/),
    hostEntry: z.literal('host.mjs').optional(),
    clientEntry: z.literal('client.mjs').optional(),
  })
  .strict()
  .refine(({ hostEntry, clientEntry }) => hostEntry !== undefined || clientEntry !== undefined, {
    message: 'Extension build cache has no artifact entrypoint.',
  })

const extensionEntrypointsSchema = z.union([
  z.object({ host: z.literal('source/host.ts'), client: z.literal('source/client.ts') }).strict(),
  z.object({ host: z.literal('source/host.ts') }).strict(),
  z.object({ client: z.literal('source/client.ts') }).strict(),
])

const extensionManifestV1Schema = z
  .object({
    extensionId: ExtensionIdSchema,
    revisionId: ExtensionRevisionIdSchema,
    entrypoints: extensionEntrypointsSchema,
  })
  .strict()

const extensionManifestSchema = z.union([
  extensionManifestV1Schema,
  extensionManifestV1Schema
    .extend({
      schemaVersion: z.literal(2),
      contributions: z.array(
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
      ),
    })
    .strict(),
  extensionManifestV1Schema
    .extend({
      schemaVersion: z.literal(3),
      scope: z.literal('host-adapter'),
      entrypoints: z.union([
        z.object({ host: z.literal('source/host.ts'), client: z.literal('source/client.ts') }).strict(),
        z.object({ host: z.literal('source/host.ts') }).strict(),
      ]),
      contributions: z
        .array(
          z.discriminatedUnion('kind', [
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
        .min(1)
        .superRefine((contributions, context) => {
          if (contributions.filter(({ kind }) => kind === 'adapter').length !== 1) {
            context.addIssue({ code: 'custom', message: 'Host Adapter Manifest 必须且只能声明一个 Adapter。' })
          }
        }),
    })
    .strict(),
])

const importPolicy: Plugin = {
  name: 'nekro-nxt-extension-import-policy',
  setup(buildContext) {
    buildContext.onResolve({ filter: /^[^./]|^@/ }, (args) => {
      if (args.path === '@nekro-nxt/extension-sdk') return { path: args.path, namespace: 'nekro-nxt-sdk' }
      return { errors: [{ text: `Extension import is not allowed: ${args.path}` }] }
    })
    buildContext.onLoad({ filter: /.*/, namespace: 'nekro-nxt-sdk' }, () => ({
      contents: EXTENSION_SDK_BUNDLE_SOURCE,
      loader: 'js',
    }))
  },
}

export class ExtensionBuilder {
  readonly #cacheRoot: string

  constructor(cacheRoot: string) {
    if (!path.isAbsolute(cacheRoot)) throw new TypeError('Extension build cache root must be absolute.')
    this.#cacheRoot = cacheRoot
  }

  async build(input: {
    readonly extensionId?: ExtensionId
    readonly revisionId: ExtensionRevisionId
    readonly contentDigest: string
    readonly sourceDirectory: string
  }): Promise<ExtensionBuildArtifact> {
    const buildKey = createHash('sha256')
      .update(`${BUILDER_VERSION}\0node-${process.versions.modules}\0${input.contentDigest}`)
      .digest('hex')
    const directory = path.join(this.#cacheRoot, input.revisionId, buildKey)
    const manifestPath = path.join(directory, 'build.json')
    const manifest = extensionManifestSchema.parse(
      JSON.parse(await readFile(path.join(input.sourceDirectory, 'manifest.json'), 'utf8')),
    )
    if (manifest.revisionId !== input.revisionId) {
      throw new Error('Extension Manifest revision does not match build input.')
    }
    if (input.extensionId !== undefined && manifest.extensionId !== input.extensionId) {
      throw new Error('Extension Manifest identity does not match build input.')
    }
    try {
      const cached = extensionBuildCacheSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
      if (
        cached.buildKey === buildKey &&
        cached.revisionId === input.revisionId &&
        this.#matchesEntrypoints(cached, manifest) &&
        (await this.#isCompleteCache(directory, cached))
      ) {
        return this.#artifactFromCache(directory, cached)
      }
    } catch {
      // Missing or invalid cache is disposable and rebuilt below.
    }

    const temporary = `${directory}.tmp-${randomUUID()}`
    await rm(temporary, { recursive: true, force: true })
    await mkdir(temporary, { recursive: true, mode: 0o700 })
    try {
      const hostEntry =
        'host' in manifest.entrypoints
          ? await this.#buildEntry(
              path.join(input.sourceDirectory, manifest.entrypoints.host),
              temporary,
              'host',
              'node',
            )
          : undefined
      const clientEntry =
        'client' in manifest.entrypoints
          ? await this.#buildEntry(
              path.join(input.sourceDirectory, manifest.entrypoints.client),
              temporary,
              'client',
              'browser',
            )
          : undefined
      if (!hostEntry && !clientEntry) throw new Error('Extension Manifest has no buildable entrypoint.')
      const artifact: ExtensionBuildArtifact = {
        revisionId: input.revisionId,
        buildKey,
        directory,
        ...(hostEntry === undefined ? {} : { hostEntry: path.join(directory, path.basename(hostEntry)) }),
        ...(clientEntry === undefined ? {} : { clientEntry: path.join(directory, path.basename(clientEntry)) }),
      }
      const cache = extensionBuildCacheSchema.parse({
        revisionId: artifact.revisionId,
        buildKey: artifact.buildKey,
        ...(artifact.hostEntry === undefined ? {} : { hostEntry: 'host.mjs' }),
        ...(artifact.clientEntry === undefined ? {} : { clientEntry: 'client.mjs' }),
      })
      await writeFile(path.join(temporary, 'build.json'), JSON.stringify(cache, null, 2) + '\n', 'utf8')
      await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 })
      await rm(directory, { recursive: true, force: true })
      await rename(temporary, directory)
      return artifact
    } catch (error) {
      await rm(temporary, { recursive: true, force: true })
      await rmdir(path.dirname(directory)).catch((cleanupError: unknown) => {
        const code = getNodeErrorCode(cleanupError)
        if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw cleanupError
      })
      throw error
    }
  }

  async deleteRevisionCaches(revisionIds: readonly ExtensionRevisionId[]): Promise<void> {
    const results = await Promise.allSettled(
      revisionIds.map((revisionId) => {
        ExtensionRevisionIdSchema.parse(revisionId)
        return rm(path.join(this.#cacheRoot, revisionId), { recursive: true, force: true })
      }),
    )
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result): unknown => result.reason)
    if (failures.length) throw new AggregateError(failures, 'Extension build cache cleanup failed.')
  }

  #artifactFromCache(directory: string, cache: z.infer<typeof extensionBuildCacheSchema>): ExtensionBuildArtifact {
    return {
      revisionId: cache.revisionId,
      buildKey: cache.buildKey,
      directory,
      ...(cache.hostEntry === undefined ? {} : { hostEntry: path.join(directory, cache.hostEntry) }),
      ...(cache.clientEntry === undefined ? {} : { clientEntry: path.join(directory, cache.clientEntry) }),
    }
  }

  #matchesEntrypoints(
    cache: z.infer<typeof extensionBuildCacheSchema>,
    manifest: z.infer<typeof extensionManifestSchema>,
  ): boolean {
    return (
      (cache.hostEntry !== undefined) === 'host' in manifest.entrypoints &&
      (cache.clientEntry !== undefined) === 'client' in manifest.entrypoints
    )
  }

  async #isCompleteCache(directory: string, cache: z.infer<typeof extensionBuildCacheSchema>): Promise<boolean> {
    const entries = [cache.hostEntry, cache.clientEntry].filter((entry) => entry !== undefined)
    return (
      await Promise.all(
        entries.map(async (entry) => {
          try {
            return (await stat(path.join(directory, entry))).isFile()
          } catch {
            return false
          }
        }),
      )
    ).every(Boolean)
  }

  async #buildEntry(
    entry: string,
    outputDirectory: string,
    name: 'host' | 'client',
    platform: 'node' | 'browser',
  ): Promise<string> {
    if (!(await stat(entry)).isFile()) throw new Error(`Extension entrypoint is not a file: ${name}`)
    const outfile = path.join(outputDirectory, `${name}.mjs`)
    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      format: 'esm',
      platform,
      target: platform === 'node' ? 'node22' : 'es2022',
      sourcemap: 'external',
      logLevel: 'silent',
      plugins: [importPolicy],
    })
    return outfile
  }
}
