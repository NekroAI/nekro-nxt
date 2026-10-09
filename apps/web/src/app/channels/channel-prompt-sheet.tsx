import { useEffect, useState } from 'react'
import {
  promptDocumentFromText,
  promptDocumentPlainText,
  type HostApiResponse,
  type PromptDocumentV1,
} from '@nekro-nxt/contracts'
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
  Textarea,
  toast,
} from '../../ui-kit/index.js'
import styles from './channel-prompt-sheet.module.css'

export type ChannelPromptView = HostApiResponse<'getChannelPrompt'>
type ChannelPromptPart = ChannelPromptView['instructions']
type Revision = ChannelPromptPart['revisions'][number]

const author = { admin: '管理员', agent: '智能体' } as const

export const promptTime = (at: number): string =>
  new Date(at).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })

/** One line describing who last changed a part and when. */
export const promptUpdateNote = (part: ChannelPromptPart): string | undefined =>
  part.updatedBy === undefined || part.updatedAt === undefined
    ? undefined
    : `${author[part.updatedBy]}于 ${promptTime(part.updatedAt)} 更新`

const preview = (document: PromptDocumentV1): string => {
  const text = promptDocumentPlainText(document).replace(/\s+/gu, ' ').trim()
  return text.length > 40 ? `${text.slice(0, 39)}…` : text || '（空）'
}

const same = (left: PromptDocumentV1, right: PromptDocumentV1): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

function Revisions({
  revisions,
  onRestore,
}: {
  readonly revisions: readonly Revision[]
  readonly onRestore: (document: PromptDocumentV1) => void
}) {
  if (revisions.length === 0) return null
  return (
    <details className={styles.history}>
      <summary>之前的版本 {revisions.length}</summary>
      <ul className={styles.revisions}>
        {revisions.map((revision) => (
          <li key={revision.revision} className={styles.revision}>
            <div className={styles.revisionText}>
              <span>{preview(revision.document)}</span>
              <span className={styles.note}>
                {author[revision.updatedBy]} · {promptTime(revision.updatedAt)}
              </span>
            </div>
            <Button size="small" variant="ghost" onClick={() => onRestore(revision.document)}>
              恢复
            </Button>
          </li>
        ))}
      </ul>
    </details>
  )
}

/**
 * Edits what the agent answering this channel reads about it: the admin's instructions, and the notes the agent
 * keeps itself (which the admin can correct, clear or lock). Earlier versions of both stay restorable.
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
  const [instructions, setInstructions] = useState<PromptDocumentV1>({ version: 1, segments: [] })
  const [instructionsLength, setInstructionsLength] = useState(0)
  const [notes, setNotes] = useState('')
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
        setInstructions(loaded.instructions.document)
        setInstructionsLength(promptDocumentPlainText(loaded.instructions.document).length)
        setNotes(promptDocumentPlainText(loaded.notes.document))
        setLocked(loaded.notes.locked)
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
    return () => controller.abort()
  }, [channelId, open, reload])

  const notesDocument = promptDocumentFromText(notes.trim())
  const instructionsChanged = view !== undefined && !same(instructions, view.instructions.document)
  const notesChanged = view !== undefined && (!same(notesDocument, view.notes.document) || locked !== view.notes.locked)
  const tooLong =
    view !== undefined && (instructionsLength > view.instructions.maxChars || notes.trim().length > view.notes.maxChars)

  const save = async () => {
    if (!view || tooLong) return
    setSaving(true)
    try {
      let saved = view
      if (instructionsChanged) {
        saved = await workspaceApi.updateChannelPrompt(channelId, {
          kind: 'instructions',
          document: instructions,
          locked: false,
          expectedRevision: view.instructions.revision,
        })
      }
      if (notesChanged) {
        saved = await workspaceApi.updateChannelPrompt(channelId, {
          kind: 'notes',
          document: notesDocument,
          locked,
          expectedRevision: view.notes.revision,
        })
      }
      onSaved(saved)
      if (instructionsChanged || notesChanged) toast('已保存，下一条消息起生效')
      onOpenChange(false)
    } catch (error) {
      if (error instanceof HostRequestError && error.status === 409) {
        toast('内容刚被修改过，已重新载入', { tone: 'bad' })
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
          <PropertyGroup title="频道说明" description="写给智能体的群规、话题范围、语气和称呼，只在这个频道生效。">
            <div className={styles.editor}>
              <PromptReferenceEditor
                value={instructions}
                {...(agentId === undefined ? {} : { currentAgentId: agentId })}
                label="频道说明"
                labelHidden
                description="输入 @ 可以引用成员、频道或扩展"
                placeholder="例如：本群讨论开源项目，回答附代码示例，不发广告。"
                onChange={(next, plainText) => {
                  setInstructions(next)
                  setInstructionsLength(plainText.length)
                }}
              />
              <div className={styles.count} data-over={instructionsLength > view.instructions.maxChars || undefined}>
                {instructionsLength} / {view.instructions.maxChars} 字
              </div>
            </div>
            {view.instructions.updatedBy !== undefined ? (
              <p className={styles.note}>{promptUpdateNote(view.instructions)}</p>
            ) : null}
            <Revisions
              revisions={view.instructions.revisions}
              onRestore={(document) => {
                setInstructions(document)
                setInstructionsLength(promptDocumentPlainText(document).length)
              }}
            />
          </PropertyGroup>

          <PropertyGroup title="智能体笔记" description="智能体自己记下的这个群的约定。解锁后它才能修改。">
            <div className={styles.editor}>
              <Textarea
                aria-label="智能体笔记"
                rows={6}
                value={notes}
                placeholder="智能体还没有记笔记"
                onChange={(event) => setNotes(event.target.value)}
              />
              <div className={styles.count} data-over={notes.trim().length > view.notes.maxChars || undefined}>
                {notes.trim().length} / {view.notes.maxChars} 字
              </div>
            </div>
            <PropertyList>
              <PropertyRow
                label="锁定"
                description={locked ? '智能体不能修改笔记' : '智能体可以根据对群的了解更新笔记'}
              >
                <Switch label="锁定智能体笔记" checked={locked} onCheckedChange={setLocked} />
              </PropertyRow>
            </PropertyList>
            {view.notes.updatedBy !== undefined ? <p className={styles.note}>{promptUpdateNote(view.notes)}</p> : null}
            <Revisions
              revisions={view.notes.revisions}
              onRestore={(document) => setNotes(promptDocumentPlainText(document))}
            />
          </PropertyGroup>
        </>
      )}
    </Sheet>
  )
}
