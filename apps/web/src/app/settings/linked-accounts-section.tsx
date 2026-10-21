import {
  HostApiContracts,
  LinkedAccountPlatformIdSchema,
  type LinkedAccountsView,
  type LinkedAccountUse,
  type LinkedAccountView,
} from '@nekro-nxt/contracts'
import { ChevronRight, Plus } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AddLinkedAccountDialog, ReplaceLinkedAccountTokenDialog } from '../../linked-accounts/account-dialogs.js'
import {
  ACCOUNT_SOURCE_LABEL,
  accountScopesText,
  useLinkedAccounts,
  type LinkedPlatformView,
} from '../../linked-accounts/linked-accounts-data.js'
import { useProductStore } from '../../product-runtime.js'
import { callHostApi } from '../../host-api-client.js'
import {
  Button,
  Chip,
  ConfirmDialog,
  DangerZone,
  DataTable,
  Diagnostics,
  EmptyState,
  MasterDetail,
  ObjectHeader,
  PropertyGroup,
  PropertyList,
  PropertyRow,
  Skeleton,
  toast,
  type Column,
} from '../../ui-kit/index.js'
import { CodeRunNodeDownload, CodeRunNodeRemove } from '../agents/runtime-download.js'
import { relativeTime } from '../channels/timeline-model.js'
import { SectionHead } from './section-head.js'
import own from './credentials-section.module.css'
import styles from './settings.module.css'

const formatTime = (time: number) => {
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const useAgentName = () => {
  const agents = useProductStore((state) => state.agents)
  return (id: string | null) =>
    id === null ? '—' : (agents.find((agent) => agent.id === id)?.name ?? '已删除的智能体')
}

/**
 * 设置 → 关联账号: third-party accounts agents' commands act as, one block per platform, plus the platforms' own
 * tools. Accounts are only kept here; each agent picks its account in its capabilities. An open account is addressed
 * by `?account=`, and `?add=<platform>` opens the add dialog.
 */
export function LinkedAccountsSection({ lead }: { readonly lead: ReactNode }) {
  const [params, setParams] = useSearchParams()
  const { view, error, load, replace } = useLinkedAccounts()
  const cli = useProductStore((state) => state.capabilityAvailability.githubCli)
  const agentName = useAgentName()
  const [adding, setAdding] = useState<string>()
  const requestedAdd = LinkedAccountPlatformIdSchema.safeParse(params.get('add'))
  const addingId = adding ?? (requestedAdd.success ? requestedAdd.data : undefined)
  const addingPlatform = view?.platforms.find((platform) => platform.id === addingId)
  const selectedId = params.get('account') ?? ''
  const selectedPlatform = view?.platforms.find((platform) =>
    platform.accounts.some((account) => account.id === selectedId),
  )
  const selected = selectedPlatform?.accounts.find((account) => account.id === selectedId)
  const select = (id: string) => setParams(id ? { account: id } : {})

  const columnsOf = (platform: LinkedPlatformView): readonly Column<LinkedAccountView>[] => [
    {
      key: 'login',
      header: '账号',
      width: 'minmax(140px, 1.2fr)',
      render: (account) => (
        <span className={styles.deviceName}>
          <b>{account.login}</b>
          {account.available ? null : <Chip tone="bad">无法读取</Chip>}
        </span>
      ),
    },
    {
      key: 'scopes',
      header: '权限范围',
      width: 'minmax(120px, 1.4fr)',
      priority: 3,
      render: (account) => <span className={own.clip}>{accountScopesText(account, platform.name)}</span>,
    },
    {
      key: 'agents',
      header: '已授权',
      width: 'minmax(96px, 1.2fr)',
      priority: 2,
      render: (account) => (
        <span className={own.clip}>
          {account.grantedAgentIds.length === 0 ? '—' : account.grantedAgentIds.map(agentName).join('、')}
        </span>
      ),
    },
    {
      key: 'lastUsed',
      header: '最近使用',
      width: 'minmax(80px, 0.7fr)',
      priority: 2,
      render: (account) => (
        <span className={styles.muted}>
          {account.lastUsedAt === null ? '未使用' : relativeTime(account.lastUsedAt)}
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

  const closeAdd = () => {
    setAdding(undefined)
    if (requestedAdd.success) setParams(selectedId ? { account: selectedId } : {})
  }

  const list = (
    <>
      {lead}
      <SectionHead title="关联账号" />
      {view === undefined ? (
        error ? (
          <EmptyState title="读取关联账号失败" action={<Button onClick={() => void load()}>重试</Button>}>
            {error}
          </EmptyState>
        ) : (
          <div className={styles.loading} role="status" aria-label="正在读取关联账号">
            <Skeleton height={44} />
            <Skeleton height={44} />
          </div>
        )
      ) : (
        view.platforms.map((platform) => (
          <PropertyGroup
            key={platform.id}
            title={platform.name}
            actions={
              <Button size="small" icon={<Plus size={14} aria-hidden="true" />} onClick={() => setAdding(platform.id)}>
                关联账号
              </Button>
            }
          >
            {platform.accounts.length === 0 ? (
              <p className={own.note}>还没有关联账号。</p>
            ) : (
              <DataTable
                label={`${platform.name} 账号`}
                columns={columnsOf(platform)}
                rows={platform.accounts}
                rowKey={(account) => account.id}
                selectedKey={selected?.id}
                onSelect={(account) => select(account.id)}
              />
            )}
          </PropertyGroup>
        ))
      )}
      <AddLinkedAccountDialog
        platform={addingPlatform}
        localLogins={view?.localGithubLogins ?? []}
        onOpenChange={(open) => !open && closeAdd()}
        onAdded={({ view: next, accountId }) => {
          replace(next)
          setAdding(undefined)
          select(accountId ?? '')
        }}
      />
    </>
  )

  // The platforms' tools belong to the whole page, not to one account: hidden while one is open.
  const tools = (view?.platforms ?? []).flatMap((platform) =>
    platform.tool === undefined ? [] : [{ platform, tool: platform.tool }],
  )
  const overview =
    tools.length === 0 ? undefined : (
      <>
        {tools.map(({ platform, tool }) => {
          const availability = tool.id === 'github-cli' ? (cli ?? tool.availability) : tool.availability
          return (
            <PropertyGroup key={platform.id} title={tool.name}>
              <PropertyList>
                <PropertyRow
                  label="gh"
                  description={
                    availability.available
                      ? `${availability.version ?? ''}，${availability.source === 'downloaded' ? '由 NekroNXT 下载' : '来自这台设备'}`
                      : availability.download === undefined
                        ? '这台设备没有 gh'
                        : '这台设备没有 gh，下载后智能体的命令里可以直接使用'
                  }
                >
                  {availability.available ? (
                    <CodeRunNodeRemove availability={availability} kind={tool.id} />
                  ) : (
                    <CodeRunNodeDownload availability={availability} kind={tool.id} />
                  )}
                </PropertyRow>
              </PropertyList>
            </PropertyGroup>
          )
        })}
      </>
    )

  return (
    <MasterDetail
      label="关联账号"
      lead={lead}
      list={list}
      overview={overview}
      selectedKey={selected?.id}
      back={{ label: '全部关联账号', onBack: () => select('') }}
      detail={
        selected !== undefined && selectedPlatform !== undefined ? (
          <LinkedAccountDetail
            key={selected.id}
            account={selected}
            platform={selectedPlatform}
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

/** One account: where it came from, its permissions and token, the agents it is granted to, its uses and removal. */
function LinkedAccountDetail({
  account,
  platform,
  onView,
  onRemoved,
}: {
  readonly account: LinkedAccountView
  readonly platform: LinkedPlatformView
  readonly onView: (view: LinkedAccountsView) => void
  readonly onRemoved: (view: LinkedAccountsView) => void
}) {
  const channels = useProductStore((state) => state.channels)
  const agentName = useAgentName()
  const [replacing, setReplacing] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [granted, setGranted] = useState(account.grantedAgentIds)
  const [uses, setUses] = useState<readonly LinkedAccountUse[]>()
  useEffect(() => {
    let current = true
    callHostApi(HostApiContracts.getLinkedAccountUses, { accountId: account.id }, undefined)
      .then((result) => current && setUses(result.uses))
      .catch(() => current && setUses([]))
    return () => {
      current = false
    }
  }, [account.id, account.lastUsedAt])

  const channelName = (id: string | null) => {
    if (id === null) return '—'
    const channel = channels.find((candidate) => candidate.id === id)
    return channel === undefined ? '—' : (channel.customName ?? channel.name)
  }

  const remove = async () => {
    const result = await callHostApi(
      HostApiContracts.removeLinkedAccount,
      { accountId: account.id },
      { confirm: granted.length > 0 },
    )
    if (!result.removed) {
      setGranted(result.grantedAgentIds)
      throw new Error('它已授权给智能体，再次确认后移除。')
    }
    toast('账号已移除')
    onRemoved(result.view)
  }

  const useColumns: readonly Column<LinkedAccountUse & { readonly key: string }>[] = [
    { key: 'at', header: '时间', width: 'minmax(104px, 1fr)', render: (use) => formatTime(use.at) },
    { key: 'agent', header: '智能体', width: 'minmax(80px, 1fr)', render: (use) => agentName(use.agentId) },
    {
      key: 'channel',
      header: '频道',
      width: 'minmax(80px, 1fr)',
      priority: 2,
      render: (use) => <span className={own.clip}>{channelName(use.channelId)}</span>,
    },
  ]

  return (
    <div className={own.detail}>
      <ObjectHeader
        level={2}
        size="compact"
        title={account.login}
        status={account.available ? undefined : <Chip tone="bad">无法读取</Chip>}
        meta={
          <>
            <span>{platform.name}</span>
            <span>{account.lastUsedAt === null ? '尚未使用' : `最近使用：${relativeTime(account.lastUsedAt)}`}</span>
          </>
        }
      />
      <PropertyGroup title="账号">
        <PropertyList>
          <PropertyRow label="来源" description={ACCOUNT_SOURCE_LABEL[account.source]} />
          <PropertyRow label="权限范围" description={accountScopesText(account, platform.name)} />
          <PropertyRow label="Token" description={account.available ? '已保存' : '无法读取已保存的 token，请更换。'}>
            <Button size="small" onClick={() => setReplacing(true)}>
              更换 token
            </Button>
          </PropertyRow>
        </PropertyList>
      </PropertyGroup>
      <PropertyGroup title="已授权的智能体" tip="在智能体的能力里选择账号。">
        {account.grantedAgentIds.length === 0 ? (
          <p className={own.note}>还没有授权给智能体。</p>
        ) : (
          <PropertyList>
            {account.grantedAgentIds.map((agentId) => (
              <PropertyRow
                key={agentId}
                label={
                  <Link className={styles.link} to={`/agents/${agentId}#profile-capabilities`}>
                    {agentName(agentId)}
                  </Link>
                }
              />
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
      <Diagnostics items={[{ label: '账号编号', value: account.id }]} />
      <DangerZone>
        <PropertyRow label="移除账号" description="授权给它的智能体的命令会失去这个账号。">
          <Button
            size="small"
            variant="danger"
            onClick={() => {
              setGranted(account.grantedAgentIds)
              setRemoving(true)
            }}
          >
            移除
          </Button>
        </PropertyRow>
      </DangerZone>
      <ReplaceLinkedAccountTokenDialog
        account={replacing ? account : undefined}
        platformName={platform.name}
        onOpenChange={(open) => !open && setReplacing(false)}
        onReplaced={onView}
      />
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`移除「${account.login}」？`}
        confirmLabel="移除"
        danger
        onConfirm={remove}
      >
        {granted.length === 0 ? (
          <p>没有智能体使用它。</p>
        ) : (
          <>
            <p>以下智能体的命令会失去这个账号：</p>
            <ul className={own.users}>
              {granted.map((agentId) => (
                <li key={agentId}>{agentName(agentId)}</li>
              ))}
            </ul>
          </>
        )}
      </ConfirmDialog>
    </div>
  )
}
