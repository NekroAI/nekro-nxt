import { useGo } from '../model/nav.js'
import { CompatibilityNotices } from '../system/compatibility.js'
import { ChevronRight, Download, MoreHorizontal, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { HostApiContracts } from '@nekro-nxt/contracts'
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
  useExtensionActivation,
} from '../../extension-ui/index.js'
import { useProductApi } from '../model/store.js'
import { CONTRIBUTION_PLACE, contributionParts, extensionUsage, recordLabels, scopeLabel } from './workshop-model.js'
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
  const labels = useMemo(() => recordLabels(extension.revisions), [extension.revisions])
  const latest = extension.revisions.at(-1)
  const current = extension.revisions.findLast(usable) ?? latest
  const unsupported = extension.revisions.filter((item) => !usable(item)).length

  return (
    <MainContent>
      <ObjectHeader
        visual={
          <span className={styles.objectGlyph} data-scope={extension.scope}>
            {[...extension.name][0] ?? '扩'}
          </span>
        }
        title={extension.name}
        status={
          <Chip tone={usage.tone} dot>
            {usage.label}
          </Chip>
        }
        meta={
          <>
            <span>{scopeLabel[extension.scope]}</span>
            <span>{extension.createdByAgent ? `由${extension.createdByAgent}创造` : '本地导入'}</span>
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
      {extension.description ? <p className={styles.lead}>{extension.description}</p> : null}
      <CompatibilityNotices extensionId={extension.id} />
      {unsupported > 0 ? (
        <Banner tone="warn">
          {unsupported === extension.revisions.length
            ? '这个扩展的保存格式已不再受支持，无法启用；请让智能体重新创造。'
            : '部分较早的保存记录格式不再受支持，无法启用。'}
        </Banner>
      ) : null}

      <Overview revision={current} />

      {extension.scope === 'agent' ? (
        <AgentUsage extension={extension} labels={labels} />
      ) : (
        <Installation extension={extension} labels={labels} />
      )}

      <ExtensionSettings extension={extension} />

      <PropertyGroup title="保存记录" description="每次保存都会留下一份记录，可以切换使用或导出。">
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
        {extension.scope === 'agent'
          ? `，${extension.activations.length} 个智能体会停止使用。`
          : extension.scope === 'host-adapter'
            ? '；连接、频道和消息保留。'
            : '；页面入口随之移除。'}
      </ConfirmDialog>
    </MainContent>
  )
}

/** What the extension gives the user and where it shows up. */
function Overview({ revision }: { readonly revision: Revision | undefined }) {
  const parts = (revision?.contributions ?? []).map(contributionParts)
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
              description={CONTRIBUTION_PLACE[part.kind] ?? CONTRIBUTION_PLACE['内容']}
            >
              <code className={styles.contributionName}>{part.name}</code>
            </PropertyRow>
          ))}
        </PropertyList>
      )}
    </PropertyGroup>
  )
}

/**
 * Configuration and the extension's own panels. Agent extensions are configured per enabled agent; Host extensions
 * once for their installation.
 */
function ExtensionSettings({ extension }: { readonly extension: LocalExtensionSummary }) {
  const enabledAgents = extension.activations.map((activation) => ({
    id: activation.agentId,
    name: activation.agentName,
  }))
  const [chosen, setChosen] = useState(enabledAgents[0]?.id ?? '')
  const agentId =
    extension.scope === 'agent'
      ? (enabledAgents.find((agent) => agent.id === chosen)?.id ?? enabledAgents[0]?.id)
      : undefined
  if (extension.scope === 'agent' && agentId === undefined) return null
  const hasConfig = activeConfigSchema(extension, agentId) !== undefined
  return (
    <>
      {hasConfig ? (
        <PropertyGroup
          title="配置"
          actions={
            extension.scope === 'agent' && enabledAgents.length > 1 ? (
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
            <ExtensionConfigEditor
              key={agentId ?? 'host'}
              extension={extension}
              {...(agentId === undefined ? {} : { agentId })}
            />
          </div>
        </PropertyGroup>
      ) : null}
      {extension.scope === 'agent' && agentId !== undefined ? (
        <PanelSlot anchor={{ kind: 'extension', id: extension.id }} density="full" agentId={agentId} />
      ) : null}
    </>
  )
}

/** Agent-scoped extensions: one row per agent with the saved record it uses and an on/off switch. */
function AgentUsage({
  extension,
  labels,
}: {
  readonly extension: LocalExtensionSummary
  readonly labels: ReadonlyMap<string, string>
}) {
  const agents = useProductStore((state) => state.agents)
  const [pending, setPending] = useState('')
  const activation = useExtensionActivation()
  const latestUsable = extension.revisions.findLast(usable)
  const recordOptions = extension.revisions.toReversed().map((item) => ({
    value: item.id,
    label: `${labels.get(item.id) ?? ''}${item.id === latestUsable?.id ? ' · 最新' : ''}`,
    disabled: !usable(item),
  }))

  const enabledFor = (agent: AgentSummary): boolean => extension.activations.some((item) => item.agentId === agent.id)

  const change = async (agentId: string, enabled: boolean, revisionId?: string) => {
    setPending(agentId)
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
      setPending('')
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
        return (
          <Link to={`/agents/${agent.id}`} className={styles.cellAgent}>
            <AgentAvatar name={agent.name} hue={agentHue(agent)} size="sm" />
            <span className={styles.cellAgentText}>
              <b>{agent.name}</b>
              {broken ? (
                <small className={styles.bad}>{record.runtime?.message ?? '运行异常'}</small>
              ) : record ? (
                <small>{relativeTime(record.activatedAt)}启用</small>
              ) : null}
            </span>
          </Link>
        )
      },
    },
    {
      key: 'record',
      header: '使用的保存记录',
      width: 'minmax(180px, 1.4fr)',
      priority: 2,
      render: (agent) => {
        const record = extension.activations.find((item) => item.agentId === agent.id)
        return record ? (
          <Select
            aria-label={`${agent.name}使用的保存记录`}
            value={record.revisionId}
            disabled={pending !== ''}
            onValueChange={(value) => void change(agent.id, true, value)}
            options={recordOptions}
          />
        ) : (
          <span className={styles.faint}>未启用</span>
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
            disabled={pending !== '' || (!enabled && !latestUsable)}
            onCheckedChange={(next) => void change(agent.id, next, next ? latestUsable?.id : undefined)}
          />
        )
      },
    },
  ]

  return (
    <PropertyGroup title="使用">
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

/** Host-scoped extensions (adapters and pages) are installed once for this machine from a chosen saved record. */
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
  const [approve, setApprove] = useState<Revision>()
  const [uninstallOpen, setUninstallOpen] = useState(false)
  const chosen = extension.revisions.find((item) => item.id === choice)
  const chosenInstalled = chosen !== undefined && chosen.id === installed?.revisionId

  const install = async (revision: Revision, digest?: string) => {
    setBusy(true)
    try {
      await api.getState().setHostExtensionInstalled(extension.id, revision.id, digest)
      toast(`已安装${labels.get(revision.id) ?? ''}保存的记录`)
    } finally {
      setBusy(false)
    }
  }
  const request = (revision: Revision) => {
    if (revision.verification?.permissionApprovalRequired && revision.verification.permissionDigest) {
      setApprove(revision)
      return
    }
    void install(revision).catch(failure)
  }
  const permissions = approve?.verification?.permissions

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
          description={installed ? `${relativeTime(installed.installedAt)}安装` : '还没有安装到本机'}
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
        onConfirm={() => (approve ? install(approve, approve.verification?.permissionDigest) : undefined)}
      >
        {permissions && (permissions.permissions.length > 0 || permissions.networkOrigins.length > 0) ? (
          <ul className={styles.permissions}>
            {permissions.permissions.map((item) => (
              <li key={item}>{item}</li>
            ))}
            {permissions.networkOrigins.map((origin) => (
              <li key={origin}>访问 {origin}</li>
            ))}
          </ul>
        ) : (
          '这份记录没有申请额外权限。'
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
        {extension.scope === 'host-adapter'
          ? '连接、频道和历史保留；重新安装前这些连接无法收发消息。'
          : '页面入口会被移除。'}
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
