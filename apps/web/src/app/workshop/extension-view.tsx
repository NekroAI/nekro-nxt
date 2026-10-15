import { useGo } from '../model/nav.js'
import { LogsButton } from '../logs/logs-button.js'
import { CompatibilityNotices } from '../system/compatibility.js'
import { Download, GitBranch, MoreHorizontal, Share2, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { communityPublisherLabel, HostApiContracts, type HostApiResponse } from '@nekro-nxt/contracts'
import { callHostApi } from '../../host-api-client.js'
import {
  useHostActions,
  useProductRuntime,
  useProductStore,
  type AgentSummary,
  type LocalExtensionSummary,
} from '../../product-runtime.js'
import type { ExtensionApprovals } from '../../product-model.js'
import {
  AgentAvatar,
  Banner,
  Button,
  Chip,
  ConfirmDialog,
  DangerZone,
  DataTable,
  Diagnostics,
  Dialog,
  ExtensionIcon,
  Field,
  Input,
  MainContent,
  Menu,
  ObjectHeader,
  PropertyGroup,
  PropertyList,
  PropertyRow,
  Select,
  Switch,
  SwitchRow,
  TabStrip,
  toast,
  type Column,
} from '../../ui-kit/index.js'
import { relativeTime } from '../channels/timeline-model.js'
import { agentHue } from '../model/identity.js'
import {
  ExtensionConfigEditor,
  PanelSlot,
  activeConfigSchema,
  approvalRiskKeys,
  configFieldTitles,
  PermissionApprovalList,
  useExtensionActivation,
} from '../../extension-ui/index.js'
import { useProductApi } from '../model/store.js'
import {
  CONTRIBUTION_PLACE,
  SLUG_PATTERN,
  contributionParts,
  extensionUsage,
  hasAgentLayer,
  mcpParts,
  mcpStatusText,
  proposeSlug,
  providesLabel,
} from './workshop-model.js'
import { ExtensionData } from './extension-data.js'
import { LineageView } from './lineage-view.js'
import { PublishDialog } from './publish-dialog.js'
import { useVersionText, type VersionText } from './version-text.js'
import styles from './workshop.module.css'

type Revision = LocalExtensionSummary['revisions'][number]
type Tab = 'overview' | 'config' | 'versions' | 'data' | 'diagnostics'

const failure = (error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })

const usable = (revision: Revision): boolean => revision.format === undefined || revision.format === 'current'

const pad = (value: number) => String(value).padStart(2, '0')
const fileStamp = (time: number) => {
  const date = new Date(time)
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

const download = async (extension: LocalExtensionSummary, revision: Revision) => {
  const bytes = await callHostApi(
    HostApiContracts.exportExtensionRevision,
    { extensionId: extension.id, revisionId: revision.id },
    undefined,
  )
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/zip' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${extension.slug}-${revision.versionLabel.replace('·', '-')}-${fileStamp(revision.createdAt)}.nxt-extension`
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function ExtensionView({ extension }: { readonly extension: LocalExtensionSummary }) {
  const navigate = useGo()
  const hostActions = useHostActions()
  const agents = useProductStore((state) => state.agents)
  const ui = useProductRuntime().uiStore
  const usage = extensionUsage(extension)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [publishing, setPublishing] = useState<Revision>()
  const [branching, setBranching] = useState<Revision>()
  const switching = useVersionSwitch(extension)
  const describe = useVersionText()
  const versionOf = (revision: Revision | undefined) => (revision ? describe(extension, revision.id) : undefined)
  const [params, setParams] = useSearchParams()
  const [uninstallOpen, setUninstallOpen] = useState(false)
  const api = useProductApi()
  const hasConfig =
    (extension.installation !== undefined && activeConfigSchema(extension) !== undefined) ||
    extension.activations.some((activation) => activeConfigSchema(extension, activation.agentId) !== undefined)
  const tabs: readonly { readonly value: Tab; readonly label: string }[] = [
    { value: 'overview', label: '概览' },
    ...(hasConfig ? [{ value: 'config' as const, label: '配置' }] : []),
    { value: 'versions', label: '版本' },
    { value: 'data', label: '数据' },
    { value: 'diagnostics', label: '诊断' },
  ]
  const tab = tabs.find((item) => item.value === params.get('tab'))?.value ?? 'overview'
  const openTab = (value: Tab) => setParams(value === 'overview' ? {} : { tab: value }, { replace: true })
  const latest = extension.revisions.at(-1)
  const installed = extension.revisions.find((item) => item.id === extension.installation?.revisionId)
  const current = installed ?? extension.revisions.findLast(usable) ?? latest
  const unsupported = extension.revisions.filter((item) => !usable(item)).length
  const communityRelease = current?.releases.find((release) => release.via === 'install')
  // Revising goes through an agent that can create: the one that made it, or else the first one with a channel.
  const reviser =
    agents.find(
      (agent) => agent.id === extension.createdByAgentId && agent.capabilities.dynamicCreation && agent.channels[0],
    ) ?? agents.find((agent) => agent.capabilities.dynamicCreation && agent.channels[0] !== undefined)

  return (
    <MainContent>
      <ObjectHeader
        visual={<ExtensionIcon id={extension.id} name={extension.name} iconUrl={extension.iconUrl} size="lg" />}
        title={extension.name}
        status={
          <Chip tone={usage.tone} dot>
            {usage.label}
          </Chip>
        }
        meta={
          <>
            <span>{providesLabel(extension.provides)}</span>
            {current ? <span>{versionOf(current)?.title}</span> : null}
            {extension.branchOf ? (
              <Link to={`/workshop/extensions/${extension.branchOf.extensionId}`} className={styles.metaLink}>
                分支自{extension.branchOf.displayName ? `「${extension.branchOf.displayName}」` : '另一个扩展'}
              </Link>
            ) : communityRelease ? (
              <Link to={`/community/extensions/${extension.id}`} className={styles.metaLink}>
                来自社区 {communityPublisherLabel(communityRelease.publisherHandle)}
              </Link>
            ) : (
              <span>{extension.createdByAgent ? `由${extension.createdByAgent}创造` : '本地导入'}</span>
            )}
          </>
        }
        actions={
          <>
            <LogsButton query={{ scope: { extensionId: extension.id } }} />
            <Menu
              label="扩展操作"
              align="end"
              trigger={
                <Button size="small" variant="ghost" icon={<MoreHorizontal size={14} />}>
                  更多
                </Button>
              }
              items={[
                ...(current
                  ? [
                      {
                        key: 'export',
                        label: '导出当前版本',
                        icon: <Download size={14} />,
                        onSelect: () => void download(extension, current).catch(failure),
                      },
                      ...(usable(current)
                        ? [
                            {
                              key: 'publish',
                              label: '发布到社区',
                              icon: <Share2 size={14} />,
                              onSelect: () => setPublishing(current),
                            },
                            {
                              key: 'branch',
                              label: '创建分支',
                              icon: <GitBranch size={14} />,
                              onSelect: () => setBranching(current),
                            },
                          ]
                        : []),
                    ]
                  : []),
              ]}
            />
          </>
        }
      />
      <PublishDialog
        extension={extension}
        revision={publishing}
        open={publishing !== undefined}
        onOpenChange={(open) => !open && setPublishing(undefined)}
        onBranch={() => publishing && setBranching(publishing)}
      />
      <BranchDialog extension={extension} revision={branching} onClose={() => setBranching(undefined)} />
      {switching.dialog}
      {extension.description ? <p className={styles.lead}>{extension.description}</p> : null}
      <CompatibilityNotices extensionId={extension.id} />
      {extension.openRevisionTaskId ? (
        <Banner
          tone="info"
          action={
            <Button size="small" onClick={() => navigate(`/workshop/tasks/${extension.openRevisionTaskId}`)}>
              查看任务
            </Button>
          }
        >
          有一个修改这个扩展的任务还没完成，保存后会成为它的下一个版本。
        </Banner>
      ) : null}
      {unsupported > 0 ? (
        <Banner tone="warn">
          {unsupported === extension.revisions.length
            ? '这个扩展的格式已不再受支持，无法启用；请让智能体重新创造。'
            : '部分较早版本的格式不再受支持，无法启用。'}
        </Banner>
      ) : null}

      <TabStrip label="扩展详情" options={tabs} value={tab} onChange={openTab} />

      {tab === 'overview' ? (
        <>
          <Overview revision={current} pages={extension.revisions.flatMap((revision) => revision.pages)} />
          <Installation
            extension={extension}
            switching={switching}
            title={versionOf(extension.revisions.find((item) => item.id === extension.installation?.revisionId))}
            onVersions={() => openTab('versions')}
          />
          {hasAgentLayer(extension) ? <AgentUsage extension={extension} /> : null}
          {extension.installation ? (
            <PanelSlot anchor={{ kind: 'extension', id: extension.id }} density="full" />
          ) : null}
          <DangerZone>
            {extension.installation ? (
              <PropertyRow label="卸载" description={`扩展停止运行，数据保留${removalConsequences(extension)}`}>
                <Button variant="danger" disabled={switching.busy} onClick={() => setUninstallOpen(true)}>
                  卸载
                </Button>
              </PropertyRow>
            ) : null}
            <PropertyRow label="删除扩展" description="全部版本、源码、数据与验证记录都会被永久删除。">
              <Button variant="danger" icon={<Trash2 size={14} />} onClick={() => setDeleteOpen(true)}>
                删除扩展
              </Button>
            </PropertyRow>
          </DangerZone>
        </>
      ) : null}

      {tab === 'config' ? <ExtensionSettings extension={extension} /> : null}

      {tab === 'versions' ? (
        <>
          <VersionList extension={extension} switching={switching} describe={versionOf} />
          <PropertyGroup
            title="谱系"
            tip="每次保存都是一个新版本，接在它修改的版本之后；分支是从某个版本另起的扩展，分支还可以再分支。实心点是正在使用的版本。点一个版本可以切换、导出、发布或从它修改。"
          >
            <LineageView
              extension={extension}
              actions={{
                onSwitch: (revision) => switching.request(revision),
                onBranch: (revision) => setBranching(revision),
                onPublish: (revision) => setPublishing(revision),
                onExport: (revision) => void download(extension, revision).catch(failure),
                onRevise:
                  reviser?.channels[0] === undefined
                    ? undefined
                    : (revision) => {
                        const channelId = reviser.channels[0]!
                        ui.getState().setChannelDraft(
                          channelId,
                          `在「${extension.name}」${versionOf(revision)?.title ?? ''}的基础上修改：`,
                        )
                        navigate(`/channels/${channelId}`)
                      },
              }}
            />
          </PropertyGroup>
        </>
      ) : null}

      {tab === 'data' ? <ExtensionData extension={extension} /> : null}

      {tab === 'diagnostics' ? (
        <Diagnostics
          items={[
            { label: '扩展 ID', value: extension.id },
            { label: '本地标识', value: extension.slug },
            ...extension.revisions.toReversed().map((revision) => ({
              label: `${versionOf(revision)?.title ?? ''}（${versionOf(revision)?.code ?? ''}）`,
              value: `${revision.id}（第 ${revision.revision} 个）`,
            })),
          ]}
        />
      ) : null}

      <ConfirmDialog
        open={uninstallOpen}
        onOpenChange={setUninstallOpen}
        title={`卸载「${extension.name}」？`}
        confirmLabel="卸载"
        danger
        onConfirm={async () => {
          await api.getState().setHostExtensionInstalled(extension.id, null)
          toast('已卸载')
        }}
      >
        {`扩展会停止运行，数据保留${removalConsequences(extension)}`}
      </ConfirmDialog>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`删除「${extension.name}」？`}
        confirmLabel="删除扩展"
        danger
        onConfirm={async () => {
          await hostActions['extensions.delete']({ extensionId: extension.id })
          toast(`已删除「${extension.name}」`)
          navigate('/workshop', { replace: true })
        }}
      >
        {extension.revisions.length} 个版本、源码、数据与验证记录会被永久删除
        {removalConsequences(extension)}
      </ConfirmDialog>
    </MainContent>
  )
}

/** Creates a new extension from one version; the data of the original can come along. */
function BranchDialog({
  extension,
  revision,
  onClose,
}: {
  readonly extension: LocalExtensionSummary
  readonly revision: Revision | undefined
  readonly onClose: () => void
}) {
  const navigate = useGo()
  const describe = useVersionText()
  const describeVersionTitle = (item: Revision) => `「${describe(extension, item.id)?.title ?? ''}」`
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [copyData, setCopyData] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!revision) return
    const proposed = `${extension.name}（分支）`
    setName(proposed)
    setSlug(proposeSlug(`${extension.slug}-branch`))
    setSlugEdited(false)
    setCopyData(true)
    setError('')
  }, [revision])
  const valid = name.trim() !== '' && SLUG_PATTERN.test(slug)
  const create = async () => {
    if (!revision) return
    setBusy(true)
    setError('')
    try {
      const result = await callHostApi(
        HostApiContracts.branchExtension,
        { extensionId: extension.id },
        { revisionId: revision.id, name: name.trim(), slug, copyData },
      )
      toast(`已创建分支「${name.trim()}」`)
      onClose()
      navigate(`/workshop/extensions/${result.extensionId}`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={revision !== undefined}
      onOpenChange={(open) => !open && !busy && onClose()}
      title="从这个版本创建分支"
      actions={
        <>
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" busy={busy} disabled={!valid} onClick={() => void create()}>
            创建分支
          </Button>
        </>
      }
    >
      <p style={{ margin: 0 }}>
        分支是一个新扩展，代码和「{extension.name}」{revision ? describeVersionTitle(revision) : ''}
        完全相同，之后各自修改、互不影响。它会记住自己分支自哪里，发布到社区时也会标明。
      </p>
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
      <SwitchRow
        title="复制现有数据"
        description="把原扩展积累的记录、索引和素材复制一份给分支；之后两边的数据分开保存。"
        checked={copyData}
        onCheckedChange={setCopyData}
      />
      {error ? (
        <p role="alert" style={{ margin: 0, color: 'var(--bad)' }}>
          {error}
        </p>
      ) : null}
    </Dialog>
  )
}

/** What the extension gives the user and where it shows up. */
function Overview({ revision, pages }: { readonly revision: Revision | undefined; readonly pages: Revision['pages'] }) {
  const navigate = useGo()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const parts = [
    ...(revision?.contributions ?? []).map((value) => ({ ...contributionParts(value), detail: undefined })),
    ...mcpParts(revision?.verification?.permissions?.agent?.mcp?.servers ?? []),
  ]
    // Data endpoints only feed the extension's own screens; people never use them directly.
    .filter((part) => part.kind !== '数据接口')
  // One row per kind (tools, pages, panels…), its names as chips.
  const kinds = [...new Set(parts.map((part) => part.kind))].map((kind) => ({
    kind,
    parts: parts.filter((part) => part.kind === kind),
  }))
  return (
    <PropertyGroup title="能提供什么">
      {kinds.length === 0 ? (
        <p className={styles.faint}>这个版本还没有经过验证，暂时无法说明它提供的内容。</p>
      ) : (
        <PropertyList>
          {kinds.map(({ kind, parts: items }) => {
            const open = expanded.has(kind) || items.length <= CHIP_LIMIT
            const shown = open ? items : items.slice(0, CHIP_LIMIT)
            const detail = items.length === 1 ? items[0]?.detail : undefined
            return (
              <PropertyRow
                key={kind}
                label={`${kind} ${items.length}`}
                description={
                  detail ??
                  (kind === '页面' && items.some((part) => pages.find((page) => page.title === part.name)?.rail)
                    ? '独立页面，已加入左侧导航'
                    : undefined) ??
                  CONTRIBUTION_PLACE[kind] ??
                  CONTRIBUTION_PLACE['内容']
                }
                layout="stacked"
              >
                <div className={styles.contributionChips}>
                  {shown.map((part) =>
                    kind === '页面' ? (
                      <OpenPage
                        key={part.name}
                        name={part.name}
                        page={pages.find((page) => page.title === part.name)}
                        navigate={navigate}
                      />
                    ) : (
                      <Chip key={part.name}>{part.name}</Chip>
                    ),
                  )}
                  {open ? null : (
                    <Button size="small" variant="ghost" onClick={() => setExpanded((old) => new Set(old).add(kind))}>
                      还有 {items.length - CHIP_LIMIT} 个
                    </Button>
                  )}
                </div>
              </PropertyRow>
            )
          })}
        </PropertyList>
      )}
    </PropertyGroup>
  )
}

const CHIP_LIMIT = 8

/** Opens an installed page; a page that is not installed has nothing to open. */
function OpenPage({
  name,
  page,
  navigate,
}: {
  readonly name: string
  readonly page: Revision['pages'][number] | undefined
  readonly navigate: (path: string) => void
}) {
  if (!page) return <Chip>{name}</Chip>
  return (
    <Button
      size="small"
      aria-label={`打开「${page.title}」`}
      onClick={() => navigate(`${page.routeBase}${page.startPath ? `/${page.startPath}` : ''}`)}
    >
      打开「{name}」
    </Button>
  )
}

/** What removing or uninstalling the extension stops, ending with a full stop. */
const removalConsequences = (extension: LocalExtensionSummary): string => {
  const hasPages = extension.provides.includes('page')
  const hasPlatform = extension.provides.some((item) => item === 'adapter')
  const effects = [
    ...(extension.activations.length > 0 ? [`${extension.activations.length} 个智能体会停止使用`] : []),
    ...(hasPages ? ['页面入口随之移除'] : []),
    ...(hasPlatform ? ['连接、频道和消息保留，重新安装前这些连接无法收发消息'] : []),
  ]
  return effects.length === 0 ? '。' : `；${effects.join('；')}。`
}

/**
 * Configuration and the extension's own panels: the host configuration once for this machine, and each enabled
 * agent's own configuration.
 */
function ExtensionSettings({ extension }: { readonly extension: LocalExtensionSummary }) {
  const enabledAgents = extension.activations.map((activation) => ({
    id: activation.agentId,
    name: activation.agentName,
  }))
  const [chosen, setChosen] = useState(enabledAgents[0]?.id ?? '')
  const agentId = enabledAgents.find((agent) => agent.id === chosen)?.id ?? enabledAgents[0]?.id
  const hostConfig = extension.installation !== undefined && activeConfigSchema(extension) !== undefined
  const agentConfig = agentId !== undefined && activeConfigSchema(extension, agentId) !== undefined
  return (
    <>
      {hostConfig ? (
        <PropertyGroup title="本机配置" tip="对整台机器生效，所有智能体共用。">
          <div className={styles.config}>
            <ExtensionConfigEditor key="host" extension={extension} />
          </div>
        </PropertyGroup>
      ) : null}
      {agentConfig ? (
        <PropertyGroup
          title="智能体配置"
          tip="每个启用了这个扩展的智能体各有一份。"
          actions={
            enabledAgents.length > 1 ? (
              <Select
                aria-label="配置哪个智能体"
                value={agentId}
                onValueChange={(value) => setChosen(value)}
                options={enabledAgents.map((agent) => ({ value: agent.id, label: agent.name }))}
              />
            ) : undefined
          }
        >
          <div className={styles.config}>
            <ExtensionConfigEditor key={agentId} extension={extension} agentId={agentId} />
          </div>
        </PropertyGroup>
      ) : null}
    </>
  )
}

/** One row per agent with an on/off switch; every agent uses the version installed on this machine. */
function AgentUsage({ extension }: { readonly extension: LocalExtensionSummary }) {
  const agents = useProductStore((state) => state.agents)
  // Rows with a request in flight; only those rows lock, the rest of the table stays usable.
  const [changing, setChanging] = useState<ReadonlySet<string>>(new Set())
  const activation = useExtensionActivation()
  // Enabling an extension that is not on this machine yet installs its latest usable record.
  const target = extension.installation?.revisionId ?? extension.revisions.findLast(usable)?.id

  const transitionFor = (agent: AgentSummary) =>
    extension.activationTransitions?.find((item) => item.agentId === agent.id)
  /** A request waiting for the agent's current reply to end already shows its target position. */
  const enabledFor = (agent: AgentSummary): boolean => {
    const transition = transitionFor(agent)
    return transition?.state === 'waiting'
      ? transition.target === 'enabled'
      : extension.activations.some((item) => item.agentId === agent.id)
  }

  const change = async (agentId: string, enabled: boolean, revisionId?: string) => {
    setChanging((current) => new Set(current).add(agentId))
    try {
      await activation.setActive({
        extensionId: extension.id,
        agentId,
        enabled,
        ...(revisionId === undefined ? {} : { revisionId }),
      })
    } catch (error) {
      failure(error)
    } finally {
      setChanging((current) => {
        const next = new Set(current)
        next.delete(agentId)
        return next
      })
    }
  }

  const columns: readonly Column<AgentSummary>[] = [
    {
      key: 'agent',
      header: '智能体',
      width: 'minmax(160px, 2fr)',
      render: (agent) => {
        const record = extension.activations.find((item) => item.agentId === agent.id)
        const broken = record?.runtime && record.runtime.status !== 'active'
        const transition = transitionFor(agent)
        const action = transition?.target === 'enabled' ? '启用' : '停用'
        return (
          <Link to={`/agents/${agent.id}`} className={styles.cellAgent}>
            <AgentAvatar name={agent.name} hue={agentHue(agent)} size="sm" />
            <span className={styles.cellAgentText}>
              <b>{agent.name}</b>
              {transition?.state === 'waiting' ? (
                <small>正在回复，结束后{action}</small>
              ) : transition?.state === 'failed' ? (
                <small className={styles.bad}>
                  {action}失败：{transition.message ?? '原因未知'}
                </small>
              ) : broken ? (
                <small className={styles.bad}>{record.runtime?.message ?? '运行异常'}</small>
              ) : record?.mcpServers !== undefined && record.mcpServers.length > 0 ? (
                <small
                  className={
                    record.mcpServers.some(
                      (server) => server.state === 'unavailable' || server.state === 'missing-credentials',
                    )
                      ? styles.bad
                      : undefined
                  }
                >
                  {mcpStatusText(record.mcpServers)}
                </small>
              ) : record ? (
                <small>{relativeTime(record.activatedAt)}启用</small>
              ) : null}
            </span>
          </Link>
        )
      },
    },
    {
      key: 'enabled',
      header: '启用',
      width: '72px',
      align: 'end',
      render: (agent) => {
        const enabled = enabledFor(agent)
        return (
          <Switch
            label={`${agent.name}使用「${extension.name}」`}
            checked={enabled}
            pending={changing.has(agent.id) || transitionFor(agent)?.state === 'waiting'}
            disabled={!enabled && target === undefined}
            onCheckedChange={(next) => change(agent.id, next, next ? target : undefined)}
          />
        )
      },
    },
  ]

  return (
    <PropertyGroup title="智能体" tip="启用后它在对话里就能用这个扩展。">
      {activation.dialog}
      <DataTable
        label="使用这个扩展的智能体"
        columns={columns}
        rows={agents}
        rowKey={(agent) => agent.id}
        empty="还没有智能体。"
      />
    </PropertyGroup>
  )
}

type Approval = {
  readonly revision: Revision
  readonly host?: NonNullable<NonNullable<Revision['verification']>['hostPermission']>
  readonly agent?: NonNullable<NonNullable<Revision['verification']>['agentPermission']>
  readonly restoreDataSnapshotId?: string
}

type DataSnapshots = HostApiResponse<'getExtensionData'>['snapshots']

/**
 * Switching the one installed version: approvals of what the new version asks for (the machine and, when it asks
 * agents for more, those agents too), and a data snapshot to put back when the target only reads an older data format.
 */
function useVersionSwitch(extension: LocalExtensionSummary) {
  const api = useProductApi()
  const describe = useVersionText()
  const [busy, setBusy] = useState(false)
  const [approve, setApprove] = useState<Approval>()
  const [acceptedRisks, setAcceptedRisks] = useState<ReadonlySet<string>>(new Set())
  const [restoring, setRestoring] = useState<{ readonly revision: Revision; readonly snapshots: DataSnapshots }>()
  const [restoreChoice, setRestoreChoice] = useState('')

  const install = async (revision: Revision, approvals?: ExtensionApprovals) => {
    setBusy(true)
    try {
      await api.getState().setHostExtensionInstalled(extension.id, revision.id, approvals)
      const name = describe(extension, revision.id)?.title ?? '这个版本'
      toast(extension.installation ? `已切换到「${name}」` : `已安装「${name}」`)
    } finally {
      setBusy(false)
    }
  }
  const proceed = (revision: Revision, restoreDataSnapshotId?: string) => {
    const host = revision.verification?.hostPermission
    const agent = revision.verification?.agentPermission
    const needsHost = host?.approvalRequired === true
    // Agents move with the installation; a version that asks them for more needs their approval as well.
    const needsAgent = extension.activations.length > 0 && agent?.approvalRequired === true
    if (needsHost || needsAgent) {
      setAcceptedRisks(new Set())
      setApprove({
        revision,
        ...(needsHost && host !== undefined ? { host } : {}),
        ...(needsAgent && agent !== undefined ? { agent } : {}),
        ...(restoreDataSnapshotId === undefined ? {} : { restoreDataSnapshotId }),
      })
      return
    }
    void install(revision, restoreDataSnapshotId === undefined ? undefined : { restoreDataSnapshotId }).catch(failure)
  }
  const request = (revision: Revision) => {
    if (extension.installation && revision.dataVersion < extension.dataVersion) {
      void callHostApi(HostApiContracts.getExtensionData, { extensionId: extension.id }, undefined)
        .then((state) => {
          const snapshots = state.snapshots.filter((snapshot) => snapshot.dataVersion <= revision.dataVersion)
          setRestoreChoice(snapshots[0]?.id ?? '')
          setRestoring({ revision, snapshots })
        })
        .catch(failure)
      return
    }
    proceed(revision)
  }
  const rollback = async () => {
    setBusy(true)
    try {
      const result = await callHostApi(HostApiContracts.rollbackExtension, { extensionId: extension.id }, undefined)
      toast(result.message)
    } catch (error) {
      failure(error)
    } finally {
      setBusy(false)
    }
  }

  const dialog = (
    <>
      <ConfirmDialog
        open={approve !== undefined}
        onOpenChange={(open) => !open && setApprove(undefined)}
        title="批准这个版本申请的权限"
        confirmLabel="批准并安装"
        confirmDisabled={approvalRiskKeys(approve?.host, approve?.agent).some((key) => !acceptedRisks.has(key))}
        onConfirm={() =>
          approve
            ? install(approve.revision, {
                ...(approve.host === undefined ? {} : { host: approve.host.permissionDigest }),
                ...(approve.agent === undefined ? {} : { agent: approve.agent.permissionDigest }),
                ...(approve.restoreDataSnapshotId === undefined
                  ? {}
                  : { restoreDataSnapshotId: approve.restoreDataSnapshotId }),
              })
            : undefined
        }
      >
        <PermissionApprovalList
          host={approve?.host}
          agent={approve?.agent}
          hostTitle="对整台机器生效："
          agentTitle={`对正在使用它的 ${extension.activations.length} 个智能体生效：`}
          accepted={acceptedRisks}
          onAcceptedChange={setAcceptedRisks}
          {...(approve === undefined ? {} : { fieldTitle: configFieldTitles(approve.revision) })}
        />
      </ConfirmDialog>
      <ConfirmDialog
        open={restoring !== undefined}
        onOpenChange={(open) => !open && setRestoring(undefined)}
        title="切换到这个版本需要恢复旧数据"
        confirmLabel="恢复并切换"
        danger
        confirmDisabled={restoreChoice === ''}
        onConfirm={() => {
          if (!restoring) return
          setRestoring(undefined)
          proceed(restoring.revision, restoreChoice)
        }}
      >
        本机数据已经是第 {extension.dataVersion} 版格式，这个版本只认识第 {restoring?.revision.dataVersion}{' '}
        版。切换时要先把数据恢复成一份旧格式的快照；快照之后写入的数据会丢失，切换前的数据会再留一份快照。
        {restoring && restoring.snapshots.length > 0 ? (
          <Field label="恢复哪份快照">
            <Select
              aria-label="恢复哪份快照"
              value={restoreChoice}
              onValueChange={setRestoreChoice}
              options={restoring.snapshots.map((snapshot) => ({
                value: snapshot.id,
                label: `${relativeTime(snapshot.createdAt)} · ${snapshot.label} · 第 ${snapshot.dataVersion} 版格式`,
              }))}
            />
          </Field>
        ) : (
          <Banner tone="bad">没有可用的旧格式快照，无法切换到这个版本。</Banner>
        )}
      </ConfirmDialog>
    </>
  )
  return { request, rollback, busy, dialog }
}

/** Every saved version, newest first; any usable one can be installed or switched to from its row. */
function VersionList({
  extension,
  switching,
  describe,
}: {
  readonly extension: LocalExtensionSummary
  readonly switching: ReturnType<typeof useVersionSwitch>
  readonly describe: (revision: Revision | undefined) => VersionText | undefined
}) {
  const installed = extension.installation?.revisionId
  const columns: readonly Column<Revision>[] = [
    {
      key: 'version',
      header: '版本',
      width: 'minmax(220px, 2fr)',
      render: (revision) => {
        const text = describe(revision)
        return (
          <span className={styles.versionCell}>
            <b>{text?.title}</b>
            <span className={styles.faint}>
              {text?.source} · {text?.code}
            </span>
          </span>
        )
      },
    },
    {
      key: 'state',
      header: '状态',
      width: 'minmax(120px, 1fr)',
      priority: 2,
      render: (revision) => {
        const users = extension.activations.filter((item) => item.revisionId === revision.id)
        return (
          <span className={styles.contributionChips}>
            {revision.id === installed ? <Chip tone="ok">正在使用</Chip> : null}
            {users.length > 0 && revision.id !== installed ? (
              <Chip>{users.map((item) => item.agentName).join('、')} 在用</Chip>
            ) : null}
            {usable(revision) ? null : <Chip tone="warn">格式不受支持</Chip>}
          </span>
        )
      },
    },
    {
      key: 'action',
      header: <span className={styles.srOnly}>操作</span>,
      width: '132px',
      align: 'end',
      render: (revision) =>
        revision.id === installed || !usable(revision) ? null : (
          <Button size="small" busy={switching.busy} onClick={() => switching.request(revision)}>
            {installed ? '切换到这个版本' : '安装这个版本'}
          </Button>
        ),
    },
  ]
  return (
    <PropertyGroup
      title="版本"
      actions={
        installed && extension.revisions.length > 1 ? (
          <Button size="small" variant="ghost" disabled={switching.busy} onClick={() => void switching.rollback()}>
            回到上一个版本
          </Button>
        ) : undefined
      }
    >
      <DataTable
        label="版本"
        columns={columns}
        rows={extension.revisions.toReversed()}
        rowKey={(revision) => revision.id}
      />
    </PropertyGroup>
  )
}

/** The extension's single installation on this machine; versions are chosen on the 版本 tab. */
function Installation({
  extension,
  switching,
  title,
  onVersions,
}: {
  readonly extension: LocalExtensionSummary
  readonly switching: ReturnType<typeof useVersionSwitch>
  readonly title: VersionText | undefined
  readonly onVersions: () => void
}) {
  const installed = extension.installation
  const newest = extension.revisions.findLast(usable)
  const onlyAgents =
    hasAgentLayer(extension) && !extension.provides.some((item) => item === 'page' || item === 'adapter')
  return (
    <PropertyGroup title="安装">
      {installed?.runtime && installed.runtime.status !== 'active' ? (
        <Banner tone="bad">
          {installed.runtime.status === 'restore-failed' ? '启动恢复失败' : '停止失败'}
          {installed.runtime.message ? `：${installed.runtime.message}` : ''}
        </Banner>
      ) : null}
      <PropertyList>
        <PropertyRow
          label={installed && title ? title.title : '还没有安装到本机'}
          description={
            installed
              ? installed.revisionId === newest?.id
                ? `${title?.source ?? ''} · 已是最新保存的版本`
                : `${title?.source ?? ''} · 有更新保存的版本`
              : onlyAgents
                ? '给智能体启用时会自动安装'
                : undefined
          }
        >
          {installed ? (
            <Button size="small" onClick={onVersions}>
              {installed.revisionId === newest?.id ? '查看版本' : '切换版本'}
            </Button>
          ) : newest ? (
            <Button
              size="small"
              variant={onlyAgents ? 'default' : 'primary'}
              busy={switching.busy}
              onClick={() => switching.request(newest)}
            >
              安装
            </Button>
          ) : null}
        </PropertyRow>
      </PropertyList>
    </PropertyGroup>
  )
}
