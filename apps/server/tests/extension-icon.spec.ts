import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { ExtensionRevisionIdSchema, HostApiContracts } from '@nekro-nxt/contracts'
import {
  bytesToBase64,
  materializeImportedRevision,
  resourceContent,
  verifyExtensionPackage,
} from '@nekro-nxt/extension-format'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NekroRuntime } from '../src/bootstrap.js'
import { createNekroHostApi } from '../src/host-api.js'
import { projectExtensions } from '../src/host-queries.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const EXTENSION_ID = 'ext_01ICONFIXTURE00000000000000'
const REVISION_ID = 'xrv_01ICONFIXTURE00000000000000'

const HOST = `import { defineHostExtension } from '@nekro-nxt/extension-sdk'

export default defineHostExtension(async ({ harness }) => {
  return {
    inject: ['tools'],
    apply(ctx) {
      harness.registerTool(ctx, harness.defineTool({
        name: 'icon_probe',
        description: 'icon probe',
        parameters: {},
        output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: v }] } },
        execute() { return 'ok' }
      }))
    }
  }
})
`

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

/** 只含文件头与 IHDR 的虚构 96×96 PNG；宿主只校验文件头与尺寸。 */
const fictionalPng = (): Uint8Array => {
  const bytes = new Uint8Array(64)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(bytes.buffer).setUint32(16, 96)
  new DataView(bytes.buffer).setUint32(20, 96)
  return bytes
}

const iconPackage = (icon: Uint8Array): Uint8Array => {
  const manifest = {
    schemaVersion: 6,
    scope: 'agent',
    extensionId: EXTENSION_ID,
    revisionId: REVISION_ID,
    entrypoints: { host: 'source/host.ts' },
    icon: { path: 'assets/icon.png', sha256: sha256(icon) },
    permissions: { permissions: [], networkOrigins: [] },
    contributions: [{ kind: 'tool', name: 'icon_probe', description: 'icon probe' }],
  }
  const { contentDigest, payloadDigest } = materializeImportedRevision({
    manifest,
    sources: { host: HOST },
    resources: { 'assets/icon.png': resourceContent('assets/icon.png', icon) },
  })
  const files: Record<string, Uint8Array> = {
    'revision/manifest.json': strToU8(JSON.stringify(manifest)),
    'revision/source/host.ts': strToU8(HOST),
    'revision/assets/icon.png': icon,
  }
  const transfer = {
    schemaVersion: 1,
    kind: 'nekro-nxt-extension',
    extension: {
      id: EXTENSION_ID,
      scope: 'agent',
      slug: 'icon-probe',
      displayName: '图标探针',
      description: '虚构的图标测试扩展。',
      createdAt: 1_790_000_000_000,
    },
    revision: { id: REVISION_ID, revisionNumber: 1, contentDigest, payloadDigest, createdAt: 1_790_000_000_000 },
    files: Object.entries(files).map(([filePath, content]) => ({
      path: filePath,
      size: content.byteLength,
      sha256: sha256(content),
    })),
    sourceVerification: null,
  }
  return zipSync({ 'manifest.json': strToU8(JSON.stringify(transfer)), ...files })
}

describe('extension icons', () => {
  it('keeps the icon through import, storage, the revision view, the icon route and export', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-ext-icon-'))
    temporaryDirectories.push(directory)
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
    })
    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    const origin = `http://127.0.0.1:${api.port}`
    const icon = fictionalPng()
    try {
      const inspectResponse = await fetch(`${origin}/api/extensions/imports/inspect`, {
        method: 'POST',
        body: Buffer.from(iconPackage(icon)),
      })
      expect(inspectResponse.ok, await inspectResponse.clone().text()).toBe(true)
      const inspection = HostApiContracts.inspectExtensionImport.parseResponse(await inspectResponse.json())
      const commitResponse = await fetch(`${origin}/api/extensions/imports/${inspection.token}/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      expect(commitResponse.ok, await commitResponse.clone().text()).toBe(true)

      // 已保存的 Revision 目录里是原始字节。
      const revision = runtime.repository.getExtensionRevision(ExtensionRevisionIdSchema.parse(REVISION_ID))!
      const stored = await readFile(
        path.join(runtime.extensionService.revisionSourceDirectory(revision), 'assets/icon.png'),
      )
      expect(new Uint8Array(stored)).toEqual(icon)

      const iconUrl = `/api/extensions/${EXTENSION_ID}/revisions/${REVISION_ID}/icon/${sha256(icon)}.png`
      const [projected] = projectExtensions(runtime)
      expect(projected?.revisions[0]?.iconUrl).toBe(iconUrl)
      const snapshot = HostApiContracts.snapshot.parseResponse(await (await fetch(`${origin}/api/snapshot`)).json())
      expect(snapshot.extensions[0]?.revisions[0]?.iconUrl).toBe(iconUrl)

      const iconResponse = await fetch(`${origin}${iconUrl}`)
      expect(iconResponse.status).toBe(200)
      expect(iconResponse.headers.get('content-type')).toBe('image/png')
      expect(iconResponse.headers.get('cache-control')).toContain('immutable')
      expect(new Uint8Array(await iconResponse.arrayBuffer())).toEqual(icon)
      const stale = await fetch(`${origin}${iconUrl.replace(sha256(icon), 'f'.repeat(64))}`)
      expect(stale.status).toBe(404)
      const wrongType = await fetch(`${origin}${iconUrl.replace(/\.png$/u, '.svg')}`)
      expect(wrongType.status).toBe(404)

      const exported = await fetch(`${origin}/api/extensions/${EXTENSION_ID}/revisions/${REVISION_ID}/export`)
      expect(exported.ok).toBe(true)
      const archiveBytes = new Uint8Array(await exported.arrayBuffer())
      expect(unzipSync(archiveBytes)['revision/assets/icon.png']).toEqual(icon)
      const verified = verifyExtensionPackage(archiveBytes)
      expect(verified.revision.resources?.['assets/icon.png']).toBe(bytesToBase64(icon))
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })
})
