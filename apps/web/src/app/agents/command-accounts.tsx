import { useState } from 'react'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { callHostApi } from '../../host-api-client.js'
import {
  useProductStore,
  type AgentSummary,
  type CommandAccount,
  type CommandAccountUsage,
} from '../../product-runtime.js'
import {
  Button,
  Chip,
  Dialog,
  Field,
  Pressable,
  PropertyRow,
  SecretInput,
  Segmented,
  Select,
  toast,
} from '../../ui-kit/index.js'
import { useProductApi } from '../model/store.js'
import type { AgentDraft, DraftUpdate } from './agent-draft.js'
import { CodeRunNodeDownload, CodeRunNodeRemove } from './runtime-download.js'
import styles from './agents.module.css'

const USAGES: readonly { readonly value: CommandAccountUsage; readonly label: string }[] = [
  { value: 'read', label: '查看内容' },
  { value: 'issues', label: '处理 issue' },
  { value: 'pull-requests', label: '处理 PR' },
  { value: 'push', label: '推送代码' },
]

/** Token permissions as GitHub reports them; a fine-grained token reports none, its settings on GitHub decide. */
export const accountPermissionText = (account: CommandAccount): string =>
  account.scopes === undefined
    ? '由 GitHub 上这个 token 的设置决定'
    : account.scopes.length === 0
      ? '没有额外权限'
      : account.scopes.join('、')

const TOKEN_PAGE = 'https://github.com/settings/personal-access-tokens/new'

/**
 * Adds an account to the host's library: a pasted token, or a login the local GitHub CLI holds. The new account is
 * reported back so a caller can grant it right away.
 */
export function AddCommandAccountDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onAdded?: (accountId: string) => void
}) {
  const api = useProductApi()
  const existing = useProductStore((state) => state.commandAccounts)
  const [source, setSource] = useState<'token' | 'gh-login'>('token')
  const [token, setToken] = useState('')
  const [logins, setLogins] = useState<readonly string[] | undefined>(undefined)
  const [login, setLogin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const loadLogins = async () => {
    try {
      const view = await callHostApi(HostApiContracts.getCommandAccounts, {}, undefined)
      const names = view.localLogins.map((entry) => entry.login)
      setLogins(names)
      setLogin((current) =>
        names.includes(current) ? current : (view.localLogins.find((entry) => entry.active)?.login ?? names[0] ?? ''),
      )
    } catch {
      setLogins([])
    }
  }

  const reset = () => {
    setSource('token')
    setToken('')
    setLogins(undefined)
    setLogin('')
    setError('')
  }

  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      const view = await callHostApi(
        HostApiContracts.addCommandAccount,
        {},
        source === 'token'
          ? { source: 'token', service: 'github', token: token.trim() }
          : { source: 'gh-login', service: 'github', login },
      )
      const known = new Set(existing.map((account) => account.id))
      const added = view.accounts.find((account) => !known.has(account.id))
      await api.getState().refreshHost()
      toast(onAdded === undefined ? '账号已添加' : '账号已添加，保存后对这个智能体生效')
      reset()
      onOpenChange(false)
      if (added !== undefined) onAdded?.(added.id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const ready = source === 'token' ? token.trim() !== '' : login !== ''
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
      title="添加 GitHub 账号"
      actions={
        <>
          <Button onClick={() => onOpenChange(false)}>取消</Button>
          <Button variant="primary" busy={busy} disabled={!ready} onClick={() => void submit()}>
            添加
          </Button>
        </>
      }
    >
      <Segmented
        label="账号来源"
        value={source}
        options={[
          { value: 'token', label: '填写 token' },
          { value: 'gh-login', label: '使用本机 gh 登录' },
        ]}
        onChange={(next) => {
          setSource(next)
          setError('')
          if (next === 'gh-login' && logins === undefined) void loadLogins()
        }}
      />
      {source === 'token' ? (
        <Field
          label="Token"
          hint={
            <>
              建议在 GitHub 上
              <a href={TOKEN_PAGE} target="_blank" rel="noreferrer">
                创建专用 token
              </a>
              ，只开启需要的权限，例如 Issues 的读写。
            </>
          }
          error={error}
        >
          <SecretInput
            configured={false}
            value={token}
            placeholder="github_pat_…"
            onChange={(event) => setToken(event.target.value)}
          />
        </Field>
      ) : logins === undefined ? (
        <p className={styles.note}>正在读取本机登录…</p>
      ) : logins.length === 0 ? (
        <p className={styles.note}>这台设备上没有已登录的 gh 账号。</p>
      ) : (
        <Field
          label="账号"
          hint="添加的是此刻的登录，之后在 gh 里退出或刷新不会同步。该账号在 gh 里的全部权限都会交给智能体。"
          error={error}
        >
          <Select
            aria-label="gh 账号"
            value={login}
            options={logins.map((name) => ({ value: name, label: name }))}
            onValueChange={setLogin}
          />
        </Field>
      )}
    </Dialog>
  )
}

/**
 * The accounts one agent's commands may act as. Granting happens here and nowhere else; the library only keeps
 * accounts. A usage hint is told to the agent and limits nothing: the token's own permissions are the limit.
 */
export function CommandAccountRows({
  agent,
  caps,
  update,
}: {
  readonly agent: AgentSummary
  readonly caps: AgentDraft['capabilities']
  readonly update: DraftUpdate
}) {
  const accounts = useProductStore((state) => state.commandAccounts)
  const cli = useProductStore((state) => state.capabilityAvailability.githubCli)
  const [adding, setAdding] = useState(false)
  if (cli === undefined) return null

  const grant = caps.commandAccounts.find((entry) => entry.service === 'github')
  const account = grant === undefined ? undefined : accounts.find((entry) => entry.id === grant.accountId)
  const setGrant = (accountId: string) =>
    update((current) => ({
      ...current,
      capabilities: {
        ...current.capabilities,
        commandAccounts:
          accountId === ''
            ? current.capabilities.commandAccounts.filter((entry) => entry.service !== 'github')
            : [{ service: 'github', accountId, usage: grant?.accountId === accountId ? grant.usage : [] }],
      },
    }))
  const toggleUsage = (usage: CommandAccountUsage) =>
    update((current) => ({
      ...current,
      capabilities: {
        ...current.capabilities,
        commandAccounts: current.capabilities.commandAccounts.map((entry) =>
          entry.service !== 'github'
            ? entry
            : {
                ...entry,
                usage: entry.usage.includes(usage)
                  ? entry.usage.filter((item) => item !== usage)
                  : USAGES.map((item) => item.value).filter((item) => item === usage || entry.usage.includes(item)),
              },
        ),
      },
    }))

  return (
    <>
      <PropertyRow
        depth={1}
        label="GitHub 账号"
        description="命令里的 gh 和 git 以这个账号工作"
        badge={grant !== undefined && account === undefined ? <Chip tone="warn">账号已移除</Chip> : undefined}
      >
        <div className={styles.credential}>
          <Select
            aria-label="GitHub 账号"
            value={account?.id ?? ''}
            options={[
              { value: '', label: '不授权' },
              ...accounts.map((entry) => ({ value: entry.id, label: entry.login })),
            ]}
            onValueChange={setGrant}
          />
          <Button size="small" onClick={() => setAdding(true)}>
            添加 GitHub 账号
          </Button>
        </div>
      </PropertyRow>
      {account !== undefined ? (
        <>
          <PropertyRow depth={2} label="账号权限" description={accountPermissionText(account)} />
          <PropertyRow
            depth={2}
            label="使用提示"
            description={`告诉${agent.name}这个账号用来做什么，只写进提示词，不限制它能做的事`}
            layout="stacked"
          >
            <div className={styles.usageBar} role="group" aria-label="使用提示">
              {USAGES.map((item) => (
                <Pressable
                  key={item.value}
                  className={styles.usageToggle}
                  aria-pressed={grant?.usage.includes(item.value) ?? false}
                  onClick={() => toggleUsage(item.value)}
                >
                  {item.label}
                </Pressable>
              ))}
            </div>
          </PropertyRow>
          {cli.available ? (
            cli.source === 'downloaded' ? (
              <PropertyRow depth={2} label="GitHub CLI" description={`${cli.version ?? ''}，由 NekroNXT 下载`}>
                <CodeRunNodeRemove availability={cli} kind="github-cli" />
              </PropertyRow>
            ) : null
          ) : cli.download !== undefined ? (
            <PropertyRow depth={2} label="GitHub CLI" description="这台设备没有 gh，下载后命令里可以直接使用">
              <CodeRunNodeDownload availability={cli} kind="github-cli" />
            </PropertyRow>
          ) : (
            <PropertyRow
              depth={2}
              label="GitHub CLI"
              description="这台设备没有 gh，命令里只能通过 REST 接口使用这个账号"
            />
          )}
        </>
      ) : null}
      <AddCommandAccountDialog open={adding} onOpenChange={setAdding} onAdded={setGrant} />
    </>
  )
}

/** Gives an account a new token of the same GitHub account; grants keep pointing at the account. */
export function ReplaceCommandAccountTokenDialog({
  account,
  onOpenChange,
}: {
  readonly account: CommandAccount | undefined
  readonly onOpenChange: (open: boolean) => void
}) {
  const api = useProductApi()
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const close = () => {
    setToken('')
    setError('')
    onOpenChange(false)
  }
  const submit = async () => {
    if (account === undefined) return
    setBusy(true)
    setError('')
    try {
      await callHostApi(
        HostApiContracts.replaceCommandAccountToken,
        { accountId: account.id },
        { source: 'token', service: 'github', token: token.trim() },
      )
      await api.getState().refreshHost()
      toast('Token 已更换')
      close()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={account !== undefined}
      onOpenChange={(open) => (open ? undefined : close())}
      title={account === undefined ? '' : `更换 ${account.login} 的 token`}
      actions={
        <>
          <Button onClick={close}>取消</Button>
          <Button variant="primary" busy={busy} disabled={token.trim() === ''} onClick={() => void submit()}>
            更换
          </Button>
        </>
      }
    >
      <Field label="新的 token" hint="需要属于同一个 GitHub 账号。" error={error}>
        <SecretInput
          configured={false}
          value={token}
          placeholder="github_pat_…"
          onChange={(event) => setToken(event.target.value)}
        />
      </Field>
    </Dialog>
  )
}
