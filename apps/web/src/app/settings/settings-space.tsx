import { Bell, Blocks, Cpu, Info, Palette, Plug } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { DshExtensionSettings } from '../../dsh-extension-settings.js'
import { LlmProviderSettings } from '../../llm-settings.js'
import { useProductRuntime, useProductStore, useUiStateStore } from '../../product-runtime.js'
import {
  Button,
  Chip,
  Field,
  Input,
  Panel,
  Section,
  SecretInput,
  Segmented,
  SelectionList,
  SwitchRow,
  toast,
} from '../../ui-kit/next/index.js'
import { useProductApi } from '../model/store.js'
import { useGo } from '../model/nav.js'
import { useCrumb } from '../shell/crumb.js'
import styles from './settings.module.css'

const SECTIONS = [
  { key: 'models', label: '模型', icon: <Cpu size={16} /> },
  { key: 'adapters', label: '平台适配器', icon: <Plug size={16} /> },
  { key: 'dsh', label: 'DSH 插件', icon: <Blocks size={16} /> },
  { key: 'notifications', label: '通知', icon: <Bell size={16} /> },
  { key: 'appearance', label: '外观', icon: <Palette size={16} /> },
  { key: 'about', label: '关于', icon: <Info size={16} /> },
] as const

type SectionKey = (typeof SECTIONS)[number]['key']

const isSection = (value: string | undefined): value is SectionKey => SECTIONS.some((item) => item.key === value)

export default function SettingsSpace() {
  const { section } = useParams<{ section: string }>()
  const current = SECTIONS.find((item) => item.key === section)
  useCrumb('设置', current?.label)
  if (!isSection(section)) return <Navigate to="/settings/models" replace />

  return (
    <div className={styles.space}>
      <aside className={styles.list} aria-label="设置">
        <div className={styles.listHead}>
          <h2>设置</h2>
        </div>
        <div className={styles.listBody}>
          <SelectionList selectedKey={section}>
            {SECTIONS.map((item) => (
              <Link
                key={item.key}
                to={`/settings/${item.key}`}
                className={styles.row}
                data-selected={item.key === section}
                aria-current={item.key === section ? 'page' : undefined}
              >
                {item.icon}
                {item.label}
              </Link>
            ))}
          </SelectionList>
        </div>
      </aside>
      <div className={styles.page} key={section}>
        <div className={styles.body}>
          <h1 className={styles.title}>{current?.label}</h1>
          {section === 'models' ? <LlmProviderSettings /> : null}
          {section === 'adapters' ? <Adapters /> : null}
          {section === 'dsh' ? <DshExtensionSettings /> : null}
          {section === 'notifications' ? <Notifications /> : null}
          {section === 'appearance' ? <Appearance /> : null}
          {section === 'about' ? <About /> : null}
        </div>
      </div>
    </div>
  )
}

/** Installed platform adapters with their real source; adding an account happens in wiring. */
function Adapters() {
  const adapters = useProductStore((state) => state.connectionAdapters)
  const extensions = useProductStore((state) => state.extensions)
  const connections = useProductStore((state) => state.connections)
  const go = useGo()
  return (
    <div className={styles.cards}>
      {adapters.map((adapter) => {
        const source = extensions.find(
          (extension) =>
            extension.scope === 'host-adapter' &&
            extension.revisions.some((revision) => revision.contributions.includes(`适配器：${adapter.key}`)),
        )
        const accounts = connections.filter((connection) => connection.adapterKey === adapter.key).length
        return (
          <Panel key={adapter.key} className={styles.card}>
            <div className={styles.cardHead}>
              <b>{adapter.displayName}</b>
              {source ? (
                <Link to={`/workshop/extensions/${source.id}`} className={styles.source}>
                  本地扩展 · {source.name}
                </Link>
              ) : (
                <Chip>内置</Chip>
              )}
            </div>
            {adapter.description ? <p className={styles.cardText}>{adapter.description}</p> : null}
            <div className={styles.cardFoot}>
              {adapter.provisioning === 'user-created' ? (
                <>
                  <span className={styles.muted}>{accounts > 0 ? `${accounts} 个账号` : '还没有账号'}</span>
                  <Button size="small" onClick={() => go(`/wiring/new?adapter=${encodeURIComponent(adapter.key)}`)}>
                    添加账号
                  </Button>
                </>
              ) : (
                <span className={styles.muted}>由本机自动管理</span>
              )}
            </div>
          </Panel>
        )
      })}
    </div>
  )
}

function Notifications() {
  const api = useProductApi()
  const settings = useProductStore((state) => state.notificationSettings)
  const [system, setSystem] = useState(settings.system.enabled)
  const [bark, setBark] = useState(settings.bark.enabled)
  const [serverUrl, setServerUrl] = useState(settings.bark.serverUrl)
  const [deviceKey, setDeviceKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [approval, setApproval] = useState(settings.events['dynamic-client-approval-requested'] ?? true)
  const [busy, setBusy] = useState<'' | 'save' | 'bark' | 'system'>('')

  const reset = () => {
    setSystem(settings.system.enabled)
    setBark(settings.bark.enabled)
    setServerUrl(settings.bark.serverUrl)
    setDeviceKey('')
    setClearKey(false)
    setApproval(settings.events['dynamic-client-approval-requested'] ?? true)
  }
  // Saved settings changed (here or elsewhere): show them.
  useEffect(reset, [settings])

  const configured = settings.bark.deviceKeyConfigured && !clearKey
  const barkTestable = !clearKey && (configured || deviceKey.trim() !== '')
  const dirty =
    system !== settings.system.enabled ||
    bark !== settings.bark.enabled ||
    serverUrl !== settings.bark.serverUrl ||
    deviceKey.trim() !== '' ||
    clearKey ||
    approval !== (settings.events['dynamic-client-approval-requested'] ?? true)

  const run = async (kind: Exclude<typeof busy, ''>, action: () => Promise<unknown>, done: string) => {
    setBusy(kind)
    try {
      await action()
      toast(done)
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
    } finally {
      setBusy('')
    }
  }

  return (
    <>
      <Section title="渠道">
        <Panel className={styles.group}>
          <SwitchRow
            title="系统通知"
            description="由桌面端弹出；服务器实例转发给在线的桌面端"
            checked={system}
            onCheckedChange={setSystem}
            trailing={
              <Button
                size="small"
                variant="ghost"
                busy={busy === 'system'}
                disabled={busy !== ''}
                onClick={() => void run('system', () => api.getState().testSystemNotification(), '测试通知已发出')}
              >
                测试
              </Button>
            }
          />
          <SwitchRow
            title="Bark"
            description="推送到安装了 Bark 的设备"
            checked={bark}
            onCheckedChange={setBark}
            trailing={
              <Button
                size="small"
                variant="ghost"
                busy={busy === 'bark'}
                disabled={busy !== '' || !barkTestable}
                onClick={() =>
                  void run(
                    'bark',
                    () =>
                      api.getState().testBarkNotification({
                        serverUrl,
                        ...(deviceKey.trim() ? { deviceKey: deviceKey.trim() } : {}),
                      }),
                    '测试通知已发出',
                  )
                }
              >
                测试
              </Button>
            }
          />
          <div className={styles.barkFields}>
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
              <div>
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
        </Panel>
      </Section>
      <Section title="通知我">
        <Panel className={styles.group}>
          <SwitchRow
            title="创造任务等待确认运行"
            description="智能体写好带界面的候选，需要你允许运行时"
            checked={approval}
            onCheckedChange={setApproval}
          />
        </Panel>
      </Section>
      {dirty ? (
        <div className={styles.saveBar}>
          <span>通知设置有改动</span>
          <Button variant="ghost" disabled={busy !== ''} onClick={reset}>
            还原
          </Button>
          <Button
            variant="primary"
            busy={busy === 'save'}
            disabled={busy !== ''}
            onClick={() =>
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
                    events: { 'dynamic-client-approval-requested': approval },
                  }),
                '通知设置已保存',
              )
            }
          >
            保存
          </Button>
        </div>
      ) : null}
    </>
  )
}

function Appearance() {
  const ui = useProductRuntime().uiStore
  const theme = useUiStateStore((state) => state.theme)
  const reducedMotion = useUiStateStore((state) => state.reducedMotion)
  return (
    <Section title="显示">
      <Panel className={styles.group}>
        <div className={styles.line}>
          <span>主题</span>
          <Segmented
            label="主题"
            value={theme}
            onChange={(value) => ui.getState().setTheme(value)}
            options={[
              { value: 'light', label: '浅色' },
              { value: 'dark', label: '深色' },
            ]}
          />
        </div>
        <SwitchRow
          title="减少动态效果"
          description="关闭滑动、展开与入场动画"
          checked={reducedMotion}
          onCheckedChange={(enabled) => ui.getState().setReducedMotion(enabled)}
        />
      </Panel>
    </Section>
  )
}

const compiledVersion = typeof __NEKRO_PRODUCT_VERSION__ === 'string' ? __NEKRO_PRODUCT_VERSION__ : ''

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  )
}

function About() {
  const metadata = useProductStore((state) => state.productMetadata)
  const version = metadata?.version?.trim() || compiledVersion
  const repository = metadata?.repositoryUrl?.trim() || 'https://github.com/NekroAI/nekro-nxt'
  return (
    <>
      <div className={styles.brand}>
        <img src="/brand/mark.svg" alt="" />
        <div>
          <b>{metadata?.displayName?.trim() || 'NekroNXT'}</b>
          <span>{version ? `版本 ${version}` : '开发版本'}</span>
        </div>
      </div>
      <Panel className={styles.group}>
        <dl className={styles.facts}>
          <Fact label="DSH">{metadata?.dshVersion?.trim() || '—'}</Fact>
          <Fact label="Release">{metadata?.releaseId?.trim() || '—'}</Fact>
          <Fact label="许可证">
            <a href={`${repository}/blob/main/LICENSE`} target="_blank" rel="noreferrer">
              {metadata?.licenseSpdx?.trim() || 'AGPL-3.0-only'}
            </a>
          </Fact>
          <Fact label="仓库">
            <a href={repository} target="_blank" rel="noreferrer">
              {repository.replace(/^https:\/\/github\.com\//u, '')}
            </a>
          </Fact>
        </dl>
      </Panel>
      <p className={styles.notice}>
        代码按 GNU AGPL v3.0 授权，在适用法律允许范围内不提供担保。Logo、水月荧、角色插画与宣传素材版权归
        NekroAI，不属于代码许可证。
      </p>
    </>
  )
}
