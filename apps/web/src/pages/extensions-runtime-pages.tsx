import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { EmptyState, InlineFeedback, PageHeader } from '../components/product-feedback.js'
import { useProductStore, type LocalExtensionSummary } from '../product-store.js'
import { Button, ConfirmDialog, StatusBadge, type StatusTone } from '../ui-kit/index.js'
import styles from './product-pages.module.css'

const extensionLabel = (activation: LocalExtensionSummary['activation']): string => {
  if (activation === '已激活') return '已启用'
  if (activation === '等待安全切换') return '等待切换'
  if (activation === '激活失败') return '启用失败'
  return '未启用'
}

const extensionTone = (activation: LocalExtensionSummary['activation']): StatusTone => {
  if (activation === '已激活') return 'success'
  if (activation === '等待安全切换') return 'warning'
  if (activation === '激活失败') return 'error'
  return 'neutral'
}

export function ExtensionsPage() {
  const host = useProductStore((state) => state.host)
  const extensions = useProductStore((state) => state.extensions)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<{ tone: 'error' | 'success'; message: string } | null>(null)

  const changeActivation = async (extension: LocalExtensionSummary): Promise<void> => {
    if (pendingId) return
    const enable = extension.activation !== '已激活'
    setPendingId(extension.id)
    setFeedback(null)
    try {
      await useProductStore.getState().setExtensionActive(extension.id, enable)
      setFeedback({ tone: 'success', message: `${extension.name}${enable ? '已启用' : '已停用'}。` })
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setPendingId(null)
    }
  }

  return (
    <div className={styles.page}>
      <PageHeader title="扩展" meta={extensions.length > 0 ? `${extensions.length} 个本地扩展` : undefined} />
      {feedback ? <InlineFeedback tone={feedback.tone}>{feedback.message}</InlineFeedback> : null}
      {extensions.length === 0 ? (
        <EmptyState
          loading={host.status === 'initializing'}
          title={host.status === 'initializing' ? '正在读取扩展' : '还没有本地扩展'}
          description={
            host.status === 'error'
              ? '当前无法读取扩展，请重新连接后再试。'
              : '保存后的扩展会显示在这里。动态运行中的内容不会自动保存。'
          }
        />
      ) : (
        <div className={styles.objectList} role="list">
          <div className={styles.extensionHeader} aria-hidden="true">
            <span>扩展</span>
            <span>使用者</span>
            <span>版本</span>
            <span>状态</span>
            <span />
          </div>
          {extensions.map((extension) => (
            <div className={styles.extensionRow} role="listitem" key={extension.id}>
              <div className={styles.truncate}>
                <div className={styles.objectName}>{extension.name}</div>
                {extension.description ? <div className={styles.secondaryText}>{extension.description}</div> : null}
              </div>
              <div className={styles.secondaryText}>{extension.targetAgent || '尚未指定'}</div>
              <div className={styles.secondaryText}>版本 {extension.revision}</div>
              <StatusBadge tone={extensionTone(extension.activation)}>
                {extensionLabel(extension.activation)}
              </StatusBadge>
              <Button
                size="small"
                variant={extension.activation === '已激活' ? 'danger' : 'secondary'}
                loading={pendingId === extension.id}
                loadingLabel="处理中…"
                disabled={pendingId !== null}
                onClick={() => void changeActivation(extension)}
              >
                {extension.activation === '已激活' ? '停用' : '启用'}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const dynamicStatus = (status: string): { readonly label: string; readonly tone: StatusTone } => {
  if (status === 'running') return { label: '运行中', tone: 'info' }
  if (status === 'awaiting-approval') return { label: '等待确认', tone: 'warning' }
  if (status === 'failed') return { label: '运行失败', tone: 'error' }
  if (status === 'stopped') return { label: '已停止', tone: 'neutral' }
  return { label: '状态待确认', tone: 'unknown' }
}

export function CreatorPage() {
  const host = useProductStore((state) => state.host)
  const dynamic = useProductStore((state) => state.dynamic)
  const agents = useProductStore((state) => state.agents)
  const [reviewIndex, setReviewIndex] = useState<number | null>(null)
  const [declinePending, setDeclinePending] = useState(false)
  const [feedback, setFeedback] = useState<{ tone: 'error' | 'success'; message: string } | null>(null)
  const reviewItem = reviewIndex === null ? undefined : dynamic[reviewIndex]

  const decline = async (): Promise<void> => {
    if (!reviewItem?.approvalRequestId || declinePending) return
    setDeclinePending(true)
    setFeedback(null)
    try {
      await useProductStore.getState().resolveApproval({
        requestId: reviewItem.approvalRequestId,
        agentId: reviewItem.agentId,
        approved: false,
      })
      setReviewIndex(null)
      setFeedback({ tone: 'success', message: '本次界面预览已拒绝。' })
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setDeclinePending(false)
    }
  }

  return (
    <div className={styles.page}>
      <PageHeader title="创造" meta="此页面不在一级导航中" />
      {feedback ? <InlineFeedback tone={feedback.tone}>{feedback.message}</InlineFeedback> : null}
      {dynamic.length === 0 ? (
        <EmptyState
          loading={host.status === 'initializing'}
          title={host.status === 'initializing' ? '正在读取动态状态' : '没有正在运行的创造任务'}
          description="当智能体开始动态创造后，真实运行状态会出现在这里。"
        />
      ) : (
        <section className={styles.section}>
          <div className={styles.sectionHeading}>动态运行</div>
          <div className={styles.compactList}>
            {dynamic.map((item, index) => {
              const presentation = dynamicStatus(item.status)
              const agentName = agents.find((agent) => agent.id === item.agentId)?.name ?? '未命名智能体'
              return (
                <div className={styles.staticRow} key={`${item.agentId}-${index}`}>
                  <span>
                    <strong>{agentName}的临时扩展</strong>
                    <small>动态运行 {index + 1}</small>
                  </span>
                  <span className={styles.rowActions}>
                    <StatusBadge tone={presentation.tone}>{presentation.label}</StatusBadge>
                    {item.status === 'awaiting-approval' && item.approvalRequestId ? (
                      <Button size="small" onClick={() => setReviewIndex(index)}>
                        审查界面预览
                      </Button>
                    ) : null}
                  </span>
                </div>
              )
            })}
          </div>
        </section>
      )}
      {reviewItem?.approvalRequestId ? (
        <ConfirmDialog
          open={reviewIndex !== null}
          onOpenChange={(open) => {
            if (!open && !declinePending) setReviewIndex(null)
          }}
          title="允许界面预览"
          description="允许后，这次动态运行可以在当前浏览器中显示界面。不会自动保存扩展。"
          confirmLabel="允许本次预览"
          onConfirm={async () => {
            setFeedback(null)
            try {
              await useProductStore.getState().resolveApproval({
                requestId: reviewItem.approvalRequestId!,
                agentId: reviewItem.agentId,
                approved: true,
              })
              setFeedback({ tone: 'success', message: '本次界面预览已允许。' })
              return true
            } catch (error) {
              setFeedback({ tone: 'error', message: error instanceof Error ? error.message : String(error) })
              return false
            }
          }}
        >
          <div className={styles.dialogChoice}>
            <InlineFeedback tone="warning">只允许你确认来源和用途的界面预览。</InlineFeedback>
            <Button variant="danger" loading={declinePending} loadingLabel="正在拒绝…" onClick={() => void decline()}>
              拒绝本次预览
            </Button>
          </div>
        </ConfirmDialog>
      ) : null}
    </div>
  )
}

export function RuntimePage() {
  const host = useProductStore((state) => state.host)
  const agents = useProductStore((state) => state.agents)
  const dynamic = useProductStore((state) => state.dynamic)
  const activeAgents = agents.filter((agent) => agent.state !== '空闲')
  const [refreshPending, setRefreshPending] = useState(false)
  const [refreshError, setRefreshError] = useState('')

  const refresh = async (): Promise<void> => {
    if (refreshPending) return
    setRefreshPending(true)
    setRefreshError('')
    try {
      await useProductStore.getState().refreshHost()
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : String(error))
    } finally {
      setRefreshPending(false)
    }
  }

  return (
    <div className={styles.page}>
      <PageHeader
        title="运行"
        meta={activeAgents.length > 0 || dynamic.length > 0 ? '来自当前快照' : undefined}
        actions={
          <Button loading={refreshPending} loadingLabel="刷新中…" onClick={() => void refresh()}>
            <RefreshCw size={14} aria-hidden="true" /> 刷新状态
          </Button>
        }
      />
      {refreshError ? <InlineFeedback tone="error">刷新失败：{refreshError}</InlineFeedback> : null}
      {activeAgents.length === 0 && dynamic.length === 0 ? (
        <EmptyState
          loading={host.status === 'initializing'}
          title={host.status === 'initializing' ? '正在读取运行状态' : '当前没有活跃任务'}
          description="智能体开始处理消息或动态创造后，状态会显示在这里。"
        />
      ) : (
        <div className={styles.runtimeColumns}>
          <section className={styles.section}>
            <div className={styles.sectionHeading}>智能体状态</div>
            {activeAgents.length === 0 ? (
              <InlineFeedback tone="info">当前没有智能体正在处理任务。</InlineFeedback>
            ) : (
              <div className={styles.compactList}>
                {activeAgents.map((agent) => (
                  <div className={styles.staticRow} key={agent.id}>
                    <span>
                      <strong>{agent.name}</strong>
                      <small>{agent.channels.length} 个频道</small>
                    </span>
                    <StatusBadge tone={agent.state === '不可用' ? 'error' : 'info'}>{agent.state}</StatusBadge>
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className={styles.section}>
            <div className={styles.sectionHeading}>动态创造</div>
            {dynamic.length === 0 ? (
              <InlineFeedback tone="info">当前没有动态创造任务。</InlineFeedback>
            ) : (
              <div className={styles.compactList}>
                {dynamic.map((item, index) => {
                  const state = dynamicStatus(item.status)
                  const agentName = agents.find((agent) => agent.id === item.agentId)?.name ?? '未命名智能体'
                  return (
                    <div className={styles.staticRow} key={`${item.agentId}-${index}`}>
                      <span>
                        <strong>{agentName}</strong>
                        <small>动态运行 {index + 1}</small>
                      </span>
                      <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
