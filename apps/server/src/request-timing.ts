import type { Context } from '@deepseek-ai/cordis'
import type { DeepSeekLlmApiExtensionRequest, DeepSeekLlmApiJson } from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { HostLogScope } from '@nekro-nxt/contracts'
import { MODEL_RUNTIME_LOG_SOURCE } from './logs/session.js'
import type { HostLogSink } from './logs/service.js'

/** Time from step start to request dispatch above which the host logs a warning. */
export const SLOW_REQUEST_DISPATCH_MS = 5_000

/** When a DeepSeek request left NekroNXT, and what images it carried. Informational; never model-visible. */
export interface RequestSentData {
  readonly turn: number
  readonly step: number
  /** Time spent before dispatch: image preparation and upload, extension preparation. */
  readonly beforeRequestMs: number
  readonly images: number
  /** Images that went by Files API id rather than inline. */
  readonly fileImages: number
  /** Images uploaded again although the previous request already carried them. */
  readonly reuploadedImages: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'nekro-nxt/request-sent': RequestSentData
  }
}

declare module '@deepseek-ai/dsh-deepseek-llm-api-extensions' {
  interface DeepSeekLlmApiExtensionMap {
    /** Registered only to observe dispatch; it never contributes a value. */
    nekro_nxt_request_timing: null
  }
}

interface ImageFacts {
  readonly images: number
  readonly fileIds: ReadonlySet<string>
}

/** Every image block in the serialized request, including those inside tool results. */
export const requestImageFacts = (body: DeepSeekLlmApiExtensionRequest['body']): ImageFacts => {
  let images = 0
  const fileIds = new Set<string>()
  const visit = (value: DeepSeekLlmApiJson | undefined): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (value === null || typeof value !== 'object') return
    if (value['type'] === 'image') {
      images += 1
      const source = value['source']
      if (source !== null && typeof source === 'object' && !Array.isArray(source) && source['type'] === 'file') {
        const fileId = source['file_id']
        if (typeof fileId === 'string') fileIds.add(fileId)
      }
      return
    }
    for (const child of Object.values(value)) visit(child)
  }
  visit(body['messages'])
  return { images, fileIds }
}

/**
 * A stable image keeps its file id from one request to the next. Ids the previous request did not carry are new
 * uploads; beyond the images the history gained since then, they are the same pictures uploaded again.
 */
export const reuploadedImageCount = (previous: ImageFacts | undefined, current: ImageFacts): number => {
  if (previous === undefined) return 0
  let fresh = 0
  for (const id of current.fileIds) if (!previous.fileIds.has(id)) fresh += 1
  return Math.max(0, fresh - Math.max(0, current.images - previous.images))
}

/**
 * Records when each official DeepSeek request is dispatched. Image upload happens inside the adapter before
 * dispatch, so without this the time-to-first-token silently includes it.
 */
export function mountRequestTiming(
  context: Context,
  diagnostics?: {
    readonly logs: Pick<HostLogSink, 'write'>
    scopeOf(sessionId: string): HostLogScope | undefined
  },
): void {
  const steps = new WeakMap<Session, { readonly turn: number; readonly step: number; readonly at: number }>()
  const previousImages = new WeakMap<Session, ImageFacts>()
  context.on('session/event', (session, event) => {
    if (event.type === 'step/start')
      steps.set(session, { turn: event.data.turn, step: event.data.step, at: event.time })
  })
  context.deepseekLlmApiExtensions.register('nekro_nxt_request_timing', {
    prepare: (request) => {
      if (request.sessionId === undefined || request.purpose !== undefined) return undefined
      const session = context.sessions.get(SessionId(request.sessionId))
      const step = session === undefined ? undefined : steps.get(session)
      if (session === undefined || step === undefined) return undefined
      const images = requestImageFacts(request.body)
      const data: RequestSentData = {
        turn: step.turn,
        step: step.step,
        beforeRequestMs: Math.max(0, Date.now() - step.at),
        images: images.images,
        fileImages: images.fileIds.size,
        reuploadedImages: reuploadedImageCount(previousImages.get(session), images),
      }
      previousImages.set(session, images)
      session.append('nekro-nxt/request-sent', data)
      if (diagnostics && (data.beforeRequestMs >= SLOW_REQUEST_DISPATCH_MS || data.reuploadedImages > 0)) {
        const scope = diagnostics.scopeOf(request.sessionId)
        diagnostics.logs.write({
          level: 'warn',
          message:
            data.reuploadedImages > 0
              ? `模型请求发出前用了 ${Math.round(data.beforeRequestMs / 1000)} 秒，其中 ${data.reuploadedImages} 张图片被重复上传`
              : `模型请求发出前用了 ${Math.round(data.beforeRequestMs / 1000)} 秒（${data.images} 张图片）`,
          source: MODEL_RUNTIME_LOG_SOURCE,
          ...(scope === undefined ? {} : { scope }),
          details: { ...data },
        })
      }
      return undefined
    },
  })
}
