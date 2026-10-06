import { LlmProviderRemovalDialog } from './llm-provider-removal.js'
import { useProductRuntime } from './product-runtime.js'
import { StaleHostReadError, callHostApi } from './host-api-client.js'
import { ChevronRight, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { HostApiContracts, type HostApiResponse } from '@nekro-nxt/contracts'
import { providerDisplayName } from './provider-labels.js'
import {
  ModelListEditor,
  ModelListView,
  modelPayload,
  modelRowFromModel,
  modelRowsError,
  modelsToAdd,
  type ModelRow,
} from './llm-model-editor.js'
import {
  Banner,
  Button,
  Chip,
  ConfirmDialog,
  Diagnostics,
  Dialog,
  Disclosure,
  EmptyState,
  Field,
  Input,
  ObjectHeader,
  Pressable,
  PropertyGroup,
  SecretInput,
  Select,
  Skeleton,
  toast,
  type Tone,
} from './ui-kit/next/index.js'
import styles from './llm-settings.module.css'

type ProviderSettingsView = HostApiResponse<'llmProviders'>
export type ProviderView = ProviderSettingsView['providers'][number]
type DiscoveredModelView = HostApiResponse<'llmDiscoverModels'>['models'][number]

/** DSH model adapters whose per-route model list product settings can edit. */
const EDITABLE_MODEL_NAMESPACES = new Set(['llm-pi-ai', 'llm-deepseek'])
/** Select value standing for "no route-wide protocol": each catalog model keeps its own. */
const CATALOG_PROTOCOL = '__catalog__'
/** Selection key of a provider that does not exist yet (custom OpenAI-compatible route). */
export const CUSTOM_PROVIDER = '__custom__'

const failure = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const customProviderKey = (displayName: string, providers: readonly ProviderView[]): string => {
  const base =
    displayName
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-|-$/gu, '') || 'custom-provider'
  let candidate = base
  let suffix = 2
  while (providers.some((provider) => provider.provider === candidate)) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  return candidate
}

/** How a provider is wired: user-declared, the generic catalog route, or a fixed built-in adapter. */
export const providerKind = (provider: ProviderView): string =>
  provider.declared ? '自定义接入' : provider.settingsNs === 'llm-pi-ai' ? '通用接入' : '内置固定接入'

export const providerStatus = (provider: ProviderView): { readonly label: string; readonly tone: Tone } =>
  provider.active
    ? { label: '可用', tone: 'ok' }
    : provider.configured
      ? { label: '待启用', tone: 'warn' }
      : { label: '未配置', tone: 'neutral' }

/** The shared provider catalog query; the first caller loads it. */
export function useLlmProviders() {
  const store = useProductRuntime().store
  const query = store((state) => state.llmProvidersQuery)
  const load = async (): Promise<ProviderSettingsView | undefined> => {
    try {
      return await store.getState().loadLlmProviders()
    } catch (cause) {
      if (cause instanceof StaleHostReadError) return undefined
      if (query.data) toast(`模型供应商刷新失败：${failure(cause)}`, { tone: 'bad', group: 'llm-provider-refresh' })
      return undefined
    }
  }
  return { settings: query.data ?? null, loading: query.loading, error: query.error, load }
}

/** Chooses an unconfigured catalog provider or the custom route to start configuring. */
export function AddProviderDialog({
  open,
  onOpenChange,
  providers,
  onPick,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly providers: readonly ProviderView[]
  readonly onPick: (provider: string) => void
}) {
  const available = providers.filter((provider) => !provider.configured)
  const [candidate, setCandidate] = useState('')
  useEffect(() => {
    if (open) setCandidate(available[0]?.provider ?? CUSTOM_PROVIDER)
    // Reset only on open; the catalog refreshing must not override the user's pick.
  }, [open])
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="添加模型供应商"
      actions={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onOpenChange(false)
              onPick(candidate)
            }}
          >
            开始配置
          </Button>
        </>
      }
    >
      <Field label="模型供应商" hint="候选项来自当前运行环境的供应商目录。">
        <Select
          value={candidate}
          onChange={(event) => setCandidate(event.target.value)}
          options={[
            ...available.map((provider) => ({
              value: provider.provider,
              label: providerDisplayName(provider.provider, provider.displayName),
            })),
            { value: CUSTOM_PROVIDER, label: '自定义 OpenAI 兼容供应商' },
          ]}
        />
      </Field>
    </Dialog>
  )
}

/**
 * One provider's configuration: credential, model catalog, connection test, advanced route settings and removal.
 * `providerId` may be {@link CUSTOM_PROVIDER} for a provider that is being created.
 */
export function ModelProviderDetail({
  providerId: requested,
  onSelect,
}: {
  readonly providerId: string
  readonly onSelect: (provider: string) => void
}): ReactNode {
  const store = useProductRuntime().store
  const { settings } = useLlmProviders()
  const customMode = requested === CUSTOM_PROVIDER
  const selected = useMemo(
    () => (customMode ? undefined : settings?.providers.find((provider) => provider.provider === requested)),
    [customMode, requested, settings],
  )
  const [displayName, setDisplayName] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [api, setApi] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [rows, setRows] = useState<readonly ModelRow[]>([])
  const [modelsDirty, setModelsDirty] = useState(false)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(customMode)
  const [discovered, setDiscovered] = useState<readonly DiscoveredModelView[]>([])
  const [pending, setPending] = useState<'save' | 'discover' | 'test' | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const advancedId = useId()

  const customEditor = customMode || selected?.declared === true
  const providerId = customMode
    ? settings
      ? customProviderKey(displayName, settings.providers)
      : ''
    : (selected?.provider ?? '')
  const modelsEditable = customEditor || (selected !== undefined && EDITABLE_MODEL_NAMESPACES.has(selected.settingsNs))
  const discoverable = customMode || selected?.discoverable === true
  const submitsModels = customEditor || modelsDirty
  const catalogRoute = !customEditor && selected?.settingsNs === 'llm-pi-ai'
  const restorable = !customMode && selected?.declared === false && selected.modelsCustomized
  const modelsError = modelsEditable && submitsModels ? modelRowsError(rows) : undefined
  const submittedModels = modelPayload(rows)
  const testModels = submitsModels ? submittedModels : selected?.models.length ? selected.models : discovered
  const testModel = testModels[0]
  const testModelName = testModel && 'name' in testModel ? (testModel.name ?? testModel.id) : testModel?.id

  // A different provider (or fresh data for it) resets the draft; typing never does.
  const selectedKey = selected ? `${selected.provider}:${selected.settingsRevision}` : requested
  useEffect(() => {
    setSubmitted(false)
    setDiscovered([])
    setApiKey('')
    setModelsDirty(false)
    if (customMode) {
      setDisplayName('')
      setBaseURL('')
      setApi(settings?.protocols[0] ?? '')
      setRows([])
      setAdvancedOpen(true)
      return
    }
    if (!selected) return
    setDisplayName(providerDisplayName(selected.provider, selected.displayName))
    setBaseURL(selected.baseURL ?? '')
    setApi(selected.api ?? '')
    setRows(selected.models.map(modelRowFromModel))
  }, [selectedKey])

  if (!settings) return null
  if (!customMode && !selected) {
    return <EmptyState title="没有找到这个供应商" action={<Button onClick={() => onSelect('')}>返回模型</Button>} />
  }

  const discover = async (): Promise<void> => {
    if (!providerId || pending) return
    setPending('discover')
    try {
      const result = await callHostApi(
        HostApiContracts.llmDiscoverModels,
        {},
        {
          provider: providerId,
          settingsNs: selected?.settingsNs ?? 'llm-pi-ai',
          ...(baseURL.trim() ? { baseURL: baseURL.trim() } : {}),
          ...(api ? { api } : {}),
          ...(apiKey ? { apiKey } : {}),
        },
      )
      setDiscovered(result.models)
      if (customEditor && rows.length === 0 && result.models.length > 0) {
        setRows(result.models.map(modelRowFromModel))
        setModelsDirty(true)
      }
      const missing = modelsToAdd(rows, result.models).length
      toast(
        missing > 0
          ? `已找到 ${result.models.length} 个可用模型，其中 ${missing} 个尚未加入列表。`
          : `已找到 ${result.models.length} 个可用模型，均已在列表中。`,
        { group: `llm-provider-discover:${providerId}` },
      )
    } catch (cause) {
      toast(failure(cause), { tone: 'bad', group: `llm-provider-discover:${providerId}` })
    } finally {
      setPending(null)
    }
  }

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setSubmitted(true)
    if (!providerId || (customEditor && (!displayName.trim() || !baseURL.trim() || !api)) || modelsError) return
    const revision = customMode
      ? (settings.providers.find((provider) => provider.settingsNs === 'llm-pi-ai')?.settingsRevision ?? 0)
      : selected?.settingsRevision
    if (revision === undefined || pending) return
    setPending('save')
    try {
      const next = await callHostApi(
        HostApiContracts.llmSaveProvider,
        { provider: providerId },
        {
          expectedRevision: revision,
          ...(apiKey ? { apiKey } : {}),
          ...(baseURL.trim() ? { baseURL: baseURL.trim() } : {}),
          ...(customEditor ? { displayName: displayName.trim() } : {}),
          ...(api && (customEditor || catalogRoute) ? { api } : {}),
          ...(submitsModels ? { models: submittedModels } : {}),
        },
      )
      store.getState().replaceLlmProviders(next)
      setApiKey('')
      setModelsDirty(false)
      setSubmitted(false)
      if (customMode) onSelect(providerId)
      try {
        await store.getState().refreshHost()
        toast('供应商配置已保存。API 密钥只写入本机凭据存储。', { group: `llm-provider-save:${providerId}` })
      } catch (refreshError) {
        toast(`配置已保存，但页面数据刷新失败：${failure(refreshError)}`, {
          tone: 'bad',
          group: `llm-provider-save:${providerId}`,
        })
      }
    } catch (cause) {
      toast(failure(cause), { tone: 'bad', group: `llm-provider-save:${providerId}` })
    } finally {
      setPending(null)
    }
  }

  const restoreModels = async (): Promise<void> => {
    if (!selected) return
    const next = await callHostApi(
      HostApiContracts.llmRestoreProviderModels,
      { provider: selected.provider },
      { expectedRevision: selected.settingsRevision },
    )
    store.getState().replaceLlmProviders(next)
    // The restored catalog may keep the same revision; show it explicitly instead of waiting for a key change.
    const restored = next.providers.find((provider) => provider.provider === selected.provider)
    if (restored) setRows(restored.models.map(modelRowFromModel))
    setModelsDirty(false)
    toast('已恢复供应商自带的模型列表。', { group: `llm-provider-restore:${selected.provider}` })
    void store
      .getState()
      .refreshHost()
      .catch(() => undefined)
  }

  const testConnection = async (): Promise<void> => {
    if (!providerId || !testModel || pending) return
    setPending('test')
    try {
      await callHostApi(
        HostApiContracts.llmTestProvider,
        {},
        {
          provider: providerId,
          model: testModel.id,
          settingsNs: selected?.settingsNs ?? 'llm-pi-ai',
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...(baseURL.trim() ? { baseURL: baseURL.trim() } : {}),
          ...(api ? { api } : {}),
          models: testModels.map((model) => ({ ...model })),
        },
      )
      toast(`当前页面配置测试通过，可使用 ${testModelName}。`, { group: `llm-provider-test:${providerId}` })
    } catch (cause) {
      toast(failure(cause), { tone: 'bad', group: `llm-provider-test:${providerId}` })
    } finally {
      setPending(null)
    }
  }

  const displayNameError = submitted && customEditor && !displayName.trim() ? '请输入供应商名称。' : undefined
  const baseUrlError = submitted && customEditor && !baseURL.trim() ? '请输入 API 地址。' : undefined
  const apiError = submitted && customEditor && !api ? '请选择 API 协议。' : undefined
  const canSave =
    settings.writable &&
    Boolean(providerId) &&
    modelsError === undefined &&
    (!customEditor || Boolean(displayName.trim() && baseURL.trim() && api))
  const canTest =
    Boolean(providerId && testModel) && modelsError === undefined && (!customEditor || Boolean(baseURL.trim() && api))
  const status = selected ? providerStatus(selected) : undefined
  const title = selected ? providerDisplayName(selected.provider, selected.displayName) : '自定义供应商'

  return (
    <form className={styles.detail} autoComplete="off" onSubmit={(event) => void save(event)}>
      <ObjectHeader
        level={2}
        size="compact"
        title={title}
        status={status ? <Chip tone={status.tone}>{status.label}</Chip> : <Chip>新建</Chip>}
        meta={
          selected ? (
            <>
              <span>{providerKind(selected)}</span>
              <span>{selected.models.length} 个模型</span>
              <span>{selected.credential?.configured ? 'API 密钥已保存' : '尚未保存 API 密钥'}</span>
            </>
          ) : (
            <span>连接任意 OpenAI 兼容接口</span>
          )
        }
      />

      <PropertyGroup title="凭据">
        <div className={styles.fields}>
          {customEditor ? (
            <Field label="供应商名称" error={displayNameError}>
              <Input value={displayName} maxLength={80} onChange={(event) => setDisplayName(event.target.value)} />
            </Field>
          ) : null}
          <Field
            label="API 密钥"
            hint={
              selected?.credential?.configured ? '留空表示沿用当前密钥；已保存密钥无法查看。' : '保存后的密钥无法查看。'
            }
          >
            <SecretInput
              configured={selected?.credential?.configured === true}
              data-1p-ignore="true"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </Field>
        </div>
      </PropertyGroup>

      <PropertyGroup
        title="模型"
        description={
          modelsEditable
            ? `打开“看图”的模型可以直接理解频道里的图片。${catalogRoute ? '加入目录外的模型时，需要在高级设置中选择 API 协议。' : ''}`
            : '这个供应商的模型由其适配器固定提供。'
        }
        actions={
          <>
            {restorable ? <Chip tone="accent">已自定义</Chip> : null}
            {restorable ? (
              <Button size="small" variant="ghost" disabled={pending !== null} onClick={() => setRestoreOpen(true)}>
                恢复默认模型
              </Button>
            ) : null}
          </>
        }
      >
        {modelsEditable ? (
          <ModelListEditor
            rows={rows}
            discovered={discovered}
            disabled={pending !== null}
            error={modelsError}
            onChange={(next) => {
              setRows(next)
              setModelsDirty(true)
            }}
          />
        ) : (
          <ModelListView models={selected?.models ?? []} />
        )}
      </PropertyGroup>

      {customEditor || catalogRoute || selected ? (
        <PropertyGroup
          title={
            <Pressable
              className={styles.disclosureToggle}
              aria-expanded={advancedOpen}
              aria-controls={advancedId}
              onClick={() => setAdvancedOpen(!advancedOpen)}
            >
              <ChevronRight size={14} aria-hidden="true" className={styles.chevron} data-open={advancedOpen} />
              高级设置
            </Pressable>
          }
        >
          <Disclosure open={advancedOpen} id={advancedId}>
            <div className={styles.fields}>
              <Field
                label="API 地址"
                hint={!customEditor ? '留空使用供应商默认地址。' : undefined}
                error={baseUrlError}
              >
                <Input
                  value={baseURL}
                  spellCheck={false}
                  placeholder="https://…/v1"
                  onChange={(event) => setBaseURL(event.target.value)}
                />
              </Field>
              {customEditor ? (
                <Field label="API 协议" error={apiError}>
                  <Select
                    value={api}
                    placeholder="选择协议"
                    onChange={(event) => setApi(event.target.value)}
                    options={settings.protocols.map((protocol) => ({ value: protocol, label: protocol }))}
                  />
                </Field>
              ) : catalogRoute ? (
                <Field label="API 协议" hint="选择后该供应商的全部模型都使用此协议；加入目录外的模型时必须选择。">
                  <Select
                    value={api || CATALOG_PROTOCOL}
                    onChange={(event) => setApi(event.target.value === CATALOG_PROTOCOL ? '' : event.target.value)}
                    options={[
                      { value: CATALOG_PROTOCOL, label: '沿用各模型自带协议' },
                      ...settings.protocols.map((protocol) => ({ value: protocol, label: protocol })),
                    ]}
                  />
                </Field>
              ) : null}
            </div>
          </Disclosure>
        </PropertyGroup>
      ) : null}

      {selected ? (
        <Diagnostics
          items={[
            { label: '供应商标识', value: selected.provider },
            { label: '配置区域', value: selected.settingsNs },
            { label: '配置版本', value: String(selected.settingsRevision) },
          ]}
        />
      ) : null}

      {selected?.configured ? (
        <div className={styles.dangerRow}>
          <span className={styles.muted}>
            {selected.declared ? '删除这个自定义供应商及其模型。' : '移除已保存的配置，供应商仍留在目录中。'}
          </span>
          <Button
            variant="danger"
            icon={<Trash2 size={14} aria-hidden="true" />}
            disabled={pending !== null}
            onClick={() => setRemoving(true)}
          >
            {selected.declared ? '删除供应商' : '移除配置'}
          </Button>
        </div>
      ) : null}

      <div className={styles.actionBar}>
        <div className={styles.actionBarStart}>
          {discoverable ? (
            <Button
              busy={pending === 'discover'}
              disabled={!providerId || pending !== null}
              onClick={() => void discover()}
            >
              获取可用模型
            </Button>
          ) : null}
          <Button
            busy={pending === 'test'}
            disabled={!canTest || pending !== null}
            onClick={() => void testConnection()}
          >
            测试连接
          </Button>
        </div>
        <Button type="submit" variant="primary" busy={pending === 'save'} disabled={!canSave || pending !== null}>
          保存供应商
        </Button>
      </div>

      {removing && selected ? (
        <LlmProviderRemovalDialog
          key={selected.provider}
          provider={selected.provider}
          onClose={() => setRemoving(false)}
          onRemoved={(next) => {
            store.getState().replaceLlmProviders(next)
            setRemoving(false)
            onSelect(next.providers.find((provider) => provider.configured)?.provider ?? '')
            toast('供应商配置已移除，API 密钥已保留。', { group: 'llm-provider-remove' })
            void store
              .getState()
              .refreshHost()
              .catch((cause: unknown) => {
                toast(`配置已移除，但页面数据刷新失败：${failure(cause)}`, {
                  tone: 'bad',
                  group: 'llm-provider-remove-refresh',
                })
              })
          }}
        />
      ) : null}
      <ConfirmDialog
        open={restoreOpen}
        onOpenChange={setRestoreOpen}
        title="恢复默认模型"
        confirmLabel="恢复默认模型"
        onConfirm={restoreModels}
      >
        {title}将改回供应商自带的模型列表，在这里新增或修改的模型会被移除。使用被移除模型的智能体需要重新选择模型。
      </ConfirmDialog>
    </form>
  )
}

/** Loading and failure states shared by the model settings views. */
export function ProviderCatalogState({ onRetry }: { readonly onRetry: () => void }): ReactNode {
  const { settings, error } = useLlmProviders()
  if (settings) return null
  if (!error) {
    return (
      <div className={styles.loading} role="status" aria-label="正在读取模型供应商">
        <Skeleton height={28} width="40%" />
        <Skeleton height={120} />
      </div>
    )
  }
  return (
    <EmptyState
      title="无法读取模型供应商"
      action={
        <Button icon={<RefreshCw size={14} aria-hidden="true" />} onClick={onRetry}>
          重新加载
        </Button>
      }
    >
      {error || '请检查连接后重试。'}
    </EmptyState>
  )
}

/** Inline credential form used where a model is needed right away (creating the first agent). */
export function AddModelProviderForm({ onSaved }: { readonly onSaved?: () => void }): ReactNode {
  const store = useProductRuntime().store
  const { settings, error: queryError, load } = useLlmProviders()
  const [providerId, setProviderId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void load().then((next) => {
      if (!next) return
      setProviderId((current) =>
        next.providers.some((provider) => provider.provider === current)
          ? current
          : (next.providers.find((provider) => !provider.configured)?.provider ?? next.providers[0]?.provider ?? ''),
      )
    })
  }, [])

  const selected = settings?.providers.find((provider) => provider.provider === providerId)
  const saveable = settings?.writable === true && providerId !== ''

  const save = async (): Promise<void> => {
    if (!settings || !selected || saving) return
    if (!apiKey.trim() && !selected.credential?.configured) {
      setError('请输入 API 密钥。')
      return
    }
    setSaving(true)
    setError('')
    try {
      const next = await callHostApi(
        HostApiContracts.llmSaveProvider,
        { provider: selected.provider },
        { expectedRevision: selected.settingsRevision, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) },
      )
      store.getState().replaceLlmProviders(next)
      setApiKey('')
      try {
        await store.getState().refreshHost()
        toast('供应商配置已保存。API 密钥只写入本机凭据存储。', { group: `llm-provider-save:${selected.provider}` })
        onSaved?.()
      } catch (refreshError) {
        toast(`配置已保存，但页面数据刷新失败：${failure(refreshError)}`, {
          tone: 'bad',
          group: `llm-provider-save:${selected.provider}`,
        })
      }
    } catch (cause) {
      setError(failure(cause))
    } finally {
      setSaving(false)
    }
  }

  if (!settings && !queryError) {
    return (
      <div className={styles.loading} role="status" aria-label="正在读取模型供应商">
        <Skeleton height={32} />
        <Skeleton height={32} />
      </div>
    )
  }
  if (!settings) {
    return (
      <Banner tone="bad" action={<Button onClick={() => void load()}>重新加载</Button>}>
        无法读取模型供应商：{queryError || '请检查连接后重试。'}
      </Banner>
    )
  }
  if (settings.providers.length === 0) {
    return <Banner tone="info">当前没有可配置的供应商。完整目录和自定义供应商位于设置。</Banner>
  }

  return (
    <div className={styles.compactForm}>
      <Field label="模型供应商">
        <Select
          value={providerId}
          onChange={(event) => setProviderId(event.target.value)}
          options={settings.providers.map((provider) => ({
            value: provider.provider,
            label: providerDisplayName(provider.provider, provider.displayName),
          }))}
        />
      </Field>
      <Field label="API 密钥" hint="保存后的密钥无法查看。" error={error || undefined}>
        <SecretInput
          configured={selected?.credential?.configured === true}
          data-1p-ignore="true"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </Field>
      <div className={styles.compactActions}>
        <Button variant="primary" busy={saving} disabled={!saveable} onClick={() => void save()}>
          保存供应商
        </Button>
      </div>
    </div>
  )
}
