import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef, SaveImageAttachment, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { ChannelId } from '@nekro-nxt/contracts'
import type { AssetService } from '@nekro-nxt/core'
import type { AssetAccessRepository, NekroAssetAttachmentStore } from './session-image-context.js'

/** The Session whose tool call is running, so a plugin's image lands in that Session's channel. */
const runningToolSession = new AsyncLocalStorage<string>()

/**
 * Remembers which Session each tool call runs in for the duration of the call, including the plugin code it awaits.
 * Returns the disposer.
 */
export const trackToolCallSessions = (context: Context): (() => void) =>
  context.on('tools/execute', (exec, next) => {
    const sessionId = exec.agent?.id
    return sessionId === undefined ? next() : runningToolSession.run(String(sessionId), next)
  })

/**
 * The `attachments` service a third-party DSH plugin receives once an administrator allows it to submit images (附加功能
 * F11): `saveImage` stores the picture as an Asset of the channel whose tool call is running and returns the
 * reference the plugin puts in its tool result. Reads go to the Host store; nothing else of it is exposed.
 */
export const channelImageSubmission = (input: {
  readonly store: () => NekroAssetAttachmentStore
  readonly channelOf: (sessionId: string) => ChannelId | undefined
  readonly assets: Pick<AssetAccessRepository, 'grantAssetAccess'>
  readonly assetService: Pick<AssetService, 'prepare'>
  readonly now?: () => number
}) => {
  const now = input.now ?? Date.now
  const saveImage = async (image: SaveImageAttachment): Promise<ImageAttachmentRef> => {
    const sessionId = runningToolSession.getStore()
    const channelId = sessionId === undefined ? undefined : input.channelOf(sessionId)
    if (channelId === undefined) {
      throw new Error('Images can be submitted only from a tool call that runs in a channel.')
    }
    const store = input.store()
    await store.validateImage(image)
    const { asset } = await input.assetService.prepare({ bytes: image.data, declaredMediaType: image.mediaType })
    if (!asset.mediaType.startsWith('image/')) throw new Error(`Submitted image decodes as ${asset.mediaType}.`)
    input.assets.grantAssetAccess({ assetId: asset.id, channelId, source: 'agent-tool', grantedAt: now() })
    return store.refForAsset(asset, image.name)
  }
  return {
    get imageLimits() {
      return input.store().imageLimits
    },
    validateImage: (image: SaveImageAttachment): Promise<void> => input.store().validateImage(image),
    saveImage,
    async saveImages(images: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]> {
      const refs: ImageAttachmentRef[] = []
      for (const image of images) refs.push(await saveImage(image))
      return refs
    },
    readImage: (ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> =>
      input.store().readImage(ref, signal),
    isAttachmentError: (error: unknown): boolean => input.store().isAttachmentError(error),
  }
}
