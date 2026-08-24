import { ArrowRight, Boxes, Check, Save, Sparkles } from 'lucide-react'
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
  SwitchControl,
  Textarea,
  type StatusTone,
} from '../ui-kit/index.js'
import styles from './product-pages.module.css'
import { DynamicClientSlots } from '../dynamic-client-coordinator.js'
import { ExtensionDetailsExtensionSlots } from '../persistent-extension-client.js'

const extensionLabel = (activeAgentCount: number): string =>
  activeAgentCount > 0 ? `${activeAgentCount} 个智能体正在使用` : '尚未启用'

const extensionTone = (activeAgentCount: number): StatusTone => (activeAgentCount > 0 ? 'success' : 'neutral')

export const extensionDescription = (description: string): string =>
  description
    .replace(/^由官方\s+/u, '由 ')
    .replaceAll('Host Tool', '智能体工具')
    .replace(/\bRPC\b/gu, '界面数据接口')
    .replaceAll('产品 Slot', '产品界面')
    .replace(/\bClient\b/gu, '界面')
    .replace(/\bHost\b/gu, '服务端')
    .replaceAll('已验证 智能体工具', '已验证智能体工具')
    .replace(/([\p{Script=Han}])\s+([与和及、，。；])/gu, '$1$2')

export const contributionLabel = (contribution: string): string => {
  const match = /^(工具|RPC|界面)[：:]\s*(.+)$/u.exec(contribution)
  if (!match) return contribution
  const [, kind, name = ''] = match
  if (kind === '工具') return `智能体工具 · ${name}`
  if (kind === 'RPC') return `界面数据接口 · ${name}`
  if (name === 'agent.workbench.sections' || name === '智能体工作台') return '智能体工作台面板'
  if (name === 'extension.details.panels' || name === '扩展详情') return '扩展详情面板'
  return `产品界面 · ${name}`
}

export const contractVersionLabel = (version: string): string =>
  version === 'nekro-nxt-extension-v1' ? 'NekroNXT 扩展 v1' : version

export function ExtensionsPage() {
  const { extensionId = '' } = useParams()
  const navigate = useNxtNavigate()
  const host = useProductStore((state) => state.host)
  const agents = useProductStore((state) => state.agents)
  const extensions = useProductStore((state) => state.extensions)
  const [pendingAgentId, setPendingAgentId] = useState<string | null>(null)
  const selectedId = extensionId || extensions[0]?.id || ''

  const changeActivation = async (
    extension: LocalExtensionSummary,
    agentId: string,
    agentName: string,
    enabled: boolean,
  ): Promise<void> => {
    if (pendingAgentId) return
    setPendingAgentId(agentId)
    try {
      await useProductStore.getState().setExtensionActive(extension.id, agentId, enabled)
      notify(
        `${enabled ? '已为' : '已停止让'}${agentName}${enabled ? '启用' : '使用'}“${extension.name}”。`,
        'success',
        `extension-activation:${extension.id}:${agentId}`,
      )
    } catch (error) {
      notify(
        error instanceof Error ? error.message : String(error),
        'error',
        `extension-activation:${extension.id}:${agentId}`,
      )
    } finally {
      setPendingAgentId(null)
    }
  }
  const selected = extensions.find((extension) => extension.id === selectedId) ?? extensions[0]
  const detailsActivation =
    selected?.activations.find((activation) => activation.agentId === selected.createdByAgentId) ??
    selected?.activations[0]
  const selectedClientDiagnostic = selected?.clientDiagnostics.find(
    (diagnostic) =>
      diagnostic.agentId === detailsActivation?.agentId && diagnostic.revisionId === detailsActivation.revisionId,
  )
  if (!extensionId && extensions[0]) {
    return <Navigate to={`/extensions/${extensions[0].id}`} replace />
  }

  return (
    <div className={[styles.page, styles.desktopPage, styles.extensionsPage].join(' ')} data-product-page="extensions">
      <PageHeader
        icon={Boxes}
        title={selected?.name ?? '扩展库'}
        meta={selected ? `版本 ${selected.revision} · ${extensions.length} 个本地扩展` : undefined}
        quiet
        actions={
          selected ? (
            <StatusBadge tone={extensionTone(selected.activations.length)}>
              {extensionLabel(selected.activations.length)}
            </StatusBadge>
          ) : undefined
        }
      />
      <StageCrossfade className={styles.desktopContentStage} swapKey={selected?.id ?? 'empty'}>
        {extensions.length === 0 ? (
          <EmptyState
            loading={host.status === 'initializing'}
            illustration={
              host.status === 'error'
                ? { src: '/brand/illustrations/host-unreachable.svg' }
                : { src: '/brand/illustrations/no-extensions.svg' }
            }
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
            <p className={styles.workspaceLead}>
              {selected.description ? extensionDescription(selected.description) : '还没有说明这个扩展是做什么的。'}
            </p>
            <div className={styles.extensionOverview}>
              <section>
                <div className={styles.sectionHeading}>使用进度</div>
                <ol
                  className={[styles.lifecycleSteps, styles.lifecycleStepsCompact].join(' ')}
                  aria-label="扩展使用进度"
                >
                  <li data-done="">
                    <span>
                      <Check size={12} aria-hidden="true" />
                    </span>
                    <small>试运行</small>
                  </li>
                  <li data-done="">
                    <span>
                      <Check size={12} aria-hidden="true" />
                    </span>
                    <small>保存为扩展</small>
                  </li>
                  <li data-done={selected.activations.length > 0 ? '' : undefined}>
                    <span>{selected.activations.length > 0 ? <Check size={12} aria-hidden="true" /> : '3'}</span>
                    <small>启用给智能体</small>
                  </li>
                </ol>
              </section>
              <section>
                <div className={styles.sectionHeading}>当前版本</div>
                <dl className={styles.facts}>
                  <dt>版本</dt>
                  <dd>版本 {selected.revision}</dd>
                  <dt>创建来源</dt>
                  <dd>{selected.createdByAgent || '未记录'}</dd>
                  <dt>正在使用</dt>
                  <dd>{selected.activations.length > 0 ? `${selected.activations.length} 个智能体` : '暂无'}</dd>
                  <dt>当前状态</dt>
                  <dd>{selected.activations.length > 0 ? '已启用' : '尚未启用'}</dd>
                </dl>
              </section>
            </div>
            <div className={styles.extensionDetailGrid}>
              <section>
                <div className={styles.sectionHeading}>包含内容</div>
                {selected.contributions.length > 0 ? (
                  <div className={styles.tagList}>
                    {selected.contributions.map((item) => (
                      <span key={item} title={item}>
                        {contributionLabel(item)}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className={styles.secondaryText}>这个版本没有可展示的工具或界面。</p>
                )}
              </section>
              <section>
                <div className={styles.sectionHeading}>检查结果</div>
                {selected.verification ? (
                  <dl className={styles.facts}>
                    <dt>扩展格式</dt>
                    <dd>{contractVersionLabel(selected.verification.contractVersion)}</dd>
                    <dt>DSH 版本</dt>
                    <dd>{selected.verification.dshVersion}</dd>
                    <dt>服务端功能</dt>
                    <dd>{selected.verification.hostBuilt ? '检查通过' : '未包含'}</dd>
                    <dt>界面功能</dt>
                    <dd>{selected.verification.clientBuilt ? '检查通过' : '未包含'}</dd>
                    <dt>工具测试</dt>
                    <dd>
                      {selected.verification.toolInvocationCount > 0
                        ? `${selected.verification.toolInvocationCount} 次通过`
                        : '未包含'}
                    </dd>
                    <dt>最近界面加载</dt>
                    <dd>
                      {!selected.verification.clientBuilt
                        ? '未包含界面功能'
                        : selectedClientDiagnostic === undefined
                          ? '还没有加载记录'
                          : selectedClientDiagnostic.status === 'loaded'
                            ? `已加载 · ${new Date(selectedClientDiagnostic.observedAt).toLocaleString('zh-CN')}`
                            : `失败 · ${new Date(selectedClientDiagnostic.observedAt).toLocaleString('zh-CN')}`}
                    </dd>
                  </dl>
                ) : (
                  <p className={styles.secondaryText}>这个版本保存时还没有记录检查结果。</p>
                )}
              </section>
            </div>
            <section className={styles.activationSection}>
              <div className={styles.sectionBar}>
                <div>
                  <div className={styles.sectionHeading}>使用范围</div>
                  <div className={styles.secondaryText}>选择使用这个扩展的智能体。</div>
                </div>
                <span className={styles.activationCount}>
                  {selected.activations.length}/{agents.length} 已启用
                </span>
              </div>
              {agents.length > 0 ? (
                <div className={styles.activationGrid} role="list" aria-label="智能体使用范围">
                  {agents.map((agent) => {
                    const activation = selected.activations.find((candidate) => candidate.agentId === agent.id)
                    return (
                      <div
                        className={styles.activationCard}
                        data-active={activation ? '' : undefined}
                        key={agent.id}
                        role="listitem"
                      >
                        <span className={styles.activationGlyph} aria-hidden="true">
                          {agent.name.trim().slice(0, 1) || '智'}
                        </span>
                        <span className={styles.activationCopy}>
                          <strong>{agent.name}</strong>
                          <small className={styles.activationMeta}>
                            {activation
                              ? `正在使用 · 版本 ${activation.revision || selected.revision}`
                              : `尚未启用 · 可用版本 ${selected.revision}`}
                          </small>
                        </span>
                        <SwitchControl
                          label={`${activation ? '停止让' : '允许'}${agent.name}使用“${selected.name}”`}
                          checked={activation !== undefined}
                          disabled={pendingAgentId !== null}
                          onCheckedChange={(enabled) => void changeActivation(selected, agent.id, agent.name, enabled)}
                        />
                      </div>
                    )
                  })}
                </div>
              ) : (
                <p className={styles.secondaryText}>请先创建智能体，再为它启用这个扩展。</p>
              )}
            </section>
            {detailsActivation ? (
              <ExtensionDetailsExtensionSlots
                agentId={detailsActivation.agentId}
                extensionId={selected.id}
                revisionId={detailsActivation.revisionId}
                activation="active"
              />
            ) : null}
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
  const selectedPackageAvailable = selectedItem?.packageId !== undefined
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
    <div className={[styles.page, styles.creatorPage].join(' ')}>
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
                  <small>动态包用于临时运行；保存会创建本地扩展。</small>
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
              <InlineFeedback tone="info">请在“{requestedAgent.name}”的频道中描述需求。</InlineFeedback>
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
                  <div className={styles.secondaryText}>当前内容属于临时动态运行，尚未成为本地扩展。</div>
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
                <DynamicClientSlots agentId={selectedItem.agentId} episodeId={selectedItem.episodeId} />
              </div>
              {selectedItem.status === 'awaiting-approval' && selectedItem.approvalRequestId ? (
                <InlineFeedback tone="warning">这次动态运行正在等待界面预览确认。</InlineFeedback>
              ) : (
                <InlineFeedback tone="info">只有正在运行的动态包可以保存；保存后再选择使用它的智能体。</InlineFeedback>
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
                    disabled={selectedItem.status !== 'running' || !selectedPackageAvailable}
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
        description="保存会创建可追踪的本地版本；使用它的智能体单独选择。"
        confirmLabel="保存本地版本"
        onConfirm={async () => {
          if (!selectedItem || !selectedItem.packageId || !extensionName.trim() || !extensionSlug.trim()) {
            setSaveError('请填写扩展名称和本地标识。')
            return false
          }
          setSaveError('')
          try {
            const saved = await useProductStore.getState().saveDynamicExtension({
              agentId: selectedItem.agentId,
              episodeId: selectedItem.episodeId,
              pluginId: selectedItem.pluginId,
              packageId: selectedItem.packageId,
              name: extensionName,
              slug: extensionSlug,
              description: extensionDescription,
            })
            notify('动态运行已保存为本地扩展。', 'success', 'dynamic-extension-save')
            navigate(`/extensions/${saved.extensionId}`)
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
          description="允许后，本次动态运行会在当前浏览器中显示界面；保存扩展是独立操作。"
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
