import { HostApiContracts, type LinkedAccountsView, type LinkedAccountView } from '@nekro-nxt/contracts'
import { useEffect, useState } from 'react'
import { callHostApi } from '../host-api-client.js'
import { Button, Dialog, Field, SecretInput, Segmented, Select, toast } from '../ui-kit/index.js'
import type { LinkedPlatformView } from './linked-accounts-data.js'
import styles from './linked-accounts.module.css'

const TOKEN_PAGE = 'https://github.com/settings/personal-access-tokens/new'

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/**
 * Links an account of one platform: a typed token, or a login the local `gh` holds (read once). The new account's id
 * is reported back so the caller can open it.
 */
export function AddLinkedAccountDialog({
  platform,
  localLogins,
  onOpenChange,
  onAdded,
}: {
  /** The platform to link an account of; undefined keeps the dialog closed. */
  readonly platform: LinkedPlatformView | undefined
  readonly localLogins: LinkedAccountsView['localGithubLogins']
  readonly onOpenChange: (open: boolean) => void
  readonly onAdded: (result: { readonly view: LinkedAccountsView; readonly accountId: string | undefined }) => void
}) {
  const open = platform !== undefined
  const [method, setMethod] = useState<'token' | 'gh-login'>('token')
  const [token, setToken] = useState('')
  const [login, setLogin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open) return
    setMethod('token')
    setToken('')
    setLogin('')
    setError('')
  }, [open])

  const offersLogin = platform?.addMethods.includes('gh-login') ?? false
  const chosenLogin = login || (localLogins.find((entry) => entry.active)?.login ?? localLogins[0]?.login ?? '')
  const ready = method === 'token' ? token.trim() !== '' : chosenLogin !== ''

  const submit = async () => {
    if (platform === undefined) return
    setBusy(true)
    setError('')
    try {
      const known = new Set(platform.accounts.map((account) => account.id))
      const view = await callHostApi(
        HostApiContracts.addLinkedAccount,
        {},
        method === 'token'
          ? { platform: platform.id, method: 'token', token: token.trim() }
          : { platform: platform.id, method: 'gh-login', login: chosenLogin },
      )
      const added = view.platforms
        .find((candidate) => candidate.id === platform.id)
        ?.accounts.find((account) => !known.has(account.id))
      toast(added === undefined ? '账号已关联' : `已关联 ${added.login}`)
      onAdded({ view, accountId: added?.id })
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !busy && onOpenChange(next)}
      title={platform === undefined ? '' : `关联 ${platform.name} 账号`}
      actions={
        <>
          <Button onClick={() => onOpenChange(false)}>取消</Button>
          <Button variant="primary" busy={busy} disabled={!ready} onClick={() => void submit()}>
            关联
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        {offersLogin ? (
          <Segmented
            className={styles.segmented}
            label="账号来源"
            value={method}
            options={[
              { value: 'token', label: '填写 token' },
              { value: 'gh-login', label: '本机 gh 已登录账号' },
            ]}
            onChange={(next) => {
              setMethod(next)
              setError('')
            }}
          />
        ) : null}
        {method === 'token' ? (
          <Field
            label="Token"
            hint={
              <>
                建议
                <a href={TOKEN_PAGE} target="_blank" rel="noreferrer">
                  创建专用 token
                </a>
                ，只开启需要的权限。
              </>
            }
            error={error || undefined}
          >
            <SecretInput
              configured={false}
              value={token}
              placeholder="github_pat_…"
              autoComplete="off"
              onChange={(event) => setToken(event.target.value)}
            />
          </Field>
        ) : localLogins.length === 0 ? (
          <p className={styles.note}>这台设备上没有已登录的 gh 账号。</p>
        ) : (
          <Field label="账号" hint="授权的智能体会获得该账号在 gh 里的全部权限。" error={error || undefined}>
            <Select
              aria-label="gh 账号"
              value={chosenLogin}
              options={localLogins.map((entry) => ({ value: entry.login, label: entry.login }))}
              onValueChange={setLogin}
            />
          </Field>
        )}
      </div>
    </Dialog>
  )
}

/** Gives an account a new token of the same account on its platform; grants keep pointing at the account. */
export function ReplaceLinkedAccountTokenDialog({
  account,
  platformName,
  onOpenChange,
  onReplaced,
}: {
  readonly account: LinkedAccountView | undefined
  readonly platformName: string
  readonly onOpenChange: (open: boolean) => void
  readonly onReplaced: (view: LinkedAccountsView) => void
}) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const open = account !== undefined
  useEffect(() => {
    if (!open) return
    setToken('')
    setError('')
  }, [open])

  const submit = async () => {
    if (account === undefined) return
    setBusy(true)
    setError('')
    try {
      const view = await callHostApi(
        HostApiContracts.replaceLinkedAccountToken,
        { accountId: account.id },
        { method: 'token', token: token.trim() },
      )
      toast('Token 已更换')
      onReplaced(view)
      onOpenChange(false)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !busy && onOpenChange(next)}
      title={account === undefined ? '' : `更换 ${account.login} 的 token`}
      actions={
        <>
          <Button onClick={() => onOpenChange(false)}>取消</Button>
          <Button variant="primary" busy={busy} disabled={token.trim() === ''} onClick={() => void submit()}>
            更换
          </Button>
        </>
      }
    >
      <Field label="新的 token" hint={`需要属于同一个 ${platformName} 账号。`} error={error || undefined}>
        <SecretInput
          configured={false}
          value={token}
          placeholder="github_pat_…"
          autoComplete="off"
          onChange={(event) => setToken(event.target.value)}
        />
      </Field>
    </Dialog>
  )
}
