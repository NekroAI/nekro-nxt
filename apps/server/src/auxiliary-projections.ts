import type { AgentImageDiagnostics } from './session-image-context.js'

/** Optional diagnostics must not prevent the workspace's durable facts from loading. */
export async function optionalProjection<T, F>(read: () => Promise<T>, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise<F>((resolve) => {
        timer = setTimeout(() => resolve(fallback), 2000)
        timer.unref()
      }),
    ])
  } catch {
    return fallback
  } finally {
    clearTimeout(timer)
  }
}

export const unavailableImageDiagnostics: AgentImageDiagnostics = {
  route: { mode: 'unavailable' },
  activeSessions: 0,
  residentImages: 0,
  duplicateImagesSkipped: 0,
  blockers: ['暂时无法读取视觉状态，请稍后重试。'],
}
