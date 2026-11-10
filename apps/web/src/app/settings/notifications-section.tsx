import { useCallback, useEffect, useState } from 'react'
import { HostApiContracts, type HostApiResponse } from '@nekro-nxt/contracts'
import { callHostApi } from '../../host-api-client.js'
import { useProductStore } from '../../product-runtime.js'
import {
  Button,
  Chip,
  Field,
  Input,
  PropertyGroup,
  PropertyList,
  PropertyRow,
  SaveBar,
  SecretInput,
  Skeleton,
  Switch,
  toast,
} from '../../ui-kit/index.js'
import {
  disablePush,
  enablePush,
  pushSubscriptionId,
  readPushState,
  registerPushWorker,
  type PushState,
} from '../../web-push.js'
import { relativeTime } from '../channels/timeline-model.js'
import { useProductApi } from '../model/store.js'
import { useManagementAccessAvailable } from './access-section.js'
import { SectionHead } from './section-head.js'
import styles from './settings.module.css'

const REMOTE_ACCESS_GUIDE = 'https://github.com/NekroAI/nekro-nxt/blob/main/docs/guide/server.md#通过反向代理使用-https'

export function NotificationsSection() {
  const api = useProductApi()
  const settings = useProductStore((state) => state.notificationSettings)
  const hostStatus = useProductStore((state) => state.host.status)
  const signedIn = useManagementAccessAvailable()
  const [system, setSystem] = useState(settings.system.enabled)
  const [browserPush, setBrowserPush] = useState(settings.browserPush.enabled)
  const [bark, setBark] = useState(settings.bark.enabled)
  const [serverUrl, setServerUrl] = useState(settings.bark.serverUrl)
  const [deviceKey, setDeviceKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [wecom, setWecom] = useState(settings.wecom.enabled)
  const [webhookUrl, setWebhookUrl] = useState('')
  const [clearWebhook, setClearWebhook] = useState(false)
  const [ntfy, setNtfy] = useState(settings.ntfy.enabled)
  const [ntfyServerUrl, setNtfyServerUrl] = useState(settings.ntfy.serverUrl)
  const [ntfyTopic, setNtfyTopic] = useState('')
  const [ntfyToken, setNtfyToken] = useState('')
  const [clearNtfyToken, setClearNtfyToken] = useState(false)
  const [approval, setApproval] = useState(settings.events['dynamic-client-approval-requested'] ?? true)
  const [feedback, setFeedback] = useState(settings.events['community-feedback-update'])
  const [credentialRequested, setCredentialRequested] = useState(settings.events['credential-requested'])
  const [extensionNotices, setExtensionNotices] = useState(settings.events['extension-notification'])
  const [busy, setBusy] = useState<'' | 'save' | 'bark' | 'system' | 'wecom' | 'ntfy'>('')
  const [saveError, setSaveError] = useState('')

  const reset = () => {
    setSystem(settings.system.enabled)
    setBrowserPush(settings.browserPush.enabled)
    setBark(settings.bark.enabled)
    setServerUrl(settings.bark.serverUrl)
    setDeviceKey('')
    setClearKey(false)
    setWecom(settings.wecom.enabled)
    setWebhookUrl('')
    setClearWebhook(false)
    setNtfy(settings.ntfy.enabled)
    setNtfyServerUrl(settings.ntfy.serverUrl)
    setNtfyTopic('')
    setNtfyToken('')
    setClearNtfyToken(false)
    setApproval(settings.events['dynamic-client-approval-requested'] ?? true)
    setFeedback(settings.events['community-feedback-update'])
    setCredentialRequested(settings.events['credential-requested'])
    setExtensionNotices(settings.events['extension-notification'])
    setSaveError('')
  }
  // Saved settings changed (here or elsewhere): show them. Keyed by content, so a refresh that returns the same
  // saved values never discards what the user is editing.
  const savedKey = JSON.stringify(settings)
  useEffect(reset, [savedKey])

  const configured = settings.bark.deviceKeyConfigured && !clearKey
  const barkTestable = !clearKey && (configured || deviceKey.trim() !== '')
  const webhookConfigured = settings.wecom.webhookConfigured && !clearWebhook
  const wecomTestable = !clearWebhook && (webhookConfigured || webhookUrl.trim() !== '')
  const ntfyTokenConfigured = settings.ntfy.tokenConfigured && !clearNtfyToken
  const ntfyTestable = settings.ntfy.topicConfigured || ntfyTopic.trim() !== ''
  const changes = [
    ...(system !== settings.system.enabled ? ['系统通知'] : []),
    ...(browserPush !== settings.browserPush.enabled ? ['浏览器推送'] : []),
    ...(bark !== settings.bark.enabled || serverUrl !== settings.bark.serverUrl || deviceKey.trim() !== '' || clearKey
      ? ['Bark']
      : []),
    ...(wecom !== settings.wecom.enabled || webhookUrl.trim() !== '' || clearWebhook ? ['企业微信'] : []),
    ...(ntfy !== settings.ntfy.enabled ||
    ntfyServerUrl !== settings.ntfy.serverUrl ||
    ntfyTopic.trim() !== '' ||
    ntfyToken.trim() !== '' ||
    clearNtfyToken
      ? ['ntfy']
      : []),
    ...(approval !== (settings.events['dynamic-client-approval-requested'] ?? true) ? ['通知事件'] : []),
    ...(feedback !== settings.events['community-feedback-update'] ? ['社区反馈更新'] : []),
    ...(credentialRequested !== settings.events['credential-requested'] ? ['凭据申请'] : []),
    ...(extensionNotices !== settings.events['extension-notification'] ? ['扩展通知'] : []),
  ]

  const run = async (kind: Exclude<typeof busy, ''>, action: () => Promise<unknown>, done: string) => {
    setBusy(kind)
    try {
      await action()
      toast(done)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (kind === 'save') setSaveError(message)
      else toast(message, { tone: 'bad' })
    } finally {
      setBusy('')
    }
  }

  const save = () =>
    void run(
      'save',
      () =>
        api.getState().updateNotificationSettings({
          ...(settings.revision === undefined ? {} : { expectedRevision: settings.revision }),
          system: { enabled: system },
          bark: {
            enabled: bark,
            serverUrl,
            ...(deviceKey.trim() ? { deviceKey: deviceKey.trim() } : {}),
            ...(clearKey ? { clearDeviceKey: true } : {}),
          },
          browserPush: { enabled: browserPush },
          wecom: {
            enabled: wecom,
            ...(webhookUrl.trim() ? { webhookUrl: webhookUrl.trim() } : {}),
            ...(clearWebhook ? { clearWebhookUrl: true } : {}),
          },
          ntfy: {
            enabled: ntfy,
            serverUrl: ntfyServerUrl,
            ...(ntfyTopic.trim() ? { topic: ntfyTopic.trim() } : {}),
            ...(ntfyToken.trim() ? { token: ntfyToken.trim() } : {}),
            ...(clearNtfyToken ? { clearToken: true } : {}),
          },
          events: {
            'dynamic-client-approval-requested': approval,
            'community-feedback-update': feedback,
            'credential-requested': credentialRequested,
            'extension-notification': extensionNotices,
          },
        }),
      '通知设置已保存',
    )

  // Until the first snapshot the store holds placeholder defaults; never present them as the saved settings.
  if (hostStatus === 'initializing') {
    return (
      <>
        <SectionHead title="通知" />
        <div className={styles.loading} role="status" aria-label="正在读取通知设置">
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      </>
    )
  }

  const testButton = (kind: 'bark' | 'wecom' | 'ntfy' | 'system', enabled: boolean, action: () => Promise<unknown>) => (
    <Button
      size="small"
      variant="ghost"
      busy={busy === kind}
      disabled={busy !== '' || !enabled}
      onClick={() => void run(kind, action, '测试通知已发出')}
    >
      测试
    </Button>
  )

  return (
    <>
      <SectionHead title="通知" />
      <PropertyGroup title="渠道">
        <PropertyList>
          <PropertyRow label="系统通知" tip="在桌面版上弹出">
            <span className={styles.rowControls}>
              {testButton('system', true, () => api.getState().testSystemNotification())}
              <Switch label="系统通知" checked={system} onCheckedChange={setSystem} />
            </span>
          </PropertyRow>
          <PropertyRow label="浏览器推送" tip="推送到开启了推送的手机和电脑浏览器，在下方「浏览器推送」里按设备开启">
            <Switch label="浏览器推送" checked={browserPush} onCheckedChange={setBrowserPush} />
          </PropertyRow>
          <PropertyRow label="Bark" tip="推送到安装了 Bark 的设备">
            <span className={styles.rowControls}>
              {testButton('bark', barkTestable, () =>
                api.getState().testBarkNotification({
                  serverUrl,
                  ...(deviceKey.trim() ? { deviceKey: deviceKey.trim() } : {}),
                }),
              )}
              <Switch label="Bark" checked={bark} onCheckedChange={setBark} />
            </span>
          </PropertyRow>
          <PropertyRow label="Bark 连接" layout="stacked" depth={1}>
            <div className={styles.channelFields}>
              <Field label="服务地址">
                <Input value={serverUrl} spellCheck={false} onChange={(event) => setServerUrl(event.target.value)} />
              </Field>
              <Field label="Device Key">
                <SecretInput
                  configured={configured}
                  value={deviceKey}
                  onChange={(event) => {
                    setDeviceKey(event.target.value)
                    if (event.target.value) setClearKey(false)
                  }}
                />
              </Field>
              {configured ? (
                <div className={styles.channelFieldAction}>
                  <Button
                    size="small"
                    variant="ghost"
                    onClick={() => {
                      setClearKey(true)
                      setBark(false)
                      setDeviceKey('')
                    }}
                  >
                    清除已保存的 Key
                  </Button>
                </div>
              ) : null}
            </div>
          </PropertyRow>
          <PropertyRow label="企业微信" tip="通过群机器人发到企业微信群">
            <span className={styles.rowControls}>
              {testButton('wecom', wecomTestable, () =>
                api.getState().testWecomNotification(webhookUrl.trim() ? { webhookUrl: webhookUrl.trim() } : {}),
              )}
              <Switch label="企业微信" checked={wecom} onCheckedChange={setWecom} />
            </span>
          </PropertyRow>
          <PropertyRow label="企业微信连接" layout="stacked" depth={1}>
            <div className={styles.channelFields}>
              <Field label="Webhook 地址" hint="在群里添加机器人后复制">
                <SecretInput
                  configured={webhookConfigured}
                  value={webhookUrl}
                  onChange={(event) => {
                    setWebhookUrl(event.target.value)
                    if (event.target.value) setClearWebhook(false)
                  }}
                />
              </Field>
              {webhookConfigured ? (
                <div className={styles.channelFieldAction}>
                  <Button
                    size="small"
                    variant="ghost"
                    onClick={() => {
                      setClearWebhook(true)
                      setWecom(false)
                      setWebhookUrl('')
                    }}
                  >
                    清除已保存的地址
                  </Button>
                </div>
              ) : null}
            </div>
          </PropertyRow>
          <PropertyRow label="ntfy" tip="推送到安装了 ntfy 并订阅了这个主题的手机，可以使用自己搭建的 ntfy 服务">
            <span className={styles.rowControls}>
              {testButton('ntfy', ntfyTestable, () =>
                api.getState().testNtfyNotification({
                  serverUrl: ntfyServerUrl,
                  ...(ntfyTopic.trim() ? { topic: ntfyTopic.trim() } : {}),
                  ...(ntfyToken.trim() ? { token: ntfyToken.trim() } : {}),
                }),
              )}
              <Switch label="ntfy" checked={ntfy} onCheckedChange={setNtfy} />
            </span>
          </PropertyRow>
          <PropertyRow label="ntfy 连接" layout="stacked" depth={1}>
            <div className={styles.channelFields}>
              <Field label="服务地址">
                <Input
                  value={ntfyServerUrl}
                  spellCheck={false}
                  onChange={(event) => setNtfyServerUrl(event.target.value)}
                />
              </Field>
              <Field label="主题" hint="用别人猜不到的名字">
                <SecretInput
                  configured={settings.ntfy.topicConfigured}
                  value={ntfyTopic}
                  onChange={(event) => setNtfyTopic(event.target.value)}
                />
              </Field>
              <Field label="访问令牌" hint="服务开启了访问控制时填写">
                <SecretInput
                  configured={ntfyTokenConfigured}
                  value={ntfyToken}
                  onChange={(event) => {
                    setNtfyToken(event.target.value)
                    if (event.target.value) setClearNtfyToken(false)
                  }}
                />
              </Field>
              {ntfyTokenConfigured ? (
                <div className={styles.channelFieldAction}>
                  <Button
                    size="small"
                    variant="ghost"
                    onClick={() => {
                      setClearNtfyToken(true)
                      setNtfyToken('')
                    }}
                  >
                    清除已保存的令牌
                  </Button>
                </div>
              ) : null}
            </div>
          </PropertyRow>
        </PropertyList>
      </PropertyGroup>
      {signedIn && window.nekroDesktopShell === undefined ? <BrowserPushGroup /> : null}
      <PropertyGroup title="通知我">
        <PropertyList>
          <PropertyRow label="创造任务等待确认运行" tip="智能体写好带界面的候选，需要你允许运行时">
            <Switch label="创造任务等待确认运行" checked={approval} onCheckedChange={setApproval} />
          </PropertyRow>
          <PropertyRow label="社区反馈更新" tip="反馈等待确认、收到回复或处理状态有变化时">
            <Switch label="社区反馈更新" checked={feedback} onCheckedChange={setFeedback} />
          </PropertyRow>
          <PropertyRow label="凭据申请" tip="智能体需要的凭据还没有添加时">
            <Switch label="凭据申请" checked={credentialRequested} onCheckedChange={setCredentialRequested} />
          </PropertyRow>
          <PropertyRow label="扩展通知" tip="扩展发出的提醒">
            <Switch label="扩展通知" checked={extensionNotices} onCheckedChange={setExtensionNotices} />
          </PropertyRow>
        </PropertyList>
      </PropertyGroup>
      <SaveBar
        changes={changes}
        busy={busy === 'save'}
        error={saveError || undefined}
        onSave={save}
        onDiscard={reset}
      />
    </>
  )
}

type Subscriptions = HostApiResponse<'listPushSubscriptions'>

const STATE_TEXT: Record<PushState, string> = {
  insecure: '推送需要通过受信任证书的 HTTPS 访问，现在的连接不满足。',
  'needs-install': '在 iPhone 或 iPad 上，先在 Safari 的分享菜单里选「添加到主屏幕」，再从主屏幕打开 NekroNXT 开启。',
  unsupported: '这个浏览器不支持推送。',
  denied: '通知权限被拒绝了。在浏览器或系统设置里允许 NekroNXT 发送通知后，回到这里开启。',
  off: '开启后，这台设备会收到通知。',
  on: '已开启。',
}

/** This device's push switch and every subscribed browser; changes apply right away, outside the save bar. */
function BrowserPushGroup() {
  const [listed, setListed] = useState<Subscriptions>()
  const [state, setState] = useState<PushState>()
  const [mine, setMine] = useState<string>()
  const [busy, setBusy] = useState('')

  const refresh = useCallback(async () => {
    const next = await callHostApi(HostApiContracts.listPushSubscriptions, {}, undefined)
    setListed(next)
    setState(await readPushState(new Set(next.subscriptions.map((entry) => entry.id))))
    const endpoint = (await (await registerPushWorker())?.pushManager.getSubscription())?.endpoint
    setMine(endpoint === undefined ? undefined : await pushSubscriptionId(endpoint))
  }, [])

  useEffect(() => {
    refresh().catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'bad' }))
  }, [refresh])

  const act = async (key: string, action: () => Promise<unknown>, done: string) => {
    setBusy(key)
    try {
      await action()
      toast(done)
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
    } finally {
      setBusy('')
      await refresh().catch(() => undefined)
    }
  }

  const test = (id: string) =>
    act(
      `test:${id}`,
      () => callHostApi(HostApiContracts.testPushSubscription, { subscriptionId: id }, undefined),
      '测试通知已发出',
    )

  return (
    <PropertyGroup title="浏览器推送">
      <PropertyList>
        <PropertyRow
          label="这台设备"
          description={
            state === undefined ? (
              '正在检查…'
            ) : state === 'insecure' ? (
              <>
                {STATE_TEXT.insecure}
                <a className={styles.source} href={REMOTE_ACCESS_GUIDE} target="_blank" rel="noreferrer">
                  配置 HTTPS 访问
                </a>
              </>
            ) : (
              STATE_TEXT[state]
            )
          }
        >
          {state === 'off' ? (
            <Button
              size="small"
              busy={busy === 'enable'}
              disabled={busy !== ''}
              onClick={() => void act('enable', enablePush, '推送已开启')}
            >
              开启
            </Button>
          ) : state === 'on' ? (
            <span className={styles.rowControls}>
              {mine === undefined ? null : (
                <Button
                  size="small"
                  variant="ghost"
                  busy={busy === `test:${mine}`}
                  disabled={busy !== ''}
                  onClick={() => void test(mine)}
                >
                  测试
                </Button>
              )}
              <Button
                size="small"
                variant="ghost"
                busy={busy === 'disable'}
                disabled={busy !== ''}
                onClick={() => void act('disable', disablePush, '推送已关闭')}
              >
                关闭
              </Button>
            </span>
          ) : null}
        </PropertyRow>
        {listed?.subscriptions
          .filter((entry) => entry.id !== mine)
          .map((entry) => (
            <PropertyRow
              key={entry.id}
              label={entry.label}
              badge={entry.deviceId === listed.currentDeviceId ? <Chip>此设备</Chip> : undefined}
              description={`${entry.deviceLabel}，${entry.lastDeliveredAt === undefined ? '还没有送达过' : `最近送达 ${relativeTime(entry.lastDeliveredAt)}`}`}
            >
              <span className={styles.rowControls}>
                <Button
                  size="small"
                  variant="ghost"
                  busy={busy === `test:${entry.id}`}
                  disabled={busy !== ''}
                  onClick={() => void test(entry.id)}
                >
                  测试
                </Button>
                <Button
                  size="small"
                  variant="ghost"
                  busy={busy === `remove:${entry.id}`}
                  disabled={busy !== ''}
                  onClick={() =>
                    void act(
                      `remove:${entry.id}`,
                      () =>
                        callHostApi(HostApiContracts.deletePushSubscription, { subscriptionId: entry.id }, undefined),
                      '订阅已移除',
                    )
                  }
                >
                  移除
                </Button>
              </span>
            </PropertyRow>
          ))}
      </PropertyList>
    </PropertyGroup>
  )
}
