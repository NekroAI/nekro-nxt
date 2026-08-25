import { Settings } from 'lucide-react'
import { useEffect, useState } from 'react'
import { LlmProviderSettings } from '../llm-settings.js'
import { DshExtensionSettings } from '../dsh-extension-settings.js'
import { InlineFeedback, PageHeader } from '../components/product-feedback.js'
import { notify } from '../components/notifications.js'
import { useProductStore, type ThemeChoice } from '../product-store.js'
import {
  Button,
  Field,
  Input,
  SecretInput,
  SelectField,
  StageCrossfade,
  StatusBadge,
  SwitchField,
} from '../ui-kit/index.js'
import { useUiPreferences, type ContrastChoice } from '../ui-preferences.js'
import { useSearchParams } from 'react-router-dom'
import { useNxtNavigate } from '../shell/nxt-link.js'
import { AboutPage } from './about-page.js'
import styles from './product-pages.module.css'

function SystemExtensionsPanel() {
  const adapters = useProductStore((state) => state.connectionAdapters)
  const navigate = useNxtNavigate()
  return (
    <section className={styles.settingsSection} data-settings-content="">
      <div className={styles.systemAdapterIntro}>
        <div className={styles.sectionHeading}>已安装适配器</div>
        <p className={styles.secondaryText}>接入聊天平台。前往「连接」添加账号。</p>
      </div>
      <div className={styles.systemAdapterGrid}>
        {adapters.map((adapter) => (
          <article className={styles.systemAdapterCard} key={adapter.key}>
            <header>
              <div className={styles.sectionHeading}>{adapter.displayName}</div>
              <StatusBadge tone="success">已安装</StatusBadge>
            </header>
            <p className={styles.secondaryText}>{adapter.description}</p>
            {adapter.userCreatable ? (
              <Button onClick={() => void navigate(`/connections?create=1&adapter=${encodeURIComponent(adapter.key)}`)}>
                添加账号
              </Button>
            ) : (
              <StatusBadge tone="info">当前设备托管</StatusBadge>
            )}
          </article>
        ))}
      </div>
    </section>
  )
}

function NotificationsPanel() {
  const settings = useProductStore((state) => state.notificationSettings)
  const [systemEnabled, setSystemEnabled] = useState(settings.system.enabled)
  const [enabled, setEnabled] = useState(settings.bark.enabled)
  const [serverUrl, setServerUrl] = useState(settings.bark.serverUrl)
  const [deviceKey, setDeviceKey] = useState('')
  const [clearDeviceKey, setClearDeviceKey] = useState(false)
  const [approvalEnabled, setApprovalEnabled] = useState(settings.events['dynamic-client-approval-requested'])
  const [pending, setPending] = useState<'save' | 'test-bark' | 'test-system' | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    setSystemEnabled(settings.system.enabled)
    setEnabled(settings.bark.enabled)
    setServerUrl(settings.bark.serverUrl)
    setDeviceKey('')
    setClearDeviceKey(false)
    setApprovalEnabled(settings.events['dynamic-client-approval-requested'])
  }, [settings])

  const save = async (): Promise<void> => {
    if (pending) return
    setPending('save')
    setError('')
    try {
      await useProductStore.getState().updateNotificationSettings({
        ...(settings.revision === undefined ? {} : { expectedRevision: settings.revision }),
        system: { enabled: systemEnabled },
        bark: {
          enabled,
          serverUrl,
          ...(deviceKey.trim() ? { deviceKey: deviceKey.trim() } : {}),
          ...(clearDeviceKey ? { clearDeviceKey: true } : {}),
        },
        events: { 'dynamic-client-approval-requested': approvalEnabled },
      })
      notify('通知设置已保存。', 'success', 'notification-settings-save')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(null)
    }
  }

  const test = async (): Promise<void> => {
    if (pending) return
    setPending('test-bark')
    setError('')
    try {
      await useProductStore.getState().testBarkNotification({
        serverUrl,
        ...(deviceKey.trim() ? { deviceKey: deviceKey.trim() } : {}),
      })
      notify('Bark 测试通知已发送。', 'success', 'notification-settings-test')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(null)
    }
  }

  const testSystem = async (): Promise<void> => {
    if (pending) return
    setPending('test-system')
    setError('')
    try {
      await useProductStore.getState().testSystemNotification()
      notify(
        '系统测试通知已发布；已连接且允许通知的 Desktop 客户端会收到它。',
        'success',
        'system-notification-settings-test',
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(null)
    }
  }

  const configured = settings.bark.deviceKeyConfigured && !clearDeviceKey
  const barkTestDisabled = pending !== null || clearDeviceKey || (!configured && !deviceKey.trim())
  return (
    <section className={styles.settingsSection} data-settings-content="">
      <div className={styles.settingsGroup}>
        <div className={styles.sectionHeading}>系统通知渠道</div>
        <InlineFeedback tone="info">
          Desktop 本地实例直接显示系统通知。服务器实例将通知实时转发给在线且已授权通知的 Desktop
          客户端，转发范围限于当前在线时段。
        </InlineFeedback>
        <SwitchField
          label="启用系统通知"
          description="通过可信 Desktop 客户端显示操作系统通知。"
          checked={systemEnabled}
          onCheckedChange={setSystemEnabled}
        />
        <Button
          loading={pending === 'test-system'}
          loadingLabel="正在发布…"
          disabled={pending !== null}
          onClick={() => void testSystem()}
        >
          发送系统测试通知
        </Button>
      </div>
      <div className={styles.settingsGroup}>
        <div className={styles.sectionHeading}>Bark 通知渠道</div>
        <InlineFeedback tone={configured ? 'info' : 'warning'}>
          {configured
            ? 'Device Key 已保存在本机凭据目录。输入新值将替换当前值。'
            : '填写 Bark Device Key，用于向你的设备推送通知。'}
        </InlineFeedback>
        <SwitchField
          label="启用 Bark 通知"
          description="推送范围由下方通知项目控制。"
          checked={enabled}
          onCheckedChange={setEnabled}
        />
        <Field label="服务地址" hint="默认使用 Bark 官方服务，也可以填写自建服务地址。">
          <Input value={serverUrl} onChange={(event) => setServerUrl(event.currentTarget.value)} />
        </Field>
        <Field label="Device Key" hint="只保存在本机凭据目录，不写入产品数据库。">
          <SecretInput
            value={deviceKey}
            placeholder={configured ? '输入新 Device Key（可选）' : '输入 Device Key'}
            onChange={(event) => {
              setDeviceKey(event.currentTarget.value)
              if (event.currentTarget.value) setClearDeviceKey(false)
            }}
          />
        </Field>
        {configured ? (
          <Button
            variant="ghost"
            disabled={pending !== null}
            onClick={() => {
              setClearDeviceKey(true)
              setEnabled(false)
              setDeviceKey('')
            }}
          >
            清除已保存的 Device Key
          </Button>
        ) : null}
        <div className={styles.notificationActions}>
          <Button
            loading={pending === 'test-bark'}
            loadingLabel="正在发送…"
            disabled={barkTestDisabled}
            onClick={() => void test()}
          >
            发送测试通知
          </Button>
        </div>
      </div>
      <div className={styles.settingsGroup}>
        <div className={styles.sectionHeading}>通知项目</div>
        <SwitchField
          label="扩展预览等待确认"
          description="智能体生成带界面的扩展并等待你确认预览时推送。"
          checked={approvalEnabled}
          onCheckedChange={setApprovalEnabled}
        />
        <Button
          variant="primary"
          loading={pending === 'save'}
          loadingLabel="正在保存…"
          disabled={pending !== null}
          onClick={() => void save()}
        >
          保存通知设置
        </Button>
        {error ? <InlineFeedback tone="error">{error}</InlineFeedback> : null}
      </div>
    </section>
  )
}

const isThemeChoice = (value: string): value is ThemeChoice => value === 'light' || value === 'dark'
const isContrastChoice = (value: string): value is ContrastChoice =>
  value === 'system' || value === 'standard' || value === 'more'

export function SettingsPage() {
  const productMetadata = useProductStore((state) => state.productMetadata)
  const [searchParams] = useSearchParams()
  const theme = useProductStore((state) => state.theme)
  const reducedMotion = useProductStore((state) => state.reducedMotion)
  const reducedTransparency = useUiPreferences((state) => state.appearance.reducedTransparency)
  const contrast = useUiPreferences((state) => state.appearance.contrast)
  const inspectorCollapsed = useUiPreferences((state) => state.layout.inspectorCollapsed)
  const requestedTab = searchParams.get('tab')
  const activeTab =
    requestedTab === 'appearance' ||
    requestedTab === 'notifications' ||
    requestedTab === 'dsh-extensions' ||
    requestedTab === 'system-extensions' ||
    requestedTab === 'about'
      ? requestedTab
      : 'models'
  const title =
    activeTab === 'appearance'
      ? '外观'
      : activeTab === 'notifications'
        ? '通知'
        : activeTab === 'dsh-extensions'
          ? 'DSH 扩展'
          : activeTab === 'system-extensions'
            ? '系统扩展'
            : activeTab === 'about'
              ? '关于'
              : '模型供应商'

  return (
    <div className={[styles.page, styles.desktopPage, styles.settingsPage].join(' ')} data-product-page="settings">
      <PageHeader icon={Settings} title={title} quiet />
      <StageCrossfade className={styles.desktopContentStage} swapKey={activeTab}>
        {activeTab === 'models' ? <LlmProviderSettings /> : null}
        {activeTab === 'dsh-extensions' ? <DshExtensionSettings /> : null}
        {activeTab === 'system-extensions' ? <SystemExtensionsPanel /> : null}
        {activeTab === 'notifications' ? <NotificationsPanel /> : null}
        {activeTab === 'about' ? <AboutPage metadata={productMetadata} /> : null}
        {activeTab === 'appearance' ? (
          <section className={styles.settingsSection} data-settings-content="">
            <div className={styles.appearanceSignature} aria-label="月潮观测所品牌主题">
              <img src="/brand/mark.svg" alt="" aria-hidden="true" />
              <div>
                <strong>月潮观测所</strong>
                <small>月潮靛构成稳定工作面，流明蓝标记焦点，黄铜节点标记校准。</small>
              </div>
              <span className={styles.appearanceSwatches} aria-hidden="true">
                <i data-tone="moon" />
                <i data-tone="lumen" />
                <i data-tone="brass" />
              </span>
            </div>
            <div className={styles.settingsGroup}>
              <div className={styles.sectionHeading}>主题与可读性</div>
              <SelectField
                label="主题"
                value={theme}
                onValueChange={(value) => {
                  if (isThemeChoice(value)) useProductStore.getState().setTheme(value)
                }}
                options={[
                  { value: 'light', label: '浅色' },
                  { value: 'dark', label: '深色' },
                ]}
              />
              <SwitchField
                label="减少动态效果"
                description="关闭页面衔接、选中块滑动和对话框过渡。"
                checked={reducedMotion}
                onCheckedChange={(enabled) => useProductStore.getState().setReducedMotion(enabled)}
              />
              <SwitchField
                label="减少透明效果"
                description="将浮层、侧栏和状态背景改为更明确的实色与边框。"
                checked={reducedTransparency}
                onCheckedChange={(enabled) => useUiPreferences.getState().setReducedTransparency(enabled)}
              />
              <SelectField
                label="对比度"
                value={contrast}
                onValueChange={(value) => {
                  if (isContrastChoice(value)) useUiPreferences.getState().setContrast(value)
                }}
                options={[
                  { value: 'system', label: '跟随系统' },
                  { value: 'standard', label: '标准' },
                  { value: 'more', label: '更高对比度' },
                ]}
              />
            </div>
            <div className={styles.settingsGroup}>
              <div className={styles.sectionHeading}>工作区布局</div>
              <SwitchField
                label="默认隐藏检查器"
                description="打开频道或智能体工作台时优先显示主画布；主画布右边缘的检查器按钮可随时重新展开。"
                checked={inspectorCollapsed}
                onCheckedChange={(enabled) => useUiPreferences.getState().setInspectorCollapsed(enabled)}
              />
              <Button onClick={() => useUiPreferences.getState().resetLayout()}>恢复默认分栏</Button>
            </div>
          </section>
        ) : null}
      </StageCrossfade>
    </div>
  )
}
