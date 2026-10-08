import { useEffect, useState } from 'react'
import { promptDocumentPlainText, type HostApiResponse, type PromptDocumentV1 } from '@nekro-nxt/contracts'
import { HostRequestError, workspaceApi } from '../../host-api-client.js'
import { PromptReferenceEditor } from '../../components/prompt-reference-editor.js'
import {
  Button,
  EmptyState,
  PropertyGroup,
  PropertyList,
  PropertyRow,
  Sheet,
  Spinner,
  Switch,
  toast,
} from '../../ui-kit/index.js'
import styles from './channel-prompt-sheet.module.css'

export type ChannelPromptView = HostApiResponse<'getChannelPrompt'>

const author = { admin: '管理员', agent: '智能体' } as const

export const promptTime = (at: number): string =>
  new Date(at).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })

/** One line describing who last changed a prompt and when. */
export const promptUpdateNote = (view: ChannelPromptView): string | undefined =>
  view.updatedBy === undefined || view.updatedAt === undefined
    ? undefined
    : `${author[view.updatedBy]}于 ${promptTime(view.updatedAt)} 更新`

const preview = (document: PromptDocumentV1): string => {
  const text = promptDocumentPlainText(document).replace(/\s+/gu, ' ').trim()
  return text.length > 40 ? `${text.slice(0, 39)}…` : text || '（空）'
}

/**
 * Edits the channel's own instructions for whoever answers it. The agent may rewrite them too unless they are locked;
 * earlier versions stay restorable because of that.
 */
export function ChannelPromptSheet({
  open,
  onOpenChange,
  channelId,
  channelName,
  agentId,
  onSaved,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly channelId: string
  readonly channelName: string
  readonly agentId?: string | undefined
  readonly onSaved: (view: ChannelPromptView) => void
}) {
  const [view, setView] = useState<ChannelPromptView | undefined>()
  const [failed, setFailed] = useState(false)
  const [document, setDocument] = useState<PromptDocumentV1>({ version: 1, segments: [] })
  const [length, setLength] = useState(0)
  const [locked, setLocked] = useState(false)
  const [saving, setSaving] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (!open) return
    setView(undefined)
    setFailed(false)
    const controller = new AbortController()
    workspaceApi
      .getChannelPrompt(channelId, { signal: controller.signal })
      .then((loaded) => {
        setView(loaded)
        setDocument(loaded.document)
        setLength(promptDocumentPlainText(loaded.document).length)
        setLocked(loaded.locked)
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
    return () => controller.abort()
  }, [channelId, open, reload])

  const tooLong = view !== undefined && length > view.maxChars
  const save = async () => {
    if (!view || tooLong) return
    setSaving(true)
    try {
      const saved = await workspaceApi.updateChannelPrompt(channelId, {
        document,
        locked,
        expectedRevision: view.revision,
      })
      onSaved(saved)
      toast('频道说明已保存，从智能体下一次思考起生效')
      onOpenChange(false)
    } catch (error) {
      if (error instanceof HostRequestError && error.status === 409) {
        toast('频道说明刚被修改过，已重新载入', { tone: 'bad' })
        setReload((value) => value + 1)
      } else toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={`「${channelName}」的频道说明`}
      footer={
        view ? (
          <>
            <Button onClick={() => onOpenChange(false)}>取消</Button>
            <Button variant="primary" disabled={saving || tooLong} onClick={() => void save()}>
              {saving ? <Spinner /> : '保存'}
            </Button>
          </>
        ) : undefined
      }
    >
      {failed ? (
        <EmptyState title="读取失败">稍后再试。</EmptyState>
      ) : !view ? (
        <div className={styles.loading}>
          <Spinner />
        </div>
      ) : (
        <>
          <p className={styles.lead}>
            只在这个频道生效，例如群规、话题范围、语气和称呼。智能体的人设不变，换智能体时说明会保留。
          </p>
          <div className={styles.editor}>
            <PromptReferenceEditor
              value={document}
              {...(agentId === undefined ? {} : { currentAgentId: agentId })}
              label="频道说明"
              labelHidden
              description="输入 @ 可以引用成员、频道或扩展"
              placeholder="例如：本群讨论开源项目，回答附代码示例，不发广告。"
              onChange={(next, plainText) => {
                setDocument(next)
                setLength(plainText.length)
              }}
            />
            <div className={styles.count} data-over={tooLong || undefined}>
              {length} / {view.maxChars} 字
            </div>
          </div>
          <PropertyList>
            <PropertyRow
              label="锁定"
              description={locked ? '智能体不能修改' : '智能体可以根据对群的了解更新'}
              tip="未锁定时，智能体会把群里长期有效的要求和约定整理进这段说明；每次修改都能在下方找回。"
            >
              <Switch label="锁定频道说明" checked={locked} onCheckedChange={setLocked} />
            </PropertyRow>
          </PropertyList>
          {view.updatedBy !== undefined ? <p className={styles.note}>{promptUpdateNote(view)}</p> : null}
          {view.revisions.length > 0 ? (
            <PropertyGroup title="之前的版本" description="恢复后需要保存才会生效">
              <ul className={styles.revisions}>
                {view.revisions.map((revision) => (
                  <li key={revision.revision} className={styles.revision}>
                    <div className={styles.revisionText}>
                      <span>{preview(revision.document)}</span>
                      <span className={styles.note}>
                        {author[revision.updatedBy]} · {promptTime(revision.updatedAt)}
                      </span>
                    </div>
                    <Button
                      size="small"
                      variant="ghost"
                      onClick={() => {
                        setDocument(revision.document)
                        setLength(promptDocumentPlainText(revision.document).length)
                      }}
                    >
                      恢复
                    </Button>
                  </li>
                ))}
              </ul>
            </PropertyGroup>
          ) : null}
        </>
      )}
    </Sheet>
  )
}
