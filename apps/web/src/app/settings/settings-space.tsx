import {
  Bell,
  Blocks,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Info,
  MonitorSmartphone,
  Palette,
  Plug,
  Plus,
  Upload,
} from 'lucide-react'
import { CompatibilityNotices } from '../system/compatibility.js'
import { useEffect, useState, type ReactNode } from 'react'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  DSH_GROUP_LABEL,
  DshCatalogState,
  DshPluginDetail,
  InstallDshPluginDialog,
  dshEntryStatus,
  useDshCatalog,
  type DshSettingsCatalogEntry,
} from '../../dsh-extension-settings.js'
import {
  AddProviderDialog,
  CUSTOM_PROVIDER,
  ModelProviderDetail,
  ProviderCatalogState,
  providerKind,
  providerStatus,
  useLlmProviders,
  type ProviderView,
} from '../../llm-settings.js'
import { providerDisplayName } from '../../provider-labels.js'
import { useProductRuntime, useProductStore, useUiStateStore } from '../../product-runtime.js'
import {
  Button,
  Chip,
  DataTable,
  EmptyState,
  Field,
  Input,
  ListPane,
  MainContent,
  PropertyGroup,
  PropertyList,
  PropertyRow,
  SaveBar,
  SecretInput,
  Segmented,
  Select,
  SelectionList,
  Skeleton,
  Switch,
  toast,
  WorkbenchPage,
  type Column,
} from '../../ui-kit/index.js'
import { useDensity } from '../model/density.js'
import { useProductApi } from '../model/store.js'
import { useGo } from '../model/nav.js'
import { useCrumb } from '../shell/crumb.js'
import { AccessSection, useManagementAccessAvailable } from './access-section.js'
import styles from './settings.module.css'

const SECTIONS = [
  { key: 'models', label: '模型', icon: <Cpu size={16} /> },
  { key: 'dsh', label: 'DSH 插件', icon: <Blocks size={16} /> },
  { key: 'adapters', label: '平台适配器', icon: <Plug size={16} /> },
  { key: 'notifications', label: '通知', icon: <Bell size={16} /> },
  { key: 'access', label: '登录设备', icon: <MonitorSmartphone size={16} /> },
  { key: 'appearance', label: '外观', icon: <Palette size={16} /> },
  { key: 'about', label: '关于', icon: <Info size={16} /> },
] as const

type SectionKey = (typeof SECTIONS)[number]['key']

const isSection = (value: string | undefined): value is SectionKey => SECTIONS.some((item) => item.key === value)

/** Configured providers, usable ones first, in catalog order otherwise. */
const listedProviders = (providers: readonly ProviderView[]): readonly ProviderView[] =>
  providers.filter((provider) => provider.configured).sort((a, b) => Number(b.active) - Number(a.active))

const DSH_GROUPS = ['builtin', 'installed', 'runtime'] as const

export default function SettingsSpace() {
  const { section } = useParams<{ section: string }>()
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const current = SECTIONS.find((item) => item.key === section)
  // Sign-in exists only when this page reaches the Server through its management edge.
  const accessAvailable = useManagementAccessAvailable()
  const sections = SECTIONS.filter((item) => item.key !== 'access' || accessAvailable || section === 'access')
  useCrumb('设置', current?.label)
  const llm = useLlmProviders()
  const dsh = useDshCatalog(section === 'dsh')
  const providers = llm.settings?.providers ?? []
  const requestedProvider = params.get('provider') ?? ''
  // Only what the address names is open; without it the section shows its overview instead of jumping to an item.
  const providerId =
    requestedProvider === CUSTOM_PROVIDER || providers.some((provider) => provider.provider === requestedProvider)
      ? requestedProvider
      : ''
  const requestedEntry = params.get('entry') ?? ''
  const dshEntry = dsh.entries.find((entry) => entry.id === requestedEntry)
  useEffect(() => {
    if (section === 'models' && !llm.settings && !llm.loading) void llm.load()
  }, [section])
  // 社区地址已移到「社区 → 账号」底部，旧地址直接带过去。
  if (section === 'community') return <Navigate to="/community/account" replace />
  if (!isSection(section)) return <Navigate to="/settings/models" replace />

  const selectProvider = (provider: string) =>
    void navigate(provider ? `/settings/models?provider=${encodeURIComponent(provider)}` : '/settings/models')

  return (
    <WorkbenchPage
      list={
        <ListPane title="设置" label="设置">
          <SelectionList selectedKey={section}>
            {sections.map((item) => (
              <Link
                key={item.key}
                to={`/settings/${item.key}`}
                className={styles.row}
                data-selected={section === item.key}
                aria-current={item.key === section ? 'page' : undefined}
              >
                {item.icon}
                {item.label}
              </Link>
            ))}
          </SelectionList>
        </ListPane>
      }
    >
      <MainContent
        width={
          section === 'notifications' || section === 'appearance' || section === 'about' || section === 'access'
            ? 'readable'
            : 'full'
        }
      >
        <NarrowNav section={section} />
        {section === 'models' ? (
          <ModelsSection
            providers={providers}
            providerId={providerId}
            ready={llm.settings !== null}
            onRetry={() => void llm.load()}
            onSelect={selectProvider}
          />
        ) : null}
        {section === 'dsh' ? (
          <DshSection
            entry={dshEntry}
            entries={dsh.entries}
            loading={dsh.loading}
            error={dsh.error}
            onRefresh={dsh.refresh}
            onSelect={(id) => setParams(id ? { entry: id } : {})}
          />
        ) : null}
        {section === 'adapters' ? <Adapters /> : null}
        {section === 'notifications' ? <Notifications /> : null}
        {section === 'access' ? (
          <>
            <SectionHead title="登录设备" />
            <AccessSection />
          </>
        ) : null}
        {section === 'appearance' ? <Appearance /> : null}
        {section === 'about' ? <About /> : null}
      </MainContent>
    </WorkbenchPage>
  )
}

/** Below 1100px the settings list collapses; this selector keeps every section reachable. */
function NarrowNav({ section }: { readonly section: SectionKey }) {
  const navigate = useNavigate()
  const accessAvailable = useManagementAccessAvailable()
  return (
    <div className={styles.narrowNav}>
      <Select
        aria-label="设置分节"
        value={section}
        options={SECTIONS.filter((item) => item.key !== 'access' || accessAvailable || section === 'access').map(
          (item) => ({ value: item.key, label: item.label }),
        )}
        onValueChange={(value) => void navigate(`/settings/${value}`)}
      />
    </div>
  )
}

function SectionHead({
  title,
  actions,
  back,
}: {
  readonly title: string
  readonly actions?: ReactNode
  /** On an item's page the item's own header is the page title; this only offers the way back to the overview. */
  readonly back?: { readonly label: string; readonly onBack: () => void }
}) {
  return (
    <>
      {back ? (
        <Button
          size="small"
          variant="ghost"
          icon={<ChevronLeft size={15} />}
          className={styles.back}
          onClick={back.onBack}
        >
          {back.label}
        </Button>
      ) : (
        <header className={styles.head}>
          <h1 className={styles.title}>{title}</h1>
          {actions ? <div className={styles.headActions}>{actions}</div> : null}
        </header>
      )}
      <CompatibilityNotices showContextReset />
    </>
  )
}

function ModelsSection({
  providers,
  providerId,
  ready,
  onRetry,
  onSelect,
}: {
  readonly providers: readonly ProviderView[]
  readonly providerId: string
  readonly ready: boolean
  readonly onRetry: () => void
  readonly onSelect: (provider: string) => void
}) {
  const [adding, setAdding] = useState(false)
  const configured = listedProviders(providers)
  const columns: readonly Column<ProviderView>[] = [
    {
      key: 'name',
      header: '供应商',
      width: 'minmax(200px, 2fr)',
      render: (provider) => (
        <span className={styles.adapterName}>
          <b>{providerDisplayName(provider.provider, provider.displayName)}</b>
          <span className={styles.muted}>{providerKind(provider)}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: '状态',
      width: 'minmax(96px, 0.8fr)',
      render: (provider) => {
        const status = providerStatus(provider)
        return (
          <Chip tone={status.tone} dot>
            {status.label}
          </Chip>
        )
      },
    },
    {
      key: 'models',
      header: '模型',
      width: 'minmax(80px, 0.6fr)',
      priority: 2,
      render: (provider) => <span className={styles.muted}>{provider.models.length} 个</span>,
    },
    {
      key: 'open',
      header: <span className={styles.srOnly}>打开</span>,
      width: '40px',
      align: 'end',
      render: () => <ChevronRight size={16} className={styles.rowChevron} aria-hidden="true" />,
    },
  ]
  return (
    <>
      <SectionHead
        title="模型"
        {...(providerId ? { back: { label: '全部供应商', onBack: () => onSelect('') } } : {})}
        actions={
          ready && !providerId ? (
            <Button size="small" icon={<Plus size={14} aria-hidden="true" />} onClick={() => setAdding(true)}>
              添加供应商
            </Button>
          ) : undefined
        }
      />
      {!ready ? (
        <ProviderCatalogState onRetry={onRetry} />
      ) : providerId ? (
        <ModelProviderDetail key={providerId} providerId={providerId} onSelect={onSelect} />
      ) : configured.length > 0 ? (
        <DataTable
          label="模型供应商"
          columns={columns}
          rows={configured}
          rowKey={(provider) => provider.provider}
          onSelect={(provider) => onSelect(provider.provider)}
        />
      ) : (
        <EmptyState
          icon={<Cpu size={22} />}
          title="还没有配置模型供应商"
          action={
            <Button variant="primary" onClick={() => setAdding(true)}>
              添加供应商
            </Button>
          }
        >
          智能体需要至少一个可用的模型供应商才能回复。
        </EmptyState>
      )}
      <AddProviderDialog open={adding} onOpenChange={setAdding} providers={providers} onPick={onSelect} />
    </>
  )
}

function DshSection({
  entry,
  entries,
  loading,
  error,
  onRefresh,
  onSelect,
}: {
  readonly entry: DshSettingsCatalogEntry | undefined
  readonly entries: readonly DshSettingsCatalogEntry[]
  readonly loading: boolean
  readonly error: string
  readonly onRefresh: () => Promise<void>
  readonly onSelect: (id: string) => void
}) {
  const [installing, setInstalling] = useState(false)
  const ordered = DSH_GROUPS.flatMap((group) => entries.filter((item) => item.group === group))
  const columns: readonly Column<DshSettingsCatalogEntry>[] = [
    {
      key: 'name',
      header: '插件',
      width: 'minmax(200px, 2fr)',
      render: (item) => (
        <span className={styles.adapterName}>
          <b>{item.label}</b>
          <span className={styles.muted}>{item.namespaces.length > 0 ? '可配置' : '无配置项'}</span>
        </span>
      ),
    },
    {
      key: 'source',
      header: '来源',
      width: 'minmax(96px, 0.8fr)',
      priority: 2,
      render: (item) => <span className={styles.muted}>{DSH_GROUP_LABEL[item.group]}</span>,
    },
    {
      key: 'status',
      header: '状态',
      width: 'minmax(96px, 0.8fr)',
      // Only a real state earns a label; the neutral fallback is the source, already in its own column.
      render: (item) => {
        const status = dshEntryStatus(item)
        return status.tone === 'neutral' ? (
          <span className={styles.muted}>—</span>
        ) : (
          <Chip tone={status.tone} dot>
            {status.label}
          </Chip>
        )
      },
    },
    {
      key: 'open',
      header: <span className={styles.srOnly}>打开</span>,
      width: '40px',
      align: 'end',
      render: () => <ChevronRight size={16} className={styles.rowChevron} aria-hidden="true" />,
    },
  ]
  return (
    <>
      <SectionHead
        title="DSH 插件"
        {...(entry ? { back: { label: '全部插件', onBack: () => onSelect('') } } : {})}
        actions={
          entry ? undefined : (
            <Button size="small" icon={<Upload size={14} aria-hidden="true" />} onClick={() => setInstalling(true)}>
              安装插件
            </Button>
          )
        }
      />
      {entry ? (
        <DshPluginDetail key={entry.id} entry={entry} onRefresh={onRefresh} onRemoved={() => onSelect('')} />
      ) : ordered.length > 0 ? (
        <DataTable
          label="DSH 插件"
          columns={columns}
          rows={ordered}
          rowKey={(item) => item.id}
          onSelect={(item) => onSelect(item.id)}
        />
      ) : (
        <DshCatalogState loading={loading} error={error} onRetry={() => void onRefresh()} />
      )}
      <InstallDshPluginDialog open={installing} onOpenChange={setInstalling} onInstalled={() => void onRefresh()} />
    </>
  )
}

type AdapterView = ReturnType<typeof useAdapterRows>[number]

function useAdapterRows() {
  const adapters = useProductStore((state) => state.connectionAdapters)
  const extensions = useProductStore((state) => state.extensions)
  const connections = useProductStore((state) => state.connections)
  return adapters.map((adapter) => ({
    adapter,
    source: extensions.find(
      (extension) =>
        extension.scope === 'host-adapter' &&
        extension.revisions.some((revision) => revision.contributions.includes(`适配器：${adapter.key}`)),
    ),
    accounts: connections.filter((connection) => connection.adapterKey === adapter.key).length,
  }))
}

/** Installed platform adapters with their real source; adding an account happens in wiring. */
function Adapters() {
  const rows = useAdapterRows()
  const go = useGo()
  const columns: readonly Column<AdapterView>[] = [
    {
      key: 'name',
      header: '适配器',
      width: 'minmax(220px, 2.4fr)',
      render: ({ adapter }) => (
        <span className={styles.adapterName}>
          <b>{adapter.displayName}</b>
          {adapter.description ? <span className={styles.muted}>{adapter.description}</span> : null}
        </span>
      ),
    },
    {
      key: 'source',
      header: '来源',
      width: 'minmax(120px, 1fr)',
      priority: 2,
      render: ({ source }) =>
        source ? (
          <Link to={`/workshop/extensions/${source.id}`} className={styles.source}>
            本地扩展 · {source.name}
          </Link>
        ) : (
          <Chip>内置</Chip>
        ),
    },
    {
      key: 'accounts',
      header: '账号',
      width: 'minmax(96px, 0.8fr)',
      render: ({ adapter, accounts }) =>
        adapter.provisioning === 'user-created' ? (
          <span className={styles.muted}>{accounts > 0 ? `${accounts} 个账号` : '还没有账号'}</span>
        ) : (
          <span className={styles.muted}>由本机自动管理</span>
        ),
    },
    {
      key: 'action',
      header: <span className={styles.srOnly}>操作</span>,
      width: '104px',
      align: 'end',
      render: ({ adapter }) =>
        adapter.provisioning === 'user-created' ? (
          <Button size="small" onClick={() => go(`/wiring/new?adapter=${encodeURIComponent(adapter.key)}`)}>
            添加账号
          </Button>
        ) : null,
    },
  ]
  return (
    <>
      <SectionHead title="平台适配器" />
      <DataTable
        label="平台适配器"
        columns={columns}
        rows={rows}
        rowKey={({ adapter }) => adapter.key}
        empty="没有已安装的平台适配器"
      />
    </>
  )
}

function Notifications() {
  const api = useProductApi()
  const settings = useProductStore((state) => state.notificationSettings)
  const hostStatus = useProductStore((state) => state.host.status)
  const [system, setSystem] = useState(settings.system.enabled)
  const [bark, setBark] = useState(settings.bark.enabled)
  const [serverUrl, setServerUrl] = useState(settings.bark.serverUrl)
  const [deviceKey, setDeviceKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [approval, setApproval] = useState(settings.events['dynamic-client-approval-requested'] ?? true)
  const [busy, setBusy] = useState<'' | 'save' | 'bark' | 'system'>('')
  const [saveError, setSaveError] = useState('')

  const reset = () => {
    setSystem(settings.system.enabled)
    setBark(settings.bark.enabled)
    setServerUrl(settings.bark.serverUrl)
    setDeviceKey('')
    setClearKey(false)
    setApproval(settings.events['dynamic-client-approval-requested'] ?? true)
    setSaveError('')
  }
  // Saved settings changed (here or elsewhere): show them. Keyed by content, so a refresh that returns the same
  // saved values never discards what the user is editing.
  const savedKey = JSON.stringify(settings)
  useEffect(reset, [savedKey])

  const configured = settings.bark.deviceKeyConfigured && !clearKey
  const barkTestable = !clearKey && (configured || deviceKey.trim() !== '')
  const changes = [
    ...(system !== settings.system.enabled ? ['系统通知'] : []),
    ...(bark !== settings.bark.enabled || serverUrl !== settings.bark.serverUrl || deviceKey.trim() !== '' || clearKey
      ? ['Bark']
      : []),
    ...(approval !== (settings.events['dynamic-client-approval-requested'] ?? true) ? ['通知事件'] : []),
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
          events: { 'dynamic-client-approval-requested': approval },
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

  return (
    <>
      <SectionHead title="通知" />
      <PropertyGroup title="渠道">
        <PropertyList>
          <PropertyRow label="系统通知" description="由桌面端弹出；服务器实例转发给在线的桌面端">
            <span className={styles.rowControls}>
              <Button
                size="small"
                variant="ghost"
                busy={busy === 'system'}
                disabled={busy !== ''}
                onClick={() => void run('system', () => api.getState().testSystemNotification(), '测试通知已发出')}
              >
                测试
              </Button>
              <Switch label="系统通知" checked={system} onCheckedChange={setSystem} />
            </span>
          </PropertyRow>
          <PropertyRow label="Bark" description="推送到安装了 Bark 的设备">
            <span className={styles.rowControls}>
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
              <Switch label="Bark" checked={bark} onCheckedChange={setBark} />
            </span>
          </PropertyRow>
          <PropertyRow label="Bark 连接" layout="stacked">
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
          </PropertyRow>
        </PropertyList>
      </PropertyGroup>
      <PropertyGroup title="通知我">
        <PropertyList>
          <PropertyRow label="创造任务等待确认运行" description="智能体写好带界面的候选，需要你允许运行时">
            <Switch label="创造任务等待确认运行" checked={approval} onCheckedChange={setApproval} />
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

function Appearance() {
  const ui = useProductRuntime().uiStore
  const theme = useUiStateStore((state) => state.theme)
  const reducedMotion = useUiStateStore((state) => state.reducedMotion)
  const [density, setDensity] = useDensity()
  return (
    <>
      <SectionHead title="外观" />
      <PropertyList>
        <PropertyRow label="主题">
          <Segmented
            label="主题"
            value={theme}
            onChange={(value) => ui.getState().setTheme(value)}
            options={[
              { value: 'light', label: '浅色' },
              { value: 'dark', label: '深色' },
            ]}
          />
        </PropertyRow>
        <PropertyRow label="界面密度" description="紧凑会缩小行高和控件，在一屏内显示更多内容">
          <Segmented
            label="界面密度"
            value={density}
            onChange={setDensity}
            options={[
              { value: 'comfortable', label: '标准' },
              { value: 'compact', label: '紧凑' },
            ]}
          />
        </PropertyRow>
        <PropertyRow label="减少动态效果" description="关闭滑动、展开与入场动画">
          <Switch
            label="减少动态效果"
            checked={reducedMotion}
            onCheckedChange={(enabled) => ui.getState().setReducedMotion(enabled)}
          />
        </PropertyRow>
      </PropertyList>
    </>
  )
}

const compiledVersion = typeof __NEKRO_PRODUCT_VERSION__ === 'string' ? __NEKRO_PRODUCT_VERSION__ : ''

function About() {
  const metadata = useProductStore((state) => state.productMetadata)
  const version = metadata?.version?.trim() || compiledVersion
  const repository = metadata?.repositoryUrl?.trim() || 'https://github.com/NekroAI/nekro-nxt'
  return (
    <>
      <SectionHead title="关于" />
      <div className={styles.brand}>
        <img src="/brand/mark.svg" alt="" />
        <div>
          <b>{metadata?.displayName?.trim() || 'NekroNXT'}</b>
          <span>{version ? `版本 ${version}` : '开发版本'}</span>
        </div>
      </div>
      <PropertyList>
        <PropertyRow label="DSH">{metadata?.dshVersion?.trim() || '—'}</PropertyRow>
        <PropertyRow label="Release">{metadata?.releaseId?.trim() || '—'}</PropertyRow>
        <PropertyRow label="许可证">
          <a href={`${repository}/blob/main/LICENSE`} className={styles.link} target="_blank" rel="noreferrer">
            {metadata?.licenseSpdx?.trim() || 'AGPL-3.0-only'}
          </a>
        </PropertyRow>
        <PropertyRow label="仓库">
          <a href={repository} className={styles.link} target="_blank" rel="noreferrer">
            {repository.replace(/^https:\/\/github\.com\//u, '')}
          </a>
        </PropertyRow>
      </PropertyList>
      <p className={styles.notice}>
        代码按 GNU AGPL v3.0 授权，在适用法律允许范围内不提供担保。Logo、水月荧、角色插画与宣传素材版权归
        NekroAI，不属于代码许可证。
      </p>
    </>
  )
}
