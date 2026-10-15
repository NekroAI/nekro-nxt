import { HostApiContracts, type ExtensionRequestView } from '@nekro-nxt/contracts'
import { ShieldQuestion } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { callHostApi } from '../../host-api-client.js'
import { useProductStore } from '../../product-runtime.js'
import {
  AgentAvatar,
  Button,
  Chip,
  Dialog,
  EmptyState,
  Field,
  Input,
  MainContent,
  ObjectHeader,
  PropertyGroup,
  toast,
  type Tone,
} from '../../ui-kit/index.js'
import { relativeTime } from '../channels/timeline-model.js'
import { agentHue } from '../model/identity.js'
import styles from './workshop.module.css'

const STATUS: Record<ExtensionRequestView['status'], { readonly label: string; readonly tone: Tone }> = {
  pending: { label: '等待确认', tone: 'warn' },
  approved: { label: '正在执行', tone: 'accent' },
  completed: { label: '已完成', tone: 'ok' },
  failed: { label: '执行失败', tone: 'bad' },
  rejected: { label: '已拒绝', tone: 'neutral' },
  expired: { label: '已过期', tone: 'neutral' },
}

const failure = (error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })

/**
 * Extension actions agents asked an administrator to confirm, and the record of what they did on their own. The same
 * requests can be answered in chat with `/ext approve N`; answering here posts the same notice in the channel.
 */
export function RequestsView() {
  const pending = useProductStore((state) => state.extensionRequests)
  const agents = useProductStore((state) => state.agents)
  const extensions = useProductStore((state) => state.extensions)
  const [history, setHistory] = useState<readonly ExtensionRequestView[]>()
  const [busy, setBusy] = useState<number>()
  const [rejecting, setRejecting] = useState<ExtensionRequestView>()
  const [reason, setReason] = useState('')
  useEffect(() => {
    callHostApi(HostApiContracts.listExtensionRequests, {}, undefined)
      .then((result) => setHistory(result.requests.filter((request) => request.status !== 'pending').slice(0, 30)))
      .catch(() => setHistory([]))
  }, [pending.length])

  const approve = async (request: ExtensionRequestView) => {
    setBusy(request.number)
    try {
      const result = await callHostApi(HostApiContracts.approveExtensionRequest, { number: request.number }, undefined)
      toast(result.message)
    } catch (error) {
      failure(error)
    } finally {
      setBusy(undefined)
    }
  }
  const reject = async () => {
    if (!rejecting) return
    setBusy(rejecting.number)
    try {
      await callHostApi(
        HostApiContracts.rejectExtensionRequest,
        { number: rejecting.number },
        reason.trim() ? { reason: reason.trim() } : {},
      )
      setRejecting(undefined)
      setReason('')
    } catch (error) {
      failure(error)
    } finally {
      setBusy(undefined)
    }
  }

  const row = (request: ExtensionRequestView, actions: boolean) => {
    const agent = agents.find((item) => item.id === request.agentId)
    const extension = extensions.find((item) => item.id === request.extensionId)
    const status = STATUS[request.status]
    return (
      <div key={request.number} className={styles.action} data-tone={actions ? 'warn' : undefined}>
        {agent ? <AgentAvatar name={agent.name} hue={agentHue(agent)} size="sm" /> : null}
        <div className={styles.actionText}>
          <b>
            #{request.number} {agent?.name ?? '智能体'}
            {request.autonomous ? '自主' : '请求'}
            {request.summary}
          </b>
          <span>
            {relativeTime(request.createdAt)}
            {extension ? (
              <>
                {' · '}
                <Link to={`/workshop/extensions/${extension.id}`} className={styles.metaLink}>
                  {extension.name}
                </Link>
              </>
            ) : null}
            {request.decidedBy && !request.autonomous ? ` · ${request.decidedBy}` : ''}
            {request.resultMessage ? ` · ${request.resultMessage}` : ''}
            {actions ? ` · ${relativeTime(request.expiresAt)}过期` : ''}
          </span>
        </div>
        {actions ? (
          <>
            <Button disabled={busy !== undefined} onClick={() => setRejecting(request)}>
              拒绝
            </Button>
            <Button variant="primary" busy={busy === request.number} onClick={() => void approve(request)}>
              同意
            </Button>
          </>
        ) : (
          <Chip tone={status.tone}>{request.autonomous && request.status === 'completed' ? '自主完成' : status.label}</Chip>
        )}
      </div>
    )
  }

  return (
    <MainContent width="readable">
      <ObjectHeader
        visual={
          <span className={styles.rowGlyph}>
            <ShieldQuestion size={18} />
          </span>
        }
        title="扩展请求"
        meta={<span>智能体的扩展操作，按它的扩展自主权需要管理员同意的会出现在这里</span>}
      />
      <PropertyGroup title="等待确认">
        {pending.length === 0 ? (
          <EmptyState title="没有等待确认的请求">智能体发出的请求会同时出现在频道里，管理员可以在聊天里用 /ext approve 编号 同意。</EmptyState>
        ) : (
          pending.map((request) => row(request, true))
        )}
      </PropertyGroup>
      {history && history.length > 0 ? (
        <PropertyGroup title="最近的记录" tip="包括智能体在自主权内直接完成的操作">
          {history.map((request) => row(request, false))}
        </PropertyGroup>
      ) : null}
      <Dialog
        open={rejecting !== undefined}
        onOpenChange={(open) => !open && setRejecting(undefined)}
        title={`拒绝请求 #${rejecting?.number ?? ''}？`}
        actions={
          <>
            <Button onClick={() => setRejecting(undefined)}>取消</Button>
            <Button variant="danger" busy={busy === rejecting?.number} onClick={() => void reject()}>
              拒绝
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>{rejecting?.summary}</p>
        <Field label="原因" hint="可选。会告诉智能体，它会据此调整，不会重复提出同一个请求。">
          <Input value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </Dialog>
    </MainContent>
  )
}
