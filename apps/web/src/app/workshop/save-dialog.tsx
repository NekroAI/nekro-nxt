import { useEffect, useState } from 'react'
import { useProductStore } from '../../product-runtime.js'
import { Button, Dialog, Field, Input, Textarea, toast } from '../../ui-kit/index.js'
import { useProductApi } from '../model/store.js'
import { SLUG_PATTERN, proposeSlug, type AuthoringTask } from './workshop-model.js'

/**
 * Saves the task's verified candidate as an immutable version. A revise task always becomes the next version of the
 * extension it changes; a new task becomes a new extension. Saving never enables it.
 */
export function SaveDialog({
  open,
  onOpenChange,
  task,
  agentName,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly task: AuthoringTask
  readonly agentName: string
}) {
  const api = useProductApi()
  const target = useProductStore((state) =>
    task.kind === 'revise' ? state.extensions.find((item) => item.id === task.targetExtensionId) : undefined,
  )
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    const title = task.candidateAttempt?.name || task.title
    setName(title)
    setSlug(proposeSlug(title))
    setSlugEdited(false)
    setDescription(task.candidateAttempt?.purpose || task.requirementSummary)
    setError('')
    // Reset only when the dialog opens; live task updates must not wipe what the user typed.
  }, [open])

  const revising = task.kind === 'revise'
  const valid = revising ? target !== undefined : SLUG_PATTERN.test(slug) && name.trim() !== ''
  const save = async () => {
    const candidate = task.candidateAttempt
    if (!candidate) return
    setBusy(true)
    setError('')
    try {
      await api.getState().saveDynamicExtension({
        taskId: task.id,
        attemptId: candidate.id,
        name: target?.name ?? name.trim(),
        slug: target?.slug ?? slug,
        description: target?.description ?? description.trim(),
      })
      onOpenChange(false)
      toast(target ? `已保存为「${target.name}」的新版本` : `已保存「${name.trim()}」`)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !busy && onOpenChange(next)}
      title={revising ? `保存「${target?.name ?? '扩展'}」的新版本` : '保存为新扩展'}
      actions={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" busy={busy} disabled={!valid} onClick={() => void save()}>
            保存
          </Button>
        </>
      }
    >
      {revising ? (
        target ? (
          <p style={{ margin: 0 }}>
            保存后成为「{target.name}」的下一个版本，接在{' '}
            {target.revisions.find((item) => item.id === task.baseRevisionId)?.versionLabel ?? '修改时的版本'}{' '}
            之后。正在使用的版本不变，需要时在扩展详情里切换。
          </p>
        ) : (
          <p role="alert" style={{ margin: 0, color: 'var(--bad)' }}>
            要修改的扩展已经不在本机，这个任务无法保存。
          </p>
        )
      ) : (
        <>
          <Field label="名称">
            <Input
              value={name}
              maxLength={80}
              onChange={(event) => {
                setName(event.target.value)
                if (!slugEdited) setSlug(proposeSlug(event.target.value))
              }}
            />
          </Field>
          <Field label="标识" error={SLUG_PATTERN.test(slug) ? undefined : '小写字母、数字和连字符，3–64 位'}>
            <Input
              value={slug}
              spellCheck={false}
              onChange={(event) => {
                setSlugEdited(true)
                setSlug(event.target.value.trim())
              }}
            />
          </Field>
          <Field label="说明">
            <Textarea
              value={description}
              maxLength={500}
              rows={3}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
        </>
      )}
      <p style={{ margin: 0, color: 'var(--muted)', fontSize: 'var(--fs-xs)' }}>
        保存后不会自动启用，{agentName}仍使用原有能力。
      </p>
      {error ? (
        <p role="alert" style={{ margin: 0, color: 'var(--bad)' }}>
          {error}
        </p>
      ) : null}
    </Dialog>
  )
}
