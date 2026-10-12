import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { AssetService } from '@nekro-nxt/core'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  collectVisibleImageResidency,
  NekroAssetAttachmentStore,
  parseNekroImageAttachmentId,
} from '../src/session-image-context.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('NekroAssetAttachmentStore', () => {
  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', {}],
    ['invalid id type', { attachmentId: 42 }],
    ['foreign id', { attachmentId: '/synthetic/private/image.png' }],
  ])('reports a classified, redacted error for a %s reference', async (_label, input) => {
    const root = await mkdtemp(path.join(tmpdir(), 'nxt-image-store-'))
    roots.push(root)
    const database = await openMigratedCoreDatabase(':memory:')
    try {
      const repository = new SqliteCoreRepository(database)
      const store = new NekroAssetAttachmentStore(new Context(), {
        assets: repository,
        assetService: new AssetService(repository, path.join(root, 'assets')),
        requestImageRoot: path.join(root, 'request-images'),
      })
      const expected = {
        name: 'AttachmentError',
        code: 'INVALID_ATTACHMENT_REF',
        message: 'Image attachment reference is missing or invalid.',
      }
      await expect(store.readImage(input)).rejects.toMatchObject(expected)
      await expect(store.readImageRequest(input, { width: 512, height: 512, maxBytes: 1024 })).rejects.toMatchObject(
        expected,
      )
      const controller = new AbortController()
      controller.abort(new Error('fixture cancellation'))
      await expect(
        store.readImageRequest(input, { width: 512, height: 512, maxBytes: 1024 }, controller.signal),
      ).rejects.toThrow('fixture cancellation')
    } finally {
      database.close()
    }
  })

  it('ignores malformed historical images while retaining valid and legacy image references', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nxt-image-residency-'))
    roots.push(root)
    const database = await openMigratedCoreDatabase(':memory:')
    try {
      const repository = new SqliteCoreRepository(database)
      const assets = new AssetService(repository, path.join(root, 'assets'))
      const { asset } = await assets.prepare({
        bytes: await sharp({ create: { width: 2, height: 2, channels: 3, background: '#4a7' } })
          .png()
          .toBuffer(),
        declaredMediaType: 'image/png',
      })
      const store = new NekroAssetAttachmentStore(new Context(), {
        assets: repository,
        assetService: assets,
        requestImageRoot: path.join(root, 'request-images'),
      })
      const ref = await store.refForAsset(asset, undefined, 'low')
      const malformed: ContentBlock[] = [
        undefined,
        null,
        {},
        { attachmentId: 42 },
        { attachmentId: 'foreign-image' },
      ].map((attachment) => {
        const block = { type: 'image' as const, attachment: ref }
        // Simulate already-persisted or extension-provided content without weakening the public schema.
        Reflect.set(block, 'attachment', attachment)
        return block
      })
      const session = Session.create(SessionId('synthetic-image-residency'))
      const content = [...malformed, { type: 'image' as const, attachment: ref }]
      const messages = [
        {
          ...createUserMessage({
            content: [],
            source: { kind: 'nekro-nxt-channel', admissionId: 'adm_fixture', channelEventIds: [] },
          }),
          content,
        },
      ]
      vi.spyOn(session, 'deriveMessages').mockReturnValue(messages)
      expect(collectVisibleImageResidency({ session }, repository)).toEqual(new Map([[asset.contentDigest, 'low']]))
      content.splice(malformed.length, 1, {
        type: 'image',
        attachment: { ...ref, attachmentId: AttachmentId(asset.id) },
      })
      expect(collectVisibleImageResidency({ session }, repository, 'high')).toEqual(
        new Map([[asset.contentDigest, 'auto']]),
      )
      expect(messages[0]?.content).toEqual(content)
      for (const value of [undefined, null, 42, {}, '', 'foreign-image'])
        expect(parseNekroImageAttachmentId(value)).toBeUndefined()
    } finally {
      database.close()
    }
  })

  it('hands provider adapters the content digest so their upload index keeps the record', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nxt-image-store-'))
    roots.push(root)
    const database = await openMigratedCoreDatabase(path.join(root, 'core.sqlite'))
    try {
      const repository = new SqliteCoreRepository(database)
      const assetService = new AssetService(repository, path.join(root, 'assets'))
      const data = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#4a7' } })
        .png()
        .toBuffer()
      const { asset } = await assetService.prepare({ bytes: data, declaredMediaType: 'image/png' })
      const store = new NekroAssetAttachmentStore(new Context(), {
        assets: repository,
        assetService,
        requestImageRoot: path.join(root, 'request-images'),
      })
      const ref = await store.refForAsset(asset, 'cat.png')
      const target = { width: 2048, height: 2048, maxBytes: 8 * 1024 * 1024 }

      const first = await store.readImageRequest(ref, target)
      const second = await store.readImageRequest(ref, target)

      expect(String(ref.attachmentId)).toMatch(/^nxt-asset:/u)
      expect(first.attachment.attachmentId).toBe(asset.contentDigest)
      expect(first.attachment).toMatchObject({ name: 'cat.png', width: 64, height: 48 })
      expect(second.variantId).toBe(first.variantId)
    } finally {
      database.close()
    }
  })
})
