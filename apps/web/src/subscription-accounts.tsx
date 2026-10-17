import { useEffect, useRef, useState, type ReactNode } from 'react'
import { HostApiContracts, type HostApiRequest, type HostApiResponse } from '@nekro-nxt/contracts'
import { callHostApi } from './host-api-client.js'
import { useProductRuntime } from './product-runtime.js'
import { Banner, Button, ConfirmDialog, Dialog, Field, Input, Select, toast } from './ui-kit/index.js'
import styles from './llm-settings.module.css'

type Status = HostApiResponse<'llmSubscriptionStatus'>
type Action = HostApiRequest<'llmSubscriptionAction'>

const failure = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))
/** The sign-in callback goes to the host's own loopback; only a browser on that machine reaches it. */
const onHostMachine = (): boolean => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(window.location.hostname)

/** OpenAI's sign-in guidelines name the button and its mark; other providers get a plain label. */
function SignInLabel({ provider, label }: { readonly provider: string; readonly label: string }): ReactNode {
  if (provider !== 'openai') return <>登录 {label}</>
  return (
    <>
      <img className={styles.chatGptLogoDark} src="/vendor/chatgpt-logo-black.svg" width={21} height={21} alt="" />
      <img className={styles.chatGptLogoLight} src="/vendor/chatgpt-logo-white.svg" width={21} height={21} alt="" />
      Continue with ChatGPT
    </>
  )
}

/**
 * The accounts a provider route can use instead of an API key. One account is in use at a time; signing in adds
 * an account, and the sign-in runs on the host, so the page only shows what the host asks the person to do.
 */
export function SubscriptionAccounts({ provider }: { readonly provider: string }): ReactNode {
  const store = useProductRuntime().store
  const [status, setStatus] = useState<Status>()
  const [chosen, setChosen] = useState('')
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [renaming, setRenaming] = useState<string>()
  const [removing, setRemoving] = useState(false)
  const opened = useRef<string | undefined>(undefined)
  const handled = useRef<string | undefined>(undefined)
  const running = status?.login?.status === 'running'
  const remote = !onHostMachine()

  const read = async (): Promise<Status> => {
    const next = await callHostApi(HostApiContracts.llmSubscriptionStatus, { provider }, undefined)
    setStatus(next)
    return next
  }
  const act = async (input: Action, done?: string): Promise<void> => {
    setBusy(true)
    try {
      const result = await callHostApi(HostApiContracts.llmSubscriptionAction, { provider }, input)
      setStatus(result.status)
      if (result.revocationConfirmed === false) {
        toast(`已从这台主机退出。没能确认 ${result.status.label} 已撤销授权，可以在使用量设置里断开 NekroNXT。`, {
          tone: 'bad',
          group: `subscription:${provider}`,
        })
      } else if (done) toast(done, { group: `subscription:${provider}` })
      void store
        .getState()
        .loadLlmProviders(true)
        .catch(() => undefined)
    } catch (cause) {
      toast(failure(cause), { tone: 'bad', group: `subscription:${provider}` })
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    let alive = true
    void read()
      .then((next) => {
        if (!alive) return
        setChosen(next.activeAccountId ?? next.accounts[0]?.id ?? '')
        // An attempt that ended before this page opened is not news.
        if (next.login?.status !== 'running') handled.current = next.login?.id
      })
      .catch((cause: unknown) => toast(failure(cause), { tone: 'bad', group: `subscription:${provider}` }))
    return () => {
      alive = false
    }
  }, [provider])

  useEffect(() => {
    if (!running) return
    let reading = false
    const timer = window.setInterval(() => {
      if (reading) return
      reading = true
      void read()
        .catch(() => undefined)
        .finally(() => {
          reading = false
        })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [running, provider])

  useEffect(() => {
    const login = status?.login
    if (!login) return
    const url = login.notices.findLast((notice) => notice.url)?.url
    // Open the authorization page once per attempt; the link below stays for blocked pop-ups.
    if (login.status === 'running' && url && opened.current !== login.id) {
      opened.current = login.id
      window.open(url, '_blank', 'noopener,noreferrer')
    }
    if (login.status === 'running' || handled.current === login.id) return
    handled.current = login.id
    setAnswer('')
    if (login.status === 'authorized' || (login.status === 'failed' && status.activeAccountId !== null)) {
      setChosen(status.activeAccountId ?? '')
      void store
        .getState()
        .loadLlmProviders(true)
        .catch(() => undefined)
    }
    if (login.status === 'authorized') {
      toast(`已登录 ${status.label}。`, { group: `subscription:${provider}` })
    } else if (login.status === 'failed' && login.error) {
      toast(login.error, { tone: 'bad', group: `subscription:${provider}` })
    }
  }, [status])

  if (!status) return null
  const active = status.accounts.find((account) => account.id === status.activeAccountId)
  const selected = status.accounts.find((account) => account.id === chosen)
  const prompt = status.login?.status === 'running' ? status.login.prompt : null
  const link = status.login?.status === 'running' ? status.login.notices.findLast((notice) => notice.url) : undefined

  return (
    <div className={styles.accounts}>
      {status.accounts.length ? (
        <Field
          label="账号"
          tip={`请求使用所选账号的 ${status.label} 套餐额度。Plus 套餐的 5 小时额度与其他使用此账号的应用共用。`}
        >
          <Select
            value={chosen}
            onValueChange={setChosen}
            options={status.accounts.map((account) => ({
              value: account.id,
              label: account.id === status.activeAccountId ? `${account.label}（正在使用）` : account.label,
            }))}
          />
        </Field>
      ) : (
        <p className={styles.muted}>登录后，这个供应商的请求使用账号的 {status.label} 套餐额度，不需要 API 密钥。</p>
      )}

      {running ? (
        <Banner
          action={
            <Button size="small" variant="ghost" disabled={busy} onClick={() => void act({ action: 'cancel' })}>
              取消登录
            </Button>
          }
        >
          {status.login?.notices.at(-1)?.message ?? `正在等待 ${status.label} 授权。`}
          {link?.url ? (
            <>
              {' '}
              <a href={link.url} target="_blank" rel="noopener noreferrer">
                打开授权页面
              </a>
            </>
          ) : null}
          {link?.code ? <strong> {link.code}</strong> : null}
          {remote
            ? ' 你正在从其他设备访问 NekroNXT：授权后浏览器会跳到一个打不开的 127.0.0.1 页面，这是正常的，把它地址栏里的完整网址粘贴到下面即可。'
            : null}
        </Banner>
      ) : null}

      {prompt ? (
        <>
          <Field
            label={prompt.message}
            tip={
              prompt.kind === 'text' && !remote ? '在这台电脑上授权后通常会自动完成；没有完成时再粘贴网址。' : undefined
            }
          >
            {prompt.kind === 'select' ? (
              <Select
                value={answer}
                placeholder="请选择"
                onValueChange={setAnswer}
                options={(prompt.options ?? []).map((option) => ({ value: option.id, label: option.label }))}
              />
            ) : (
              <Input
                value={answer}
                type={prompt.kind === 'secret' ? 'password' : 'text'}
                spellCheck={false}
                placeholder={prompt.placeholder}
                onChange={(event) => setAnswer(event.target.value)}
              />
            )}
          </Field>
          <div className={styles.actionBarStart}>
            <Button
              size="small"
              disabled={busy || !answer.trim()}
              onClick={() => void act({ action: 'answer', promptId: prompt.id, value: answer.trim() })}
            >
              提交
            </Button>
          </div>
        </>
      ) : null}

      <div className={styles.actionBarStart}>
        <Button disabled={busy || running} onClick={() => void act({ action: 'login' })}>
          {status.accounts.length ? '添加账号' : <SignInLabel provider={provider} label={status.label} />}
        </Button>
        {selected && selected.id !== status.activeAccountId ? (
          <Button
            disabled={busy || running}
            onClick={() => void act({ action: 'activate', accountId: selected.id }, `已改用 ${selected.label}。`)}
          >
            使用此账号
          </Button>
        ) : null}
        {selected ? (
          <>
            <Button variant="ghost" disabled={busy || running} onClick={() => setRenaming(selected.label)}>
              重命名
            </Button>
            <Button variant="ghost" disabled={busy || running} onClick={() => setRemoving(true)}>
              退出此账号
            </Button>
          </>
        ) : null}
        <Button variant="ghost" onClick={() => window.open(status.usageUrl, '_blank', 'noopener,noreferrer')}>
          管理使用量
        </Button>
      </div>
      {status.accounts.length > 0 && !active ? (
        <Banner tone="warn">没有正在使用的账号。选择一个账号并点“使用此账号”，或重新登录。</Banner>
      ) : null}

      <Dialog
        open={renaming !== undefined}
        onOpenChange={(open) => {
          if (!open) setRenaming(undefined)
        }}
        title="重命名账号"
        actions={
          <>
            <Button variant="ghost" onClick={() => setRenaming(undefined)}>
              取消
            </Button>
            <Button
              variant="primary"
              disabled={busy || !renaming?.trim() || !selected}
              onClick={() => {
                if (!selected || !renaming) return
                void act({ action: 'rename', accountId: selected.id, label: renaming.trim() }).then(() =>
                  setRenaming(undefined),
                )
              }}
            >
              保存
            </Button>
          </>
        }
      >
        <Field label="账号名称">
          <Input value={renaming ?? ''} maxLength={80} onChange={(event) => setRenaming(event.target.value)} />
        </Field>
      </Dialog>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title="退出此账号"
        confirmLabel="退出"
        onConfirm={async () => {
          if (!selected) return
          await act({ action: 'remove', accountId: selected.id }, `已退出 ${selected.label}。`)
          const next = await read().catch(() => undefined)
          setChosen(next?.activeAccountId ?? next?.accounts[0]?.id ?? '')
        }}
      >
        {selected?.label} 将从这台主机退出，并撤销 NekroNXT 的授权。
        {selected?.id === status.activeAccountId
          ? '退出后这个供应商没有可用的账号，直到你改用其他账号或重新登录。'
          : ''}
      </ConfirmDialog>
    </div>
  )
}
