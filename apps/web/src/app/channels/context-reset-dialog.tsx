import { ConfirmDialog, toast } from '../../ui-kit/index.js'
import { useProductApi } from '../model/store.js'

export type ContextReset = 'compact' | 'clear'

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
        await api.getState().resetChannelContext(channelId, episodeId, reset)
        toast(reset === 'clear' ? '已清空上下文' : '已压缩上下文')
      }}
    >
      <p>
        {reset === 'clear' ? '当前任务会停止，从空白开始。聊天记录保留。' : '当前任务会停止，对话整理成摘要后继续。'}
      </p>
    </ConfirmDialog>
  )
}
