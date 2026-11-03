import { useEffect } from 'react'
import { ConfirmDialog, toast } from '../../ui-kit/index.js'
import { useProductApi } from '../model/store.js'
import type { ChannelRuntimeView } from '../../product-model.js'

export type ContextReset = 'compact' | 'clear'

/** Compactions started from this page, by channel: the session they close and when, so the end is announced once. */
const startedCompactions = new Map<string, { readonly episodeId: string; readonly at: number }>()

/** Confirms 「压缩上下文」 or 「清空上下文」 for one channel's current session. */
export function ContextResetDialog({
  channelId,
  episodeId,
  reset,
  onClose,
}: {
  readonly channelId: string
  readonly episodeId: string | undefined
  readonly reset: ContextReset | null
  readonly onClose: () => void
}) {
  const api = useProductApi()
  return (
    <ConfirmDialog
      open={reset !== null}
      onOpenChange={(open) => !open && onClose()}
      title={reset === 'clear' ? '清空上下文？' : '压缩上下文？'}
      confirmLabel={reset === 'clear' ? '清空' : '压缩'}
      danger={reset === 'clear'}
      onConfirm={async () => {
        if (!episodeId || !reset) return
        if (reset === 'compact') startedCompactions.set(channelId, { episodeId, at: Date.now() })
        try {
          await api.getState().resetChannelContext(channelId, episodeId, reset)
        } catch (error) {
          startedCompactions.delete(channelId)
          throw error
        }
        if (reset === 'clear') toast('已清空上下文')
      }}
    >
      <p>
        {reset === 'clear'
          ? '当前任务会停止，从空白开始。聊天记录保留。'
          : '当前任务会停止，对话整理成摘要后继续。压缩在后台进行，不影响其他操作。'}
      </p>
    </ConfirmDialog>
  )
}

/** Announces the end of a compaction started from this page: a new session is open. A failure shows in the timeline. */
export function useCompactionDoneToast(channelId: string, runtime: ChannelRuntimeView | undefined) {
  const episodeId = runtime?.episodeId
  const compacting = runtime?.compaction !== undefined
  const failedAt = runtime?.compactionFailure?.at
  useEffect(() => {
    const started = startedCompactions.get(channelId)
    if (started === undefined) return
    if (failedAt !== undefined && failedAt >= started.at) startedCompactions.delete(channelId)
    else if (!compacting && episodeId !== undefined && episodeId !== started.episodeId) {
      startedCompactions.delete(channelId)
      toast('已压缩上下文')
    }
  }, [channelId, episodeId, compacting, failedAt])
}
