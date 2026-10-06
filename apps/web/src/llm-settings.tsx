import { LlmProviderRemovalDialog } from './llm-provider-removal.js'
import { useProductRuntime } from './product-runtime.js'
import { StaleHostReadError, callHostApi } from './host-api-client.js'
import { Plus, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { HostApiContracts, type HostApiResponse } from '@nekro-nxt/contracts'
import { notify } from './components/notifications.js'
import { EmptyState } from './components/product-feedback.js'
import { providerDisplayName } from './provider-labels.js'
import {
  ModelListEditor,
  modelPayload,
  modelRowFromModel,
  modelRowsError,
  modelsToAdd,
  type ModelRow,
} from './llm-model-editor.js'
import { Button, ConfirmDialog, Dialog, Field, Input, SecretInput, SelectField, StatusBadge } from './ui-kit/index.js'
import styles from './llm-settings.module.css'

type ProviderSettingsView = HostApiResponse<'llmProviders'>
type ProviderView = ProviderSettingsView['providers'][number]
type DiscoveredModelView = HostApiResponse<'llmDiscoverModels'>['models'][number]

/** DSH model adapters whose per-route model list product settings can edit. */
const EDITABLE_MODEL_NAMESPACES = new Set(['llm-pi-ai', 'llm-deepseek'])
/** Select value standing for "no route-wide protocol": each catalog model keeps its own. */
const CATALOG_PROTOCOL = '__catalog__'

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

export function LlmProviderSettings(): React.ReactNode {
  const useProductStore = useProductRuntime().store

  const query = useProductStore((state) => state.llmProvidersQuery)
  const settings = query.data ?? null
  const [selectedId, setSelectedId] = useState('')
  const [customMode, setCustomMode] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [removingProvider, setRemovingProvider] = useState('')
  const [addCandidate, setAddCandidate] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [api, setApi] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [rows, setRows] = useState<readonly ModelRow[]>([])
  const [modelsDirty, setModelsDirty] = useState(false)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [discovered, setDiscovered] = useState<readonly DiscoveredModelView[]>([])
  const [operation, setPending] = useState<'save' | 'discover' | 'test' | 'restore' | null>(null)
  const pending = operation ?? (query.loading ? 'load' : null)
  const [actionError, setError] = useState('')
  const error = actionError || query.error
  const [submitted, setSubmitted] = useState(false)

  const selected = useMemo(
    () => settings?.providers.find((provider) => provider.provider === selectedId),
    [selectedId, settings],
  )
  const selectedDisplayName = selected ? providerDisplayName(selected.provider, selected.displayName) : undefined
  const configuredProviders = settings?.providers.filter((provider) => provider.configured) ?? []
  const availableProviders = settings?.providers.filter((provider) => !provider.configured) ?? []
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

  const load = async (): Promise<void> => {
    if (pending === 'load' && settings) return
    try {
      const next = await useProductStore.getState().loadLlmProviders()
      setSelectedId((current) =>
        next.providers.some((provider) => provider.provider === current && provider.configured)
          ? current
          : (next.providers.find((provider) => provider.configured)?.provider ?? ''),
      )
    } catch (cause) {
      if (cause instanceof StaleHostReadError) return
      const message = cause instanceof Error ? cause.message : String(cause)
      if (settings) notify(`模型供应商刷新失败：${message}`, 'error', 'llm-provider-refresh')
    }
  }

  useEffect(() => {
    void load()
    // The initial request owns this effect; subsequent refreshes are explicit user actions.
  }, [])

  useEffect(() => {
    if (!selected || customMode) return
    setDisplayName(providerDisplayName(selected.provider, selected.displayName))
    setBaseURL(selected.baseURL ?? '')
    setApi(selected.api ?? '')
    setRows(selected.models.map(modelRowFromModel))
    setModelsDirty(false)
    setApiKey('')
    setDiscovered([])
    setSubmitted(false)
  }, [customMode, selected])

  const enterCustomMode = (): void => {
    setCustomMode(true)
    setDisplayName('')
    setBaseURL('')
    setApi(settings?.protocols[0] ?? '')
    setRows([])
    setModelsDirty(false)
    setApiKey('')
    setDiscovered([])
    setError('')
    setSubmitted(false)
  }

  const selectProvider = (provider: ProviderView): void => {
    setCustomMode(false)
    setSelectedId(provider.provider)
    setError('')
    setSubmitted(false)
  }

  const discover = async (): Promise<void> => {
    if (!providerId || pending) return
    setPending('discover')
    setError('')
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
      notify(
        missing > 0
          ? `已找到 ${result.models.length} 个可用模型，其中 ${missing} 个尚未加入列表。`
          : `已找到 ${result.models.length} 个可用模型，均已在列表中。`,
        'success',
        `llm-provider-discover:${providerId}`,
      )
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause), 'error', `llm-provider-discover:${providerId}`)
    } finally {
      setPending(null)
    }
  }

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setSubmitted(true)
    if (
      !settings ||
      !providerId ||
      (customEditor && (!displayName.trim() || !baseURL.trim() || !api)) ||
      modelsError !== undefined
    ) {
      return
    }
    const revision = customMode
      ? (settings.providers.find((provider) => provider.settingsNs === 'llm-pi-ai')?.settingsRevision ?? 0)
      : selected?.settingsRevision
    if (revision === undefined || pending) return
    setPending('save')
    setError('')
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
      useProductStore.getState().replaceLlmProviders(next)
      setSelectedId(providerId)
      setCustomMode(false)
      setApiKey('')
      setModelsDirty(false)
      setSubmitted(false)
      try {
        await useProductStore.getState().refreshHost()
        notify('供应商配置已保存。API 密钥只写入本机凭据存储。', 'success', `llm-provider-save:${providerId}`)
      } catch (refreshError) {
        notify(
          `配置已保存，但页面数据刷新失败：${refreshError instanceof Error ? refreshError.message : String(refreshError)}`,
          'warning',
          `llm-provider-save:${providerId}`,
        )
      }
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause), 'error', `llm-provider-save:${providerId}`)
    } finally {
      setPending(null)
    }
  }

  const restoreModels = async (): Promise<boolean> => {
    if (!selected || pending) return false
    setPending('restore')
    try {
      const next = await callHostApi(
        HostApiContracts.llmRestoreProviderModels,
        { provider: selected.provider },
        { expectedRevision: selected.settingsRevision },
      )
      useProductStore.getState().replaceLlmProviders(next)
      setModelsDirty(false)
      notify('已恢复供应商自带的模型列表。', 'success', `llm-provider-restore:${selected.provider}`)
      void useProductStore
        .getState()
        .refreshHost()
        .catch(() => undefined)
      return true
    } catch (cause) {
      notify(
        cause instanceof Error ? cause.message : String(cause),
        'error',
        `llm-provider-restore:${selected.provider}`,
      )
      return false
    } finally {
      setPending(null)
    }
  }

  const testConnection = async (): Promise<void> => {
    if (!providerId || !testModel || pending) return
    setPending('test')
    setError('')
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
      notify(`当前页面配置测试通过，可使用 ${testModelName}。`, 'success', `llm-provider-test:${providerId}`)
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause), 'error', `llm-provider-test:${providerId}`)
    } finally {
      setPending(null)
    }
  }

  const displayNameError = submitted && customEditor && !displayName.trim() ? '请输入供应商名称。' : undefined
  const baseUrlError = submitted && customEditor && !baseURL.trim() ? '请输入 API 地址。' : undefined
  const apiError = submitted && customEditor && !api ? '请选择 API 协议。' : undefined
  const canSave =
    settings?.writable === true &&
    Boolean(providerId) &&
    modelsError === undefined &&
    (!customEditor || Boolean(displayName.trim() && baseURL.trim() && api))
  const canTest =
    Boolean(providerId && testModel) && modelsError === undefined && (!customEditor || Boolean(baseURL.trim() && api))

  if (!settings && !query.error) {
    return <EmptyState loading title="正在读取模型供应商" description="加载完成后可管理 API 密钥和模型。" />
  }

  if (!settings) {
    return (
      <EmptyState
        title="无法读取模型供应商"
        description={error || '请检查连接后重试。'}
        action={
          <Button onClick={() => void load()}>
            <RefreshCw size={14} aria-hidden="true" /> 重新加载
          </Button>
        }
      />
    )
  }

  return (
    <div className={styles.providerSettings}>
      <div className={styles.toolbar}>
        <div>
          <h2>供应商配置</h2>
          <p>管理模型访问凭据和可用模型。</p>
        </div>
        <Button
          size="small"
          loading={pending === 'load'}
          loadingLabel="刷新中…"
          disabled={pending !== null}
          onClick={() => void load()}
        >
          <RefreshCw size={14} aria-hidden="true" /> 刷新
        </Button>
      </div>

      <div className={styles.layout}>
        <aside className={styles.providerList} aria-label="供应商列表">
          {configuredProviders.length === 0 ? <div className={styles.listEmpty}>还没有已配置的供应商</div> : null}
          {configuredProviders.map((provider) => (
            <Button
              className={[
                styles.providerButton,
                provider.provider === selectedId && !customMode ? styles.providerButtonActive : '',
              ]
                .filter(Boolean)
                .join(' ')}
              variant="ghost"
              onClick={() => selectProvider(provider)}
              key={provider.provider}
            >
              <span>
                <strong>{providerDisplayName(provider.provider, provider.displayName)}</strong>
                <small>
                  {provider.declared ? '自定义接入' : provider.settingsNs === 'llm-pi-ai' ? '通用接入' : '内置固定接入'}{' '}
                  · {provider.models.length} 个模型
                </small>
              </span>
              <StatusBadge tone={provider.active ? 'success' : 'warning'}>
                {provider.active ? '可用' : '待启用'}
              </StatusBadge>
            </Button>
          ))}
          <Button
            className={styles.addProvider}
            onClick={() => {
              setAddCandidate(availableProviders[0]?.provider ?? '__custom__')
              setAddOpen(true)
            }}
          >
            <Plus size={14} aria-hidden="true" /> 添加供应商
          </Button>
        </aside>

        {selected || customMode ? (
          <form className={styles.editor} autoComplete="off" onSubmit={(event) => void save(event)}>
            <div className={styles.editorHeading}>
              <div>
                <h3>{customMode ? '自定义供应商' : (selectedDisplayName ?? '选择供应商')}</h3>
                {selected ? <p>{selected.credential?.configured ? 'API 密钥已保存' : '尚未保存 API 密钥'}</p> : null}
              </div>
              {selected ? (
                <StatusBadge tone={selected.active ? 'success' : selected.configured ? 'warning' : 'neutral'}>
                  {selected.active ? '可用' : selected.configured ? '待启用' : '未配置'}
                </StatusBadge>
              ) : null}
            </div>

            {customEditor ? (
              <Field label="供应商名称" error={displayNameError}>
                <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
              </Field>
            ) : null}
            <Field
              label="API 密钥"
              hint={
                selected?.credential?.configured ? '留空表示沿用当前密钥；已保存密钥无法查看。' : '保存的密钥无法查看。'
              }
            >
              <SecretInput value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
            </Field>

            <div className={styles.modelSection}>
              <div className={styles.modelSectionHeading}>
                <span>
                  <span className={styles.fieldLabel}>模型</span>
                  {restorable ? <StatusBadge tone="info">已自定义</StatusBadge> : null}
                </span>
                {restorable ? (
                  <Button size="small" variant="ghost" disabled={pending !== null} onClick={() => setRestoreOpen(true)}>
                    恢复默认模型
                  </Button>
                ) : null}
              </div>
              {modelsEditable ? (
                <>
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
                  <p className={styles.modelHint}>
                    打开“支持图片”的模型可直接理解频道中的图片。
                    {catalogRoute ? '新增供应商目录之外的模型时，需要在高级设置中填写 API 地址并选择 API 协议。' : ''}
                  </p>
                </>
              ) : (
                <>
                  <div className={styles.modelList}>
                    {selected?.models.map((model) => (
                      <span key={model.id}>
                        {model.name}
                        {model.inputModalities?.includes('image') ? ' · 图片' : ''}
                      </span>
                    ))}
                  </div>
                  <p className={styles.modelHint}>此供应商的模型由其适配器固定提供，暂不支持在这里修改。</p>
                </>
              )}
            </div>

            <details className={styles.advanced} open={customMode}>
              <summary>高级设置</summary>
              <div className={styles.advancedFields}>
                <Field
                  label="API 地址"
                  hint={!customEditor ? '留空使用供应商默认地址。' : undefined}
                  error={baseUrlError}
                >
                  <Input
                    value={baseURL}
                    onChange={(event) => setBaseURL(event.target.value)}
                    placeholder="https://…/v1"
                  />
                </Field>
                {customEditor ? (
                  <SelectField
                    label="API 协议"
                    value={api}
                    onValueChange={setApi}
                    options={settings.protocols.map((protocol) => ({ value: protocol, label: protocol }))}
                    error={apiError}
                  />
                ) : catalogRoute ? (
                  <SelectField
                    label="API 协议"
                    helper="选择后该供应商的全部模型都使用此协议；新增目录外的模型时必须选择。"
                    value={api || CATALOG_PROTOCOL}
                    onValueChange={(value) => setApi(value === CATALOG_PROTOCOL ? '' : value)}
                    options={[
                      { value: CATALOG_PROTOCOL, label: '沿用各模型自带协议' },
                      ...settings.protocols.map((protocol) => ({ value: protocol, label: protocol })),
                    ]}
                  />
                ) : null}
              </div>
            </details>

            <div className={styles.actions}>
              <div className={styles.secondaryActions}>
                {discoverable ? (
                  <Button
                    type="button"
                    onClick={() => void discover()}
                    loading={pending === 'discover'}
                    loadingLabel="获取中…"
                    disabled={!providerId || pending !== null}
                  >
                    获取可用模型
                  </Button>
                ) : null}
                <Button
                  type="button"
                  onClick={() => void testConnection()}
                  loading={pending === 'test'}
                  loadingLabel="测试中…"
                  disabled={!canTest || pending !== null}
                >
                  测试连接
                </Button>
              </div>
              <Button
                type="submit"
                variant="primary"
                loading={pending === 'save'}
                loadingLabel="保存中…"
                disabled={!canSave || pending !== null}
              >
                保存供应商
              </Button>
            </div>
            {!customMode && selected?.configured ? (
              <div className={styles.removalAction}>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={pending !== null}
                  onClick={() => setRemovingProvider(selected.provider)}
                >
                  {selected.declared ? '删除供应商' : '移除配置'}
                </Button>
              </div>
            ) : null}
          </form>
        ) : (
          <div className={styles.editor}>
            <EmptyState
              title="还没有已配置的供应商"
              description="从当前运行环境的供应商目录中选择一项并保存配置。"
              action={
                <Button
                  onClick={() => {
                    setAddCandidate(availableProviders[0]?.provider ?? '__custom__')
                    setAddOpen(true)
                  }}
                >
                  添加供应商
                </Button>
              }
            />
          </div>
        )}
      </div>

      {removingProvider ? (
        <LlmProviderRemovalDialog
          key={removingProvider}
          provider={removingProvider}
          onClose={() => setRemovingProvider('')}
          onRemoved={(next) => {
            useProductStore.getState().replaceLlmProviders(next)
            setSelectedId(next.providers.find((provider) => provider.configured)?.provider ?? '')
            setApiKey('')
            setCustomMode(false)
            setRemovingProvider('')
            notify('供应商配置已移除，API 密钥已保留。', 'success', 'llm-provider-remove')
            void useProductStore
              .getState()
              .refreshHost()
              .catch((cause: unknown) => {
                notify(
                  `配置已移除，但页面数据刷新失败：${cause instanceof Error ? cause.message : String(cause)}`,
                  'warning',
                  'llm-provider-remove-refresh',
                )
              })
          }}
        />
      ) : null}
      <ConfirmDialog
        open={restoreOpen}
        onOpenChange={setRestoreOpen}
        title="恢复默认模型"
        description={`${selectedDisplayName ?? '此供应商'}将改回供应商自带的模型列表，在这里新增或修改的模型会被移除。使用被移除模型的智能体需要重新选择模型。`}
        confirmLabel="恢复默认模型"
        confirmLoadingLabel="恢复中…"
        onConfirm={restoreModels}
      />
      <Dialog
        open={addOpen}
        onOpenChange={setAddOpen}
        title="添加模型供应商"
        description="候选项来自当前运行环境的可配置供应商目录。"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setAddOpen(false)
                if (addCandidate === '__custom__') enterCustomMode()
                else {
                  const provider = settings.providers.find((candidate) => candidate.provider === addCandidate)
                  if (provider) selectProvider(provider)
                }
              }}
            >
              开始配置
            </Button>
          </>
        }
      >
        <SelectField
          label="模型供应商"
          value={addCandidate}
          onValueChange={setAddCandidate}
          options={[
            ...availableProviders.map((provider) => ({
              value: provider.provider,
              label: providerDisplayName(provider.provider, provider.displayName),
            })),
            { value: '__custom__', label: '自定义 OpenAI 兼容供应商' },
          ]}
        />
      </Dialog>
    </div>
  )
}

export function AddModelProviderForm({ onSaved }: { readonly onSaved?: () => void }): ReactNode {
  const useProductStore = useProductRuntime().store

  const query = useProductStore((state) => state.llmProvidersQuery)
  const settings = query.data ?? null
  const [providerId, setProviderId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [operation, setPending] = useState<'save' | null>(null)
  const pending = operation ?? (query.loading ? 'load' : null)
  const [actionError, setError] = useState('')
  const error = actionError || query.error

  const load = async (): Promise<void> => {
    try {
      const next = await useProductStore.getState().loadLlmProviders()
      setProviderId((current) => {
        if (next.providers.some((provider) => provider.provider === current)) return current
        return next.providers.find((provider) => !provider.configured)?.provider ?? next.providers[0]?.provider ?? ''
      })
    } catch (cause) {
      if (cause instanceof StaleHostReadError) return
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const selected = settings?.providers.find((provider) => provider.provider === providerId)

  const save = async (): Promise<void> => {
    if (!settings || !selected || pending) return
    if (!apiKey.trim() && !selected.credential?.configured) {
      setError('请输入 API 密钥。')
      return
    }
    setPending('save')
    setError('')
    try {
      const next = await callHostApi(
        HostApiContracts.llmSaveProvider,
        { provider: selected.provider },
        {
          expectedRevision: selected.settingsRevision,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        },
      )
      useProductStore.getState().replaceLlmProviders(next)
      setApiKey('')
      try {
        await useProductStore.getState().refreshHost()
        notify('供应商配置已保存。API 密钥只写入本机凭据存储。', 'success', `llm-provider-save:${selected.provider}`)
        onSaved?.()
      } catch (refreshError) {
        notify(
          `配置已保存，但页面数据刷新失败：${refreshError instanceof Error ? refreshError.message : String(refreshError)}`,
          'warning',
          `llm-provider-save:${selected.provider}`,
        )
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(null)
    }
  }

  if (!settings && !query.error) {
    return <EmptyState loading title="正在读取模型供应商" description="加载完成后可在此保存凭据。" />
  }

  if (!settings) {
    return (
      <EmptyState
        title="无法读取模型供应商"
        description={error || '请检查连接后重试。'}
        action={
          <Button onClick={() => void load()}>
            <RefreshCw size={14} aria-hidden="true" /> 重新加载
          </Button>
        }
      />
    )
  }

  if (settings.providers.length === 0) {
    return <EmptyState title="当前没有可配置的供应商" description="完整目录和自定义供应商位于设置。" />
  }

  const providerSelected = providerId.length > 0

  return (
    <div className={styles.compactForm}>
      <SelectField
        label="模型供应商"
        value={providerId}
        onValueChange={setProviderId}
        options={settings.providers.map((provider) => ({
          value: provider.provider,
          label: providerDisplayName(provider.provider, provider.displayName),
        }))}
      />
      <Field label="API 密钥" hint="保存的密钥无法查看。" error={error || undefined}>
        <SecretInput value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
      </Field>
      <div className={styles.compactActions}>
        <Button
          variant="primary"
          loading={pending === 'save'}
          loadingLabel="保存中…"
          disabled={pending !== null || settings.writable !== true || !providerSelected}
          onClick={() => void save()}
        >
          保存供应商
        </Button>
      </div>
    </div>
  )
}
