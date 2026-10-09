import { useGo } from '../model/nav.js'
import { CompatibilityNotices } from '../system/compatibility.js'
import { ChevronRight, Download, MoreHorizontal, Share2, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { communityPublisherLabel, HostApiContracts } from '@nekro-nxt/contracts'
import { callHostApi } from '../../host-api-client.js'
import {
  useHostActions,
  useProductStore,
  type AgentSummary,
  type LocalExtensionSummary,
} from '../../product-runtime.js'
import {
  AgentAvatar,
  Banner,
  Button,
  Chip,
  ConfirmDialog,
  DataTable,
  Diagnostics,
  Disclosure,
  ExtensionIcon,
  MainContent,
  Menu,
  ObjectHeader,
  PropertyGroup,
  PropertyList,
  PropertyRow,
  Pressable,
  Select,
  Switch,
  toast,
  type Column,
} from '../../ui-kit/index.js'
import { relativeTime } from '../channels/timeline-model.js'
import { agentHue } from '../model/identity.js'
import {
  ExtensionConfigEditor,
  PanelSlot,
  activeConfigSchema,
  permissionLines,
  useExtensionActivation,
} from '../../extension-ui/index.js'
import { useProductApi } from '../model/store.js'
import {
  CONTRIBUTION_PLACE,
  contributionParts,
  extensionUsage,
  hasAgentLayer,
  mcpParts,
  mcpStatusText,
  providesLabel,
  recordLabels,
} from './workshop-model.js'
import { PublishDialog } from './publish-dialog.js'
import styles from './workshop.module.css'

type Revision = LocalExtensionSummary['revisions'][number]

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
  anchor.download = `${extension.slug}-${fileStamp(revision.createdAt)}.nxt-extension`
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function ExtensionView({ extension }: { readonly extension: LocalExtensionSummary }) {
  const navigate = useGo()
  const hostActions = useHostActions()
  const usage = extensionUsage(extension)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [publishOpen, setPublishOpen] = useState(false)
  const labels = useMemo(() => recordLabels(extension.revisions), [extension.revisions])
  const latest = extension.revisions.at(-1)
  const current = extension.revisions.findLast(usable) ?? latest
  const unsupported = extension.revisions.filter((item) => !usable(item)).length

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
            {current?.source ? (
              <Link to={`/community/extensions/${extension.id}`} className={styles.metaLink}>
                来自社区 {communityPublisherLabel(current.source.publisherHandle)}
              </Link>
            ) : (
              <span>{extension.createdByAgent ? `由${extension.createdByAgent}创造` : '本地导入'}</span>
            )}
            {latest ? <span>{relativeTime(latest.createdAt)}保存</span> : null}
          </>
        }
        actions={
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
                      label: '导出最新保存',
                      icon: <Download size={14} />,
                      onSelect: () => void download(extension, current).catch(failure),
                    },
                    ...(usable(current)
                      ? [
                          {
                            key: 'publish',
                            label: '发布到社区',
                            icon: <Share2 size={14} />,
                            onSelect: () => setPublishOpen(true),
                          },
                        ]
                      : []),
                  ]
                : []),
              {
                key: 'delete',
                label: '删除扩展',
                icon: <Trash2 size={14} />,
                danger: true,
                onSelect: () => setDeleteOpen(true),
              },
            ]}
          />
        }
      />
      <PublishDialog extension={extension} revision={current} open={publishOpen} onOpenChange={setPublishOpen} />
      {extension.description ? <p className={styles.lead}>{extension.description}</p> : null}
      <CompatibilityNotices extensionId={extension.id} />
      {unsupported > 0 ? (
        <Banner tone="warn">
          {unsupported === extension.revisions.length
            ? '这个扩展的保存格式已不再受支持，无法启用；请让智能体重新创造。'
            : '部分较早的保存记录格式不再受支持，无法启用。'}
        </Banner>
      ) : null}

      <Overview revision={current} pages={extension.revisions.flatMap((revision) => revision.pages)} />

      <Installation extension={extension} labels={labels} />
      {hasAgentLayer(extension) ? <AgentUsage extension={extension} /> : null}

      <ExtensionSettings extension={extension} />

      <PropertyGroup title="保存记录" tip="每次保存都会留下一份记录，可以切换使用或导出。">
        <div className={styles.records}>
          {extension.revisions.toReversed().map((revision) => (
            <RecordRow
              key={revision.id}
              extension={extension}
              revision={revision}
              label={labels.get(revision.id) ?? ''}
              latest={revision.id === latest?.id}
            />
          ))}
        </div>
      </PropertyGroup>

      <Diagnostics
        items={[
          { label: '扩展 ID', value: extension.id },
          { label: '本地标识', value: extension.slug },
          ...extension.revisions.toReversed().map((revision) => ({
            label: `${labels.get(revision.id) ?? ''} 保存`,
            value: `${revision.id}（第 ${revision.revision} 份）`,
          })),
        ]}
      />

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
        {extension.revisions.length} 份保存记录、源码与验证记录会被永久删除
        {removalConsequences(extension)}
      </ConfirmDialog>
    </MainContent>
  )
}

/** What the extension gives the user and where it shows up. */
function Overview({ revision, pages }: { readonly revision: Revision | undefined; readonly pages: Revision['pages'] }) {
  const navigate = useGo()
  const parts = [
    ...(revision?.contributions ?? []).map((value) => ({ ...contributionParts(value), detail: undefined })),
    ...mcpParts(revision?.verification?.permissions?.agent?.mcp?.servers ?? []),
  ]
  return (
    <PropertyGroup title="能提供什么">
      {parts.length === 0 ? (
        <p className={styles.faint}>这份保存记录还没有经过验证，暂时无法说明它提供的内容。</p>
      ) : (
        <PropertyList>
          {parts.map((part) => (
            <PropertyRow
              key={`${part.kind}:${part.name}`}
              label={part.kind}
              description={part.detail ?? CONTRIBUTION_PLACE[part.kind] ?? CONTRIBUTION_PLACE['内容']}
            >
              <code className={styles.contributionName}>{part.name}</code>
              {part.kind === '页面' ? (
                <OpenPage page={pages.find((page) => page.title === part.name)} navigate={navigate} />
              ) : null}
            </PropertyRow>
          ))}
        </PropertyList>
      )}
    </PropertyGroup>
  )
}

/** Opens an installed page; a page that is not installed has nothing to open. */
function OpenPage({
  page,
  navigate,
}: {
  readonly page: Revision['pages'][number] | undefined
  readonly navigate: (path: string) => void
}) {
  if (!page) return null
  return (
    <Button
      size="small"
      aria-label={`打开「${page.title}」`}
      onClick={() => navigate(`${page.routeBase}${page.startPath ? `/${page.startPath}` : ''}`)}
    >
      打开
    </Button>
  )
}

/** What removing or uninstalling the extension stops, ending with a full stop. */
const removalConsequences = (extension: LocalExtensionSummary): string => {
  const parts = [
    ...(extension.activations.length > 0 ? [`${extension.activations.length} 个智能体会停止使用`] : []),
    ...(extension.provides.includes('page') ? ['页面入口随之移除'] : []),
    ...(extension.provides.includes('adapter') ? ['连接、频道和消息保留，重新安装前这些连接无法收发消息'] : []),
  ]
  return parts.length === 0 ? '。' : `；${parts.join('；')}。`
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
      {extension.installation ? (
        <PanelSlot
          anchor={{ kind: 'extension', id: extension.id }}
          density="full"
          {...(agentId === undefined ? {} : { agentId })}
        />
      ) : null}
    </>
  )
}

/** One row per agent with an on/off switch; every agent uses the record installed on this machine. */
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
    <PropertyGroup
      title="智能体"
      tip="启用后，这个智能体在对话中获得扩展的能力；所有智能体使用本机安装的同一份保存记录。"
    >
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

/**
 * The extension's single installation on this machine. Switching records moves every agent using it; approvals cover
 * the machine and, when the new record asks agents for more, those agents too.
 */
function Installation({
  extension,
  labels,
}: {
  readonly extension: LocalExtensionSummary
  readonly labels: ReadonlyMap<string, string>
}) {
  const api = useProductApi()
  const installed = extension.installation
  const [choice, setChoice] = useState(installed?.revisionId ?? extension.revisions.findLast(usable)?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [approve, setApprove] = useState<{
    readonly revision: Revision
    readonly host?: NonNullable<NonNullable<Revision['verification']>['hostPermission']>
    readonly agent?: NonNullable<NonNullable<Revision['verification']>['agentPermission']>
  }>()
  const [uninstallOpen, setUninstallOpen] = useState(false)
  const chosen = extension.revisions.find((item) => item.id === choice)
  const chosenInstalled = chosen !== undefined && chosen.id === installed?.revisionId

  const install = async (revision: Revision, approvals?: { readonly host?: string; readonly agent?: string }) => {
    setBusy(true)
    try {
      await api.getState().setHostExtensionInstalled(extension.id, revision.id, approvals)
      toast(`已安装${labels.get(revision.id) ?? ''}保存的记录`)
    } finally {
      setBusy(false)
    }
  }
  const request = (revision: Revision) => {
    const host = revision.verification?.hostPermission
    const agent = revision.verification?.agentPermission
    const needsHost = host?.approvalRequired === true
    // Agents move with the installation; a record that asks them for more needs their approval as well.
    const needsAgent = extension.activations.length > 0 && agent?.approvalRequired === true
    if (needsHost || needsAgent) {
      setApprove({
        revision,
        ...(needsHost && host !== undefined ? { host } : {}),
        ...(needsAgent && agent !== undefined ? { agent } : {}),
      })
      return
    }
    void install(revision).catch(failure)
  }
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
          label="使用的保存记录"
          description={
            installed
              ? `${relativeTime(installed.installedAt)}安装`
              : onlyAgents
                ? '给智能体启用时会自动安装'
                : '还没有安装到本机'
          }
        >
          <Select
            aria-label="保存记录"
            value={choice}
            onValueChange={(value) => setChoice(value)}
            options={extension.revisions.toReversed().map((item) => ({
              value: item.id,
              label: `${labels.get(item.id) ?? ''}${item.id === installed?.revisionId ? ' · 已安装' : ''}`,
              disabled: !usable(item),
            }))}
          />
          <Button
            variant="primary"
            busy={busy}
            disabled={!chosen || chosenInstalled}
            onClick={() => chosen && request(chosen)}
          >
            {installed ? '切换到这份' : '安装'}
          </Button>
          {installed ? (
            <Button variant="danger" disabled={busy} onClick={() => setUninstallOpen(true)}>
              卸载
            </Button>
          ) : null}
        </PropertyRow>
      </PropertyList>
      <ConfirmDialog
        open={approve !== undefined}
        onOpenChange={(open) => !open && setApprove(undefined)}
        title="批准这份记录申请的权限"
        confirmLabel="批准并安装"
        onConfirm={() =>
          approve
            ? install(approve.revision, {
                ...(approve.host === undefined ? {} : { host: approve.host.permissionDigest }),
                ...(approve.agent === undefined ? {} : { agent: approve.agent.permissionDigest }),
              })
            : undefined
        }
      >
        {approve?.host === undefined ? null : (
          <>
            <p className={styles.faint}>对整台机器生效：</p>
            <ul className={styles.permissions}>
              {permissionLines(approve.host.declaration).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </>
        )}
        {approve?.agent === undefined ? null : (
          <>
            <p className={styles.faint}>对正在使用它的 {extension.activations.length} 个智能体生效：</p>
            <ul className={styles.permissions}>
              {permissionLines(approve.agent.declaration).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </>
        )}
      </ConfirmDialog>
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
        {`扩展会停止运行${removalConsequences(extension)}`}
      </ConfirmDialog>
    </PropertyGroup>
  )
}

function RecordRow({
  extension,
  revision,
  label,
  latest,
}: {
  readonly extension: LocalExtensionSummary
  readonly revision: Revision
  readonly label: string
  readonly latest: boolean
}) {
  const [open, setOpen] = useState(latest)
  const [busy, setBusy] = useState(false)
  const verification = revision.verification
  const users = extension.activations.filter((item) => item.revisionId === revision.id)
  const installed = extension.installation?.revisionId === revision.id
  const id = `record-${revision.id}`
  return (
    <div className={styles.record} data-open={open}>
      <Pressable className={styles.recordHead} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <ChevronRight size={14} className={styles.chevron} data-open={open} />
        <b>{label}</b>
        {latest ? <Chip tone="accent">最新</Chip> : null}
        {installed ? <Chip tone="ok">已安装</Chip> : null}
        {users.length > 0 ? <Chip tone="ok">{users.map((item) => item.agentName).join('、')} 在用</Chip> : null}
        {!usable(revision) ? <Chip tone="warn">格式不受支持</Chip> : null}
        <span className={styles.grow} />
        <span className={styles.recordCount}>{revision.contributions.length} 项内容</span>
      </Pressable>
      <Disclosure open={open} id={id}>
        <div className={styles.recordBody}>
          {revision.contributions.length > 0 ? (
            <ul className={styles.contributions}>
              {revision.contributions.map((item) => {
                const part = contributionParts(item)
                return (
                  <li key={item}>
                    <span>{part.kind}</span>
                    {part.name}
                  </li>
                )
              })}
            </ul>
          ) : null}
          {verification ? (
            <dl className={styles.facts}>
              <dt>验证</dt>
              <dd>{relativeTime(verification.verifiedAt)}通过</dd>
              <dt>工具调用</dt>
              <dd>{verification.toolInvocationCount > 0 ? `${verification.toolInvocationCount} 次通过` : '无'}</dd>
              <dt>界面</dt>
              <dd>{verification.clientBuilt ? '已渲染' : '无'}</dd>
            </dl>
          ) : (
            <p className={styles.faint}>本机没有这份记录的验证结果。</p>
          )}
          <div>
            <Button
              size="small"
              icon={<Download size={14} />}
              busy={busy}
              onClick={() => {
                setBusy(true)
                void download(extension, revision)
                  .catch(failure)
                  .finally(() => setBusy(false))
              }}
            >
              导出这份
            </Button>
          </div>
        </div>
      </Disclosure>
    </div>
  )
}
