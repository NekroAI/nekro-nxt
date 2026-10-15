import { useState } from 'react'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { callHostApi } from '../../host-api-client.js'
import { useProductStore, type CommandAccount } from '../../product-runtime.js'
import {
  Button,
  Chip,
  ConfirmDialog,
  DataTable,
  EmptyState,
  PropertyGroup,
  PropertyList,
  PropertyRow,
  toast,
  type Column,
} from '../../ui-kit/index.js'
import {
  AddCommandAccountDialog,
  ReplaceCommandAccountTokenDialog,
  accountPermissionText,
} from '../agents/command-accounts.js'
import { CodeRunNodeDownload, CodeRunNodeRemove } from '../agents/runtime-download.js'
import { useProductApi } from '../model/store.js'
import styles from './settings.module.css'

const failure = (error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })

/**
 * The accounts commands can act as. An account takes effect only for the agents that were granted it on their own
 * page; this page keeps the accounts and shows who uses them.
 */
export function AccountsSection() {
  const api = useProductApi()
  const accounts = useProductStore((state) => state.commandAccounts)
  const agents = useProductStore((state) => state.agents)
  const cli = useProductStore((state) => state.capabilityAvailability.githubCli)
  const [adding, setAdding] = useState(false)
  const [replacing, setReplacing] = useState<CommandAccount>()
  const [removing, setRemoving] = useState<CommandAccount>()

  const agentNames = (account: CommandAccount) =>
    account.usedBy.map((id) => agents.find((agent) => agent.id === id)?.name ?? '已删除的智能体')

  const remove = async (account: CommandAccount) => {
    try {
      await callHostApi(HostApiContracts.removeCommandAccount, { accountId: account.id }, undefined)
      await api.getState().refreshHost()
      toast('账号已移除')
    } catch (error) {
      failure(error)
    }
  }

  const columns: readonly Column<CommandAccount>[] = [
    {
      key: 'login',
      header: '账号',
      width: 'minmax(140px, 1.4fr)',
      render: (account) => (
        <span className={styles.deviceName}>
          {account.login}
          <Chip tone="neutral">{account.source === 'gh-login' ? 'gh 登录' : 'Token'}</Chip>
        </span>
      ),
    },
    {
      key: 'permissions',
      header: '权限',
      width: 'minmax(160px, 2fr)',
      priority: 2,
      render: (account) => <span className={styles.faint}>{accountPermissionText(account)}</span>,
    },
    {
      key: 'users',
      header: '使用它的智能体',
      width: 'minmax(120px, 1.4fr)',
      render: (account) => (
        <span className={styles.faint}>{account.usedBy.length === 0 ? '无' : agentNames(account).join('、')}</span>
      ),
    },
    {
      key: 'actions',
      header: <span className={styles.srOnly}>操作</span>,
      width: '168px',
      align: 'end',
      render: (account) => (
        <span className={styles.rowControls}>
          <Button size="small" variant="ghost" onClick={() => setReplacing(account)}>
            更换 token
          </Button>
          <Button size="small" variant="danger" onClick={() => setRemoving(account)}>
            移除
          </Button>
        </span>
      ),
    },
  ]

  return (
    <>
      <PropertyGroup
        title="GitHub 账号"
        actions={
          <Button size="small" onClick={() => setAdding(true)}>
            添加 GitHub 账号
          </Button>
        }
      >
        {accounts.length === 0 ? (
          <EmptyState title="还没有账号">在智能体页的“能力”里授权后，它运行的命令才能使用 GitHub。</EmptyState>
        ) : (
          <DataTable label="GitHub 账号" columns={columns} rows={accounts} rowKey={(account) => account.id} />
        )}
      </PropertyGroup>
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
      <AddCommandAccountDialog open={adding} onOpenChange={setAdding} />
      <ReplaceCommandAccountTokenDialog account={replacing} onOpenChange={(open) => !open && setReplacing(undefined)} />
      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(open) => !open && setRemoving(undefined)}
        title={removing === undefined ? '' : `移除 ${removing.login}？`}
        confirmLabel="移除"
        danger
        onConfirm={async () => {
          if (removing !== undefined) await remove(removing)
          setRemoving(undefined)
        }}
      >
        <p>
          {removing === undefined || removing.usedBy.length === 0
            ? '没有智能体在使用这个账号。'
            : `${agentNames(removing).join('、')} 的命令会立刻失去这个账号。`}
        </p>
      </ConfirmDialog>
    </>
  )
}
