import { useGo } from '../model/nav.js'
import { Download, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { callHostApi } from '../../host-api-client.js'
import { useHostActions, useProductStore, type LocalExtensionSummary } from '../../product-runtime.js'
import {
  AgentAvatar,
  Banner,
  Button,
  Chip,
  ConfirmDialog,
  Disclosure,
  Panel,
  Section,
  Select,
  Switch,
  toast,
  Pressable,
} from '../../ui-kit/next/index.js'
import { relativeTime } from '../channels/timeline-model.js'
import { agentHue } from '../model/identity.js'
import {
  ExtensionConfigEditor,
  PanelSlot,
  activeConfigSchema,
  useExtensionActivation,
} from '../../extension-ui/index.js'
import { useProductApi } from '../model/store.js'
import { contributionParts, extensionUsage, scopeLabel } from './workshop-model.js'
import styles from './workshop.module.css'

type Revision = LocalExtensionSummary['revisions'][number]

const failure = (error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })

const SLOT_NAMES: Record<string, string> = {
  'agent.workbench.sections': '智能体面板',
  'extension.details.panels': '扩展详情面板',
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
  anchor.download = `${extension.slug}-r${revision.revision}.nxt-extension`
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function ExtensionView({ extension }: { readonly extension: LocalExtensionSummary }) {
  const navigate = useGo()
  const hostActions = useHostActions()
  const usage = extensionUsage(extension)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const latest = extension.revisions.at(-1)
  const unsupported = extension.revisions.filter(
    (item) => item.format !== undefined && item.format !== 'current',
  ).length

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <div className={styles.heroInner}>
          <div className={styles.heroMeta}>
            <Chip>{scopeLabel[extension.scope]}</Chip>
            <Chip tone={usage.tone} dot>
              {usage.label}
            </Chip>
            <span>
              {extension.createdByAgent ? `由${extension.createdByAgent}创造` : '本地导入'} ·{' '}
              {extension.revisions.length} 个版本
            </span>
          </div>
          <h1 className={styles.title}>{extension.name}</h1>
          {extension.description ? <p className={styles.lead}>{extension.description}</p> : null}
        </div>
      </header>

      <div className={styles.body}>
        {unsupported > 0 ? (
          <Banner tone="warn">
            {unsupported === extension.revisions.length
              ? '这个扩展的版本格式已不再受支持，无法启用；请让智能体重新创造。'
              : '部分旧版本格式不再受支持，无法启用。'}
          </Banner>
        ) : null}

        {extension.scope === 'agent' ? <AgentUsage extension={extension} /> : <Installation extension={extension} />}

        <ExtensionSettings extension={extension} />

        <Section title="版本">
          <Panel className={styles.versions}>
            {extension.revisions.toReversed().map((revision) => (
              <RevisionRow
                key={revision.id}
                extension={extension}
                revision={revision}
                latest={revision.id === latest?.id}
              />
            ))}
          </Panel>
        </Section>

        <Section title="删除" small>
          <div className={styles.danger}>
            <span>
              删除全部版本与源码
              {extension.scope === 'agent'
                ? `，并停止 ${extension.activations.length} 个智能体的使用`
                : extension.scope === 'host-adapter'
                  ? '；连接、频道和消息保留'
                  : '；页面入口随之移除'}
              。
            </span>
            <Button variant="danger" icon={<Trash2 size={14} />} onClick={() => setDeleteOpen(true)}>
              删除扩展
            </Button>
          </div>
        </Section>
      </div>

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
        {extension.revisions.length} 个版本、源码与验证记录会被永久删除。
      </ConfirmDialog>
    </div>
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
        <Section
          title="配置"
          actions={
            extension.scope === 'agent' && enabledAgents.length > 1 ? (
              <Select
                aria-label="配置哪个智能体"
                value={agentId}
                onChange={(event) => setChosen(event.target.value)}
                options={enabledAgents.map((agent) => ({ value: agent.id, label: agent.name }))}
              />
            ) : undefined
          }
        >
          <Panel className={styles.config}>
            <ExtensionConfigEditor
              key={agentId ?? 'host'}
              extension={extension}
              {...(agentId === undefined ? {} : { agentId })}
            />
          </Panel>
        </Section>
      ) : null}
      {extension.scope === 'agent' && agentId !== undefined ? (
        <PanelSlot anchor={{ kind: 'extension', id: extension.id }} density="full" agentId={agentId} />
      ) : null}
    </>
  )
}

/** Agent-scoped extensions: one row per agent with its revision and an on/off switch. */
function AgentUsage({ extension }: { readonly extension: LocalExtensionSummary }) {
  const agents = useProductStore((state) => state.agents)
  const [pending, setPending] = useState('')
  const activation = useExtensionActivation()
  const usable = extension.revisions.filter((item) => item.format === undefined || item.format === 'current')
  const latestUsable = usable.at(-1)

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

  return (
    <Section title="使用">
      {activation.dialog}
      {agents.length === 0 ? (
        <Panel className={styles.quiet}>还没有智能体。</Panel>
      ) : (
        <Panel className={styles.table}>
          {agents.map((agent) => {
            const activation = extension.activations.find((item) => item.agentId === agent.id)
            const broken = activation?.runtime && activation.runtime.status !== 'active'
            return (
              <div key={agent.id} className={styles.tableRow}>
                <Link to={`/agents/${agent.id}`} className={styles.cellAgent}>
                  <AgentAvatar name={agent.name} hue={agentHue(agent)} size="sm" />
                  <span>
                    <b>{agent.name}</b>
                    {broken ? (
                      <small className={styles.bad}>{activation.runtime?.message ?? '运行异常'}</small>
                    ) : activation ? (
                      <small>{relativeTime(activation.activatedAt)}启用</small>
                    ) : null}
                  </span>
                </Link>
                {activation ? (
                  <Select
                    aria-label={`${agent.name}使用的版本`}
                    value={activation.revisionId}
                    disabled={pending !== ''}
                    onChange={(event) => void change(agent.id, true, event.target.value)}
                    options={extension.revisions.toReversed().map((item) => ({
                      value: item.id,
                      label: `r${item.revision}${item.id === latestUsable?.id ? ' · 最新' : ''}`,
                      disabled: item.format !== undefined && item.format !== 'current',
                    }))}
                  />
                ) : (
                  <span className={styles.faint}>未启用</span>
                )}
                <Switch
                  label={`${agent.name}使用「${extension.name}」`}
                  checked={activation !== undefined}
                  disabled={pending !== '' || (!activation && !latestUsable)}
                  onCheckedChange={(enabled) => void change(agent.id, enabled, enabled ? latestUsable?.id : undefined)}
                />
              </div>
            )
          })}
        </Panel>
      )}
    </Section>
  )
}

/** Host-scoped extensions (adapters and pages) are installed once for this machine at a chosen revision. */
function Installation({ extension }: { readonly extension: LocalExtensionSummary }) {
  const api = useProductApi()
  const installed = extension.installation
  const usable = extension.revisions.filter((item) => item.format === undefined || item.format === 'current')
  const [choice, setChoice] = useState(installed?.revisionId ?? usable.at(-1)?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [approve, setApprove] = useState<Revision>()
  const [uninstallOpen, setUninstallOpen] = useState(false)
  const chosen = extension.revisions.find((item) => item.id === choice)
  const chosenInstalled = chosen !== undefined && chosen.id === installed?.revisionId

  const install = async (revision: Revision, digest?: string) => {
    setBusy(true)
    try {
      await api.getState().setHostExtensionInstalled(extension.id, revision.id, digest)
      toast(`已安装 r${revision.revision}`)
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
    <Section title="安装">
      {installed?.runtime && installed.runtime.status !== 'active' ? (
        <Banner tone="bad">
          {installed.runtime.status === 'restore-failed' ? '启动恢复失败' : '停止失败'}
          {installed.runtime.message ? `：${installed.runtime.message}` : ''}
        </Banner>
      ) : null}
      <Panel className={styles.install}>
        <Select
          aria-label="版本"
          value={choice}
          onChange={(event) => setChoice(event.target.value)}
          options={extension.revisions.toReversed().map((item) => ({
            value: item.id,
            label: `r${item.revision}${item.id === installed?.revisionId ? ' · 已安装' : ''}`,
            disabled: item.format !== undefined && item.format !== 'current',
          }))}
        />
        <Button
          variant="primary"
          busy={busy}
          disabled={!chosen || chosenInstalled}
          onClick={() => chosen && request(chosen)}
        >
          {installed ? '切换到此版本' : '安装'}
        </Button>
        {installed ? (
          <Button variant="danger" disabled={busy} onClick={() => setUninstallOpen(true)}>
            卸载
          </Button>
        ) : null}
      </Panel>
      <ConfirmDialog
        open={approve !== undefined}
        onOpenChange={(open) => !open && setApprove(undefined)}
        title={`批准 r${approve?.revision ?? ''} 的权限`}
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
          '这个版本没有申请额外权限。'
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
    </Section>
  )
}

function RevisionRow({
  extension,
  revision,
  latest,
}: {
  readonly extension: LocalExtensionSummary
  readonly revision: Revision
  readonly latest: boolean
}) {
  const [open, setOpen] = useState(latest)
  const [busy, setBusy] = useState(false)
  const verification = revision.verification
  const users = extension.activations.filter((item) => item.revisionId === revision.id)
  const installed = extension.installation?.revisionId === revision.id
  const id = `revision-${revision.id}`
  return (
    <div className={styles.version} data-open={open}>
      <Pressable
        type="button"
        className={styles.versionHead}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <b>r{revision.revision}</b>
        <span className={styles.versionTime}>{relativeTime(revision.createdAt)}</span>
        {latest ? <Chip tone="accent">最新</Chip> : null}
        {installed ? <Chip tone="ok">已安装</Chip> : null}
        {users.length > 0 ? <Chip tone="ok">{users.map((item) => item.agentName).join('、')}</Chip> : null}
        {revision.format !== undefined && revision.format !== 'current' ? <Chip tone="warn">格式不受支持</Chip> : null}
        <span className={styles.grow} />
        <span className={styles.versionCount}>{revision.contributions.length} 项能力</span>
      </Pressable>
      <Disclosure open={open} id={id}>
        <div className={styles.versionBody}>
          {revision.contributions.length > 0 ? (
            <ul className={styles.contributions}>
              {revision.contributions.map((item) => {
                const part = contributionParts(item)
                return (
                  <li key={item}>
                    <span>{part.kind}</span>
                    {SLOT_NAMES[part.name] ?? part.name}
                  </li>
                )
              })}
            </ul>
          ) : null}
          {verification ? (
            <dl className={styles.facts}>
              <dt>验证</dt>
              <dd>{relativeTime(verification.verifiedAt)}</dd>
              <dt>工具调用</dt>
              <dd>{verification.toolInvocationCount > 0 ? `${verification.toolInvocationCount} 次通过` : '无'}</dd>
              <dt>界面</dt>
              <dd>{verification.clientBuilt ? '已渲染' : '无'}</dd>
              <dt>DSH</dt>
              <dd>{verification.dshVersion}</dd>
            </dl>
          ) : (
            <p className={styles.faint}>本机没有这个版本的验证记录。</p>
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
              导出
            </Button>
          </div>
        </div>
      </Disclosure>
    </div>
  )
}
