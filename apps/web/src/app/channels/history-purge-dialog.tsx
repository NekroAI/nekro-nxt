import { useEffect, useState } from 'react'
import type { HostApiResponse } from '@nekro-nxt/contracts'
import { Banner, ConfirmDialog, Field, Input, Skeleton, toast } from '../../ui-kit/index.js'
import { useProductApi } from '../model/store.js'
import styles from './channels.module.css'

type Preview = HostApiResponse<'previewChannelHistoryPurge'>

/** Confirms 「彻底清除」: shows what will be deleted and asks for the channel name. */
export function HistoryPurgeDialog({
  open,
  onOpenChange,
  channelId,
  channelName,
  boundAgentId,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly channelId: string
  readonly channelName: string
  readonly boundAgentId: string | null
}) {
  const api = useProductApi()
  const [preview, setPreview] = useState<Preview | undefined>()
  const [error, setError] = useState('')
  const [typed, setTyped] = useState('')

  useEffect(() => {
    if (!open) return
    let current = true
    setPreview(undefined)
    setError('')
    setTyped('')
    api
      .getState()
      .previewChannelHistoryPurge(channelId)
      .then((next) => current && setPreview(next))
      .catch((failure: unknown) => current && setError(failure instanceof Error ? failure.message : String(failure)))
    return () => {
      current = false
    }
  }, [api, channelId, open])

  const blocked = preview?.blockedReason
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`彻底清除「${channelName}」的聊天记录？`}
      confirmLabel="彻底清除"
      danger
      confirmDisabled={preview === undefined || blocked !== undefined || typed.trim() !== channelName}
      onConfirm={async () => {
        const result = await api.getState().purgeChannelHistory(channelId, boundAgentId)
        toast(`已删除 ${result.messages} 条消息`)
      }}
    >
      {error ? <Banner tone="bad">{error}</Banner> : null}
      {preview === undefined && !error ? <Skeleton height={56} /> : null}
      {preview ? (
        <>
          <dl className={styles.purgeFacts}>
            <div>
              <dt>消息</dt>
              <dd>{preview.messages} 条</dd>
            </div>
            <div>
              <dt>对话</dt>
              <dd>{preview.conversations} 段</dd>
            </div>
            <div>
              <dt>附件</dt>
              <dd>{preview.attachments} 个</dd>
            </div>
          </dl>
          <p>删除后无法恢复，智能体也查不到。别处还在用的附件保留。</p>
          <p>保留：频道和绑定、频道说明、成员笔记、扩展数据。</p>
        </>
      ) : null}
      {blocked ? <Banner tone="warn">{blocked}</Banner> : null}
      {preview && !blocked ? (
        <Field label={`输入“${channelName}”确认`}>
          <Input value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" />
        </Field>
      ) : null}
    </ConfirmDialog>
  )
}
