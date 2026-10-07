import { communityReviewLabel, HostApiContracts, type HostApiResponse } from '@nekro-nxt/contracts'
import { useEffect, useState } from 'react'
import { callHostApi } from '../../host-api-client.js'
import type { LocalExtensionSummary } from '../../product-runtime.js'
import { Banner, Button, Chip, Dialog, Field, Textarea, toast } from '../../ui-kit/index.js'
import { relativeTime } from '../channels/timeline-model.js'
import { openExternal, useCommunityStatus } from '../community/community-model.js'

type Revision = LocalExtensionSummary['revisions'][number]
type Published = HostApiResponse<'publishToCommunity'>

/**
 * 把一次保存发布到社区。发布内容就是导出的扩展包；社区会自动审查，审查完成前公开标注「风险未知」，
 * 发现泄露凭据等明确问题时不公开。
 */
export function PublishDialog({
  extension,
  revision,
  open,
  onOpenChange,
}: {
  readonly extension: LocalExtensionSummary
  readonly revision: Revision | undefined
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const community = useCommunityStatus(open)
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [published, setPublished] = useState<Published>()
  useEffect(() => {
    if (open) setPublished(undefined)
  }, [open])
  const account = community.status?.account ?? null

  const close = () => {
    if (busy) return
    onOpenChange(false)
    if (published) setNotes('')
  }

  const publish = async () => {
    if (!revision) return
    setBusy(true)
    try {
      setPublished(
        await callHostApi(
          HostApiContracts.publishToCommunity,
          {},
          { extensionId: extension.id, revisionId: revision.id, notes: notes.trim() },
        ),
      )
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
      void community.refresh()
    } finally {
      setBusy(false)
    }
  }

  const signIn = async () => {
    try {
      await community.signIn()
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
    }
  }

  if (published) {
    const label = communityReviewLabel(published.reviewStatus)
    // 只列出需要作者留意的检查结果；提示级信息在审查报告里查看。
    const notable = published.findings.filter((finding) => finding.severity !== 'info')
    return (
      <Dialog
        open={open}
        onOpenChange={(next) => !next && close()}
        title="已发布到社区"
        actions={
          <>
            <Button onClick={close}>完成</Button>
            <Button variant="primary" onClick={() => openExternal(published.reportUrl)}>
              查看审查报告
            </Button>
          </>
        }
      >
        <p>
          <Chip tone={label.tone}>{label.label}</Chip>
        </p>
        <p>
          {published.reviewStatus === 'rejected'
            ? '自动检查发现了必须修改的问题，这次发布不会公开。请查看审查报告，修改后重新保存并发布。'
            : '社区正在审查这次发布，通常几分钟内完成。审查报告里有安全、可靠性等方面的建议。'}
        </p>
        {notable.length > 0 ? (
          <ul>
            {notable.slice(0, 6).map((finding, index) => (
              <li key={index}>{finding.title}</li>
            ))}
          </ul>
        ) : null}
      </Dialog>
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && close()}
      title={`发布「${extension.name}」到社区`}
      actions={
        account ? (
          <>
            <Button onClick={close} disabled={busy}>
              取消
            </Button>
            <Button variant="primary" busy={busy} disabled={!revision} onClick={() => void publish()}>
              发布
            </Button>
          </>
        ) : (
          <>
            <Button onClick={close}>取消</Button>
            <Button variant="primary" onClick={() => void signIn()}>
              {community.waiting ? '重新打开授权页' : '登录社区'}
            </Button>
          </>
        )
      }
    >
      {community.status === undefined ? (
        <p>正在读取社区账号…</p>
      ) : account ? (
        <>
          <p>
            以 @{account.handle} 发布{revision ? `${relativeTime(revision.createdAt)}的保存` : '最新保存'}
            。所有人都能看到并安装它，同一个扩展再次发布会成为新的一次发布。
          </p>
          <Field label="更新说明" hint="可选。告诉使用者这次改了什么。">
            <Textarea value={notes} maxLength={2000} rows={3} onChange={(event) => setNotes(event.target.value)} />
          </Field>
          <Banner tone="info">
            社区会自动审查源码与权限并给出建议。审查完成前会标注「风险未知」；源码中包含凭据等明确问题时不会公开。
          </Banner>
        </>
      ) : (
        <>
          <p>发布需要先登录社区。登录在浏览器中完成，授权后回到这里继续。</p>
          {community.waiting ? <Banner tone="info">已在浏览器中打开社区授权页，完成后这里会自动更新。</Banner> : null}
        </>
      )}
    </Dialog>
  )
}
