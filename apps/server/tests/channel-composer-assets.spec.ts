import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { AdapterHostContributionV2, PhysicalDeliveryRequest } from '@nekro-nxt/adapter-sdk'
import {
  HostApiContracts,
  HostApiErrorSchema,
  type AssetId,
  type ChannelId,
  type HostApiRequest,
} from '@nekro-nxt/contracts'
import { assetChannelGrants, assetOccurrences, openCoreDatabase } from '@nekro-nxt/storage-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { NekroRuntime } from '../src/bootstrap.js'
import { createNekroHostApi } from '../src/host-api.js'

const MIB = 1024 * 1024
const DAY = 24 * 60 * 60 * 1000
// A synthetic one-pixel PNG; no user files or platform payloads enter these fixtures.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)
const textFile = Buffer.from('这是一份合成的中文附件。\n', 'utf8')

async function expectError(response: Response, status: number) {
  expect(response.status, await response.clone().text()).toBe(status)
  const { error } = HostApiErrorSchema.parse(await response.json())
  expect(error.message.length).toBeGreaterThan(0)
  return error
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'nxt-composer-assets-'))
  const web = new Context()
  const open: {
    runtime?: NekroRuntime
    api?: ReturnType<typeof createNekroHostApi>
    database?: ReturnType<typeof openCoreDatabase>
  } = {}
  onTestFinished(async () => {
    open.api?.dispose()
    try {
      await web.fiber.dispose()
    } finally {
      try {
        await open.runtime?.dispose()
      } finally {
        open.database?.close()
        await rm(directory, { recursive: true, force: true })
      }
    }
  })
  const runtime = await NekroRuntime.create({
    coreDatabasePath: path.join(directory, 'core.sqlite'),
    sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
    assetRoot: path.join(directory, 'assets'),
    extensionDataRoot: path.join(directory, 'extensions'),
    extensionCacheRoot: path.join(directory, 'extension-cache'),
  })
  open.runtime = runtime
  await runtime.start()
  await web.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const api = createNekroHostApi(web.webServer, runtime)
  open.api = api
  const database = openCoreDatabase(path.join(directory, 'core.sqlite'))
  open.database = database
  const origin = `http://127.0.0.1:${api.port}`
  // Unbound internal channels record real inbound facts without invoking a model.
  const channel = runtime.core.createChannel({
    connectionId: runtime.internalConnectionId,
    platformChannelId: 'synthetic-composer-room',
    kind: 'internal',
  })
  const otherChannel = runtime.core.createChannel({
    connectionId: runtime.internalConnectionId,
    platformChannelId: 'synthetic-other-room',
    kind: 'internal',
  })
  const assetUrl = (channelId: ChannelId, assetId?: AssetId) =>
    `${origin}/api/channels/${channelId}/assets${assetId === undefined ? '' : `/${assetId}`}`
  const uploadResponse = (
    channelId: ChannelId,
    bytes: Uint8Array,
    fileName: string,
    contentType = 'application/octet-stream',
  ) =>
    fetch(assetUrl(channelId), {
      method: 'POST',
      headers: { 'content-type': contentType, 'x-file-name': encodeURIComponent(fileName) },
      body: new Uint8Array(bytes),
    })
  const upload = async (channelId: ChannelId, bytes: Uint8Array, fileName: string, contentType?: string) => {
    const response = await uploadResponse(channelId, bytes, fileName, contentType)
    expect(response.status, await response.clone().text()).toBe(200)
    return HostApiContracts.uploadChannelAsset.parseResponse(await response.json())
  }
  let nextEvent = 0
  const send = (channelId: ChannelId, parts: HostApiRequest<'sendChannelMessage'>['parts']) =>
    fetch(`${origin}/api/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parts, clientEventId: `synthetic-composer-${++nextEvent}` }),
    })
  const remove = async (channelId: ChannelId, assetId: AssetId) => {
    const response = await fetch(assetUrl(channelId, assetId), { method: 'DELETE' })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(HostApiContracts.deleteChannelAsset.parseResponse(await response.json())).toEqual({ assetId, revoked: true })
  }
  const history = async (channelId: ChannelId) => {
    const response = await fetch(`${origin}/api/channels/${channelId}/messages?limit=40`)
    expect(response.status, await response.clone().text()).toBe(200)
    return HostApiContracts.listChannelMessages.parseResponse(await response.json()).messages
  }
  return { runtime, database, channel, otherChannel, assetUrl, uploadResponse, upload, send, remove, history }
}

describe('channel composer assets through the real Host API', () => {
  it('decodes Chinese file names once and derives image MIME from bytes', async () => {
    const f = await fixture()
    const fileName = '合成图 100% #.png'
    const asset = await f.upload(f.channel.id, png, fileName, 'text/html')
    expect(asset).toMatchObject({ fileName, mediaType: 'image/png', byteSize: png.length, partType: 'image' })
    expect(f.runtime.repository.getAssetById(asset.assetId)).toMatchObject({
      mediaType: 'image/png',
      byteSize: png.length,
    })
    expect(f.database.db.select().from(assetOccurrences).all()).toEqual([])
    expect(await f.history(f.channel.id)).toEqual([])
    const response = await fetch(f.assetUrl(f.channel.id, asset.assetId))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png)
  })

  it.each([
    { name: '合成说明.txt', contentType: 'text/html', bytes: textFile },
    { name: '合成页面.html', contentType: 'text/html', bytes: Buffer.from('<h1>合成页面</h1>', 'utf8') },
    { name: '伪装图片.png', contentType: 'image/png', bytes: textFile },
  ])('serves $name as a safe file regardless of client MIME and extension', async ({ name, contentType, bytes }) => {
    const f = await fixture()
    const asset = await f.upload(f.channel.id, bytes, name, contentType)
    expect(asset).toMatchObject({
      fileName: name,
      mediaType: 'application/octet-stream',
      partType: 'file',
      byteSize: bytes.length,
    })
    const response = await fetch(f.assetUrl(f.channel.id, asset.assetId))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
    await expectError(await f.send(f.channel.id, [{ type: 'image', assetId: asset.assetId }]), 400)
    expect(await f.history(f.channel.id)).toEqual([])
  })

  it('accepts and sends an empty file', async () => {
    const f = await fixture()
    const asset = await f.upload(f.channel.id, new Uint8Array(), '合成空文件.txt')
    expect(asset).toMatchObject({ byteSize: 0, mediaType: 'application/octet-stream', partType: 'file' })
    const parts = [{ type: 'file' as const, assetId: asset.assetId, name: asset.fileName }]
    const response = await f.send(f.channel.id, parts)
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await f.history(f.channel.id)).toEqual([expect.objectContaining({ parts })])
  })

  it('refuses reading and sending another channel’s assets without revoking the owner’s grant', async () => {
    const f = await fixture()
    const asset = await f.upload(f.channel.id, png, '隔离图片.png')
    await expectError(await fetch(f.assetUrl(f.otherChannel.id, asset.assetId)), 404)
    for (const type of ['image', 'file'] as const) {
      await expectError(await f.send(f.otherChannel.id, [{ type, assetId: asset.assetId }]), 400)
    }
    await f.remove(f.otherChannel.id, asset.assetId)
    expect(f.runtime.repository.canAccessAsset(asset.assetId, f.channel.id)).toBe(true)
    expect(f.runtime.repository.canAccessAsset(asset.assetId, f.otherChannel.id)).toBe(false)
    expect(await f.history(f.otherChannel.id)).toEqual([])
    expect(f.database.db.select().from(assetOccurrences).all()).toEqual([])
    const response = await fetch(f.assetUrl(f.channel.id, asset.assetId))
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png)
  })

  it('records attachment-only internal messages with real asset occurrences', async () => {
    const f = await fixture()
    const image = await f.upload(f.channel.id, png, '合成图片.png')
    const file = await f.upload(f.channel.id, textFile, '合成说明.txt')
    const parts = [
      { type: 'image' as const, assetId: image.assetId, alt: image.fileName },
      { type: 'file' as const, assetId: file.assetId, name: file.fileName },
    ]
    const response = await f.send(f.channel.id, parts)
    expect(response.status, await response.clone().text()).toBe(200)
    const sent = HostApiContracts.sendChannelMessage.parseResponse(await response.json())
    expect(sent.inserted).toBe(true)
    expect(sent.channelEventId).toBeDefined()
    expect(await f.history(f.channel.id)).toEqual([expect.objectContaining({ role: 'member', parts })])
    expect(f.database.db.select().from(assetOccurrences).all()).toEqual([
      { channelEventId: sent.channelEventId, partIndex: 0, assetId: image.assetId },
      { channelEventId: sent.channelEventId, partIndex: 1, assetId: file.assetId },
    ])
  })

  it('revokes an unsent browser grant and returns 404 on subsequent reads', async () => {
    const f = await fixture()
    const asset = await f.upload(f.channel.id, textFile, '未发送.txt')
    await f.remove(f.channel.id, asset.assetId)
    await f.remove(f.channel.id, asset.assetId)
    await expectError(await fetch(f.assetUrl(f.channel.id, asset.assetId)), 404)
    await expectError(await f.send(f.channel.id, [{ type: 'file', assetId: asset.assetId }]), 400)
    expect(f.runtime.repository.canAccessAsset(asset.assetId, f.channel.id)).toBe(false)
    expect(f.database.db.select().from(assetChannelGrants).all()).toEqual([])
    expect(await f.history(f.channel.id)).toEqual([])
  })

  it('keeps a sent asset and its history readable after removing it from a draft', async () => {
    const f = await fixture()
    const asset = await f.upload(f.channel.id, png, '已发送.png')
    const sent = await f.send(f.channel.id, [{ type: 'image', assetId: asset.assetId }])
    expect(sent.status, await sent.clone().text()).toBe(200)
    const before = await f.history(f.channel.id)
    await f.remove(f.channel.id, asset.assetId)
    expect(await f.history(f.channel.id)).toEqual(before)
    expect(f.database.db.select().from(assetOccurrences).all()).toHaveLength(1)
    const response = await fetch(f.assetUrl(f.channel.id, asset.assetId))
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png)
  })

  it.each(['agent-tool', 'extension-library'] as const)(
    'preserves an existing %s grant when the browser uploads and removes the same bytes',
    async (source) => {
      const f = await fixture()
      const { asset } = await f.runtime.assetService.prepare({ bytes: textFile })
      f.runtime.repository.grantAssetAccess({
        assetId: asset.id,
        channelId: f.channel.id,
        source,
        grantedAt: Date.now(),
      })
      const uploaded = await f.upload(f.channel.id, textFile, '共享资源.txt')
      expect(uploaded.assetId).toBe(asset.id)
      await f.remove(f.channel.id, asset.id)
      expect(f.database.db.select().from(assetChannelGrants).all()).toEqual([
        expect.objectContaining({ assetId: asset.id, channelId: f.channel.id, source }),
      ])
      const response = await fetch(f.assetUrl(f.channel.id, asset.id))
      expect(response.status).toBe(200)
      expect(Buffer.from(await response.arrayBuffer())).toEqual(textFile)
    },
  )

  it.each([
    '',
    '   ',
    '../说明.txt',
    'folder/说明.txt',
    'folder\\说明.txt',
    '控制\u0000.txt',
    '换行\n.txt',
    'a'.repeat(256),
  ])('rejects an invalid upload name %j without granting access', async (name) => {
    const f = await fixture()
    await expectError(await f.uploadResponse(f.channel.id, textFile, name), 400)
    expect(f.database.db.select().from(assetChannelGrants).all()).toEqual([])
    expect(await f.history(f.channel.id)).toEqual([])
  })

  it('rejects malformed filename encoding', async () => {
    const f = await fixture()
    const response = await fetch(f.assetUrl(f.channel.id), {
      method: 'POST',
      headers: { 'x-file-name': '%E0%A4%A', 'content-type': 'application/octet-stream' },
      body: textFile,
    })
    await expectError(response, 400)
    expect(f.database.db.select().from(assetChannelGrants).all()).toEqual([])
  })

  it('rejects damaged bytes recognized as PNG rather than granting an unreadable image', async () => {
    const f = await fixture()
    // Keep the PNG signature and chunk type, but truncate before complete image dimensions.
    const damaged = png.subarray(0, 20)
    const { asset } = await f.runtime.assetService.prepare({ bytes: damaged })
    expect(asset.mediaType).toBe('image/png')
    await expectError(await f.uploadResponse(f.channel.id, damaged, '损坏图片.png', 'image/png'), 400)
    expect(f.runtime.repository.canAccessAsset(asset.id, f.channel.id)).toBe(false)
    expect(f.database.db.select().from(assetChannelGrants).all()).toEqual([])
    expect(await f.history(f.channel.id)).toEqual([])
  })

  it('accepts 20 attachments and rejects 21 without recording another message', async () => {
    const f = await fixture()
    const asset = await f.upload(f.channel.id, textFile, '数量边界.txt')
    const parts = Array.from({ length: 20 }, () => ({ type: 'file' as const, assetId: asset.assetId }))
    const accepted = await f.send(f.channel.id, parts)
    expect(accepted.status, await accepted.clone().text()).toBe(200)
    const before = await f.history(f.channel.id)
    await expectError(await f.send(f.channel.id, [...parts, { type: 'file', assetId: asset.assetId }]), 400)
    expect(await f.history(f.channel.id)).toEqual(before)
    expect(f.database.db.select().from(assetOccurrences).all()).toHaveLength(20)
  })

  it('accepts a 64 MiB upload and rejects one extra byte over HTTP', async () => {
    const f = await fixture()
    const asset = await f.upload(f.channel.id, Buffer.alloc(64 * MIB, 0x61), '上传上限.txt')
    expect(asset).toMatchObject({ byteSize: 64 * MIB, partType: 'file' })
    await expectError(await f.uploadResponse(f.channel.id, Buffer.alloc(64 * MIB + 1, 0x62), '上传超限.txt'), 400)
    expect(f.database.db.select().from(assetChannelGrants).all()).toEqual([
      expect.objectContaining({ assetId: asset.assetId, channelId: f.channel.id }),
    ])
    expect(await f.history(f.channel.id)).toEqual([])
  }, 30_000)

  it('counts every attachment occurrence toward the 64 MiB message limit', async () => {
    const f = await fixture()
    const large = await f.upload(f.channel.id, Buffer.alloc(32 * MIB, 0x61), '总大小边界.txt')
    const extra = await f.upload(f.channel.id, Buffer.from('x'), '多一字节.txt')
    const parts = [
      { type: 'file' as const, assetId: large.assetId },
      { type: 'file' as const, assetId: large.assetId },
    ]
    const accepted = await f.send(f.channel.id, parts)
    expect(accepted.status, await accepted.clone().text()).toBe(200)
    const before = await f.history(f.channel.id)
    await expectError(await f.send(f.channel.id, [...parts, { type: 'file', assetId: extra.assetId }]), 400)
    expect(await f.history(f.channel.id)).toEqual(before)
    expect(f.database.db.select().from(assetOccurrences).all()).toHaveLength(2)
  }, 30_000)

  it.each(['read', 'send'] as const)(
    'lazily expires an unused browser grant after seven days on %s',
    async (operation) => {
      const f = await fixture()
      const asset = await f.upload(f.channel.id, textFile, '过期草稿.txt')
      f.runtime.repository.grantAssetAccess({
        assetId: asset.assetId,
        channelId: f.channel.id,
        source: 'browser-composer',
        grantedAt: Date.now() - 8 * DAY,
      })
      expect(f.runtime.repository.canAccessAsset(asset.assetId, f.channel.id)).toBe(true)
      const response =
        operation === 'read'
          ? await fetch(f.assetUrl(f.channel.id, asset.assetId))
          : await f.send(f.channel.id, [{ type: 'file', assetId: asset.assetId }])
      await expectError(response, operation === 'read' ? 404 : 400)
      expect(f.runtime.repository.canAccessAsset(asset.assetId, f.channel.id)).toBe(false)
      expect(f.database.db.select().from(assetChannelGrants).all()).toEqual([])
      expect(await f.history(f.channel.id)).toEqual([])
    },
  )

  it('keeps recent drafts, sent resources and other-source grants through lazy expiry', async () => {
    const f = await fixture()
    const recent = await f.upload(f.channel.id, textFile, '近期草稿.txt')
    const sent = await f.upload(f.channel.id, png, '旧消息图片.png')
    const response = await f.send(f.channel.id, [{ type: 'image', assetId: sent.assetId }])
    expect(response.status, await response.clone().text()).toBe(200)
    const shared = await f.runtime.assetService.prepare({ bytes: Buffer.from('合成工具文件') })
    for (const grant of [
      { assetId: recent.assetId, source: 'browser-composer' as const, grantedAt: Date.now() - 6 * DAY },
      { assetId: sent.assetId, source: 'browser-composer' as const, grantedAt: Date.now() - 8 * DAY },
      { assetId: shared.asset.id, source: 'agent-tool' as const, grantedAt: Date.now() - 8 * DAY },
    ])
      f.runtime.repository.grantAssetAccess({ ...grant, channelId: f.channel.id })
    for (const [assetId, bytes] of [
      [recent.assetId, textFile],
      [sent.assetId, png],
      [shared.asset.id, Buffer.from('合成工具文件')],
    ] as const) {
      const read = await fetch(f.assetUrl(f.channel.id, assetId))
      expect(read.status, await read.clone().text()).toBe(200)
      expect(Buffer.from(await read.arrayBuffer())).toEqual(bytes)
    }
  })

  it.each(['image', 'file'] as const)(
    'rejects %s upload and send using the running adapter’s actual capability',
    async (partType) => {
      const f = await fixture()
      const delivered: PhysicalDeliveryRequest[] = []
      const contribution: AdapterHostContributionV2 = {
        apiVersion: 2,
        descriptor: {
          key: 'composer-fixture',
          displayName: '合成附件平台',
          description: 'Synthetic attachment capability fixture.',
          provisioning: 'user-created',
          aliasEditable: true,
          channelDiscovery: 'adapter-observed',
          channelKinds: ['group'],
          activities: [],
          features: {},
          diagnostics: { receive: true, send: true },
          configSchema: { type: 'object', dict: {} },
        },
        create: (host) =>
          Promise.resolve({
            capabilities: {
              outbound: {
                text: true,
                mentions: false,
                images: partType !== 'image',
                files: partType !== 'file',
                audio: false,
                replies: false,
                mixedContent: true,
                proactiveSend: true,
              },
              activities: {},
            },
            start: async () => {
              await host.account.report({ platformUserId: 'synthetic-composer-account', observedAt: Date.now() })
              host.diagnostics.publish({ status: 'connected', proactiveSend: true })
            },
            stop: () => Promise.resolve(),
            deliver: (request) => {
              delivered.push(request)
              return Promise.resolve({ status: 'sent' as const, platformMessageId: 'synthetic-composer-delivery' })
            },
          }),
      }
      await f.runtime.registerAdapter('test:composer-fixture', contribution)
      const connection = await f.runtime.createConnection({ adapterKey: contribution.descriptor.key })
      const channel = f.runtime.core.createChannel({
        connectionId: connection.id,
        platformChannelId: 'synthetic-external-room',
        kind: 'group',
      })
      const agent = f.runtime.core.createAgent({
        displayName: '合成附件智能体',
        persona: '',
        model: { provider: 'synthetic-unused', model: 'unused' },
      })
      f.runtime.core.createBinding({ channelId: channel.id, agentId: agent.definition.id, triggerPolicy: 'always' })
      expect(f.runtime.connectionCapabilities(connection.id)?.outbound).toMatchObject({
        proactiveSend: true,
        [partType === 'image' ? 'images' : 'files']: false,
      })
      const bytes = partType === 'image' ? png : textFile
      await expectError(await f.uploadResponse(channel.id, bytes, partType === 'image' ? '受限.png' : '受限.txt'), 400)
      expect(f.database.db.select().from(assetChannelGrants).all()).toEqual([])
      // A previously granted asset must still be checked against the current adapter at send time.
      const { asset } = await f.runtime.assetService.prepare({ bytes })
      f.runtime.repository.grantAssetAccess({
        assetId: asset.id,
        channelId: channel.id,
        source: 'browser-composer',
        grantedAt: Date.now(),
      })
      await expectError(await f.send(channel.id, [{ type: partType, assetId: asset.id }]), 400)
      expect(delivered).toEqual([])
      expect(await f.history(channel.id)).toEqual([])
      expect(f.database.db.select().from(assetOccurrences).all()).toEqual([])
    },
  )
})
