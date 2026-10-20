import {
  HostApiContracts,
  type CredentialRequestView,
  type CredentialsView,
  type CredentialUse,
  type CredentialView,
} from '@nekro-nxt/contracts'
import { ChevronRight, KeyRound, Plus } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  AddCredentialDialog,
  AgentScopeField,
  ReplaceCredentialValueDialog,
  USAGE_OPTIONS,
} from '../../credentials/credential-form.js'
import {
  credentialDraftIssues,
  credentialUsageText,
  draftOfCredential,
  errorText,
  parseDomains,
  scopeOfDraft,
  useCredentials,
  type CredentialDraft,
} from '../../credentials/credentials-data.js'
import { callHostApi } from '../../host-api-client.js'
import { useProductStore } from '../../product-runtime.js'
import {
  Button,
  Chip,
  ConfirmDialog,
  DangerZone,
  DataTable,
  Diagnostics,
  EmptyState,
  Input,
  MasterDetail,
  ObjectHeader,
  PropertyGroup,
  PropertyList,
  PropertyRow,
  SaveBar,
  Segmented,
  Skeleton,
  Switch,
  Textarea,
  toast,
  type Column,
} from '../../ui-kit/index.js'
import { CodeRunNodeDownload, CodeRunNodeRemove } from '../agents/runtime-download.js'
import { relativeTime } from '../channels/timeline-model.js'
import { SectionHead } from './section-head.js'
import own from './credentials-section.module.css'
import styles from './settings.module.css'

const failure = (cause: unknown) => toast(errorText(cause), { tone: 'bad' })

/** Pre-fill of the add form from the address an agent's request links to. */
const prefillFromParams = (params: URLSearchParams) => {
  if (params.get('add') !== '1') return undefined
  const usage = params.get('usage') === 'program' ? 'program' : 'request'
  return {
    initial: {
      name: params.get('name') ?? '',
      description: params.get('purpose') ?? '',
      usage,
      domains: (params.get('domains') ?? '')
        .split(',')
        .filter((domain) => domain !== '')
        .join(', '),
    } satisfies Partial<CredentialDraft>,
    requestId: params.get('request') ?? undefined,
  }
}

/** Swallows clicks and keys so a control inside a selectable table row does not also open the row. */
function RowControl({ children }: { readonly children: ReactNode }) {
  return (
    <div
      role="presentation"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  )
}

/**
 * 设置 → 凭据: named credentials shared by extensions, MCP servers and commands, the model providers opened to agents
 * and extensions, and credentials agents asked for. An open credential is addressed by `?credential=`.
 */
export function CredentialsSection({ lead }: { readonly lead: ReactNode }) {
  const [params, setParams] = useSearchParams()
  const { view, error, load, replace } = useCredentials()
  const agents = useProductStore((state) => state.agents)
  const cli = useProductStore((state) => state.capabilityAvailability.githubCli)
  const [adding, setAdding] = useState<'generic' | 'github'>()
  const prefill = prefillFromParams(params)
  const selectedId = params.get('credential') ?? ''
  const selected = view?.credentials.find((credential) => credential.id === selectedId)
  const select = (id: string) => setParams(id ? { credential: id } : {})
  const agentName = (id: string) => agents.find((agent) => agent.id === id)?.name ?? '已删除的智能体'

  const setAutoUse = async (credential: CredentialView, autoUse: boolean) => {
    try {
      replace(await callHostApi(HostApiContracts.updateCredential, { credentialId: credential.id }, { autoUse }))
    } catch (cause) {
      failure(cause)
    }
  }
  const setProviderOpen = async (provider: string, open: boolean) => {
    try {
      replace(await callHostApi(HostApiContracts.setModelProviderAccess, { provider }, { open }))
    } catch (cause) {
      failure(cause)
    }
  }
  const dismiss = async (request: CredentialRequestView) => {
    try {
      replace(await callHostApi(HostApiContracts.dismissCredentialRequest, { requestId: request.id }, undefined))
    } catch (cause) {
      failure(cause)
    }
  }

  const columns: readonly Column<CredentialView>[] = [
    {
      key: 'name',
      header: '名称',
      width: 'minmax(140px, 1.4fr)',
      render: (credential) => (
        <span className={styles.adapterName}>
          <span className={styles.deviceName}>
            <b>{credential.name}</b>
            {credential.available ? null : <Chip tone="bad">无法读取</Chip>}
          </span>
          {credential.kind === 'github' && !credential.name.includes(credential.metadata.login ?? '\u0000') ? (
            <span className={styles.muted}>GitHub · {credential.metadata.login ?? '未知账号'}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'description',
      header: '说明',
      width: 'minmax(120px, 1.4fr)',
      priority: 3,
      render: (credential) => <span className={own.clip}>{credential.description || '—'}</span>,
    },
    {
      key: 'usage',
      header: '用途',
      width: 'minmax(120px, 1.2fr)',
      priority: 2,
      render: (credential) => <span className={own.clip}>{credentialUsageText(credential)}</span>,
    },
    {
      key: 'autoUse',
      header: '自动使用',
      width: '88px',
      render: (credential) => (
        <RowControl>
          <Switch
            label={`${credential.name} 自动使用`}
            checked={credential.autoUse}
            onCheckedChange={(checked) => setAutoUse(credential, checked)}
          />
        </RowControl>
      ),
    },
    {
      key: 'lastUsed',
      header: '最近使用',
      width: 'minmax(80px, 0.7fr)',
      priority: 2,
      render: (credential) => (
        <span className={styles.muted}>
          {credential.lastUsedAt === null ? '未使用' : relativeTime(credential.lastUsedAt)}
        </span>
      ),
    },
    {
      key: 'open',
      header: <span className={styles.srOnly}>打开</span>,
      width: '32px',
      align: 'end',
      render: () => <ChevronRight size={16} className={styles.rowChevron} aria-hidden="true" />,
    },
  ]

  const list = (
    <>
      {lead}
      <SectionHead
        title="凭据"
        actions={
          <>
            <Button size="small" onClick={() => setAdding('github')}>
              添加 GitHub 账号
            </Button>
            <Button size="small" icon={<Plus size={14} aria-hidden="true" />} onClick={() => setAdding('generic')}>
              添加凭据
            </Button>
          </>
        }
      />
      {view !== undefined && view.requests.length > 0 ? (
        <PropertyGroup title="凭据申请">
          <PropertyList>
            {view.requests.map((request) => (
              <PropertyRow
                key={request.id}
                label={request.name}
                description={`${agentName(request.agentId)}申请${request.purpose ? `：${request.purpose}` : ''}`}
              >
                <span className={styles.rowControls}>
                  <Button size="small" variant="ghost" onClick={() => void dismiss(request)}>
                    忽略
                  </Button>
                  <Button
                    size="small"
                    onClick={() => setParams(new URL(request.route, window.location.origin).searchParams)}
                  >
                    添加
                  </Button>
                </span>
              </PropertyRow>
            ))}
          </PropertyList>
        </PropertyGroup>
      ) : null}
      {view === undefined ? (
        error ? (
          <EmptyState title="读取凭据失败" action={<Button onClick={() => void load()}>重试</Button>}>
            {error}
          </EmptyState>
        ) : (
          <div className={styles.loading} role="status" aria-label="正在读取凭据">
            <Skeleton height={44} />
            <Skeleton height={44} />
          </div>
        )
      ) : view.credentials.length === 0 ? (
        <EmptyState
          icon={<KeyRound size={22} />}
          title="还没有凭据"
          action={
            <Button variant="primary" onClick={() => setAdding('generic')}>
              添加凭据
            </Button>
          }
        >
          API 密钥和 token 添加一次，扩展、MCP 服务和命令都能使用。
        </EmptyState>
      ) : (
        <DataTable
          label="凭据"
          columns={columns}
          rows={view.credentials}
          rowKey={(credential) => credential.id}
          selectedKey={selected?.id}
          onSelect={(credential) => select(credential.id)}
        />
      )}
      {view !== undefined && view.modelProviders.length > 0 ? (
        <PropertyGroup title="模型供应商" description="打开的供应商可以被智能体和扩展调用。">
          <PropertyList>
            {view.modelProviders.map((provider) => (
              <PropertyRow key={provider.provider} label={provider.name}>
                <Switch
                  label={`${provider.name} 开放给智能体和扩展`}
                  checked={provider.open}
                  onCheckedChange={(open) => setProviderOpen(provider.provider, open)}
                />
              </PropertyRow>
            ))}
          </PropertyList>
        </PropertyGroup>
      ) : null}
      {cli === undefined ? null : (
        <PropertyGroup title="GitHub CLI">
          <PropertyList>
            <PropertyRow
              label="gh"
              description={
                cli.available
                  ? `${cli.version ?? ''}，${cli.source === 'downloaded' ? '由 NekroNXT 下载' : '来自这台设备'}`
                  : cli.download === undefined
                    ? '这台设备没有 gh'
                    : '这台设备没有 gh，下载后智能体的命令里可以直接使用'
              }
            >
              {cli.available ? (
                <CodeRunNodeRemove availability={cli} kind="github-cli" />
              ) : (
                <CodeRunNodeDownload availability={cli} kind="github-cli" />
              )}
            </PropertyRow>
          </PropertyList>
        </PropertyGroup>
      )}
      <AddCredentialDialog
        open={adding !== undefined || prefill !== undefined}
        kind={adding ?? 'generic'}
        view={view}
        initial={adding === undefined ? prefill?.initial : undefined}
        requestId={adding === undefined ? prefill?.requestId : undefined}
        onOpenChange={(open) => {
          if (open) return
          setAdding(undefined)
          if (prefill !== undefined) setParams(selectedId ? { credential: selectedId } : {})
        }}
        onCreated={({ view: next, credentialId }) => {
          replace(next)
          setAdding(undefined)
          select(credentialId)
        }}
      />
    </>
  )

  return (
    <MasterDetail
      label="凭据"
      lead={lead}
      list={list}
      selectedKey={selected?.id}
      back={{ label: '全部凭据', onBack: () => select('') }}
      detail={
        selected !== undefined ? (
          <CredentialDetail
            key={selected.id}
            credential={selected}
            onView={replace}
            onRemoved={(next) => {
              replace(next)
              select('')
            }}
          />
        ) : undefined
      }
    />
  )
}

const CONSUMER_LABEL: Record<CredentialUse['consumerKind'], string> = {
  extension: '扩展',
  command: '命令',
  mcp: 'MCP 服务',
  model: '模型',
}

const formatTime = (time: number) => {
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const draftChanges = (base: CredentialDraft, draft: CredentialDraft, kind: CredentialView['kind']) => [
  ...(draft.name.trim() !== base.name ? ['名称'] : []),
  ...(draft.description.trim() !== base.description ? ['说明'] : []),
  ...(kind === 'generic' && draft.usage !== base.usage ? ['使用方式'] : []),
  ...(kind === 'generic' && parseDomains(draft.domains).join(',') !== parseDomains(base.domains).join(',')
    ? ['允许的域名']
    : []),
  ...(kind === 'generic' && draft.envName.trim() !== base.envName ? ['环境变量名'] : []),
  ...(draft.autoUse !== base.autoUse ? ['自动使用'] : []),
  ...(JSON.stringify(scopeOfDraft(draft)) !== JSON.stringify(scopeOfDraft(base)) ? ['可用智能体'] : []),
]

/** One credential: its settings, value, approvals, users, recent uses and removal. */
function CredentialDetail({
  credential,
  onView,
  onRemoved,
}: {
  readonly credential: CredentialView
  readonly onView: (view: CredentialsView) => void
  readonly onRemoved: (view: CredentialsView) => void
}) {
  const agents = useProductStore((state) => state.agents)
  const channels = useProductStore((state) => state.channels)
  const base = draftOfCredential(credential)
  const baseKey = JSON.stringify(base)
  const [draft, setDraft] = useState(base)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [users, setUsers] = useState(credential.usedBy)
  const [uses, setUses] = useState<readonly CredentialUse[]>()
  useEffect(() => {
    setDraft(base)
    setSaveError('')
  }, [baseKey])
  useEffect(() => {
    let current = true
    callHostApi(HostApiContracts.getCredentialUses, { credentialId: credential.id }, undefined)
      .then((result) => current && setUses(result.uses))
      .catch(() => current && setUses([]))
    return () => {
      current = false
    }
  }, [credential.id, credential.lastUsedAt])

  const agentName = (id: string | null) =>
    id === null ? '—' : (agents.find((agent) => agent.id === id)?.name ?? '已删除的智能体')
  const channelName = (id: string | null) => {
    if (id === null) return '—'
    const channel = channels.find((candidate) => candidate.id === id)
    return channel === undefined ? '—' : (channel.customName ?? channel.name)
  }
  const generic = credential.kind === 'generic'
  const issues = credentialDraftIssues(draft, credential.kind)
  const changes = draftChanges(base, draft, credential.kind)

  const save = async () => {
    if (Object.keys(issues).length > 0) {
      setSaveError(Object.values(issues)[0] ?? '')
      return
    }
    setBusy(true)
    setSaveError('')
    try {
      const envName = draft.envName.trim()
      onView(
        await callHostApi(
          HostApiContracts.updateCredential,
          { credentialId: credential.id },
          {
            name: draft.name.trim(),
            description: draft.description.trim(),
            autoUse: draft.autoUse,
            agentScope: scopeOfDraft(draft),
            ...(generic
              ? {
                  usage: draft.usage,
                  domains: [...parseDomains(draft.domains)],
                  ...(draft.usage === 'program'
                    ? { envName: envName === '' ? null : envName }
                    : base.envName === ''
                      ? {}
                      : { envName: null }),
                }
              : {}),
          },
        ),
      )
      toast('凭据已保存')
    } catch (cause) {
      setSaveError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (agentId: string) => {
    try {
      onView(
        await callHostApi(
          HostApiContracts.updateCredential,
          { credentialId: credential.id },
          { approvedAgentIds: credential.approvedAgentIds.filter((id) => id !== agentId) },
        ),
      )
    } catch (cause) {
      failure(cause)
    }
  }

  const remove = async () => {
    const inUse = users.extensions.length > 0 || users.commandAgents.length > 0
    const result = await callHostApi(
      HostApiContracts.removeCredential,
      { credentialId: credential.id },
      { confirm: inUse },
    )
    if (!result.removed) {
      setUsers(result.usedBy)
      throw new Error('它正在被使用，再次确认后删除。')
    }
    toast('凭据已删除')
    onRemoved(result.view)
  }

  const usedByRows = [
    ...credential.usedBy.extensions.map((extension) => ({
      key: extension.extensionId,
      label: extension.name,
      description: [...(extension.host ? ['本机配置'] : []), ...extension.agentIds.map((id) => agentName(id))].join(
        '、',
      ),
    })),
    ...(credential.usedBy.commandAgents.length > 0
      ? [{ key: 'commands', label: '命令', description: credential.usedBy.commandAgents.map(agentName).join('、') }]
      : []),
  ]

  const useColumns: readonly Column<CredentialUse & { readonly key: string }>[] = [
    { key: 'at', header: '时间', width: 'minmax(104px, 1fr)', render: (use) => formatTime(use.at) },
    { key: 'agent', header: '智能体', width: 'minmax(80px, 1fr)', render: (use) => agentName(use.agentId) },
    {
      key: 'channel',
      header: '频道',
      width: 'minmax(80px, 1fr)',
      priority: 2,
      render: (use) => <span className={own.clip}>{channelName(use.channelId)}</span>,
    },
    {
      key: 'consumer',
      header: '使用方',
      width: 'minmax(96px, 1.2fr)',
      render: (use) => (
        <span className={own.clip}>
          {use.consumerName === null
            ? CONSUMER_LABEL[use.consumerKind]
            : `${CONSUMER_LABEL[use.consumerKind]} · ${use.consumerName}`}
        </span>
      ),
    },
    {
      key: 'host',
      header: '目标',
      width: 'minmax(96px, 1.2fr)',
      priority: 2,
      render: (use) => <span className={own.clip}>{use.targetHost ?? '—'}</span>,
    },
  ]

  return (
    <div className={own.detail}>
      <ObjectHeader
        level={2}
        size="compact"
        title={credential.name}
        status={
          !credential.available ? (
            <Chip tone="bad">无法读取</Chip>
          ) : !credential.redactable ? (
            <Chip tone="warn">无法隐藏</Chip>
          ) : undefined
        }
        meta={
          <>
            {credential.kind === 'github' ? <span>GitHub · {credential.metadata.login ?? '未知账号'}</span> : null}
            <span>{credentialUsageText(credential)}</span>
            <span>
              {credential.lastUsedAt === null ? '尚未使用' : `最近使用：${relativeTime(credential.lastUsedAt)}`}
            </span>
          </>
        }
      />
      <PropertyGroup title="设置">
        <PropertyList>
          <PropertyRow label="名称" width="md" description={issues.name}>
            <Input
              aria-label="名称"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </PropertyRow>
          <PropertyRow label="说明" layout="stacked">
            <Textarea
              aria-label="说明"
              rows={2}
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </PropertyRow>
          <PropertyRow
            label={generic ? '值' : 'Token'}
            description={
              !credential.available
                ? '无法读取已保存的值，请更换。'
                : credential.redactable
                  ? '已保存'
                  : '已保存，少于 8 个字符，无法在智能体的上下文中隐藏。'
            }
          >
            <Button size="small" onClick={() => setReplacing(true)}>
              {generic ? '更换值' : '更换 token'}
            </Button>
          </PropertyRow>
          {generic ? (
            <>
              <PropertyRow
                label="使用方式"
                description={
                  draft.usage === 'program' ? (
                    <span className={own.warn}>智能体运行的程序可以读到原文。</span>
                  ) : undefined
                }
              >
                <Segmented
                  label="使用方式"
                  value={draft.usage}
                  options={USAGE_OPTIONS}
                  onChange={(usage) => setDraft({ ...draft, usage })}
                />
              </PropertyRow>
              <PropertyRow
                label="允许的域名"
                width="md"
                description={issues.domains ? <span className={own.warn}>{issues.domains}</span> : undefined}
              >
                <Input
                  aria-label="允许的域名"
                  value={draft.domains}
                  spellCheck={false}
                  placeholder="api.example.com"
                  onChange={(event) => setDraft({ ...draft, domains: event.target.value })}
                />
              </PropertyRow>
              {draft.usage === 'program' ? (
                <PropertyRow
                  label="环境变量名"
                  width="md"
                  tip="填写后，智能体运行的命令可以通过这个变量读取。"
                  description={issues.envName ? <span className={own.warn}>{issues.envName}</span> : undefined}
                >
                  <Input
                    aria-label="环境变量名"
                    value={draft.envName}
                    spellCheck={false}
                    placeholder="EXAMPLE_API_KEY"
                    onChange={(event) => setDraft({ ...draft, envName: event.target.value.toUpperCase() })}
                  />
                </PropertyRow>
              ) : null}
            </>
          ) : (
            <PropertyRow label="环境变量名" description="GH_TOKEN，命令中的 gh 和 git 使用这个账号" />
          )}
          <PropertyRow label="自动使用" tip="关闭后，智能体每次使用前要先申请。">
            <Switch
              label="自动使用"
              checked={draft.autoUse}
              onCheckedChange={(autoUse) => setDraft({ ...draft, autoUse })}
            />
          </PropertyRow>
          <PropertyRow label="可用智能体" layout="stacked">
            <AgentScopeField draft={draft} onChange={setDraft} />
          </PropertyRow>
        </PropertyList>
      </PropertyGroup>
      {credential.approvedAgentIds.length > 0 ? (
        <PropertyGroup title="已同意的智能体" tip="自动使用关闭时，这些智能体可以直接使用。">
          <PropertyList>
            {credential.approvedAgentIds.map((agentId) => (
              <PropertyRow key={agentId} label={agentName(agentId)}>
                <Button size="small" variant="ghost" onClick={() => void revoke(agentId)}>
                  撤销
                </Button>
              </PropertyRow>
            ))}
          </PropertyList>
        </PropertyGroup>
      ) : null}
      <PropertyGroup title="使用方">
        {usedByRows.length === 0 ? (
          <p className={own.note}>没有扩展或命令在使用。</p>
        ) : (
          <PropertyList>
            {usedByRows.map((row) => (
              <PropertyRow key={row.key} label={row.label} description={row.description || undefined} />
            ))}
          </PropertyList>
        )}
      </PropertyGroup>
      <PropertyGroup title="使用记录">
        {uses === undefined ? (
          <Skeleton height={44} />
        ) : (
          <DataTable
            label="使用记录"
            columns={useColumns}
            rows={uses.map((use, index) => ({ ...use, key: `${use.at}:${index}` }))}
            rowKey={(use) => use.key}
            empty="还没有使用记录"
          />
        )}
      </PropertyGroup>
      <Diagnostics items={[{ label: '凭据编号', value: credential.id }]} />
      <DangerZone>
        <PropertyRow label="删除凭据" description="使用它的扩展和命令会失去这个值。">
          <Button
            size="small"
            variant="danger"
            onClick={() => {
              setUsers(credential.usedBy)
              setRemoving(true)
            }}
          >
            删除
          </Button>
        </PropertyRow>
      </DangerZone>
      <SaveBar
        changes={changes}
        busy={busy}
        error={saveError || undefined}
        onSave={() => void save()}
        onDiscard={() => {
          setDraft(base)
          setSaveError('')
        }}
      />
      <ReplaceCredentialValueDialog
        credential={replacing ? credential : undefined}
        onOpenChange={(open) => !open && setReplacing(false)}
        onReplaced={onView}
      />
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`删除「${credential.name}」？`}
        confirmLabel="删除"
        danger
        onConfirm={remove}
      >
        {users.extensions.length === 0 && users.commandAgents.length === 0 ? (
          <p>没有扩展或命令在使用它。</p>
        ) : (
          <>
            <p>以下使用方会失去这个值：</p>
            <ul className={own.users}>
              {users.extensions.map((extension) => (
                <li key={extension.extensionId}>扩展「{extension.name}」</li>
              ))}
              {users.commandAgents.length > 0 ? <li>{users.commandAgents.map(agentName).join('、')} 的命令</li> : null}
            </ul>
          </>
        )}
      </ConfirmDialog>
    </div>
  )
}
