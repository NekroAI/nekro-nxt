import { useEffect, useState } from 'react'
import { useProductStore } from '../../product-runtime.js'
import { Button, Dialog, Field, Input, Select, Textarea, toast } from '../../ui-kit/index.js'
import { useProductApi } from '../model/store.js'
import { SLUG_PATTERN, proposeSlug, type AuthoringTask } from './workshop-model.js'

/**
 * Saves the task's verified candidate as an immutable extension revision: either a new extension or the next
 * revision of an existing one. Saving never enables it.
 */
export function SaveDialog({
  open,
  onOpenChange,
  task,
  agentName,
  pluginId,
  packageId,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly task: AuthoringTask
  readonly agentName: string
  readonly pluginId: string
  readonly packageId: string
}) {
  const api = useProductApi()
  const extensions = useProductStore((state) => state.extensions)
  const [target, setTarget] = useState('')
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const existing = extensions.find((item) => item.id === target)

  useEffect(() => {
    if (!open) return
    const title = task.candidateAttempt?.name || task.title
    setTarget('')
    setName(title)
    setSlug(proposeSlug(title))
    setSlugEdited(false)
    setDescription(task.candidateAttempt?.purpose || task.requirementSummary)
    setError('')
    // Reset only when the dialog opens; live task updates must not wipe what the user typed.
  }, [open])

  const slugValid = existing !== undefined || SLUG_PATTERN.test(slug)
  const save = async () => {
    const candidate = task.candidateAttempt
    if (!candidate) return
    setBusy(true)
    setError('')
    try {
      await api.getState().saveDynamicExtension({
        taskId: task.id,
        attemptId: candidate.id,
        agentId: task.agentId,
        episodeId: task.episodeId,
        pluginId,
        packageId,
        name: existing?.name ?? name.trim(),
        slug: existing?.slug ?? slug,
        description: existing?.description ?? description.trim(),
        ...(existing ? { targetExtensionId: existing.id } : {}),
      })
      onOpenChange(false)
      toast(existing ? `已保存到「${existing.name}」` : `已保存「${name.trim()}」`)
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
      title="保存为本地扩展"
      actions={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!slugValid || (!existing && !name.trim())}
            onClick={() => void save()}
          >
            保存
          </Button>
        </>
      }
    >
      <Field label="保存到">
        <Select
          value={target}
          onValueChange={(value) => setTarget(value)}
          options={[
            { value: '', label: '新扩展' },
            ...extensions.map((item) => ({ value: item.id, label: `追加到「${item.name}」` })),
          ]}
        />
      </Field>
      {existing ? null : (
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
          <Field label="标识" error={slugValid ? undefined : '小写字母、数字和连字符，3–64 位'}>
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
