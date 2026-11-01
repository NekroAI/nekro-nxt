import { ChevronRight } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type {
  AddonGroup,
  AddonId,
  AddonProviderStatus,
  AddonState,
  AddonStatus,
  RetrievalStatus,
  SpeechLanguage,
  SpeechSettings,
} from '@nekro-nxt/contracts'
import { workspaceApi } from '../../host-api-client.js'
import { useProductStore } from '../../product-runtime.js'
import {
  Button,
  Chip,
  DataTable,
  EmptyState,
  Input,
  MasterDetail,
  ObjectHeader,
  PropertyGroup,
  PropertyList,
  PropertyRow,
  Select,
  Skeleton,
  Switch,
  toast,
  type Column,
  type SelectOption,
  type Tone,
} from '../../ui-kit/index.js'
import { useProductApi } from '../model/store.js'
import { useGo } from '../model/nav.js'
import { SectionHead } from './section-head.js'
import styles from './settings.module.css'

const GROUPS: readonly { readonly key: AddonGroup; readonly label: string }[] = [
  { key: 'extension', label: '扩展能力' },
  { key: 'agent', label: '智能体命令' },
  { key: 'host', label: '系统' },
]

const SOURCE_LABEL: Record<NonNullable<AddonProviderStatus['source']>, string> = {
  bundled: '随 NekroNXT 安装',
  system: '来自这台设备',
  downloaded: '由 NekroNXT 下载',
  cloud: '云端',
}

/** What a capability needs to say beyond its rows, once. */
const ADDON_TIPS: Partial<Record<AddonId, string>> = {
  browser:
    '智能体做的扩展带界面时，试运行要在浏览器里加载并检查。打开着任何一个 NekroNXT 页面时由页面完成；一个页面都没开时由这个浏览器在后台完成。不安装也可以，候选照常运行，标为「界面未检查」。',
}

const megabytes = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024 / 1024))} MB`

const failure = (error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })

export const addonUsable = (state: AddonState | undefined): boolean => state === 'installed' || state === 'available'

/** Label and tone of a capability or a provider; a failed one that has a source is installed but cannot start. */
export const addonStateLabel = (
  state: AddonState,
  progress?: AddonStatus['progress'],
  source?: AddonProviderStatus['source'],
): { readonly label: string; readonly tone: Tone } => {
  switch (state) {
    case 'installing':
      return {
        label:
          progress?.totalBytes === undefined || progress.totalBytes === 0
            ? '正在下载'
            : `正在下载 ${Math.floor((progress.receivedBytes / progress.totalBytes) * 100)}%`,
        tone: 'accent',
      }
    case 'installed':
      return { label: '已安装', tone: 'ok' }
    case 'available':
      return { label: '可用', tone: 'ok' }
    case 'failed':
      return { label: source === undefined ? '安装失败' : '无法使用', tone: 'bad' }
    case 'unsupported':
      return { label: '这台设备不支持', tone: 'neutral' }
    case 'needs-config':
      return { label: '待配置', tone: 'warn' }
    case 'not-installed':
      return { label: '未安装', tone: 'neutral' }
  }
}

export const useAddon = (id: AddonId): AddonStatus | undefined =>
  useProductStore((state) => state.addons.find((addon) => addon.id === id))

/** The provider a capability uses now. */
export const selectedProvider = (addon: AddonStatus): AddonProviderStatus | undefined =>
  addon.providers.find((provider) => provider.id === addon.selected)

/** Whether a capability page has anything to install, remove or choose; a bundled program alone has not. */
export const addonManageable = (addon: AddonStatus): boolean =>
  !addonUsable(addon.state) ||
  addon.providers.length > 1 ||
  addon.providers.some((provider) => provider.installable || provider.removable)

/** The way from a page that relies on an add-on to its detail: 去安装 while it can be installed, 查看 otherwise. */
export function AddonLink({ addon }: { readonly addon: AddonStatus }) {
  const go = useGo()
  return (
    <Button size="small" variant="ghost" onClick={() => go(`/settings/addons/${addon.id}`)}>
      {addonUsable(addon.state) || addon.state === 'unsupported' ? '查看' : '去安装'}
    </Button>
  )
}

/**
 * 设置 → 附加功能 (附加功能 F3): every capability by what uses it; a capability's page lists its providers to install,
 * remove and choose between, plus the capability's own settings.
 */
export function AddonsSection({
  id,
  lead,
  onSelect,
}: {
  readonly id: string | undefined
  readonly lead: ReactNode
  readonly onSelect: (id: string) => void
}) {
  const addons = useProductStore((state) => state.addons)
  const selected = addons.find((addon) => addon.id === id)
  const columns: readonly Column<AddonStatus>[] = [
    {
      key: 'name',
      header: '附加功能',
      width: 'minmax(220px, 2.4fr)',
      render: (addon) => (
        <span className={styles.adapterName}>
          <b>{addon.title}</b>
          <span className={styles.muted}>{addon.summary}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: '状态',
      width: 'minmax(120px, 1fr)',
      render: (addon) => {
        const status = addonStateLabel(addon.state, addon.progress)
        return (
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
  const groups = GROUPS.map((group) => ({
    ...group,
    rows: addons.filter((addon) => addon.group === group.key),
  })).filter((group) => group.rows.length > 0)
  const list = (
    <>
      {lead}
      <SectionHead title="附加功能" subtitle="按需安装到这台设备的程序和模型。" />
      {groups.length === 0 ? (
        <EmptyState title="暂时读不到附加功能">稍后会自动刷新。</EmptyState>
      ) : (
        groups.map((group) => (
          <PropertyGroup key={group.key} title={group.label}>
            <DataTable
              label={group.label}
              columns={columns}
              rows={group.rows}
              rowKey={(addon) => addon.id}
              selectedKey={selected?.id}
              onSelect={(addon) => onSelect(addon.id)}
            />
          </PropertyGroup>
        ))
      )}
    </>
  )
  return (
    <MasterDetail
      label="附加功能"
      lead={lead}
      list={list}
      selectedKey={selected?.id}
      back={{ label: '全部附加功能', onBack: () => onSelect('') }}
      detail={selected ? <AddonDetail key={selected.id} addon={selected} /> : undefined}
    />
  )
}

function AddonDetail({ addon }: { readonly addon: AddonStatus }) {
  const status = addonStateLabel(addon.state, addon.progress, selectedProvider(addon)?.source)
  const choice = addon.providers.length > 1
  return (
    <div className={styles.addonDetail}>
      <ObjectHeader
        level={2}
        size="compact"
        title={addon.title}
        status={<Chip tone={status.tone}>{status.label}</Chip>}
        meta={<span>{addon.summary}</span>}
      />
      <PropertyList>
        <PropertyRow label="使用方" description={addon.usedBy.join('、')} tip={ADDON_TIPS[addon.id]} />
      </PropertyList>
      {addon.providers.map((provider) => (
        <ProviderGroup key={provider.id} addon={addon} provider={provider} choice={choice} />
      ))}
      {addon.id === 'retrieval' ? <RetrievalSettings addon={addon} /> : null}
      {addon.id === 'speech' ? <SpeechCloudSettings /> : null}
    </div>
  )
}

function ProviderGroup({
  addon,
  provider,
  choice,
}: {
  readonly addon: AddonStatus
  readonly provider: AddonProviderStatus
  readonly choice: boolean
}) {
  const api = useProductApi()
  const [busy, setBusy] = useState(false)
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await action()
      await api.getState().refreshHost()
    } catch (error) {
      failure(error)
    } finally {
      setBusy(false)
    }
  }
  const status = addonStateLabel(provider.state, provider.progress, provider.source)
  const inUse = provider.id === addon.selected
  const { downloadBytes, installedBytes, memoryBytes, notes } = provider.resources
  const progress = provider.progress
  return (
    <PropertyGroup
      title={provider.title}
      description={provider.summary || undefined}
      actions={
        !choice ? undefined : inUse ? (
          <Chip tone="ok">正在使用</Chip>
        ) : addonUsable(provider.state) ? (
          <Button
            size="small"
            busy={busy}
            onClick={() => void run(() => workspaceApi.selectAddonProvider(addon.id, provider.id))}
          >
            使用这一项
          </Button>
        ) : undefined
      }
    >
      <PropertyList>
        <PropertyRow
          label="状态"
          description={
            provider.state === 'installing' && progress !== undefined ? (
              <>
                正在下载 {megabytes(progress.receivedBytes)}
                {progress.totalBytes === undefined ? '' : ` / ${megabytes(progress.totalBytes)}`}
                {progress.totalBytes === undefined ? null : (
                  <progress
                    className={styles.updateProgress}
                    aria-label={`${provider.title}下载进度`}
                    max={progress.totalBytes}
                    value={progress.receivedBytes}
                  />
                )}
              </>
            ) : provider.state === 'failed' && provider.error !== undefined ? (
              <span className={styles.noteWarn} role="alert">
                {provider.error}
              </span>
            ) : (
              status.label
            )
          }
        >
          {provider.installable ? (
            <Button
              size="small"
              busy={busy}
              onClick={() => void run(() => workspaceApi.installAddonProvider(addon.id, provider.id))}
            >
              {provider.state === 'failed' ? '重试' : '安装'}
            </Button>
          ) : provider.removable ? (
            <Button
              size="small"
              variant="ghost"
              busy={busy}
              onClick={() => void run(() => workspaceApi.removeAddonProvider(addon.id, provider.id))}
            >
              删除
            </Button>
          ) : undefined}
        </PropertyRow>
        {choice || provider.source === undefined ? null : (
          <PropertyRow label="来源" description={SOURCE_LABEL[provider.source]} />
        )}
        {provider.version === undefined ? null : <PropertyRow label="版本" description={provider.version} />}
        {installedBytes !== undefined ? (
          <PropertyRow label="占用空间" description={megabytes(installedBytes)} />
        ) : downloadBytes !== undefined && provider.source === undefined ? (
          <PropertyRow label="下载大小" description={`约 ${megabytes(downloadBytes)}`} />
        ) : null}
        {memoryBytes === undefined ? null : (
          <PropertyRow label="运行时内存" description={`约 ${megabytes(memoryBytes)}`} />
        )}
        {notes.length === 0 ? null : <PropertyRow label="特点" description={notes.join('、')} />}
        {provider.licenses.length === 0 ? null : (
          <PropertyRow
            label="许可证"
            description={
              <span className={styles.licenses}>
                {provider.licenses.map((license) => (
                  <a
                    key={`${license.component ?? ''}${license.name}`}
                    href={license.url}
                    className={styles.link}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {license.component === undefined ? license.name : `${license.component}：${license.name}`}
                  </a>
                ))}
              </span>
            }
          />
        )}
        {provider.sources.length === 0 ? null : (
          <PropertyRow label="下载来源" description={provider.sources.join('、')} />
        )}
      </PropertyList>
    </PropertyGroup>
  )
}

/** Semantic search over extensions' own collections, e.g. stickers: the switch and the index it builds. */
function RetrievalSettings({ addon }: { readonly addon: AddonStatus }) {
  const [status, setStatus] = useState<RetrievalStatus>()
  const [busy, setBusy] = useState(false)
  const installed = addon.state === 'installed'
  const indexing = status?.vectors.state === 'running'
  useEffect(() => {
    const controller = new AbortController()
    const load = () =>
      workspaceApi
        .getRetrievalStatus({ signal: controller.signal })
        .then(setStatus)
        .catch(() => undefined)
    void load()
    // The index has no push channel; poll only while it is being built.
    const timer = indexing ? setInterval(() => void load(), 1000) : undefined
    return () => {
      controller.abort()
      if (timer !== undefined) clearInterval(timer)
    }
  }, [indexing, installed])
  const change = async (checked: boolean) => {
    setBusy(true)
    try {
      setStatus(await workspaceApi.updateRetrievalMode({ mode: checked ? 'builtin' : 'keyword' }))
    } catch (error) {
      failure(error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <PropertyGroup title="设置">
      <PropertyList>
        <PropertyRow
          label="启用"
          description={installed ? undefined : '安装后可以启用'}
          tip="扩展查找自己保存的资料（比如表情包）时，除了关键词，还按意思找：用「累了」也能找到「加班到崩溃」。模型在本机运行，不会把内容发到别处。"
        >
          {status === undefined ? (
            <Skeleton width={40} height={22} />
          ) : (
            <Switch
              label="启用语义检索"
              checked={status.mode === 'builtin'}
              disabled={!installed || busy}
              onCheckedChange={(checked) => void change(checked)}
            />
          )}
        </PropertyRow>
        {status?.mode === 'builtin' ? (
          <PropertyRow label="语义索引" description="新保存的资料会在几秒内加入">
            {status.vectors.error !== undefined ? (
              <span className={styles.noteWarn} role="alert">
                {status.vectors.error}
              </span>
            ) : (
              <span className={styles.note} role="status">
                {status.vectors.state === 'ready'
                  ? `已就绪，共 ${status.vectors.documents} 条`
                  : `正在建立 ${status.vectors.embedded} / ${status.vectors.documents}`}
              </span>
            )}
          </PropertyRow>
        ) : null}
      </PropertyList>
    </PropertyGroup>
  )
}

const SPEECH_LANGUAGES: readonly (SelectOption & { readonly value: SpeechLanguage })[] = [
  { value: 'auto', label: '自动识别' },
  { value: 'zh', label: '中文' },
  { value: 'en', label: '英语' },
  { value: 'ja', label: '日语' },
  { value: 'ko', label: '韩语' },
  { value: 'yue', label: '粤语' },
]

/** Which model provider and model cloud speech recognition uses; saved once both are filled in. */
function SpeechCloudSettings() {
  const api = useProductApi()
  const [settings, setSettings] = useState<SpeechSettings>()
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [language, setLanguage] = useState<SpeechLanguage>('auto')
  const [busy, setBusy] = useState(false)
  const apply = (view: SpeechSettings) => {
    setSettings(view)
    setProvider(view.cloud?.provider ?? '')
    setModel(view.cloud?.model ?? '')
    setLanguage(view.cloud?.language ?? 'auto')
  }
  useEffect(() => {
    const controller = new AbortController()
    workspaceApi
      .getSpeechSettings({ signal: controller.signal })
      .then(apply)
      .catch(() => undefined)
    return () => controller.abort()
  }, [])
  const update = async (cloud: SpeechSettings['cloud']) => {
    setBusy(true)
    try {
      apply(await workspaceApi.updateSpeechSettings({ cloud }))
      await api.getState().refreshHost()
      toast(cloud === null ? '已清除' : '已保存')
    } catch (error) {
      failure(error)
    } finally {
      setBusy(false)
    }
  }
  const save = (next: { readonly provider: string; readonly model: string; readonly language: SpeechLanguage }) => {
    const trimmed = next.model.trim()
    if (next.provider === '' || trimmed === '') return
    const current = settings?.cloud
    if (
      current?.provider === next.provider &&
      current.model === trimmed &&
      (current.language ?? 'auto') === next.language
    ) {
      return
    }
    void update({
      provider: next.provider,
      model: trimmed,
      ...(next.language === 'auto' ? {} : { language: next.language }),
    })
  }
  const providers = settings?.providers ?? []
  return (
    <PropertyGroup
      title="云端设置"
      actions={
        settings?.cloud ? (
          <Button size="small" variant="ghost" busy={busy} onClick={() => void update(null)}>
            清除
          </Button>
        ) : undefined
      }
    >
      <PropertyList>
        <PropertyRow
          label="供应商"
          description={
            settings !== undefined && providers.length === 0
              ? '在「设置 → 模型」添加 OpenAI 兼容的供应商后，可以在这里选择'
              : undefined
          }
          tip="需要供应商提供 OpenAI 兼容的语音转写，费用按供应商的价格计算。"
        >
          {settings === undefined ? (
            <Skeleton width={180} height={28} />
          ) : providers.length === 0 ? undefined : (
            <Select
              aria-label="云端语音识别的供应商"
              placeholder="选择供应商"
              value={provider}
              disabled={busy}
              options={providers.map((entry) => ({ value: entry.provider, label: entry.displayName }))}
              onValueChange={(value) => {
                setProvider(value)
                save({ provider: value, model, language })
              }}
            />
          )}
        </PropertyRow>
        <PropertyRow
          label="模型"
          width="sm"
          tip="填写供应商的语音转写模型名，例如 whisper-1、FunAudioLLM/SenseVoiceSmall。"
        >
          {settings === undefined ? (
            <Skeleton width={180} height={28} />
          ) : (
            <Input
              aria-label="云端语音识别的模型"
              placeholder="例如 whisper-1"
              value={model}
              disabled={busy || providers.length === 0}
              onChange={(event) => setModel(event.target.value)}
              onBlur={() => save({ provider, model, language })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  save({ provider, model, language })
                }
              }}
            />
          )}
        </PropertyRow>
        <PropertyRow label="语言" tip="扩展没有指定语言时使用。">
          {settings === undefined ? (
            <Skeleton width={120} height={28} />
          ) : (
            <Select
              aria-label="云端语音识别的语言"
              value={language}
              disabled={busy || providers.length === 0}
              options={SPEECH_LANGUAGES}
              onValueChange={(value) => {
                const next = SPEECH_LANGUAGES.find((option) => option.value === value)?.value ?? 'auto'
                setLanguage(next)
                save({ provider, model, language: next })
              }}
            />
          )}
        </PropertyRow>
      </PropertyList>
    </PropertyGroup>
  )
}
