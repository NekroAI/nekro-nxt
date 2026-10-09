import {
  communityPublisherLabel,
  communityReviewLabel,
  type CommunityPermissionItem,
  type HostApiResponse,
} from '@nekro-nxt/contracts'
import { useEffect, useState, type ReactNode } from 'react'
import { useHostActions } from '../../product-runtime.js'
import { Button, Chip, Dialog, Field, Input, toast } from '../../ui-kit/index.js'
import { SLUG_PATTERN, providesLabel } from './workshop-model.js'

type Inspection = HostApiResponse<'inspectExtensionImport'>

/** 社区来源的导入额外说明审查结论：安装者在确认前再看一次。 */
export function CommunityImportNote({
  publisher,
  status,
  addedPermissions = [],
}: {
  readonly publisher: string
  readonly status: Parameters<typeof communityReviewLabel>[0] | undefined
  readonly addedPermissions?: readonly CommunityPermissionItem[]
}) {
  const label = status ? communityReviewLabel(status) : undefined
  return (
    <>
      {addedPermissions.length > 0 ? (
        <p>这次发布新增了权限：{addedPermissions.map((item) => item.label).join('、')}。启用时会再次请你确认。</p>
      ) : null}
      <p>
        来自社区 {communityPublisherLabel(publisher)}
        {label ? (
          <>
            {' · '}
            <Chip tone={label.tone}>{label.label}</Chip>
          </>
        ) : null}
      </p>
    </>
  )
}

/** The confirmation step shared by file and community imports; the package was already checked by the Host. */
export function ImportDialog({
  inspection,
  note,
  onClose,
  onImported,
}: {
  readonly inspection: Inspection | undefined
  readonly note: ReactNode
  readonly onClose: () => void
  readonly onImported: (extensionId: string) => void
}) {
  const hostActions = useHostActions()
  const [slug, setSlug] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (inspection) setSlug(inspection.slugConflict ? `${inspection.slug}-2` : inspection.slug)
  }, [inspection?.token])

  const commit = async () => {
    if (!inspection) return
    setBusy(true)
    try {
      const result = await hostActions['extensions.commitImport']({
        token: inspection.token,
        ...(inspection.slugConflict ? { localSlug: slug } : {}),
      })
      toast(result.idempotent ? '本机已有相同的保存记录' : '已导入，尚未启用')
      onImported(result.extensionId)
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={inspection !== undefined}
      onOpenChange={(open) => !open && !busy && onClose()}
      title={`导入「${inspection?.displayName ?? ''}」`}
      actions={
        <>
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={inspection?.slugConflict === true && !SLUG_PATTERN.test(slug)}
            onClick={() => void commit()}
          >
            {inspection?.idempotent ? '确认' : '导入'}
          </Button>
        </>
      }
    >
      {inspection ? (
        <>
          <div>
            <Chip>{providesLabel(inspection.provides)}</Chip>
          </div>
          {note}
          <p>{inspection.idempotent ? '本机已有完全相同的保存记录。' : '导入后不会自动启用。'}</p>
          {inspection.slugConflict ? (
            <Field label="标识" hint="原标识已被占用">
              <Input value={slug} spellCheck={false} onChange={(event) => setSlug(event.target.value.trim())} />
            </Field>
          ) : null}
        </>
      ) : null}
    </Dialog>
  )
}
