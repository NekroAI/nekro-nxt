import { ArrowRight, Check, Save, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Navigate, useParams, useSearchParams } from 'react-router-dom'
import { useNxtNavigate } from '../shell/nxt-link.js'
import { notify } from '../components/notifications.js'
import { EmptyState, InlineFeedback, PageHeader } from '../components/product-feedback.js'
import { useProductStore, type LocalExtensionSummary } from '../product-store.js'
import {
  Button,
  ConfirmDialog,
  Field,
  Input,
  StageCrossfade,
  StatusBadge,
  Textarea,
  type StatusTone,
} from '../ui-kit/index.js'
import styles from './product-pages.module.css'
import { DynamicClientSlots } from '../dynamic-client-coordinator.js'

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
  const { extensionId = '' } = useParams()
  const navigate = useNxtNavigate()
  const host = useProductStore((state) => state.host)
  const extensions = useProductStore((state) => state.extensions)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const selectedId = extensionId || extensions[0]?.id || ''

  const changeActivation = async (extension: LocalExtensionSummary): Promise<void> => {
    if (pendingId) return
    const enable = extension.activation !== '已激活'
    setPendingId(extension.id)
    try {
      await useProductStore.getState().setExtensionActive(extension.id, enable)
      notify(`${extension.name}${enable ? '已启用' : '已停用'}。`, 'success', `extension-activation:${extension.id}`)
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error', `extension-activation:${extension.id}`)
    } finally {
      setPendingId(null)
    }
  }
  const selected = extensions.find((extension) => extension.id === selectedId) ?? extensions[0]
  if (!extensionId && extensions[0]) {
    return <Navigate to={`/extensions/${extensions[0].id}`} replace />
  }

  return (
    <div className={styles.page}>
      <StageCrossfade swapKey={selected?.id ?? 'empty'}>
        <PageHeader
          title={selected?.name ?? '扩展库'}
          meta={selected ? `版本 ${selected.revision} · ${extensions.length} 个本地扩展` : undefined}
          actions={
            selected ? (
              <StatusBadge tone={extensionTone(selected.activation)}>{extensionLabel(selected.activation)}</StatusBadge>
            ) : undefined
          }
        />
        {extensions.length === 0 ? (
          <EmptyState
            loading={host.status === 'initializing'}
            title={host.status === 'initializing' ? '正在读取扩展' : '从一次动态运行开始'}
            description={
              host.status === 'error'
                ? '当前无法读取扩展，请重新连接后再试。'
                : '在创造工作台验证运行结果后，可将它保存为可追踪的本地扩展。'
            }
            action={
              host.status === 'ready' ? (
                <Button onClick={() => void navigate('/work/creator')}>
                  打开创造工作台 <ArrowRight size={14} aria-hidden="true" />
                </Button>
              ) : undefined
            }
          />
        ) : selected ? (
          <section className={styles.extensionWorkspace}>
            <p className={styles.workspaceLead}>{selected.description || '没有补充说明。'}</p>
            <ol className={[styles.lifecycleSteps, styles.lifecycleStepsCompact].join(' ')} aria-label="扩展生命周期">
              <li data-done="">
                <span>
                  <Check size={12} aria-hidden="true" />
                </span>
                <small>动态运行</small>
              </li>
              <li data-done="">
                <span>
                  <Check size={12} aria-hidden="true" />
                </span>
                <small>保存版本</small>
              </li>
              <li data-done={selected.activation === '已激活' ? '' : undefined}>
                <span>{selected.activation === '已激活' ? <Check size={12} aria-hidden="true" /> : '3'}</span>
                <small>启用给智能体</small>
              </li>
            </ol>
            <dl className={styles.facts}>
              <dt>当前保存版本</dt>
              <dd>版本 {selected.revision}</dd>
              <dt>目标智能体</dt>
              <dd>{selected.targetAgent || '尚未指定'}</dd>
              <dt>启用状态</dt>
              <dd>{extensionLabel(selected.activation)}</dd>
            </dl>
            <div className={styles.sectionDivider} />
            <div>
              <div className={styles.sectionHeading}>贡献能力</div>
              {selected.contributions.length > 0 ? (
                <div className={styles.tagList}>
                  {selected.contributions.map((item) => (
                    <span key={item}>{item}</span>
                  ))}
                </div>
              ) : (
                <p className={styles.secondaryText}>当前快照尚未提供可展示的贡献内容。</p>
              )}
            </div>
            <div className={styles.sectionDivider} />
            <div>
              <div className={styles.sectionHeading}>验证证据</div>
              {selected.verification ? (
                <dl className={styles.facts}>
                  <dt>契约</dt>
                  <dd>{selected.verification.contractVersion}</dd>
                  <dt>核心引擎</dt>
                  <dd>{selected.verification.dshVersion}</dd>
                  <dt>Host 构建</dt>
                  <dd>{selected.verification.hostBuilt ? '已通过' : '不适用'}</dd>
                  <dt>Client 构建</dt>
                  <dd>{selected.verification.clientBuilt ? '已通过' : '不适用'}</dd>
                  <dt>工具调用</dt>
                  <dd>{selected.verification.toolInvocationCount} 次成功</dd>
                </dl>
              ) : (
                <p className={styles.secondaryText}>这个旧版本没有持久验证记录。</p>
              )}
            </div>
            <div className={styles.sectionActionRow}>
              <span>
                <strong>
                  {selected.activation === '已激活' ? '这个智能体正在使用该版本' : '保存不会自动扩大作用范围'}
                </strong>
                <small>启用与停用是独立操作。</small>
              </span>
              <Button
                variant={selected.activation === '已激活' ? 'danger' : 'primary'}
                loading={pendingId === selected.id}
                loadingLabel="处理中…"
                disabled={pendingId !== null}
                onClick={() => void changeActivation(selected)}
              >
                {selected.activation === '已激活' ? '停用扩展' : '启用给智能体'}
              </Button>
            </div>
          </section>
        ) : null}
      </StageCrossfade>
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
  const navigate = useNxtNavigate()
  const [searchParams] = useSearchParams()
  const requestedAgentId = searchParams.get('agent') ?? ''
  const [reviewIndex, setReviewIndex] = useState<number | null>(null)
  const [selectedKey, setSelectedKey] = useState('')
  const [saveOpen, setSaveOpen] = useState(false)
  const [extensionName, setExtensionName] = useState('')
  const [extensionSlug, setExtensionSlug] = useState('')
  const [extensionDescription, setExtensionDescription] = useState('')
  const [saveError, setSaveError] = useState('')
  const [declinePending, setDeclinePending] = useState(false)
  const reviewItem = reviewIndex === null ? undefined : dynamic[reviewIndex]
  const reviewApprovalRequestId = reviewItem?.approvalRequestId
  const selectedItem =
    dynamic.find((item) => `${item.episodeId}:${item.pluginId}:${item.packageId ?? ''}` === selectedKey) ?? dynamic[0]
  const selectedIndex = selectedItem === undefined ? -1 : dynamic.indexOf(selectedItem)
  const selectedAgent = selectedItem ? agents.find((agent) => agent.id === selectedItem.agentId) : undefined
  const eligibleAgents = agents.filter((agent) => agent.capabilities.dynamicCreation)
  const requestedAgent = agents.find((agent) => agent.id === requestedAgentId)

  useEffect(() => {
    const index = dynamic.findIndex((item) => item.agentId === requestedAgentId)
    const item = dynamic[index]
    if (item) setSelectedKey(`${item.episodeId}:${item.pluginId}:${item.packageId ?? ''}`)
  }, [dynamic, requestedAgentId])

  const decline = async (): Promise<void> => {
    const item = reviewItem
    const approvalRequestId = item?.approvalRequestId
    if (!item || !approvalRequestId || declinePending) return
    setDeclinePending(true)
    try {
      await useProductStore.getState().resolveApproval({
        requestId: approvalRequestId,
        agentId: item.agentId,
        approved: false,
      })
      setReviewIndex(null)
      notify('本次界面预览已拒绝。', 'success', `dynamic-approval:${approvalRequestId}`)
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error', `dynamic-approval:${approvalRequestId}`)
    } finally {
      setDeclinePending(false)
    }
  }

  return (
    <div className={styles.page}>
      <PageHeader title="创造" meta="动态运行、保存为本地扩展和启用给智能体是三个独立动作。" />
      {dynamic.length === 0 ? (
        <div className={styles.creatorStartGrid}>
          <section className={styles.section}>
            <div className={styles.creatorIntro}>
              <Sparkles size={22} aria-hidden="true" />
              <div>
                <div className={styles.sectionHeading}>
                  {host.status === 'initializing' ? '正在读取动态状态' : '从智能体的频道开始创造'}
                </div>
                <p>向已授权动态创造的智能体描述需求。它开始运行动态包后，这里会显示真实状态和保存入口。</p>
              </div>
            </div>
            <ol className={styles.creatorGuide}>
              <li>
                <span>1</span>
                <div>
                  <strong>描述需求</strong>
                  <small>在频道中说明要创建的能力和预期结果。</small>
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <strong>运行与验证</strong>
                  <small>动态包先临时运行，不会自动保存。</small>
                </div>
              </li>
              <li>
                <span>3</span>
                <div>
                  <strong>保存并启用</strong>
                  <small>确认结果后保存版本，再独立启用给智能体。</small>
                </div>
              </li>
            </ol>
          </section>
          <section className={styles.section}>
            <div className={styles.sectionHeading}>可开始创造的智能体</div>
            {requestedAgent ? (
              <InlineFeedback tone="info">当前从“{requestedAgent.name}”进入。需求仍在它的频道里描述。</InlineFeedback>
            ) : null}
            {eligibleAgents.length > 0 ? (
              <div className={styles.compactList}>
                {[
                  ...(requestedAgent && eligibleAgents.some((agent) => agent.id === requestedAgent.id)
                    ? [requestedAgent]
                    : []),
                  ...eligibleAgents.filter((agent) => agent.id !== requestedAgentId),
                ].map((agent) => (
                  <div className={styles.staticRow} key={agent.id}>
                    <span>
                      <strong>{agent.name}</strong>
                      <small>{agent.channels.length} 个频道可用</small>
                    </span>
                    <Button
                      size="small"
                      disabled={!agent.channels[0]}
                      onClick={() => agent.channels[0] && void navigate(`/work/channels/${agent.channels[0]}`)}
                    >
                      打开频道 <ArrowRight size={14} aria-hidden="true" />
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <InlineFeedback tone="warning">还没有智能体获得动态创造授权。请先在智能体的能力页开启。</InlineFeedback>
            )}
          </section>
        </div>
      ) : (
        <div className={styles.creatorWorkspace}>
          <div className={styles.masterList} role="list" aria-label="动态运行">
            {dynamic.map((item, index) => {
              const presentation = dynamicStatus(item.status)
              const agentName = agents.find((agent) => agent.id === item.agentId)?.name ?? '未命名智能体'
              return (
                <Button
                  className={[styles.masterButton, item === selectedItem ? styles.masterButtonActive : '']
                    .filter(Boolean)
                    .join(' ')}
                  variant="ghost"
                  onClick={() => setSelectedKey(`${item.episodeId}:${item.pluginId}:${item.packageId ?? ''}`)}
                  key={`${item.episodeId}:${item.pluginId}:${item.packageId ?? ''}`}
                >
                  <Sparkles size={16} aria-hidden="true" />
                  <span className={styles.masterCopy}>
                    <strong>
                      {item.packages.find((pkg) => pkg.packageId === item.packageId)?.name ?? `${agentName}的临时扩展`}
                    </strong>
                    <small>
                      {item.packages.find((pkg) => pkg.packageId === item.packageId)?.purpose ??
                        `动态运行 ${index + 1}`}
                    </small>
                  </span>
                  <StatusBadge tone={presentation.tone}>{presentation.label}</StatusBadge>
                </Button>
              )
            })}
          </div>
          {selectedItem ? (
            <section className={styles.section}>
              <div className={styles.sectionBar}>
                <div>
                  <div className={styles.sectionHeading}>与{selectedAgent?.name ?? '智能体'}协作创造</div>
                  <div className={styles.secondaryText}>当前内容仍是临时动态运行，尚未成为本地扩展。</div>
                </div>
                <StatusBadge tone={dynamicStatus(selectedItem.status).tone}>
                  {dynamicStatus(selectedItem.status).label}
                </StatusBadge>
              </div>
              <ol className={styles.lifecycleSteps} aria-label="创造进度">
                <li data-done="">
                  <span>
                    <Check size={12} aria-hidden="true" />
                  </span>
                  <small>描述需求</small>
                </li>
                <li data-done="">
                  <span>
                    <Check size={12} aria-hidden="true" />
                  </span>
                  <small>动态运行</small>
                </li>
                <li data-done={selectedItem.status === 'running' ? '' : undefined}>
                  <span>3</span>
                  <small>验证结果</small>
                </li>
                <li>
                  <span>4</span>
                  <small>保存版本</small>
                </li>
                <li>
                  <span>5</span>
                  <small>启用给智能体</small>
                </li>
              </ol>
              <div className={styles.creatorEvidence}>
                <div>
                  <span>目标智能体</span>
                  <strong>{selectedAgent?.name ?? '未命名智能体'}</strong>
                </div>
                <div>
                  <span>当前状态</span>
                  <strong>{dynamicStatus(selectedItem.status).label}</strong>
                </div>
                <div>
                  <span>保存状态</span>
                  <strong>尚未保存</strong>
                </div>
              </div>
              <div className={styles.dynamicSlotSurface}>
                <div className={styles.sectionHeading}>即时界面</div>
                <DynamicClientSlots agentId={selectedItem.agentId} />
              </div>
              {selectedItem.status === 'awaiting-approval' && selectedItem.approvalRequestId ? (
                <InlineFeedback tone="warning">这次动态运行正在等待界面预览确认。</InlineFeedback>
              ) : (
                <InlineFeedback tone="info">只有真实运行中的 Package 才能保存；保存后不会自动启用。</InlineFeedback>
              )}
              <div className={styles.sectionActionRow}>
                <span>
                  <strong>下一步</strong>
                  <small>确认运行结果后保存为可追踪的本地扩展版本。</small>
                </span>
                <span className={styles.rowActions}>
                  {selectedItem.approvalRequestId && selectedIndex >= 0 ? (
                    <Button onClick={() => setReviewIndex(selectedIndex)}>审查界面预览</Button>
                  ) : null}
                  <Button
                    variant="primary"
                    disabled={selectedItem.status !== 'running' || selectedItem.packageId === undefined}
                    onClick={() => {
                      setExtensionName(`${selectedAgent?.name ?? '智能体'}的新扩展`)
                      setExtensionSlug(`local-extension-${Date.now().toString(36)}`)
                      setExtensionDescription('从动态创造运行保存的本地扩展。')
                      setSaveError('')
                      setSaveOpen(true)
                    }}
                  >
                    <Save size={14} aria-hidden="true" /> 保存为本地扩展
                  </Button>
                </span>
              </div>
            </section>
          ) : null}
        </div>
      )}
      <ConfirmDialog
        open={saveOpen}
        onOpenChange={(open) => {
          setSaveOpen(open)
          if (!open) setSaveError('')
        }}
        title="保存为本地扩展"
        description="保存会创建可追踪的本地版本，但不会自动启用给智能体。"
        confirmLabel="保存本地版本"
        onConfirm={async () => {
          if (!selectedItem || !selectedItem.packageId || !extensionName.trim() || !extensionSlug.trim()) {
            setSaveError('请填写扩展名称和本地标识。')
            return false
          }
          setSaveError('')
          try {
            await useProductStore.getState().saveDynamicExtension({
              agentId: selectedItem.agentId,
              episodeId: selectedItem.episodeId,
              pluginId: selectedItem.pluginId,
              packageId: selectedItem.packageId,
              name: extensionName,
              slug: extensionSlug,
              description: extensionDescription,
            })
            notify('动态运行已保存为本地扩展；是否启用仍由你决定。', 'success', 'dynamic-extension-save')
            return true
          } catch (error) {
            notify(error instanceof Error ? error.message : String(error), 'error', 'dynamic-extension-save')
            return false
          }
        }}
      >
        <div className={styles.formStack}>
          <Field label="扩展名称">
            <Input value={extensionName} onChange={(event) => setExtensionName(event.target.value)} />
          </Field>
          <Field label="本地标识" hint="使用小写字母、数字和连字符。">
            <Input value={extensionSlug} onChange={(event) => setExtensionSlug(event.target.value)} />
          </Field>
          <Field label="说明">
            <Textarea value={extensionDescription} onChange={(event) => setExtensionDescription(event.target.value)} />
          </Field>
          {saveError ? <InlineFeedback tone="error">{saveError}</InlineFeedback> : null}
        </div>
      </ConfirmDialog>
      {reviewItem && reviewApprovalRequestId ? (
        <ConfirmDialog
          open={reviewIndex !== null}
          onOpenChange={(open) => {
            if (!open && !declinePending) setReviewIndex(null)
          }}
          title="允许界面预览"
          description="允许后，这次动态运行可以在当前浏览器中显示界面。不会自动保存扩展。"
          confirmLabel="允许本次预览"
          onConfirm={async () => {
            try {
              await useProductStore.getState().resolveApproval({
                requestId: reviewApprovalRequestId,
                agentId: reviewItem.agentId,
                approved: true,
              })
              notify('本次界面预览已允许。', 'success', `dynamic-approval:${reviewApprovalRequestId}`)
              return true
            } catch (error) {
              notify(
                error instanceof Error ? error.message : String(error),
                'error',
                `dynamic-approval:${reviewApprovalRequestId}`,
              )
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
