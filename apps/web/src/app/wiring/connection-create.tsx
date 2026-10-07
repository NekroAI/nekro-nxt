import { ArrowLeft, ChevronRight, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { AdapterConnectionDescriptor } from '@nekro-nxt/adapter-sdk'
import type { HostApiResponse } from '@nekro-nxt/contracts'
import {
  ConfigForm,
  PanelSlot,
  configDefaults,
  configIssues,
  secretIssues,
  type ConfigValue,
} from '../../extension-ui/index.js'
import { useProductStore } from '../../product-runtime.js'
import { createQrCodeSvgDataUrl } from '../../qr-code.js'
import {
  Banner,
  Button,
  Input,
  Pressable,
  PropertyGroup,
  PropertyList,
  PropertyRow,
  ReaderPage,
  Spinner,
  toast,
} from '../../ui-kit/index.js'
import { useGo } from '../model/nav.js'
import { useProductApi } from '../model/store.js'
import styles from './wiring.module.css'

type Descriptor = AdapterConnectionDescriptor
type Login = HostApiResponse<'startConnectionLogin'> | HostApiResponse<'getConnectionLogin'>
const loginActive = (login: Login | undefined): boolean => login?.status === 'pending' || login?.status === 'scanned'

/**
 * Adds a platform account (or re-authenticates one with `reauth`): choose a platform, then fill its form or scan its
 * login code. Archived connections can be restored instead.
 */
export function ConnectionCreate() {
  const [params, setParams] = useSearchParams()
  const go = useGo()
  const adapters = useProductStore((state) => state.connectionAdapters)
  const archived = useProductStore((state) => state.archivedConnections)
  const api = useProductApi()
  const creatable = adapters.filter((adapter) => adapter.provisioning === 'user-created')
  const adapter = creatable.find((item) => item.key === params.get('adapter'))
  const reauth = params.get('reauth') ?? undefined

  const choose = (key: string | undefined) => {
    const next = new URLSearchParams(params)
    if (key) next.set('adapter', key)
    else next.delete('adapter')
    next.delete('reauth')
    setParams(next, { replace: true })
  }

  const title = reauth
    ? `重新登录${adapter?.displayName ?? ''}`
    : adapter
      ? `添加${adapter.displayName}账号`
      : '添加平台账号'

  return (
    <ReaderPage
      title={title}
      actions={
        reauth ? undefined : (
          <Button
            variant="ghost"
            size="small"
            icon={<ArrowLeft size={14} />}
            onClick={() => (adapter ? choose(undefined) : go('/wiring'))}
          >
            {adapter ? '换一个平台' : '返回接线'}
          </Button>
        )
      }
    >
      {!adapter ? (
        <>
          <PropertyGroup title="选择平台">
            <PropertyList>
              {creatable.map((item) => (
                <Pressable key={item.key} className={styles.platform} onClick={() => choose(item.key)}>
                  <span className={styles.platformText}>
                    <b>{item.displayName}</b>
                    <span>{item.description}</span>
                  </span>
                  <ChevronRight size={16} aria-hidden="true" />
                </Pressable>
              ))}
            </PropertyList>
          </PropertyGroup>
          {archived.length > 0 ? (
            <PropertyGroup title="恢复已移除的账号" description="频道和消息仍保留，恢复后继续使用">
              <PropertyList>
                {archived.map((connection) => (
                  <PropertyRow
                    key={connection.id}
                    label={connection.alias?.trim() || connection.adapter}
                    description={`保留了 ${connection.channelCount} 个频道`}
                  >
                    <Button
                      size="small"
                      icon={<RotateCcw size={14} />}
                      onClick={() =>
                        void api
                          .getState()
                          .restoreConnection(connection.id)
                          .then(() => {
                            toast('账号已恢复')
                            go(`/wiring/connections/${connection.id}`)
                          })
                          .catch((error: unknown) =>
                            toast(error instanceof Error ? error.message : String(error), { tone: 'bad' }),
                          )
                      }
                    >
                      恢复
                    </Button>
                  </PropertyRow>
                ))}
              </PropertyList>
            </PropertyGroup>
          ) : null}
        </>
      ) : adapter.creation?.mode === 'qr-login' ? (
        <QrLogin key={`${adapter.key}:${reauth ?? ''}`} adapter={adapter} reauth={reauth} />
      ) : (
        <SchemaForm key={adapter.key} adapter={adapter} />
      )}
    </ReaderPage>
  )
}

/** The optional account name shared by both creation modes. */
function AliasRow({
  adapter,
  value,
  onChange,
}: {
  readonly adapter: Descriptor
  readonly value: string
  readonly onChange: (value: string) => void
}) {
  return (
    <PropertyRow label="名称" tip="可选，用来区分同一平台的多个账号" layout="stacked" htmlFor="connection-alias">
      <Input
        id="connection-alias"
        value={value}
        maxLength={80}
        placeholder={adapter.displayName}
        onChange={(event) => onChange(event.target.value)}
      />
    </PropertyRow>
  )
}

function SchemaForm({ adapter }: { readonly adapter: Descriptor }) {
  const api = useProductApi()
  const go = useGo()
  const [alias, setAlias] = useState('')
  const [values, setValues] = useState<ConfigValue>(() => configDefaults(adapter.configSchema))
  const [secrets, setSecrets] = useState<Readonly<Record<string, string>>>({})
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const create = async () => {
    setSubmitted(true)
    const invalid =
      Object.keys(configIssues(adapter.configSchema, values)).length > 0 ||
      Object.keys(secretIssues(adapter.configSchema, secrets)).length > 0
    if (invalid) return
    setBusy(true)
    setError('')
    try {
      const { connectionId } = await api
        .getState()
        .createConnection({ adapterKey: adapter.key, alias, configuration: values, credentials: secrets })
      toast('账号已添加')
      go(`/wiring/connections/${connectionId}`)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PropertyGroup title="账号">
        <PropertyList>
          <AliasRow adapter={adapter} value={alias} onChange={setAlias} />
        </PropertyList>
      </PropertyGroup>
      <PropertyGroup title="连接信息">
        <PanelSlot anchor={{ kind: 'connection', id: adapter.key }} density="full" role="setup" />
        <div className={styles.configForm}>
          <ConfigForm
            schema={adapter.configSchema}
            value={values}
            onChange={setValues}
            secrets={{ value: secrets, onChange: setSecrets }}
            showIssues={submitted}
            disabled={busy}
          />
        </div>
      </PropertyGroup>
      {error ? <Banner tone="bad">{error}</Banner> : null}
      <div className={styles.formActions}>
        <Button onClick={() => go('/wiring')} disabled={busy}>
          取消
        </Button>
        <Button variant="primary" busy={busy} onClick={() => void create()}>
          添加账号
        </Button>
      </div>
    </>
  )
}

function QrLogin({ adapter, reauth }: { readonly adapter: Descriptor; readonly reauth: string | undefined }) {
  const api = useProductApi()
  const go = useGo()
  const [alias, setAlias] = useState('')
  const [login, setLogin] = useState<Login>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const active = loginActive(login)
  const loginRef = useRef(login)
  loginRef.current = login

  const finish = (connectionId: string | undefined) => {
    toast(reauth ? '已重新登录' : '账号已添加')
    go(connectionId ? `/wiring/connections/${connectionId}` : '/wiring')
  }

  const start = async () => {
    setBusy(true)
    setError('')
    try {
      const next = await api
        .getState()
        .startConnectionLogin({ adapterKey: adapter.key, ...(reauth ? { connectionId: reauth } : { alias }) })
      setLogin(next)
      if (next.status === 'confirmed') finish(reauth)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  // Poll the pending login until it settles.
  useEffect(() => {
    if (!login || !loginActive(login)) return
    const loginId = login.loginId
    const timer = window.setInterval(() => {
      void api
        .getState()
        .getConnectionLogin(loginId)
        .then((next) => {
          setLogin((current) => (current?.loginId === loginId ? next : current))
          if (next.status === 'confirmed') finish(next.connectionId ?? reauth)
        })
        .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))
    }, 1500)
    return () => window.clearInterval(timer)
    // finish only reads stable values for this login.
  }, [login?.loginId, login?.status])

  // Leaving the page cancels a login that is still waiting for a scan.
  useEffect(
    () => () => {
      const current = loginRef.current
      if (current && loginActive(current))
        void api
          .getState()
          .cancelConnectionLogin(current.loginId)
          .catch(() => undefined)
    },
    [api],
  )

  const qr = login?.qrCodeUrl ? createQrCodeSvgDataUrl(login.qrCodeUrl) : ''
  const failed = login?.status === 'failed' || login?.status === 'expired' || login?.status === 'cancelled'

  return (
    <>
      {!login && !reauth ? (
        <PropertyGroup title="账号">
          <PropertyList>
            <AliasRow adapter={adapter} value={alias} onChange={setAlias} />
          </PropertyList>
        </PropertyGroup>
      ) : null}
      {login && qr ? (
        <div className={styles.qr} data-dim={!active}>
          <img src={qr} alt={`${adapter.displayName}登录二维码`} />
          <span>
            {login.status === 'scanned'
              ? '已扫码，请在手机上确认'
              : active
                ? `用${adapter.displayName}扫码登录`
                : (login.message ?? '二维码已失效')}
          </span>
          {active ? <Spinner /> : null}
        </div>
      ) : null}
      {error ? <Banner tone="bad">{error}</Banner> : null}
      <div className={styles.formActions}>
        <Button onClick={() => go(reauth ? `/wiring/connections/${reauth}` : '/wiring')}>取消</Button>
        {!active ? (
          <Button variant="primary" busy={busy} onClick={() => void start()}>
            {failed ? '重新获取二维码' : (adapter.creation?.actionLabel ?? '扫码登录')}
          </Button>
        ) : null}
      </div>
    </>
  )
}
