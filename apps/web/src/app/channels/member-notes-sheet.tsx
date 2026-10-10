import { useEffect, useState } from 'react'
import type { HostApiResponse } from '@nekro-nxt/contracts'
import { workspaceApi } from '../../host-api-client.js'
import { Button, ConfirmDialog, EmptyState, Input, Sheet, Spinner, Textarea, toast } from '../../ui-kit/index.js'
import sheetStyles from './channel-prompt-sheet.module.css'
import styles from './channels.module.css'
import { relativeTime } from './timeline-model.js'

export type MemberNotesView = HostApiResponse<'getChannelMemberNotes'>
type MemberNote = MemberNotesView['notes'][number]

const failure = (error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })

/** What the agent keeps about each member of this channel; an admin can correct or forget any of it. */
export function MemberNotesSheet({
  open,
  onOpenChange,
  channelId,
  channelName,
  view,
  onChanged,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly channelId: string
  readonly channelName: string
  readonly view: MemberNotesView | undefined
  readonly onChanged: (view: MemberNotesView) => void
}) {
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<{ readonly memberId: string; readonly text: string } | undefined>()
  const [forgetting, setForgetting] = useState<MemberNote | undefined>()
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (open) return
    setQuery('')
    setEditing(undefined)
  }, [open])

  const save = async (memberId: string, text: string) => {
    setSaving(true)
    try {
      onChanged(await workspaceApi.updateChannelMemberNote(channelId, memberId, { text }))
      setEditing(undefined)
    } catch (error) {
      failure(error)
    } finally {
      setSaving(false)
    }
  }

  const keyword = query.trim().toLocaleLowerCase()
  const notes = (view?.notes ?? []).filter(
    (note) =>
      keyword.length === 0 ||
      (note.displayName ?? '').toLocaleLowerCase().includes(keyword) ||
      note.text.toLocaleLowerCase().includes(keyword) ||
      note.memberId.toLocaleLowerCase().includes(keyword),
  )

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={`「${channelName}」的成员笔记`}>
      {!view ? (
        <div className={sheetStyles.loading}>
          <Spinner />
        </div>
      ) : view.notes.length === 0 ? (
        <EmptyState title="还没有成员笔记">有人告诉智能体称呼、近况或喜好时，它会记在这个人名下。</EmptyState>
      ) : (
        <div className={styles.memberNotes}>
          <Input
            aria-label="查找成员笔记"
            placeholder={`在 ${view.notes.length} 位成员中查找`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <ul className={styles.memberNoteList}>
            {notes.map((note) => {
              const draft = editing?.memberId === note.memberId ? editing : undefined
              return (
                <li key={note.memberId} className={styles.memberNote}>
                  <div className={styles.memberNoteHead}>
                    <span className={styles.memberNoteName}>{note.displayName ?? '未知成员'}</span>
                    <span className={styles.memoryMeta}>
                      {note.updatedBy === 'admin' ? '管理员' : '智能体'}更新 · {relativeTime(note.updatedAt)}
                    </span>
                  </div>
                  {draft ? (
                    <>
                      <Textarea
                        aria-label={`${note.displayName ?? '成员'}的笔记`}
                        rows={3}
                        value={draft.text}
                        onChange={(event) => setEditing({ memberId: note.memberId, text: event.target.value })}
                      />
                      <div className={styles.memberNoteActions}>
                        <span
                          className={styles.memoryMeta}
                          data-over={draft.text.trim().length > view.maxChars || undefined}
                        >
                          {draft.text.trim().length} / {view.maxChars} 字
                        </span>
                        <Button size="small" onClick={() => setEditing(undefined)}>
                          取消
                        </Button>
                        <Button
                          size="small"
                          variant="primary"
                          disabled={saving || draft.text.trim().length > view.maxChars}
                          onClick={() => void save(note.memberId, draft.text)}
                        >
                          保存
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className={styles.memberNoteText}>{note.text}</p>
                      <div className={styles.memberNoteActions}>
                        <Button
                          size="small"
                          variant="ghost"
                          onClick={() => setEditing({ memberId: note.memberId, text: note.text })}
                        >
                          编辑
                        </Button>
                        <Button
                          size="small"
                          variant="ghost"
                          className={styles.contextDanger}
                          onClick={() => setForgetting(note)}
                        >
                          忘掉
                        </Button>
                      </div>
                    </>
                  )}
                </li>
              )
            })}
          </ul>
          {notes.length === 0 ? <p className={styles.memoryEmpty}>没有找到。</p> : null}
        </div>
      )}
      <ConfirmDialog
        open={forgetting !== undefined}
        onOpenChange={(next) => !next && setForgetting(undefined)}
        title={`忘掉关于${forgetting?.displayName ?? '这位成员'}的笔记？`}
        confirmLabel="忘掉"
        danger
        onConfirm={async () => {
          if (forgetting === undefined) return
          onChanged(await workspaceApi.updateChannelMemberNote(channelId, forgetting.memberId, { text: '' }))
          setForgetting(undefined)
        }}
      >
        聊天记录保留，之后智能体可以重新记下。
      </ConfirmDialog>
    </Sheet>
  )
}
