import { useEffect, useRef, useState } from 'react'
import { HostApiContracts, type HostApiRequest, type HostApiResponse } from '@nekro-nxt/contracts'
import { callHostApi } from './host-api-client.js'
import { useProductRuntime } from './product-runtime.js'
import { ModelListView } from './llm-model-editor.js'
import { Banner, Button, Chip, Dialog, ObjectHeader, PropertyGroup, Select, toast } from './ui-kit/index.js'
import styles from './llm-settings.module.css'

type Status = HostApiResponse<'chatGptStatus'>

export function ChatGptSettings() {
  const store = useProductRuntime().store
  const [status, setStatus] = useState<Status>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [chosen, setChosen] = useState('')
  const handled = useRef<string | undefined>(undefined)
  const waiting = status?.login?.status === 'waiting' || status?.login?.status === 'exchanging'
  const active = status?.accounts.find((account) => account.id === status.activeId)
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname)

  const update = async () => {
    const next = await callHostApi(HostApiContracts.chatGptStatus, {}, undefined)
    setStatus(next)
    return next
  }
  const refreshProviders = () => store.getState().loadLlmProviders(true)
  const failure = (cause: unknown) => setError(cause instanceof Error ? cause.message : 'ChatGPT 操作失败，请重试。')
  const action = async (input: HostApiRequest<'chatGptAction'>) => {
    setBusy(true)
    setError('')
    try {
      const result = await callHostApi(HostApiContracts.chatGptAction, {}, input)
      setStatus(result.status)
      await refreshProviders()
      if (
        input.action === 'select' &&
        result.status.accounts.find((account) => account.id === result.status.activeId)?.planEnabled
      ) {
        const refreshed = await callHostApi(HostApiContracts.chatGptAction, {}, { action: 'refresh-models' })
        setStatus(refreshed.status)
        await refreshProviders()
      }
      if (result.revocationConfirmed === false) {
        setError('已退出本机账号，尚未确认 ChatGPT 已撤销授权。请在 ChatGPT 使用量设置中断开 NekroNXT。')
      }
    } catch (cause) {
      failure(cause)
    } finally {
      setBusy(false)
    }
  }
  const login = async (accountId?: string) => {
    setBusy(true)
    setError('')
    try {
      const result = await callHostApi(HostApiContracts.chatGptLogin, {}, accountId ? { accountId } : {})
      window.open(result.authorizeUrl, '_blank', 'noopener,noreferrer')
      await update()
    } catch (cause) {
      failure(cause)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    let alive = true
    void callHostApi(HostApiContracts.chatGptStatus, {}, undefined)
      .then((next) => {
        if (alive) {
          handled.current =
            next.login?.status === 'waiting' || next.login?.status === 'exchanging' ? undefined : next.login?.id
          setStatus(next)
          setChosen(next.activeId ?? next.accounts[0]?.id ?? '')
        }
      })
      .catch((cause: unknown) => {
        if (alive) failure(cause)
      })
    return () => {
      alive = false
    }
  }, [])
  useEffect(() => {
    if (!waiting) return
    let running = false
    const timer = window.setInterval(() => {
      if (running) return
      running = true
      void update()
        .catch(failure)
        .finally(() => {
          running = false
        })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [waiting])
  useEffect(() => {
    const login = status?.login
    if (!login || handled.current === login.id || (login.status !== 'completed' && login.status !== 'failed')) return
    handled.current = login.id
    if (login.status === 'failed') {
      setError(login.message ?? 'ChatGPT 登录失败，请重试。')
      return
    }
    setChosen(status.activeId ?? '')
    void refreshProviders().catch(failure)
    if (status.accounts.find((account) => account.id === status.activeId)?.planEnabled) {
      void action({ action: 'refresh-models' })
    }
  }, [status])

  return (
    <div className={styles.detail}>
      <ObjectHeader
        level={2}
        size="compact"
        title="ChatGPT"
        status={<Chip tone={active?.planEnabled ? 'ok' : 'neutral'}>{active?.signedIn ? '已登录' : '未登录'}</Chip>}
      />
      {error ? <Banner tone="bad">{error}</Banner> : null}
      <PropertyGroup
        title="ChatGPT 账号"
        description="在 NekroNXT 中使用获准的 ChatGPT 套餐额度。"
        tip="请在运行 NekroNXT 的电脑上完成浏览器登录。"
      >
        {status?.accounts.length ? (
          <Select
            aria-label="ChatGPT 账号"
            value={chosen}
            onValueChange={setChosen}
            options={status.accounts.map((account) => ({
              value: account.id,
              label: `${account.label}${account.email ? ` · ${account.email}` : ''}${account.id === status.activeId ? ' · 正在使用' : account.signedIn ? '' : ' · 已退出'}`,
            }))}
          />
        ) : null}
        <div className={styles.actionBarStart}>
          <Button
            disabled={busy || waiting || !local}
            onClick={() => void login()}
            icon={
              <>
                <img
                  className={styles.chatGptLogoDark}
                  src="/vendor/chatgpt-logo-black.svg"
                  width={21}
                  height={21}
                  alt=""
                />
                <img
                  className={styles.chatGptLogoLight}
                  src="/vendor/chatgpt-logo-white.svg"
                  width={21}
                  height={21}
                  alt=""
                />
              </>
            }
          >
            Continue with ChatGPT
          </Button>
          {chosen ? (
            <>
              <Button disabled={busy || waiting || !local} onClick={() => void login(chosen)}>
                重新登录
              </Button>
              {chosen !== status?.activeId && status?.accounts.find((account) => account.id === chosen)?.signedIn ? (
                <Button disabled={busy || waiting} onClick={() => void action({ action: 'select', accountId: chosen })}>
                  使用此账号
                </Button>
              ) : null}
              {status?.accounts.find((account) => account.id === chosen)?.signedIn ? (
                <Button disabled={busy || waiting} onClick={() => void action({ action: 'logout', accountId: chosen })}>
                  退出此账号
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
        {!local ? (
          <Banner>请在运行 NekroNXT 的电脑上登录 ChatGPT。远程服务的凭据传入方式见 Server 文档。</Banner>
        ) : null}
        {waiting ? (
          <Banner>
            正在等待 ChatGPT 授权。
            <Button
              size="small"
              variant="ghost"
              disabled={busy || status?.login?.status === 'exchanging'}
              onClick={() => void action({ action: 'cancel' })}
            >
              取消登录
            </Button>
          </Banner>
        ) : null}
        {active?.signedIn && !active.planEnabled ? (
          <Banner tone="warn">此账号尚未允许使用 ChatGPT 套餐额度。请在 ChatGPT 中允许后重新登录。</Banner>
        ) : null}
      </PropertyGroup>
      <PropertyGroup
        title="模型"
        actions={
          <Button
            size="small"
            disabled={busy || waiting || !active?.planEnabled}
            onClick={() => void action({ action: 'refresh-models' })}
          >
            获取可用模型
          </Button>
        }
      >
        {status?.models.length ? (
          <ModelListView models={status.models} />
        ) : (
          <p>
            {active?.planEnabled
              ? '此账号还没有可用模型，请获取模型列表。'
              : '登录并允许使用 ChatGPT 套餐后，获取此账号可用的模型。'}
          </p>
        )}
        {status?.models[0] ? (
          <div className={styles.actionBarStart}>
            <Button
              disabled={busy || waiting || !active?.planEnabled}
              onClick={() => {
                setBusy(true)
                setError('')
                void callHostApi(
                  HostApiContracts.llmTestProvider,
                  {},
                  { provider: 'chatgpt', model: status.models[0]!.id },
                )
                  .then(() => toast('ChatGPT 连接测试通过。'))
                  .catch(failure)
                  .finally(() => setBusy(false))
              }}
            >
              测试连接
            </Button>
          </div>
        ) : null}
      </PropertyGroup>
      <PropertyGroup title="使用量" description={active?.planEnabled ? '当前使用 ChatGPT 套餐。' : undefined}>
        <div className={styles.actionBarStart}>
          <Button onClick={() => window.open('https://chatgpt.com/settings/usage', '_blank', 'noopener,noreferrer')}>
            管理 ChatGPT 使用量
          </Button>
        </div>
      </PropertyGroup>
      <Dialog
        open={status?.welcome === true}
        onOpenChange={(open) => {
          if (!open) void action({ action: 'acknowledge' })
        }}
        title="正在使用 ChatGPT 套餐"
        actions={
          <Button variant="primary" disabled={busy} onClick={() => void action({ action: 'acknowledge' })}>
            知道了
          </Button>
        }
      >
        NekroNXT 的相关模型请求会使用此账号的 ChatGPT 套餐额度。你可以在 ChatGPT 使用量设置中调整额度和授权。
      </Dialog>
    </div>
  )
}
