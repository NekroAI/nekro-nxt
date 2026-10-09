import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AssetService } from '@nekro-nxt/core'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { NekroAssetAttachmentStore } from '../src/session-image-context.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('NekroAssetAttachmentStore', () => {
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
