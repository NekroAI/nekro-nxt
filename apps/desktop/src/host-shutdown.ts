export const HOST_STOP_GRACE_MS = 15_000
export const HOST_FORCE_EXIT_WAIT_MS = 5_000

export type HostStopWaitReason = 'protected-operation' | 'force-failed'

/** Never reports completion before exit, and never force-stops a protected operation. */
export async function waitForHostShutdown(input: {
  readonly exited: Promise<unknown>
  readonly forceTerminate?: () => void
  readonly onWaiting: (reason: HostStopWaitReason, signal: AbortSignal) => void
}): Promise<void> {
  const settled = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const notify = (reason: HostStopWaitReason): void => {
    if (!settled.signal.aborted) input.onWaiting(reason, settled.signal)
  }
  timer = setTimeout(() => {
    if (input.forceTerminate === undefined) {
      notify('protected-operation')
      return
    }
    try {
      input.forceTerminate()
      timer = setTimeout(() => notify('force-failed'), HOST_FORCE_EXIT_WAIT_MS)
    } catch {
      notify('force-failed')
    }
  }, HOST_STOP_GRACE_MS)
  try {
    await input.exited
  } finally {
    clearTimeout(timer)
    settled.abort()
  }
}
