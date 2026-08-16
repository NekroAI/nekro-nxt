import type { ExtensionRevisionId } from '@nekro-nxt/contracts'
import { EXTENSION_SDK_BUNDLE_SOURCE } from '@nekro-nxt/extension-sdk'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { build, type Plugin } from 'esbuild'
import type { ExtensionBuildArtifact } from './types.js'

const BUILDER_VERSION = 'nekro-nxt-esbuild-v1'

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
    readonly revisionId: ExtensionRevisionId
    readonly contentDigest: string
    readonly sourceDirectory: string
  }): Promise<ExtensionBuildArtifact> {
    const buildKey = createHash('sha256')
      .update(`${BUILDER_VERSION}\0node-${process.versions.modules}\0${input.contentDigest}`)
      .digest('hex')
    const directory = path.join(this.#cacheRoot, input.revisionId, buildKey)
    const manifestPath = path.join(directory, 'build.json')
    try {
      const cached = JSON.parse(await readFile(manifestPath, 'utf8')) as ExtensionBuildArtifact
      if (cached.buildKey === buildKey && cached.revisionId === input.revisionId) return cached
    } catch {
      // Missing or invalid cache is disposable and rebuilt below.
    }

    const manifest = JSON.parse(await readFile(path.join(input.sourceDirectory, 'manifest.json'), 'utf8')) as {
      entrypoints?: { host?: string; client?: string }
    }
    const temporary = `${directory}.tmp-${randomUUID()}`
    await rm(temporary, { recursive: true, force: true })
    await mkdir(temporary, { recursive: true, mode: 0o700 })
    try {
      const hostEntry = manifest.entrypoints?.host
        ? await this.#buildEntry(path.join(input.sourceDirectory, manifest.entrypoints.host), temporary, 'host', 'node')
        : undefined
      const clientEntry = manifest.entrypoints?.client
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
      await writeFile(path.join(temporary, 'build.json'), JSON.stringify(artifact, null, 2) + '\n', 'utf8')
      await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 })
      await rm(directory, { recursive: true, force: true })
      await rename(temporary, directory)
      return artifact
    } catch (error) {
      await rm(temporary, { recursive: true, force: true })
      await rmdir(path.dirname(directory)).catch((cleanupError: unknown) => {
        const code = (cleanupError as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw cleanupError
      })
      throw error
    }
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
