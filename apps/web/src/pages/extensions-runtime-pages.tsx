import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowRight, Boxes, Download, FileArchive, GripVertical, Save, Sparkles, Trash2, Upload } from 'lucide-react'
import { HostApiContracts, HostApiErrorSchema, type HostApiResponse, type HostUiPageEntry } from '@nekro-nxt/contracts'
import { useEffect, useState } from 'react'
import { Navigate, useParams, useSearchParams } from 'react-router-dom'
import { useNxtNavigate } from '../shell/nxt-link.js'
import { notify } from '../components/notifications.js'
import { EmptyState, InlineFeedback, PageHeader } from '../components/product-feedback.js'
import { useProductStore, type LocalExtensionSummary } from '../product-store.js'
import type { DynamicPackageSummary } from '../product-port.js'
import {
  Button,
  ConfirmDialog,
  Field,
  IconButton,
  Input,
  SelectField,
  StageCrossfade,
  StatusBadge,
  SwitchControl,
  Textarea,
  type StatusTone,
} from '../ui-kit/index.js'
import styles from './product-pages.module.css'
import { DynamicClientSlots } from '../dynamic-client-coordinator.js'
import { ExtensionActivationExtensionSlots } from '../persistent-extension-client.js'

const extensionLabel = (activeAgentCount: number): string =>
  activeAgentCount > 0 ? `${activeAgentCount} 个智能体正在使用` : '尚未启用'

const extensionTone = (activeAgentCount: number): StatusTone => (activeAgentCount > 0 ? 'success' : 'neutral')

const extensionScopeLabel = (scope: LocalExtensionSummary['scope']): string =>
  scope === 'host-adapter' ? '本机适配器' : scope === 'host-ui' ? '页面扩展' : '智能体扩展'

function SortableHostUiPageRow({
  page,
  ownerLabel,
  pending,
  onVisibleChange,
}: {
  readonly page: HostUiPageEntry
  readonly ownerLabel: string
  readonly pending: boolean
  readonly onVisibleChange: (visible: boolean) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: page.pageInstanceId,
  })
  const { onKeyDown: onSortableKeyDown, onPointerDown: onSortablePointerDown } = listeners ?? {}
  return (
    <div
      ref={setNodeRef}
      className={styles.hostUiPageRow}
      data-dragging={isDragging ? '' : undefined}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <IconButton
        className={styles.hostUiPageDrag}
        label={`拖动“${page.title}”排序`}
        tooltip={false}
        disabled={pending}
        {...attributes}
        onPointerDown={(event) => {
          onSortablePointerDown?.(event)
        }}
        onKeyDown={(event) => {
          onSortableKeyDown?.(event)
        }}
      >
        <GripVertical size={16} aria-hidden="true" />
      </IconButton>
      <span className={styles.hostUiPageCopy}>
        <strong>{page.title}</strong>
        <small>
          {ownerLabel} · {page.objectPane === 'navigation' ? '带对象列' : '全宽页面'}
        </small>
      </span>
      {page.diagnostic && page.diagnostic.status !== 'ready' ? (
        <StatusBadge tone="error">加载异常</StatusBadge>
      ) : (
        <StatusBadge tone={page.visible ? 'success' : 'neutral'}>{page.visible ? '侧栏可见' : '已隐藏'}</StatusBadge>
      )}
      <SwitchControl
        label={`${page.visible ? '隐藏' : '显示'}“${page.title}”入口`}
        checked={page.visible}
        disabled={pending}
        onCheckedChange={onVisibleChange}
      />
    </div>
  )
}

function HostUiPageManager() {
  const hostUi = useProductStore((state) => state.hostUi)
  const extensions = useProductStore((state) => state.extensions)
  const [pages, setPages] = useState<readonly HostUiPageEntry[]>(hostUi.pages)
  const [pending, setPending] = useState(false)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  useEffect(() => setPages(hostUi.pages), [hostUi.pages, hostUi.preferencesRevision])
  const commit = async (next: readonly HostUiPageEntry[]): Promise<void> => {
    if (pending) return
    setPages(next)
    setPending(true)
    try {
      const response = await fetch('/api/host-ui/page-preferences', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: hostUi.preferencesRevision,
          entries: next.map(({ pageInstanceId, visible }) => ({ pageInstanceId, visible })),
        }),
      })
      const body: unknown = await response.json()
      if (!response.ok) {
        const parsed = HostApiErrorSchema.safeParse(body)
        throw new Error(parsed.success ? parsed.data.error.message : `保存页面入口失败（HTTP ${response.status}）。`)
      }
      HostApiContracts.updateHostUiPagePreferences.parseResponse(body)
      await useProductStore.getState().refreshHost()
    } catch (error) {
      setPages(hostUi.pages)
      notify(error instanceof Error ? error.message : String(error), 'error', 'host-ui-page-preferences')
      await useProductStore
        .getState()
        .refreshHost()
        .catch(() => undefined)
    } finally {
      setPending(false)
    }
  }
  return (
    <div className={[styles.page, styles.desktopPage].join(' ')} data-product-page="host-ui-pages">
      <PageHeader icon={Boxes} title="页面入口" meta="管理扩展页面在侧栏中的顺序和可见状态。" quiet />
      {pages.length === 0 ? (
        <EmptyState title="没有扩展页面" description="安装带页面入口的本机扩展后，入口会出现在侧栏。" />
      ) : (
        <section className={styles.hostUiPageManager} aria-label="扩展页面入口">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={({ active, over }) => {
              if (!over || active.id === over.id) return
              const oldIndex = pages.findIndex(({ pageInstanceId }) => pageInstanceId === active.id)
              const newIndex = pages.findIndex(({ pageInstanceId }) => pageInstanceId === over.id)
              if (oldIndex < 0 || newIndex < 0) return
              void commit(arrayMove([...pages], oldIndex, newIndex))
            }}
          >
            <SortableContext
              items={pages.map(({ pageInstanceId }) => pageInstanceId)}
              strategy={verticalListSortingStrategy}
            >
              {pages.map((page) => {
                const ownerExtensionId = page.owner.kind === 'extension' ? page.owner.extensionId : undefined
                const ownerLabel =
                  ownerExtensionId !== undefined
                    ? (extensions.find(({ id }) => id === ownerExtensionId)?.name ?? '已移除的扩展')
                    : 'DSH 扩展'
                return (
                  <SortableHostUiPageRow
                    key={page.pageInstanceId}
                    page={page}
                    pending={pending}
                    ownerLabel={ownerLabel}
                    onVisibleChange={(visible) =>
                      void commit(
                        pages.map((candidate) =>
                          candidate.pageInstanceId === page.pageInstanceId ? { ...candidate, visible } : candidate,
                        ),
                      )
                    }
                  />
                )
              })}
            </SortableContext>
          </DndContext>
        </section>
      )}
    </div>
  )
}

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
  const match = /^(工具|RPC|界面|页面)[：:]\s*(.+)$/u.exec(contribution)
  if (!match) return contribution
  const [, kind, name = ''] = match
  if (kind === '工具') return `智能体工具 · ${name}`
  if (kind === 'RPC') return `界面数据接口 · ${name}`
  if (kind === '页面') return `专属页面 · ${name}`
  if (name === 'agent.workbench.sections' || name === '智能体工作台') return '智能体工作台面板'
  if (name === 'extension.details.panels' || name === '扩展详情') return '扩展详情面板'
  return `产品界面 · ${name}`
}

export const contractVersionLabel = (version: string): string =>
  version === 'nekro-nxt-extension-v1' ? 'NekroNXT 扩展 v1' : version

export function ExtensionsPage() {
  const { extensionId = '' } = useParams()
  const [extensionSearchParams] = useSearchParams()
  const navigate = useNxtNavigate()
  const host = useProductStore((state) => state.host)
  const agents = useProductStore((state) => state.agents)
  const extensions = useProductStore((state) => state.extensions)
  const [pendingAgentId, setPendingAgentId] = useState<string | null>(null)
  const [revisionByAgent, setRevisionByAgent] = useState<Record<string, string>>({})
  const [installationPending, setInstallationPending] = useState(false)
  const [uninstallOpen, setUninstallOpen] = useState(false)
  const [permissionRevisionId, setPermissionRevisionId] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deletePending, setDeletePending] = useState(false)
  const [importInspection, setImportInspection] = useState<HostApiResponse<'inspectExtensionImport'> | null>(null)
  const [importSlug, setImportSlug] = useState('')
  const [importPending, setImportPending] = useState(false)
  const [importFileName, setImportFileName] = useState('')
  const [importDragging, setImportDragging] = useState(false)
  const [focusedRevisionId, setFocusedRevisionId] = useState('')
  const [detailsAgentId, setDetailsAgentId] = useState('')
  const selectedId = extensionId || extensions[0]?.id || ''

  const changeActivation = async (
    extension: LocalExtensionSummary,
    agentId: string,
    agentName: string,
    enabled: boolean,
    revisionId?: string,
  ): Promise<void> => {
    if (pendingAgentId) return
    setPendingAgentId(agentId)
    try {
      await useProductStore.getState().setExtensionActive(extension.id, agentId, enabled, revisionId)
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
  useEffect(() => {
    setFocusedRevisionId(selected?.revisionId ?? '')
    setDetailsAgentId('')
  }, [selected?.id, selected?.revisionId])
  const focusedRevision =
    selected?.revisions.find((revision) => revision.id === focusedRevisionId) ?? selected?.revisions.at(-1)
  const permissionRevision = selected?.revisions.find((revision) => revision.id === permissionRevisionId)
  const detailsActivation = selected?.activations.find((activation) => activation.agentId === detailsAgentId)
  const selectedClientDiagnostic = selected?.clientDiagnostics.find(
    (diagnostic) =>
      diagnostic.agentId === detailsActivation?.agentId && diagnostic.revisionId === detailsActivation.revisionId,
  )
  const visibleClientDiagnostic =
    selected === undefined || selected.scope === 'agent' ? selectedClientDiagnostic : selected.hostClientDiagnostic
  const focusedVerification = focusedRevision?.verification
  const focusedClientDiagnostic =
    visibleClientDiagnostic?.revisionId === focusedRevision?.id ? visibleClientDiagnostic : undefined
  const changeInstallation = async (revisionId: string | null, permissionDigest?: string): Promise<boolean> => {
    if (!selected || installationPending) return false
    setInstallationPending(true)
    try {
      await useProductStore.getState().setHostExtensionInstalled(selected.id, revisionId, permissionDigest)
      notify(
        revisionId === null ? `已卸载“${selected.name}”。` : `已安装“${selected.name}”的所选版本。`,
        'success',
        `extension-installation:${selected.id}`,
      )
      return true
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error', `extension-installation:${selected.id}`)
      return false
    } finally {
      setInstallationPending(false)
    }
  }
  const inspectImport = async (file: File): Promise<void> => {
    setImportPending(true)
    setImportFileName(file.name)
    try {
      const response = await fetch('/api/extensions/imports/inspect', { method: 'POST', body: file })
      const body: unknown = await response.json()
      if (!response.ok) {
        const parsed = HostApiErrorSchema.safeParse(body)
        throw new Error(parsed.success ? parsed.data.error.message : `导入检查失败（HTTP ${response.status}）。`)
      }
      const inspection = HostApiContracts.inspectExtensionImport.parseResponse(body)
      setImportInspection(inspection)
      setImportSlug(inspection.slugConflict ? `${inspection.slug}-imported` : inspection.slug)
    } catch (error) {
      setImportInspection(null)
      setImportFileName('')
      notify(error instanceof Error ? error.message : String(error), 'error', 'extension-import-inspect')
    } finally {
      setImportPending(false)
    }
  }
  const commitImport = async (): Promise<void> => {
    if (!importInspection || importPending) return
    setImportPending(true)
    try {
      const response = await fetch(`/api/extensions/imports/${encodeURIComponent(importInspection.token)}/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(importInspection.slugConflict ? { localSlug: importSlug } : {}),
      })
      const body: unknown = await response.json()
      if (!response.ok) {
        const parsed = HostApiErrorSchema.safeParse(body)
        throw new Error(parsed.success ? parsed.data.error.message : `导入提交失败（HTTP ${response.status}）。`)
      }
      const result = HostApiContracts.commitExtensionImport.parseResponse(body)
      await useProductStore.getState().refreshHost()
      setImportInspection(null)
      setImportFileName('')
      notify(result.idempotent ? '相同的扩展修订已存在，未重复导入。' : '扩展修订已导入，当前未启用。', 'success')
      void navigate(`/extensions/${result.extensionId}`)
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error', 'extension-import-commit')
    } finally {
      setImportPending(false)
    }
  }
  const deleteExtension = async (): Promise<boolean> => {
    if (!selected || deletePending) return false
    setDeletePending(true)
    try {
      const response = await fetch(`/api/extensions/${encodeURIComponent(selected.id)}`, { method: 'DELETE' })
      const body: unknown = await response.json()
      if (!response.ok) {
        const parsed = HostApiErrorSchema.safeParse(body)
        throw new Error(parsed.success ? parsed.data.error.message : `删除扩展失败（HTTP ${response.status}）。`)
      }
      HostApiContracts.deleteLocalExtension.parseResponse(body)
      notify(`已删除本地扩展“${selected.name}”。`, 'success', `extension-delete:${selected.id}`)
      void navigate('/extensions')
      await useProductStore.getState().refreshHost()
      return true
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error', `extension-delete:${selected.id}`)
      return false
    } finally {
      setDeletePending(false)
    }
  }
  if (!extensionId && extensionSearchParams.get('view') === 'pages') return <HostUiPageManager />
  if (!extensionId && extensions[0]) {
    return <Navigate to={`/extensions/${extensions[0].id}`} replace />
  }

  return (
    <div className={[styles.page, styles.desktopPage, styles.extensionsPage].join(' ')} data-product-page="extensions">
      <PageHeader
        icon={Boxes}
        title={selected?.name ?? '扩展库'}
        meta={selected ? `${extensionScopeLabel(selected.scope)} · ${extensions.length} 个本地扩展` : undefined}
        quiet
        actions={
          selected ? (
            <>
              <StatusBadge
                tone={
                  selected.scope !== 'agent'
                    ? selected.installation
                      ? 'success'
                      : 'neutral'
                    : extensionTone(selected.activations.length)
                }
              >
                {selected.scope !== 'agent'
                  ? selected.installation
                    ? '已安装到本机'
                    : '尚未安装'
                  : extensionLabel(selected.activations.length)}
              </StatusBadge>
            </>
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
                <div className={styles.extensionEmptyActions}>
                  <Button onClick={() => void navigate('/work/creator')}>
                    打开创造工作台 <ArrowRight size={14} aria-hidden="true" />
                  </Button>
                  <label className={styles.extensionFileButton} data-disabled={importPending ? '' : undefined}>
                    <Upload size={14} aria-hidden="true" />
                    {importPending ? '正在检查…' : '导入扩展'}
                    <Input
                      className={styles.extensionFileInput}
                      type="file"
                      accept=".nxt-extension,application/vnd.nekro-nxt.extension+zip"
                      aria-label="选择 .nxt-extension 文件"
                      disabled={importPending}
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0]
                        if (file) void inspectImport(file)
                        event.currentTarget.value = ''
                      }}
                    />
                  </label>
                </div>
              ) : undefined
            }
          />
        ) : selected ? (
          <section className={styles.extensionWorkspace}>
            <section className={styles.extensionSummary} aria-label="扩展摘要">
              <div className={styles.extensionSummaryCopy}>
                <p className={styles.workspaceLead}>
                  {selected.description ? extensionDescription(selected.description) : '暂无扩展说明。'}
                </p>
                <div className={styles.extensionMetaLine}>
                  <span>{extensionScopeLabel(selected.scope)}</span>
                  <span>{selected.revisions.length} 个修订</span>
                  <span>{focusedRevision?.contributions.length ?? 0} 项内容</span>
                  <span>{selected.createdByAgent ? `保存来源：${selected.createdByAgent}` : '保存来源：本地导入'}</span>
                </div>
              </div>
              <div className={styles.extensionRevisionPicker}>
                <SelectField
                  label="查看修订"
                  value={focusedRevision?.id ?? ''}
                  onValueChange={setFocusedRevisionId}
                  options={selected.revisions.toReversed().map((revision) => ({
                    value: revision.id,
                    label: `r${revision.revision} · ${new Date(revision.createdAt).toLocaleDateString('zh-CN')}`,
                  }))}
                />
              </div>
            </section>
            <section className={[styles.activationSection, styles.extensionPrimarySection].join(' ')}>
              {selected.scope !== 'agent' ? (
                <>
                  {selected.installation?.runtime && selected.installation.runtime.status !== 'active' ? (
                    <InlineFeedback tone="error">
                      {selected.installation.runtime.status === 'restore-failed' ? '启动恢复失败' : '停止资源失败'}
                      {selected.installation.runtime.message ? `：${selected.installation.runtime.message}` : '。'}
                    </InlineFeedback>
                  ) : null}
                  <div className={styles.sectionBar}>
                    <div>
                      <div className={styles.sectionHeading}>本机安装</div>
                      <div className={styles.secondaryText}>
                        {selected.scope === 'host-ui'
                          ? '安装后，已设为可见的页面入口会出现在侧栏。'
                          : '可安装任意已验证修订。卸载后连接和历史保留。'}
                      </div>
                    </div>
                    {selected.installation ? (
                      <Button
                        variant="danger"
                        size="small"
                        disabled={installationPending}
                        onClick={() => setUninstallOpen(true)}
                      >
                        卸载
                      </Button>
                    ) : null}
                  </div>
                  <div className={styles.compactList} role="list" aria-label="适配器修订">
                    {selected.revisions.toReversed().map((revision) => {
                      const installed = selected.installation?.revisionId === revision.id
                      const latest = revision.id === selected.revisionId
                      return (
                        <div className={styles.staticRow} key={revision.id} role="listitem">
                          <span>
                            <strong>r{revision.revision}</strong>
                            <small>
                              {installed ? '当前已安装' : new Date(revision.createdAt).toLocaleString('zh-CN')}
                            </small>
                          </span>
                          <Button
                            size="small"
                            disabled={installed || installationPending}
                            loading={installationPending}
                            loadingLabel="正在切换…"
                            onClick={() => {
                              if (
                                revision.verification?.permissionApprovalRequired &&
                                revision.verification.permissionDigest
                              ) {
                                setPermissionRevisionId(revision.id)
                                return
                              }
                              void changeInstallation(revision.id)
                            }}
                          >
                            {selected.installation
                              ? latest
                                ? `更新到 r${revision.revision}`
                                : `切换到 r${revision.revision}`
                              : '安装到本机'}
                          </Button>
                        </div>
                      )
                    })}
                  </div>
                </>
              ) : (
                <>
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
                        const selectedRevisionId =
                          revisionByAgent[agent.id] ?? activation?.revisionId ?? selected.revisionId ?? ''
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
                                  ? activation.runtime && activation.runtime.status !== 'active'
                                    ? `${activation.runtime.status === 'restore-failed' ? '恢复失败' : '停止失败'} · r${activation.revision || selected.revision}`
                                    : `正在使用 r${activation.revision || selected.revision}`
                                  : `尚未启用 · 最新 r${selected.revision}`}
                              </small>
                            </span>
                            <SelectField
                              label={`${agent.name}使用的修订`}
                              value={selectedRevisionId}
                              disabled={pendingAgentId !== null}
                              onValueChange={(revisionId) => {
                                setRevisionByAgent((current) => ({ ...current, [agent.id]: revisionId }))
                                if (activation && revisionId !== activation.revisionId) {
                                  void changeActivation(selected, agent.id, agent.name, true, revisionId)
                                }
                              }}
                              options={selected.revisions.toReversed().map((revision) => ({
                                value: revision.id,
                                label: `r${revision.revision}`,
                              }))}
                            />
                            <SwitchControl
                              label={`${activation ? '停止让' : '允许'}${agent.name}使用“${selected.name}”`}
                              checked={activation !== undefined}
                              disabled={pendingAgentId !== null}
                              onCheckedChange={(enabled) =>
                                void changeActivation(selected, agent.id, agent.name, enabled, selectedRevisionId)
                              }
                            />
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <p className={styles.secondaryText}>当前没有可配置的智能体。创建智能体后，可在此授权使用扩展。</p>
                  )}
                  {selected.activations.length > 0 && selected.revisions.some((revision) => revision.clientBuilt) ? (
                    <SelectField
                      label="扩展界面所属智能体"
                      helper="选择一个已启用关系，界面会使用对应智能体和修订的运行上下文。"
                      value={detailsAgentId}
                      onValueChange={setDetailsAgentId}
                      options={[
                        { value: '', label: '选择已启用的智能体' },
                        ...selected.activations.map((activation) => ({
                          value: activation.agentId,
                          label: `${activation.agentName} · r${activation.revision}`,
                        })),
                      ]}
                    />
                  ) : null}
                </>
              )}
            </section>
            <div className={styles.extensionDetailGrid}>
              <section>
                <div className={styles.sectionHeading}>r{focusedRevision?.revision ?? selected.revision} 的内容</div>
                {focusedRevision && focusedRevision.contributions.length > 0 ? (
                  <div className={styles.tagList}>
                    {focusedRevision.contributions.map((item) => (
                      <span key={item} title={item}>
                        {contributionLabel(item)}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className={styles.secondaryText}>没有注册可展示的工具或界面。</p>
                )}
              </section>
              <section>
                <div className={styles.sectionHeading}>验证记录</div>
                {focusedVerification ? (
                  <dl className={styles.facts}>
                    <dt>扩展格式</dt>
                    <dd>{contractVersionLabel(focusedVerification.contractVersion)}</dd>
                    <dt>DSH 版本</dt>
                    <dd>{focusedVerification.dshVersion}</dd>
                    <dt>服务端功能</dt>
                    <dd>{focusedVerification.hostBuilt ? '验证通过' : '未提供'}</dd>
                    <dt>界面功能</dt>
                    <dd>{focusedVerification.clientBuilt ? '验证通过' : '未提供'}</dd>
                    <dt>工具测试</dt>
                    <dd>
                      {focusedVerification.toolInvocationCount > 0
                        ? `${focusedVerification.toolInvocationCount} 次通过`
                        : '无工具调用'}
                    </dd>
                    <dt>最近界面加载</dt>
                    <dd>
                      {!focusedVerification.clientBuilt
                        ? '无界面入口'
                        : focusedClientDiagnostic === undefined
                          ? '暂无运行记录'
                          : focusedClientDiagnostic.status === 'loaded'
                            ? `已加载 · ${new Date(focusedClientDiagnostic.observedAt).toLocaleString('zh-CN')}`
                            : `失败 · ${new Date(focusedClientDiagnostic.observedAt).toLocaleString('zh-CN')}`}
                    </dd>
                  </dl>
                ) : (
                  <p className={styles.secondaryText}>
                    本机没有 r{focusedRevision?.revision ?? selected.revision} 的验证记录。
                  </p>
                )}
              </section>
            </div>
            <section className={styles.extensionTransferSection} aria-labelledby="extension-transfer-heading">
              <div className={styles.sectionBar}>
                <div>
                  <div className={styles.sectionHeading} id="extension-transfer-heading">
                    导入与分享
                  </div>
                  <div className={styles.secondaryText}>
                    .nxt-extension 可用于备份或小范围共享。导入后由你决定何时启用。
                  </div>
                </div>
              </div>
              <div className={styles.extensionTransferGrid}>
                <div
                  className={styles.extensionDropZone}
                  data-extension-drop-zone=""
                  data-dragging={importDragging ? '' : undefined}
                  onDragEnter={(event) => {
                    event.preventDefault()
                    setImportDragging(true)
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDragLeave={(event) => {
                    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
                    setImportDragging(false)
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    setImportDragging(false)
                    const file = event.dataTransfer.files[0]
                    if (file) void inspectImport(file)
                  }}
                >
                  <Upload size={22} aria-hidden="true" />
                  <span>
                    <strong>{importDragging ? '释放文件开始检查' : '导入扩展'}</strong>
                    <small>{importFileName || '将 .nxt-extension 拖到此处，或从本机选择文件。'}</small>
                  </span>
                  <label className={styles.extensionFileButton} data-disabled={importPending ? '' : undefined}>
                    <FileArchive size={14} aria-hidden="true" />
                    {importPending ? '正在检查…' : '选择文件'}
                    <Input
                      className={styles.extensionFileInput}
                      type="file"
                      accept=".nxt-extension,application/vnd.nekro-nxt.extension+zip"
                      aria-label="选择 .nxt-extension 文件"
                      disabled={importPending}
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0]
                        if (file) void inspectImport(file)
                        event.currentTarget.value = ''
                      }}
                    />
                  </label>
                </div>
                <div className={styles.extensionExportPanel}>
                  <Download size={22} aria-hidden="true" />
                  <span>
                    <strong>导出 r{focusedRevision?.revision ?? selected.revision}</strong>
                    <small>导出内容：源码、扩展契约和校验信息。启用关系、运行配置与凭据不在分享包内。</small>
                  </span>
                  <Button
                    disabled={!focusedRevision}
                    onClick={() => {
                      if (!focusedRevision) return
                      window.location.assign(
                        `/api/extensions/${encodeURIComponent(selected.id)}/revisions/${encodeURIComponent(focusedRevision.id)}/export`,
                      )
                    }}
                  >
                    <Download size={14} aria-hidden="true" /> 导出 r{focusedRevision?.revision ?? selected.revision}
                  </Button>
                </div>
              </div>
              {importInspection ? (
                <div className={styles.extensionImportReview}>
                  <span>
                    <strong>{importInspection.displayName}</strong>
                    <small>
                      {importInspection.scope === 'host-adapter'
                        ? '本机适配器'
                        : importInspection.scope === 'host-ui'
                          ? '页面扩展'
                          : '智能体扩展'}
                      {importInspection.idempotent ? ' · 本地已存在相同修订' : ' · 已通过文件检查'}
                    </small>
                  </span>
                  {importInspection.slugConflict ? (
                    <Field label="本地标识" hint="该标识已被其他扩展占用。">
                      <Input value={importSlug} onChange={(event) => setImportSlug(event.currentTarget.value)} />
                    </Field>
                  ) : null}
                  <Button
                    loading={importPending}
                    disabled={importInspection.slugConflict && importSlug.trim().length < 3}
                    onClick={() => void commitImport()}
                  >
                    {importInspection.idempotent ? '确认已存在' : '导入为未启用扩展'}
                  </Button>
                </div>
              ) : null}
            </section>
            {selected.scope === 'agent' && detailsActivation ? (
              <ExtensionActivationExtensionSlots
                agentId={detailsActivation.agentId}
                extensionId={selected.id}
                revisionId={detailsActivation.revisionId}
                activation="active"
                activationId={`${detailsActivation.agentId}:${selected.id}`}
                runtimeStatus={detailsActivation.runtime?.status ?? 'active'}
              />
            ) : null}
            <section className={styles.extensionDangerZone} aria-labelledby="extension-danger-heading">
              <span>
                <Trash2 size={18} aria-hidden="true" />
                <span>
                  <strong id="extension-danger-heading">删除本地扩展</strong>
                  <small>
                    删除源码、修订、验证记录和使用关系。
                    {selected.scope === 'host-adapter' ? '连接、频道和消息保留在原位。' : ''}
                  </small>
                </span>
              </span>
              <Button variant="danger" size="small" disabled={deletePending} onClick={() => setDeleteOpen(true)}>
                <Trash2 size={14} aria-hidden="true" /> 删除本地扩展
              </Button>
            </section>
          </section>
        ) : null}
      </StageCrossfade>
      <ConfirmDialog
        open={permissionRevisionId !== ''}
        onOpenChange={(open) => {
          if (!open) setPermissionRevisionId('')
        }}
        title="批准页面权限"
        description={
          permissionRevision?.verification?.permissions
            ? [
                ...permissionRevision.verification.permissions.permissions,
                ...permissionRevision.verification.permissions.networkOrigins.map((origin) => `网络：${origin}`),
              ].join('、') || '此页面扩展未申请产品数据权限。'
            : '无法读取此扩展版本的权限声明。'
        }
        confirmLabel="批准并安装"
        confirmLoadingLabel="正在安装…"
        onConfirm={async () => {
          const digest = permissionRevision?.verification?.permissionDigest
          if (!permissionRevision || !digest) return false
          const installed = await changeInstallation(permissionRevision.id, digest)
          if (installed) setPermissionRevisionId('')
          return installed
        }}
      />
      <ConfirmDialog
        open={uninstallOpen}
        onOpenChange={setUninstallOpen}
        title={selected?.scope === 'host-ui' ? '卸载页面扩展' : '卸载适配器'}
        description={
          selected?.scope === 'host-ui'
            ? '对应页面入口会从侧栏和页面入口列表中移除。'
            : '连接、频道和历史会保留，但重新安装相同适配器前不能收发消息。'
        }
        confirmLabel={selected?.scope === 'host-ui' ? '卸载页面扩展' : '卸载适配器'}
        confirmVariant="danger"
        onConfirm={() => changeInstallation(null)}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`删除“${selected?.name ?? '本地扩展'}”`}
        description={
          selected?.scope === 'host-adapter'
            ? `删除操作会卸载本机适配器，并移除 ${selected.revisions.length} 个修订及源码。连接、频道和历史保留。`
            : selected?.scope === 'host-ui'
              ? `删除操作会卸载页面扩展，并移除 ${selected.revisions.length} 个修订、源码和页面入口。`
              : `删除操作会关闭 ${selected?.activations.length ?? 0} 个智能体使用关系，并移除 ${selected?.revisions.length ?? 0} 个修订及源码。`
        }
        cancelLabel="保留扩展"
        confirmLabel="删除本地扩展"
        confirmVariant="danger"
        confirmLoadingLabel="正在停止并删除…"
        onConfirm={deleteExtension}
      />
    </div>
  )
}

const dynamicStatus = (status: string): { readonly label: string; readonly tone: StatusTone } => {
  if (status === 'ready') return { label: '可以预览', tone: 'success' }
  if (status === 'working') return { label: '正在开发', tone: 'info' }
  if (status === 'repairing') return { label: '正在修复', tone: 'info' }
  if (status === 'interrupted') return { label: '恢复中断', tone: 'error' }
  if (status === 'completed') return { label: '已完成', tone: 'success' }
  if (status === 'drafting') return { label: '正在生成', tone: 'info' }
  if (status === 'preflight-failed') return { label: '预检失败', tone: 'error' }
  if (status === 'loading-client') return { label: '正在加载界面', tone: 'info' }
  if (status === 'verifying') return { label: '正在验证', tone: 'info' }
  if (status === 'active') return { label: '已经运行', tone: 'success' }
  if (status === 'running') return { label: '运行中', tone: 'info' }
  if (status === 'awaiting-approval') return { label: '等待确认', tone: 'warning' }
  if (status === 'starting-host') return { label: '正在启动宿主', tone: 'info' }
  if (status === 'client-pending') return { label: '正在加载界面', tone: 'info' }
  if (status === 'waiting') return { label: '等待运行条件', tone: 'warning' }
  if (status === 'rejected') return { label: '已拒绝', tone: 'neutral' }
  if (status === 'cancelled') return { label: '已取消', tone: 'neutral' }
  if (status === 'failed') return { label: '运行失败', tone: 'error' }
  if (status === 'stopped') return { label: '已停止', tone: 'neutral' }
  return { label: '状态待确认', tone: 'unknown' }
}

const dynamicRunSummary = (item: DynamicPackageSummary): string => {
  const latest = item.latestRun
  const active = item.activeRun
  if (!latest) return dynamicStatus(item.status).label
  if (active && active.pluginRunId !== latest.pluginRunId) {
    return `已有预览仍在运行；新候选${dynamicStatus(latest.status).label}`
  }
  return dynamicStatus(latest.status).label
}

const dynamicHalfLabel = (
  status: DynamicPackageSummary['latestRun'] extends infer Latest
    ? Latest extends { host: infer Half }
      ? Half extends { status: infer Status }
        ? Status
        : never
      : never
    : never,
): string => {
  if (status === 'absent') return '不包含'
  if (status === 'pending') return '等待启动'
  if (status === 'running') return '已启动'
  if (status === 'waiting') return '等待条件'
  if (status === 'failed') return '失败'
  return '已停止'
}

export function CreatorPage() {
  const { taskId: routeTaskId } = useParams()
  const host = useProductStore((state) => state.host)
  const dynamic = useProductStore((state) => state.dynamic)
  const authoringTasks = useProductStore((state) => state.authoringTasks)
  const agents = useProductStore((state) => state.agents)
  const extensions = useProductStore((state) => state.extensions)
  const navigate = useNxtNavigate()
  const [searchParams] = useSearchParams()
  const requestedAgentId = searchParams.get('agent') ?? ''
  const [selectedKey, setSelectedKey] = useState('')
  const [saveOpen, setSaveOpen] = useState(false)
  const [deleteTaskOpen, setDeleteTaskOpen] = useState(false)
  const [extensionName, setExtensionName] = useState('')
  const [extensionSlug, setExtensionSlug] = useState('')
  const [extensionDescription, setExtensionDescription] = useState('')
  const [targetExtensionId, setTargetExtensionId] = useState('')
  const [saveError, setSaveError] = useState('')
  const [savePending, setSavePending] = useState(false)
  const [declinePending, setDeclinePending] = useState(false)
  const [approvePending, setApprovePending] = useState(false)
  const selectedTask = routeTaskId ? authoringTasks.find((task) => task.id === routeTaskId) : undefined
  const visibleDynamic = selectedTask
    ? dynamic.filter((item) => item.agentId === selectedTask.agentId && item.episodeId === selectedTask.episodeId)
    : dynamic
  const selectedItem =
    visibleDynamic.find((item) => `${item.episodeId}:${item.pluginId}:${item.packageId ?? ''}` === selectedKey) ??
    visibleDynamic[0]
  const selectedAgent = selectedItem ? agents.find((agent) => agent.id === selectedItem.agentId) : undefined
  const agentIsSettling = selectedAgent !== undefined && selectedAgent.state !== '空闲'
  const selectedPackageAvailable = selectedItem?.packageId !== undefined
  const eligibleAgents = agents.filter((agent) => agent.capabilities.dynamicCreation)
  const requestedAgent = agents.find((agent) => agent.id === requestedAgentId)

  useEffect(() => {
    const item = selectedTask
      ? dynamic.find((candidate) => candidate.episodeId === selectedTask.episodeId)
      : dynamic.find((candidate) => candidate.agentId === requestedAgentId)
    if (item) setSelectedKey(`${item.episodeId}:${item.pluginId}:${item.packageId ?? ''}`)
  }, [dynamic, requestedAgentId, selectedTask])

  const decline = async (): Promise<void> => {
    const item = selectedItem
    const approvalRequestId = item?.approvalRequestId
    if (!item || !approvalRequestId || declinePending) return
    setDeclinePending(true)
    try {
      await useProductStore.getState().resolveApproval({
        requestId: approvalRequestId,
        agentId: item.agentId,
        approved: false,
      })
      notify('本次界面预览已拒绝。', 'success', `dynamic-approval:${approvalRequestId}`)
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error', `dynamic-approval:${approvalRequestId}`)
    } finally {
      setDeclinePending(false)
    }
  }

  const approve = async (): Promise<void> => {
    const item = selectedItem
    const approvalRequestId = item?.approvalRequestId
    if (!item || !approvalRequestId || approvePending) return
    setApprovePending(true)
    try {
      await useProductStore.getState().resolveApproval({
        requestId: approvalRequestId,
        agentId: item.agentId,
        approved: true,
      })
      notify('候选已完成启动，正在核对真实预览。', 'success', `dynamic-approval:${approvalRequestId}`)
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error', `dynamic-approval:${approvalRequestId}`)
    } finally {
      setApprovePending(false)
    }
  }

  const saveDynamic = async (): Promise<void> => {
    if (agentIsSettling) {
      setSaveError('智能体仍在核对运行结果，请等待它完成收尾。')
      return
    }
    if (!selectedItem || !selectedItem.packageId || !extensionName.trim() || !extensionSlug.trim()) {
      setSaveError('请填写扩展名称和本地标识。')
      return
    }
    setSaveError('')
    setSavePending(true)
    try {
      const saved = await useProductStore.getState().saveDynamicExtension({
        ...(selectedTask?.candidateAttempt === undefined
          ? {}
          : { taskId: selectedTask.id, attemptId: selectedTask.candidateAttempt.id }),
        agentId: selectedItem.agentId,
        episodeId: selectedItem.episodeId,
        pluginId: selectedItem.pluginId,
        packageId: selectedItem.packageId,
        name: extensionName,
        slug: extensionSlug,
        description: extensionDescription,
        ...(targetExtensionId ? { targetExtensionId } : {}),
      })
      setSaveOpen(false)
      notify('已保存为本地扩展。', 'success', 'dynamic-extension-save')
      navigate(`/extensions/${saved.extensionId}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setSaveError(message)
      notify(message, 'error', 'dynamic-extension-save')
    } finally {
      setSavePending(false)
    }
  }

  return (
    <div className={[styles.page, styles.creatorPage].join(' ')}>
      <PageHeader
        title={selectedTask?.title ?? '创造'}
        meta={selectedTask?.requirementSummary ?? '动态运行、保存为本地扩展和启用给智能体是三个独立动作。'}
      />
      {selectedTask ? (
        <section className={styles.creatorTaskSummary}>
          <div className={styles.sectionBar}>
            <div>
              <div className={styles.sectionHeading}>开发任务</div>
              <div className={styles.secondaryText}>
                {selectedTask.candidateAttempt
                  ? `第 ${selectedTask.candidateAttempt.ordinal} 次尝试 · ${dynamicStatus(selectedTask.candidateAttempt.state).label}`
                  : '正在等待智能体生成候选内容'}
              </div>
            </div>
            <span className={styles.rowActions}>
              <StatusBadge tone={dynamicStatus(selectedTask.status).tone}>
                {dynamicStatus(selectedTask.status).label}
              </StatusBadge>
              {!['stopped', 'completed', 'interrupted'].includes(selectedTask.status) ? (
                <Button
                  size="small"
                  variant="secondary"
                  onClick={() =>
                    void useProductStore
                      .getState()
                      .stopAuthoringTask(selectedTask.id, selectedTask.revision)
                      .catch((error: unknown) =>
                        notify(error instanceof Error ? error.message : String(error), 'error', 'authoring-stop'),
                      )
                  }
                >
                  停止任务
                </Button>
              ) : (
                <Button variant="danger" size="small" onClick={() => setDeleteTaskOpen(true)}>
                  删除任务记录
                </Button>
              )}
            </span>
          </div>
          {selectedTask.candidateAttempt?.error ? (
            <InlineFeedback tone="error">
              {selectedTask.candidateAttempt.error.phase}：{selectedTask.candidateAttempt.error.message}
            </InlineFeedback>
          ) : (
            <InlineFeedback tone={selectedTask.status === 'ready' && !agentIsSettling ? 'success' : 'info'}>
              {selectedTask.status === 'ready' && agentIsSettling
                ? '候选内容已经通过验证，智能体正在核对结果；收尾完成后可以保存。'
                : selectedTask.status === 'ready'
                  ? '候选内容已经完成真实运行与界面验证，可以检查效果并保存。'
                  : '任务状态会随预检、运行确认、宿主启动、界面加载和结果验证自动更新。'}
            </InlineFeedback>
          )}
        </section>
      ) : null}
      {visibleDynamic.length === 0 && !selectedTask ? (
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
                  <small>运行结果确认无误时，可保存为本地扩展；智能体授权在扩展详情中管理。</small>
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
              <InlineFeedback tone="warning">
                当前没有获得动态创造授权的智能体。可在智能体的能力页开启授权。
              </InlineFeedback>
            )}
          </section>
        </div>
      ) : (
        <div
          className={[styles.creatorWorkspace, selectedTask ? styles.creatorWorkspaceTask : '']
            .filter(Boolean)
            .join(' ')}
        >
          {!selectedTask ? (
            <div className={styles.masterList} role="list" aria-label="动态运行">
              {visibleDynamic.map((item, index) => {
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
                        {item.packages.find((pkg) => pkg.packageId === item.packageId)?.name ??
                          `${agentName}的临时扩展`}
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
          ) : null}
          {selectedItem ? (
            <section className={[styles.section, styles.creatorCanvas].join(' ')}>
              <div className={styles.sectionBar}>
                <div>
                  <div className={styles.sectionHeading}>与{selectedAgent?.name ?? '智能体'}协作创造</div>
                  <div className={styles.secondaryText}>当前内容属于临时动态运行，尚未成为本地扩展。</div>
                </div>
                <StatusBadge tone={dynamicStatus(selectedItem.status).tone}>
                  {dynamicRunSummary(selectedItem)}
                </StatusBadge>
              </div>
              {selectedTask?.candidateAttempt ? (
                <div className={styles.authoringPhases} aria-label="候选运行阶段">
                  {[
                    ['候选生成', 'drafting'],
                    ['运行确认', 'awaiting-approval'],
                    ['宿主启动', 'starting-host'],
                    ['界面加载', 'loading-client'],
                    ['结果验证', 'active'],
                  ].map(([label, phase], index, phases) => {
                    const states = phases.map(([, value]) => value)
                    const current = states.indexOf(selectedTask.candidateAttempt!.state)
                    const failed = selectedTask.candidateAttempt!.state === 'failed'
                    const complete = selectedTask.status === 'ready' || current > index
                    return (
                      <div
                        className={styles.authoringPhase}
                        data-state={
                          failed && index === Math.max(current, 0)
                            ? 'failed'
                            : complete
                              ? 'complete'
                              : current === index
                                ? 'current'
                                : 'pending'
                        }
                        key={phase}
                      >
                        <span>{index + 1}</span>
                        <strong>{label}</strong>
                      </div>
                    )
                  })}
                </div>
              ) : null}
              <div className={styles.creatorEvidence}>
                <div>
                  <span>目标智能体</span>
                  <strong>{selectedAgent?.name ?? '未命名智能体'}</strong>
                </div>
                <div>
                  <span>当前状态</span>
                  <strong>{dynamicRunSummary(selectedItem)}</strong>
                </div>
                <div>
                  <span>宿主 / 界面</span>
                  <strong>
                    {selectedItem.latestRun
                      ? `${dynamicHalfLabel(selectedItem.latestRun.host.status)} / ${dynamicHalfLabel(selectedItem.latestRun.client.status)}`
                      : '尚未启动'}
                  </strong>
                </div>
              </div>
              <div className={styles.dynamicSlotSurface}>
                <div className={styles.sectionHeading}>即时界面</div>
                <DynamicClientSlots agentId={selectedItem.agentId} episodeId={selectedItem.episodeId} />
              </div>
              {selectedItem.latestRun?.error ? (
                <InlineFeedback tone="error">
                  {dynamicStatus(selectedItem.latestRun.status).label}：{selectedItem.latestRun.error.message}
                </InlineFeedback>
              ) : selectedItem.status === 'awaiting-approval' && selectedItem.approvalRequestId ? (
                <div className={styles.inlineApproval}>
                  <div>
                    <strong>候选已通过静态检查，等待运行确认</strong>
                    <small>该操作在当前浏览器加载候选界面，并验证实际渲染和调用。保存为本地扩展是独立操作。</small>
                  </div>
                  <span className={styles.rowActions}>
                    <Button
                      variant="secondary"
                      loading={declinePending}
                      loadingLabel="正在拒绝…"
                      disabled={approvePending}
                      onClick={() => void decline()}
                    >
                      拒绝候选
                    </Button>
                    <Button
                      variant="primary"
                      loading={approvePending}
                      loadingLabel="正在启动…"
                      disabled={declinePending}
                      onClick={() => void approve()}
                    >
                      允许并运行
                    </Button>
                  </span>
                </div>
              ) : (
                <InlineFeedback tone="info">
                  {selectedItem.status === 'running'
                    ? '运行结果已经通过实际加载与调用验证；保存会生成本地扩展修订。'
                    : `当前阶段：${dynamicRunSummary(selectedItem)}。`}
                </InlineFeedback>
              )}
              <div className={styles.sectionActionRow}>
                <span>
                  <strong>保存到本地扩展</strong>
                  <small>保存内容成为新的不可变修订；动态运行由创造工作台独立管理。</small>
                </span>
                <span className={styles.rowActions}>
                  <Button
                    variant="primary"
                    disabled={selectedItem.status !== 'running' || !selectedPackageAvailable || agentIsSettling}
                    onClick={() => {
                      setTargetExtensionId('')
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
      {saveOpen ? (
        <section className={styles.creatorSavePanel} aria-label="保存为本地扩展">
          <div className={styles.sectionBar}>
            <div>
              <div className={styles.sectionHeading}>保存为本地扩展</div>
              <div className={styles.secondaryText}>保存会把当前候选写成不可变修订；新修订默认未启用。</div>
            </div>
            <Button variant="ghost" disabled={savePending} onClick={() => setSaveOpen(false)}>
              收起
            </Button>
          </div>
          <div className={styles.creatorSaveGrid}>
            <SelectField
              label="保存位置"
              value={targetExtensionId}
              onValueChange={(nextId) => {
                setTargetExtensionId(nextId)
                const target = extensions.find((extension) => extension.id === nextId)
                if (!target) return
                setExtensionName(target.name)
                setExtensionSlug(target.slug)
                setExtensionDescription(target.description)
              }}
              options={[
                { value: '', label: '创建新扩展' },
                ...extensions.map((extension) => ({
                  value: extension.id,
                  label: `${extension.name} · r${extension.revision}`,
                })),
              ]}
            />
            <Field label="扩展名称">
              <Input
                value={extensionName}
                disabled={Boolean(targetExtensionId)}
                onChange={(event) => setExtensionName(event.target.value)}
              />
            </Field>
            <Field label="本地标识" hint="使用小写字母、数字和连字符。">
              <Input
                value={extensionSlug}
                disabled={Boolean(targetExtensionId)}
                onChange={(event) => setExtensionSlug(event.target.value)}
              />
            </Field>
            <Field label="说明">
              <Textarea
                value={extensionDescription}
                disabled={Boolean(targetExtensionId)}
                onChange={(event) => setExtensionDescription(event.target.value)}
              />
            </Field>
            {saveError ? <InlineFeedback tone="error">{saveError}</InlineFeedback> : null}
            <div className={styles.creatorSaveActions}>
              <Button variant="secondary" disabled={savePending} onClick={() => setSaveOpen(false)}>
                取消
              </Button>
              <Button
                variant="primary"
                loading={savePending}
                loadingLabel="正在保存…"
                disabled={agentIsSettling}
                onClick={() => void saveDynamic()}
              >
                保存本地扩展
              </Button>
            </div>
          </div>
        </section>
      ) : null}
      <ConfirmDialog
        open={deleteTaskOpen}
        onOpenChange={setDeleteTaskOpen}
        title="删除扩展开发任务"
        description="任务账本和全部候选源码会被删除，已经保存的本地扩展不受影响。"
        confirmLabel="删除任务记录"
        confirmVariant="danger"
        onConfirm={async () => {
          if (!selectedTask) return false
          try {
            await useProductStore.getState().deleteAuthoringTask(selectedTask.id)
            notify('扩展开发任务已删除。', 'success', `authoring-delete:${selectedTask.id}`)
            navigate('/work/creator')
            return true
          } catch (error) {
            notify(
              error instanceof Error ? error.message : String(error),
              'error',
              `authoring-delete:${selectedTask.id}`,
            )
            return false
          }
        }}
      />
    </div>
  )
}
