import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { zipSync } from 'fflate'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { ExtensionIdSchema, type JsonValue } from '@nekro-nxt/contracts'
import { AssetService } from '@nekro-nxt/core'
import type { ExtensionToolDefinition } from '@nekro-nxt/extension-sdk'
import { localExtensions, openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { withToolImages, type ToolImagePlan } from '../src/extension-tool-images.js'
import { registerExtensionLibraryRoutes } from '../src/host-routes-extension-library.js'
import { RetrievalRuntime } from '../src/retrieval-runtime.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const temporary = async (prefix: string) => {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

const isUploadResult = (
  value: unknown,
): value is {
  readonly added: readonly { readonly name: string; readonly existed: boolean; readonly assetId: string }[]
  readonly skipped: readonly { readonly name: string; readonly reason: string }[]
} => typeof value === 'object' && value !== null && 'added' in value && 'skipped' in value

const picture = (color: string, size = 40): Promise<Buffer> =>
  sharp({ create: { width: size, height: size, channels: 3, background: color } })
    .png()
    .toBuffer()

describe('tool result images', () => {
  const searchTool: ExtensionToolDefinition = {
    name: 'sticker_search',
    description: '搜索表情包',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [
        { type: 'text', text: '找到这些：' },
        ...(Array.isArray(value) ? value : []).map((assetId) => ({
          type: 'image' as const,
          assetId: String(assetId),
          label: `候选 ${String(assetId)}`,
        })),
      ],
    },
    execute: () => ['ast_A', 'ast_B', 'ast_C'],
  }
  const attachment = {
    attachmentId: AttachmentId('nxt-asset:ast_A:low'),
    mediaType: 'image/png' as const,
    bytes: 10,
    width: 4,
    height: 4,
  }

  it('shows new pictures, names visible ones and leaves the value untouched', async () => {
    const plans: ToolImagePlan[] = [
      { state: 'shown', attachment },
      { state: 'visible' },
      { state: 'text', reason: '图片暂时读不到' },
    ]
    const wrapped = withToolImages(searchTool, { plan: () => Promise.resolve(plans) })
    const value = await wrapped.execute({})
    expect(value).toEqual(['ast_A', 'ast_B', 'ast_C'])
    expect(wrapped.output.render({}, value)).toEqual([
      { type: 'text', text: '找到这些：' },
      { type: 'text', text: '候选 ast_A' },
      { type: 'image', attachment },
      { type: 'text', text: '候选 ast_B（上文已经给你看过）' },
      { type: 'text', text: '候选 ast_C（图片暂时读不到）' },
    ])
  })

  it('passes results without pictures through unchanged', async () => {
    const plain: ExtensionToolDefinition = {
      ...searchTool,
      execute: () => [],
    }
    let asked = false
    const wrapped = withToolImages(plain, {
      plan: () => {
        asked = true
        return Promise.resolve([])
      },
    })
    const value: JsonValue = await wrapped.execute({})
    expect(wrapped.output.render({}, value)).toEqual([{ type: 'text', text: '找到这些：' }])
    expect(asked).toBe(false)
  })
})

describe('built-in retrieval model', () => {
  const index = async () =>
    new SqliteCoreRepository(
      await openMigratedCoreDatabase(path.join(await temporary('nekro-nxt-retrieval-db-'), 'core.sqlite')),
    ).extensionIndex
  const settings = () => {
    let stored: { value: JsonValue; revision: number } | undefined
    return {
      get: () => stored,
      put: (_key: string, value: JsonValue) => {
        stored = { value, revision: (stored?.revision ?? 0) + 1 }
      },
    }
  }

  it('reports platforms without a published runtime and refuses semantic search before a download', async () => {
    const runtime = new RetrievalRuntime({
      root: await temporary('nekro-nxt-retrieval-'),
      index: await index(),
      settings: settings(),
      platform: 'darwin',
      arch: 'x64',
    })
    await runtime.start()
    expect(runtime.status().builtin).toMatchObject({ supported: false, install: { state: 'not-installed' } })
    expect(() => runtime.startDownload()).toThrow('还不能运行内置语义模型')
    expect(() => runtime.setMode('builtin')).toThrow('先下载内置语义模型')
    expect(await runtime.queryVector('开心')).toBeUndefined()
  })

  it('discards files that do not match their pinned size and hash', async () => {
    const runtime = new RetrievalRuntime({
      root: await temporary('nekro-nxt-retrieval-'),
      index: await index(),
      settings: settings(),
      platform: 'linux',
      arch: 'x64',
      fetch: () => Promise.resolve(new Response('not the real file')),
    })
    await runtime.start()
    runtime.startDownload()
    await new Promise<void>((resolve) => {
      const off = runtime.subscribe(() => {
        if (runtime.status().builtin.install.state === 'failed') {
          off()
          resolve()
        }
      })
    })
    const install = runtime.status().builtin.install
    expect(install.state).toBe('failed')
    expect(install.state === 'failed' ? install.error : '').toContain('下载失败')
    expect(install.state === 'failed' ? install.error : '').toContain('校验不通过')
  })
})

describe('library uploads', () => {
  const servers: ReturnType<typeof createServer>[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
  })
  const extensionId = ExtensionIdSchema.parse('ext_STICKERSFIXTURE0000000000')

  const setup = async () => {
    const directory = await temporary('nekro-nxt-upload-')
    const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
    const repository = new SqliteCoreRepository(database)
    database.db
      .insert(localExtensions)
      .values({
        id: extensionId,
        provides: ['page'],
        slug: 'stickers',
        displayName: '表情包',
        description: '',
        createdAt: 1,
      })
      .run()
    type Route = Parameters<Parameters<typeof registerExtensionLibraryRoutes>[0]['registerRoute']>[0]
    let route: Route | undefined
    registerExtensionLibraryRoutes({
      registerRoute: (registered) => {
        route = registered
      },
      repository,
      assetService: new AssetService(repository, path.join(directory, 'assets')),
      libraryQuota: (id) => {
        if (id !== extensionId) throw new Error('这个扩展没有安装到本机。')
        return 64 * 1024 * 1024
      },
    })
    const server = createServer((req, res) => void route?.handler(req, res))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const address = server.address()
    const origin = typeof address === 'object' && address !== null ? `http://127.0.0.1:${address.port}` : ''
    const call = async (method: string, url: string, body?: Buffer, name?: string) => {
      const response = await fetch(`${origin}${url}`, {
        method,
        ...(body === undefined ? {} : { body }),
        headers: name === undefined ? {} : { 'x-nekro-file-name': encodeURIComponent(name) },
      })
      return {
        status: response.status,
        type: response.headers.get('content-type'),
        body: Buffer.from(await response.arrayBuffer()),
      }
    }
    return { repository, call }
  }

  it('imports pictures from an archive, skips the rest and deduplicates by content', async () => {
    const { repository, call } = await setup()
    const red = await picture('#ff0000')
    const archive = Buffer.from(
      zipSync({
        'set/red.png': red,
        'set/again/red-copy.png': red,
        'set/blue.png': await picture('#0000ff'),
        'set/readme.txt': new TextEncoder().encode('说明'),
        'set/fake.png': new TextEncoder().encode('not a picture'),
        '__MACOSX/set/._red.png': new TextEncoder().encode('metadata'),
      }),
    )
    const response = await call('POST', `/api/extension-library/${extensionId}/assets`, archive, 'stickers.zip')
    expect(response.status).toBe(200)
    const result: unknown = JSON.parse(response.body.toString('utf8'))
    if (!isUploadResult(result)) throw new Error('unexpected upload response')
    // Pictures of one archive are imported concurrently; only the set and the duplicate count are stable.
    expect(result.added.map(({ name }) => name).sort()).toEqual([
      'set/again/red-copy.png',
      'set/blue.png',
      'set/red.png',
    ])
    expect(result.added.filter(({ existed }) => existed)).toHaveLength(1)
    expect(result.skipped.map(({ name }) => name).sort()).toEqual(['set/fake.png', 'set/readme.txt'])
    expect(repository.extensionLibrary.libraryUsage(extensionId).count).toBe(2)

    const thumbnail = await call(
      'GET',
      `/api/extension-library/${extensionId}/assets/${result.added[0]!.assetId}?thumbnail=1`,
    )
    expect(thumbnail.status).toBe(200)
    expect(thumbnail.type).toBe('image/webp')
    expect((await sharp(thumbnail.body).metadata()).format).toBe('webp')
  })

  it('accepts a single picture, rejects other files and unknown extensions', async () => {
    const { call } = await setup()
    const single = await call(
      'POST',
      `/api/extension-library/${extensionId}/assets`,
      await picture('#00ff00'),
      '绿.png',
    )
    expect(JSON.parse(single.body.toString('utf8'))).toMatchObject({ added: [{ name: '绿.png', existed: false }] })
    const text = await call('POST', `/api/extension-library/${extensionId}/assets`, Buffer.from('hello'), 'a.txt')
    expect(JSON.parse(text.body.toString('utf8'))).toMatchObject({ added: [], skipped: [{ name: 'a.txt' }] })
    const unknown = await call(
      'POST',
      `/api/extension-library/ext_OTHERFIXTURE00000000000000/assets`,
      await picture('#000000'),
      'b.png',
    )
    expect(unknown.status).toBe(400)
    expect(unknown.body.toString('utf8')).toContain('没有安装到本机')
  })
})
