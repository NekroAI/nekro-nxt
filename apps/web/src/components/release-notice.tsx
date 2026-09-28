import { useState, useSyncExternalStore } from 'react'
import { hostReleaseGuard } from '../host-release-guard.js'
import { useProductRuntime } from '../product-runtime.js'
import { hasUnsavedFormDrafts } from '../unsaved-drafts.js'
import { saveChannelDraftRecovery } from '../channel-draft-recovery.js'
import { Button, ConfirmDialog } from '../ui-kit/index.js'
import { InlineFeedback } from './product-feedback.js'

export function ReleaseNotice() {
  const state = useSyncExternalStore(
    hostReleaseGuard.subscribe,
    hostReleaseGuard.getSnapshot,
    hostReleaseGuard.getSnapshot,
  )
  const { uiStore } = useProductRuntime()
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState('')
  if (!state.mismatch) return null
  const reload = (): boolean => {
    if (!saveChannelDraftRecovery(uiStore.getState().channelDrafts)) {
      setError('浏览器无法暂存频道草稿，请先复制内容再刷新。')
      return false
    }
    window.location.reload()
    return true
  }
  return (
    <div data-release-mismatch="">
      <InlineFeedback tone="warning">
        <strong>服务已升级，请刷新页面</strong>
        <p>当前页面已停止提交操作，输入仍保留在页面中。刷新会保留频道消息草稿；其他未保存的表单请先复制。</p>
        <Button
          size="small"
          onClick={() => {
            if (hasUnsavedFormDrafts()) setConfirm(true)
            else reload()
          }}
        >
          保留频道草稿并刷新
        </Button>
        {error ? <p role="alert">{error}</p> : null}
      </InlineFeedback>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="刷新前保留未保存的表单"
        description="频道消息草稿会在刷新后恢复。其他表单有未保存的输入，请先复制需要保留的内容；刷新后这些表单输入会丢失。"
        cancelLabel="返回复制内容"
        confirmLabel="已保留内容，刷新"
        onConfirm={reload}
      />
    </div>
  )
}
