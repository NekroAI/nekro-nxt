import { CommandsSection } from './commands-section.js'
import { SectionHead } from './section-head.js'
import {
  Bell,
  Blocks,
  ChevronRight,
  Cpu,
  Inbox,
  Info,
  MessageCircle,
  MessagesSquare,
  ScanEye,
  MonitorSmartphone,
  Palette,
  Plug,
  Plus,
  Search,
  ScrollText,
  SquareSlash,
  Upload,
  ShieldCheck,
  KeyRound,
  Link2,
} from 'lucide-react'
import { useEffect, useState } from 'react'
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
import { CompactionModelField } from '../agents/compaction-model.js'
import type {
  CompactionSettings,
  ModelFallbackSettings,
  MessagePacing,
  RetrievalStatus,
  SubConversationRetention,
  UpgradeBackupSettings,
} from '@nekro-nxt/contracts'
import { CodeRunNodeDownload, CodeRunNodeRemove } from '../agents/runtime-download.js'
import { workspaceApi } from '../../host-api-client.js'
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
  MasterDetail,
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
  Ambient,
  RevealText,
} from '../../ui-kit/index.js'
import { useDensity } from '../model/density.js'
import { useProductApi } from '../model/store.js'
import { useGo } from '../model/nav.js'
import { useCrumb } from '../shell/crumb.js'
import { useProductUpdates, versionDescription } from '../shell/product-updates.js'
import { AccessSection, useManagementAccessAvailable } from './access-section.js'
import { CredentialsSection } from './credentials-section.js'
import { LinkedAccountsSection } from './linked-accounts-section.js'
import { AdministratorsSection } from './administrators-section.js'
import { LogSettings } from '../logs/log-settings.js'
import { FeedbackSettingsSection } from './feedback-section.js'
import styles from './settings.module.css'

// Four groups (docs/NekroNxt界面交互模型.md §9); the order inside a group is the order people need them.
const GROUPS = [
  { key: 'runtime', label: '智能体运行' },
  { key: 'links', label: '连接' },
  { key: 'permission', label: '权限' },
  { key: 'system', label: '系统' },
] as const

const SECTIONS = [
  { key: 'models', label: '模型', group: 'runtime', icon: <Cpu size={16} /> },
  { key: 'retrieval', label: '检索', group: 'runtime', icon: <Search size={16} /> },
  { key: 'dsh', label: 'DSH 插件', group: 'runtime', icon: <Blocks size={16} /> },
  { key: 'chat', label: '聊天', group: 'runtime', icon: <MessageCircle size={16} /> },
  { key: 'conversations', label: '子对话', group: 'runtime', icon: <MessagesSquare size={16} /> },
  { key: 'verification', label: '界面检查', group: 'runtime', icon: <ScanEye size={16} /> },
  { key: 'adapters', label: '平台适配器', group: 'links', icon: <Plug size={16} /> },
  { key: 'credentials', label: '凭据', group: 'links', icon: <KeyRound size={16} /> },
  { key: 'accounts', label: '关联账号', group: 'links', icon: <Link2 size={16} /> },
  { key: 'administrators', label: '管理员', group: 'permission', icon: <ShieldCheck size={16} /> },
  { key: 'commands', label: '聊天命令', group: 'permission', icon: <SquareSlash size={16} /> },
  { key: 'access', label: '登录设备', group: 'permission', icon: <MonitorSmartphone size={16} /> },
  { key: 'notifications', label: '通知', group: 'system', icon: <Bell size={16} /> },
  { key: 'appearance', label: '外观', group: 'system', icon: <Palette size={16} /> },
  { key: 'logs', label: '日志保存', group: 'system', icon: <ScrollText size={16} /> },
  { key: 'feedback', label: '社区反馈', group: 'system', icon: <Inbox size={16} /> },
  { key: 'about', label: '关于', group: 'system', icon: <Info size={16} /> },
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
            {GROUPS.map((group) => (
              <div key={group.key} className={styles.navGroup} role="group" aria-label={group.label}>
                <div className={styles.navGroupLabel}>{group.label}</div>
                {sections
                  .filter((item) => item.group === group.key)
                  .map((item) => (
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
              </div>
            ))}
          </SelectionList>
        </ListPane>
      }
    >
      {section === 'models' ? (
        <ModelsSection
          providers={providers}
          providerId={providerId}
          ready={llm.settings !== null}
          onRetry={() => void llm.load()}
          onSelect={selectProvider}
        />
      ) : section === 'credentials' ? (
        <CredentialsSection lead={<NarrowNav section="credentials" />} />
      ) : section === 'accounts' ? (
        <LinkedAccountsSection lead={<NarrowNav section="accounts" />} />
      ) : section === 'dsh' ? (
        <DshSection
          entry={dshEntry}
          entries={dsh.entries}
          loading={dsh.loading}
          error={dsh.error}
          onRefresh={dsh.refresh}
          onSelect={(id) => setParams(id ? { entry: id } : {})}
        />
      ) : (
        // Every settings section shares one readable width and the same left edge (05 §6.1).
        <MainContent width="readable">
          <NarrowNav section={section} />
          {section === 'administrators' ? <AdministratorsSection /> : null}
          {section === 'commands' ? (
            <>
              <SectionHead title="聊天命令" subtitle="在群聊和私聊里用 / 开头执行的命令。" />
              <CommandsSection />
            </>
          ) : null}
          {section === 'logs' ? <LogSettings /> : null}
          {section === 'adapters' ? <Adapters /> : null}
          {section === 'chat' ? <Chat /> : null}
          {section === 'conversations' ? <SubConversations /> : null}
          {section === 'verification' ? <InterfaceChecks /> : null}
          {section === 'retrieval' ? <Retrieval /> : null}
          {section === 'notifications' ? <Notifications /> : null}
          {section === 'feedback' ? <FeedbackSettingsSection /> : null}
          {section === 'access' ? (
            <>
              <SectionHead title="登录设备" />
              <AccessSection />
            </>
          ) : null}
          {section === 'appearance' ? <Appearance /> : null}
          {section === 'about' ? <About /> : null}
        </MainContent>
      )}
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
          <span className={styles.providerStatus}>
            <Chip tone={status.tone} dot>
              {status.label}
            </Chip>
            {status.when ? <span className={styles.muted}>{status.when}</span> : null}
          </span>
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
  const list = (
    <>
      <NarrowNav section="models" />
      <SectionHead
        title="模型"
        actions={
          ready ? (
            <Button size="small" icon={<Plus size={14} aria-hidden="true" />} onClick={() => setAdding(true)}>
              添加供应商
            </Button>
          ) : undefined
        }
      />
      {!ready ? (
        <ProviderCatalogState onRetry={onRetry} />
      ) : configured.length > 0 ? (
        <DataTable
          label="模型供应商"
          columns={columns}
          rows={configured}
          rowKey={(provider) => provider.provider}
          selectedKey={providerId || undefined}
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
      {ready ? <FallbackCooldowns /> : null}
      <AddProviderDialog open={adding} onOpenChange={setAdding} providers={providers} onPick={onSelect} />
    </>
  )
  return (
    <MasterDetail
      label="模型供应商"
      lead={<NarrowNav section="models" />}
      list={list}
      selectedKey={providerId || undefined}
      back={{ label: '全部供应商', onBack: () => onSelect('') }}
      detail={
        ready && providerId ? (
          <ModelProviderDetail key={providerId} providerId={providerId} onSelect={onSelect} />
        ) : undefined
      }
    />
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
  const list = (
    <>
      <NarrowNav section="dsh" />
      <SectionHead
        title="DSH 插件"
        actions={
          <Button size="small" icon={<Upload size={14} aria-hidden="true" />} onClick={() => setInstalling(true)}>
            安装插件
          </Button>
        }
      />
      {ordered.length > 0 ? (
        <DataTable
          label="DSH 插件"
          columns={columns}
          rows={ordered}
          rowKey={(item) => item.id}
          selectedKey={entry?.id}
          onSelect={(item) => onSelect(item.id)}
        />
      ) : (
        <DshCatalogState loading={loading} error={error} onRetry={() => void onRefresh()} />
      )}
      <InstallDshPluginDialog open={installing} onOpenChange={setInstalling} onInstalled={() => void onRefresh()} />
    </>
  )
  return (
    <MasterDetail
      label="DSH 插件列表"
      lead={<NarrowNav section="dsh" />}
      list={list}
      selectedKey={entry?.id}
      back={{ label: '全部插件', onBack: () => onSelect('') }}
      detail={
        entry ? (
          <DshPluginDetail key={entry.id} entry={entry} onRefresh={onRefresh} onRemoved={() => onSelect('')} />
        ) : undefined
      }
    />
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
        extension.provides.includes('adapter') &&
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
        // The source column only says something once an adapter comes from a local extension.
        columns={rows.some((row) => row.source) ? columns : columns.filter((column) => column.key !== 'source')}
        rows={rows}
        rowKey={({ adapter }) => adapter.key}
        empty="没有已安装的平台适配器"
      />
    </>
  )
}

const PACING_OPTIONS: readonly { readonly value: MessagePacing; readonly label: string }[] = [
  { value: 'off', label: '不等待' },
  { value: 'fast', label: '短' },
  { value: 'normal', label: '适中' },
  { value: 'slow', label: '长' },
]

const minutesLabel = (minutes: number) => (minutes < 60 ? `${minutes} 分钟` : `${minutes / 60} 小时`)
const UNAVAILABLE_COOLDOWN_OPTIONS = [5, 10, 30, 60].map((minutes) => ({
  value: String(minutes),
  label: minutesLabel(minutes),
}))
const QUOTA_COOLDOWN_OPTIONS = [30, 60, 180, 360, 1440].map((minutes) => ({
  value: String(minutes),
  label: minutesLabel(minutes),
}))
/** The saved value stays selectable when it is not one of the presets. */
const withCurrent = (options: readonly { value: string; label: string }[], minutes: number) =>
  options.some((option) => option.value === String(minutes))
    ? options
    : [...options, { value: String(minutes), label: minutesLabel(minutes) }]

/**
 * How long a model that failed is passed over before conversations try it again. Which models an agent falls back to
 * is chosen on the agent; this only decides when it goes back.
 */
function FallbackCooldowns() {
  const [settings, setSettings] = useState<ModelFallbackSettings>()
  useEffect(() => {
    const controller = new AbortController()
    workspaceApi
      .getModelFallbackSettings({ signal: controller.signal })
      .then(setSettings)
      .catch(() => undefined)
    return () => controller.abort()
  }, [])
  const save = (next: ModelFallbackSettings) => {
    const previous = settings
    setSettings(next)
    workspaceApi.updateModelFallbackSettings(next).catch((error: unknown) => {
      setSettings(previous)
      toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
    })
  }
  return (
    <>
      <SectionHead title="备用模型" />
      <PropertyList>
        <PropertyRow
          label="限流或出错后"
          tip="主模型持续限流、服务出错或超时，重试几次仍失败后，智能体改用备用模型；过了这段时间，收到新消息时再试主模型。"
        >
          {settings === undefined ? (
            <Skeleton width={160} height={28} />
          ) : (
            <Select
              aria-label="限流或出错后多久再试主模型"
              value={String(settings.unavailableCooldownMinutes)}
              options={withCurrent(UNAVAILABLE_COOLDOWN_OPTIONS, settings.unavailableCooldownMinutes)}
              onValueChange={(value) => save({ ...settings, unavailableCooldownMinutes: Number(value) })}
            />
          )}
        </PropertyRow>
        <PropertyRow
          label="额度用完后"
          tip="主模型额度或余额用完时，智能体立即改用备用模型；过了这段时间，收到新消息时再试主模型。"
        >
          {settings === undefined ? (
            <Skeleton width={160} height={28} />
          ) : (
            <Select
              aria-label="额度用完后多久再试主模型"
              value={String(settings.quotaCooldownMinutes)}
              options={withCurrent(QUOTA_COOLDOWN_OPTIONS, settings.quotaCooldownMinutes)}
              onValueChange={(value) => save({ ...settings, quotaCooldownMinutes: Number(value) })}
            />
          )}
        </PropertyRow>
      </PropertyList>
    </>
  )
}

const COMPACTION_WAIT_OPTIONS = [60, 120, 180, 300, 600].map((seconds) => ({
  value: String(seconds),
  label: `${seconds / 60} 分钟`,
}))

function Chat() {
  const [pacing, setPacing] = useState<MessagePacing>()
  const [compaction, setCompaction] = useState<CompactionSettings>()
  useEffect(() => {
    const controller = new AbortController()
    workspaceApi
      .getMessagePacingSettings({ signal: controller.signal })
      .then((settings) => setPacing(settings.pacing))
      .catch(() => undefined)
    workspaceApi
      .getCompactionSettings({ signal: controller.signal })
      .then(setCompaction)
      .catch(() => undefined)
    return () => controller.abort()
  }, [])
  const saveCompaction = (next: CompactionSettings) => {
    const previous = compaction
    setCompaction(next)
    workspaceApi.updateCompactionSettings(next).catch((error: unknown) => {
      setCompaction(previous)
      toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
    })
  }
  const change = (next: MessagePacing) => {
    const previous = pacing
    setPacing(next)
    workspaceApi.updateMessagePacingSettings({ pacing: next }).catch((error: unknown) => {
      setPacing(previous)
      toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
    })
  }
  return (
    <>
      <SectionHead title="聊天" />
      <PropertyList>
        <PropertyRow label="连发间隔" tip="智能体一次连着发几条消息时，每条之间停一下再发，字多的停得久一些。">
          {pacing === undefined ? (
            <Skeleton width={220} height={28} />
          ) : (
            <Segmented label="连发间隔" value={pacing} onChange={change} options={PACING_OPTIONS} />
          )}
        </PropertyRow>
        <PropertyRow
          label="开新会话时的压缩模型"
          layout="stacked"
          tip="闲置后再被唤醒、或手动压缩时，先用它把上一段对话整理成摘要，再开新会话。这一步用不上缓存，换成更快的模型能少等一会儿。智能体可以另外指定。"
        >
          {compaction === undefined ? (
            <Skeleton width={320} height={28} />
          ) : (
            <CompactionModelField
              label="开新会话时的压缩模型"
              followLabel="跟随智能体的主模型"
              value={compaction.newSessionModel.mode === 'custom' ? compaction.newSessionModel.model : undefined}
              onChange={(model) =>
                saveCompaction({
                  ...compaction,
                  newSessionModel: model ? { mode: 'custom', model } : { mode: 'main' },
                })
              }
            />
          )}
        </PropertyRow>
        <PropertyRow
          label="压缩最多等待"
          tip="到时间还没整理完，就带着一句说明直接开新会话，之前的内容由智能体按需翻聊天记录。"
        >
          {compaction === undefined ? (
            <Skeleton width={160} height={28} />
          ) : (
            <Select
              aria-label="压缩最多等待"
              value={String(compaction.timeoutSeconds)}
              options={
                COMPACTION_WAIT_OPTIONS.some((option) => option.value === String(compaction.timeoutSeconds))
                  ? COMPACTION_WAIT_OPTIONS
                  : [
                      ...COMPACTION_WAIT_OPTIONS,
                      { value: String(compaction.timeoutSeconds), label: `${compaction.timeoutSeconds} 秒` },
                    ]
              }
              onValueChange={(value) => saveCompaction({ ...compaction, timeoutSeconds: Number(value) })}
            />
          )}
        </PropertyRow>
      </PropertyList>
    </>
  )
}

/**
 * The headless browser that checks the interface of candidates agents make when no NekroNXT page is open. Shared by
 * the whole device, like the semantic model; without it candidates still run, marked as interface unchecked.
 */
function InterfaceChecks() {
  const browser = useProductStore((state) => state.capabilityAvailability.verificationBrowser)
  return (
    <>
      <SectionHead title="界面检查" />
      <PropertyList>
        <PropertyRow
          label="后台浏览器"
          description={
            browser?.source === 'system'
              ? '已随 NekroNXT 安装'
              : browser?.available
                ? '已安装，没打开 NekroNXT 页面时用它检查扩展界面'
                : '无头 Chromium，下载约 100 MB，安装后约 200 MB'
          }
          tip="智能体做的扩展带界面时，试运行要在浏览器里加载并检查。打开着任何一个 NekroNXT 页面时由页面完成；一个页面都没开时由这个浏览器在后台完成。不安装也可以，候选照常运行，标为「界面未检查」。"
        >
          {browser === undefined ? null : browser.available ? (
            <CodeRunNodeRemove availability={browser} kind="verification-browser" />
          ) : (
            <CodeRunNodeDownload availability={browser} kind="verification-browser" />
          )}
        </PropertyRow>
      </PropertyList>
    </>
  )
}

const RETENTION_OPTIONS: readonly { readonly value: SubConversationRetention; readonly label: string }[] = [
  { value: '1d', label: '1 天' },
  { value: '3d', label: '3 天' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
  { value: 'never', label: '一直保留' },
]

/** How long ended sub-conversations stay before they are removed with their records. */
function SubConversations() {
  const [retention, setRetention] = useState<SubConversationRetention>()
  useEffect(() => {
    const controller = new AbortController()
    workspaceApi
      .getSubConversationSettings({ signal: controller.signal })
      .then((settings) => setRetention(settings.retention))
      .catch(() => undefined)
    return () => controller.abort()
  }, [])
  const change = (next: SubConversationRetention) => {
    const previous = retention
    setRetention(next)
    workspaceApi.updateSubConversationSettings({ retention: next }).catch((error: unknown) => {
      setRetention(previous)
      toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
    })
  }
  return (
    <>
      <SectionHead title="子对话" />
      <PropertyList>
        <PropertyRow
          label="结束后保留"
          tip="智能体开的子对话和验证扩展时开的子对话，结束后在频道下保留多久；到期后连同记录一起删除。"
        >
          {retention === undefined ? (
            <Skeleton width={260} height={28} />
          ) : (
            <Segmented label="结束后保留" value={retention} onChange={change} options={RETENTION_OPTIONS} />
          )}
        </PropertyRow>
      </PropertyList>
    </>
  )
}

const megabytes = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024 / 1024))} MB`

/** Search used by extensions for their own collections, e.g. stickers; semantic search runs a small model locally. */
function Retrieval() {
  const [status, setStatus] = useState<RetrievalStatus>()
  const [busy, setBusy] = useState(false)
  const fail = (error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
  const busyNow = status?.builtin.install.state === 'downloading' || status?.vectors.state === 'running'
  useEffect(() => {
    const controller = new AbortController()
    const load = () =>
      workspaceApi
        .getRetrievalStatus({ signal: controller.signal })
        .then(setStatus)
        .catch(() => undefined)
    void load()
    // Progress has no push channel; poll only while a download or an index build is running.
    const timer = busyNow ? setInterval(() => void load(), 1000) : undefined
    return () => {
      controller.abort()
      if (timer !== undefined) clearInterval(timer)
    }
  }, [busyNow])
  const run = async (action: () => Promise<RetrievalStatus>) => {
    setBusy(true)
    try {
      setStatus(await action())
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }
  if (status === undefined) {
    return (
      <>
        <SectionHead title="检索" />
        <Skeleton width={320} height={28} />
      </>
    )
  }
  const { builtin, vectors } = status
  const install = builtin.install
  const installed = install.state === 'installed'
  return (
    <>
      <SectionHead title="检索" />
      <PropertyList>
        <PropertyRow
          label="语义检索"
          tip="扩展查找自己保存的资料（比如表情包）时，除了关键词，还按意思找：用「累了」也能找到「加班到崩溃」。模型在本机运行，不会把内容发到别处。"
        >
          <Switch
            label="语义检索"
            checked={status.mode === 'builtin'}
            disabled={!installed || busy}
            onCheckedChange={(checked) =>
              void run(() => workspaceApi.updateRetrievalMode({ mode: checked ? 'builtin' : 'keyword' }))
            }
          />
        </PropertyRow>
        <PropertyRow label="语义模型" description={`${builtin.model}，约 ${megabytes(builtin.downloadBytes)}`}>
          {!builtin.supported ? (
            <span className={styles.note}>这台设备的系统或处理器暂时不能运行</span>
          ) : install.state === 'downloading' ? (
            <span className={styles.note} role="status">
              正在下载 {megabytes(install.receivedBytes)} / {megabytes(install.totalBytes)}
            </span>
          ) : installed ? (
            <Button
              size="small"
              variant="ghost"
              busy={busy}
              onClick={() => void run(() => workspaceApi.removeRetrievalModel())}
            >
              删除
            </Button>
          ) : (
            <div className={styles.note}>
              {install.state === 'failed' ? (
                <span className={styles.noteWarn} role="alert">
                  {install.error}
                </span>
              ) : null}
              <Button size="small" busy={busy} onClick={() => void run(() => workspaceApi.downloadRetrievalModel())}>
                {install.state === 'failed' ? '重试' : '下载'}
              </Button>
            </div>
          )}
        </PropertyRow>
        {status.mode === 'builtin' ? (
          <PropertyRow label="语义索引" description="新保存的资料会在几秒内加入">
            {vectors.error !== undefined ? (
              <span className={styles.noteWarn} role="alert">
                {vectors.error}
              </span>
            ) : (
              <span className={styles.note} role="status">
                {vectors.state === 'ready'
                  ? `已就绪，共 ${vectors.documents} 条`
                  : `正在建立 ${vectors.embedded} / ${vectors.documents}`}
              </span>
            )}
          </PropertyRow>
        ) : null}
      </PropertyList>
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
  const [feedback, setFeedback] = useState(settings.events['community-feedback-update'])
  const [credentialRequested, setCredentialRequested] = useState(settings.events['credential-requested'])
  const [busy, setBusy] = useState<'' | 'save' | 'bark' | 'system'>('')
  const [saveError, setSaveError] = useState('')

  const reset = () => {
    setSystem(settings.system.enabled)
    setBark(settings.bark.enabled)
    setServerUrl(settings.bark.serverUrl)
    setDeviceKey('')
    setClearKey(false)
    setApproval(settings.events['dynamic-client-approval-requested'] ?? true)
    setFeedback(settings.events['community-feedback-update'])
    setCredentialRequested(settings.events['credential-requested'])
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
    ...(feedback !== settings.events['community-feedback-update'] ? ['社区反馈更新'] : []),
    ...(credentialRequested !== settings.events['credential-requested'] ? ['凭据申请'] : []),
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
          events: {
            'dynamic-client-approval-requested': approval,
            'community-feedback-update': feedback,
            'credential-requested': credentialRequested,
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

  return (
    <>
      <SectionHead title="通知" />
      <PropertyGroup title="渠道">
        <PropertyList>
          <PropertyRow label="系统通知" tip="在桌面版上弹出">
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
          <PropertyRow label="Bark" tip="推送到安装了 Bark 的设备">
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
          <PropertyRow label="创造任务等待确认运行" tip="智能体写好带界面的候选，需要你允许运行时">
            <Switch label="创造任务等待确认运行" checked={approval} onCheckedChange={setApproval} />
          </PropertyRow>
          <PropertyRow label="社区反馈更新" tip="反馈等待确认、收到回复或处理状态有变化时">
            <Switch label="社区反馈更新" checked={feedback} onCheckedChange={setFeedback} />
          </PropertyRow>
          <PropertyRow label="凭据申请" tip="智能体需要的凭据还没有添加时">
            <Switch label="凭据申请" checked={credentialRequested} onCheckedChange={setCredentialRequested} />
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
        <PropertyRow label="界面密度" tip="紧凑会缩小行高和控件，在一屏内显示更多内容">
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
        <PropertyRow label="减少动态效果" tip="关闭滑动、展开与入场动画">
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

/** Version, whether a newer release exists on this build's channel, and the switch for automatic checks. */
function ProductUpdateRows({ updates }: { readonly updates: ReturnType<typeof useProductUpdates> }) {
  const { status, checking, checkNow, setAutoCheck } = updates
  if (status === undefined) return null
  const when =
    status.checkedAt === undefined
      ? ''
      : ` · ${new Date(status.checkedAt).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 检查`
  const stateText =
    status.state === 'available'
      ? `有新版本 ${status.latest?.version ?? ''}${status.latest?.publishedAt === undefined ? '' : ` · ${new Date(status.latest.publishedAt).toLocaleDateString('zh-CN')} 发布`}`
      : status.state === 'up-to-date'
        ? `已是最新${when}`
        : status.state === 'failed'
          ? `检查失败，稍后再试${when}`
          : status.autoCheck
            ? '正在检查'
            : '还没有检查'
  const failure = (error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
  return (
    <>
      {status.channel === 'development' ? null : (
        <>
          <PropertyRow label="更新" description={stateText}>
            {status.state === 'available' && status.latest !== undefined ? (
              <a href={status.latest.url} className={styles.link} target="_blank" rel="noreferrer">
                查看更新内容
              </a>
            ) : (
              <Button size="small" busy={checking} onClick={() => void checkNow().catch(failure)}>
                检查更新
              </Button>
            )}
          </PropertyRow>
          <PropertyRow
            label="自动检查更新"
            tip={`每 6 小时向 GitHub 查询一次${status.channel === 'preview' ? '预览版' : '正式版'}的最新发布，不发送这台实例的任何信息。`}
          >
            <Switch
              label="自动检查更新"
              checked={status.autoCheck}
              onCheckedChange={(checked) => void setAutoCheck(checked).catch(failure)}
            />
          </PropertyRow>
        </>
      )}
    </>
  )
}

const gigabytes = (bytes: number) => `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`

const BACKUP_MODES = [
  { value: 'data', label: '保存在数据目录' },
  { value: 'directory', label: '保存到其他位置' },
  { value: 'off', label: '不备份' },
] as const

/** Restore points taken before an upgrade: where they go, or none. */
function UpgradeBackupRows() {
  const [settings, setSettings] = useState<UpgradeBackupSettings>()
  const [mode, setMode] = useState<UpgradeBackupSettings['mode']>('data')
  const [directory, setDirectory] = useState('')
  const [busy, setBusy] = useState(false)
  const apply = (next: UpgradeBackupSettings) => {
    setSettings(next)
    setMode(next.mode)
    setDirectory(next.directory ?? '')
  }
  useEffect(() => {
    const controller = new AbortController()
    workspaceApi
      .getUpgradeBackupSettings({ signal: controller.signal })
      .then(apply)
      .catch(() => undefined)
    return () => controller.abort()
  }, [])
  if (settings === undefined) return null
  const save = async (next: UpgradeBackupSettings['mode'], path?: string) => {
    setBusy(true)
    try {
      apply(
        await workspaceApi.updateUpgradeBackupSettings({
          mode: next,
          ...(next === 'directory' && path ? { directory: path.trim() } : {}),
        }),
      )
      toast('已保存')
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
    } finally {
      setBusy(false)
    }
  }
  const usage =
    settings.mode === 'off'
      ? '升级时不备份'
      : settings.usage.count === 0
        ? `升级前备份全部数据，保留最近 ${settings.keep} 份`
        : `已保留 ${settings.usage.count} 份，共 ${gigabytes(settings.usage.bytes)}；保留最近 ${settings.keep} 份`
  return (
    <>
      <PropertyRow label="升级前备份" description={settings.locked ? '由服务端环境变量设置' : usage}>
        <Select
          aria-label="升级前备份"
          value={mode}
          disabled={settings.locked || busy}
          options={BACKUP_MODES.map((option) => ({ ...option }))}
          onValueChange={(value) => {
            const next = BACKUP_MODES.find((option) => option.value === value)?.value
            if (next === undefined) return
            setMode(next)
            if (next !== 'directory') void save(next)
          }}
        />
      </PropertyRow>
      {mode === 'directory' ? (
        <PropertyRow label="备份位置" description="例如外置盘上的目录；已有的备份留在原位置">
          <div className={styles.inlineForm}>
            <Input
              value={directory}
              spellCheck={false}
              disabled={settings.locked}
              placeholder="/mnt/nekro-nxt-backups"
              aria-label="备份位置"
              onChange={(event) => setDirectory(event.target.value)}
            />
            {settings.locked ? null : (
              <Button
                size="small"
                busy={busy}
                disabled={!directory.trim() || (settings.mode === 'directory' && directory === settings.directory)}
                onClick={() => void save('directory', directory)}
              >
                保存
              </Button>
            )}
          </div>
        </PropertyRow>
      ) : null}
    </>
  )
}

function About() {
  const metadata = useProductStore((state) => state.productMetadata)
  const updates = useProductUpdates()
  const version = metadata?.version?.trim() || compiledVersion
  const repository = metadata?.repositoryUrl?.trim() || 'https://github.com/NekroAI/nekro-nxt'
  return (
    <>
      <SectionHead title="关于" />
      <Ambient className={styles.brandAmbient}>
        <div className={styles.brand}>
          <img src="/brand/mark.svg" alt="" />
          <div>
            <b>
              <RevealText text={metadata?.displayName?.trim() || 'NekroNXT'} />
            </b>
            <span>
              {updates.status !== undefined && updates.status.channel !== 'development'
                ? `版本 ${versionDescription(updates.status)}`
                : version
                  ? `开发版本 · ${version}`
                  : '开发版本'}
            </span>
          </div>
        </div>
      </Ambient>
      <PropertyList>
        <ProductUpdateRows updates={updates} />
        <UpgradeBackupRows />
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
