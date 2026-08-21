import { Plus, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import {
  HostApiContracts,
  HostApiErrorSchema,
  buildHostApiContractPath,
  type HostApiContract,
  type HostApiResponse,
} from '@nekro-nxt/contracts'
import { notify } from './components/notifications.js'
import { EmptyState } from './components/product-feedback.js'
import { useProductStore } from './product-store.js'
import { providerDisplayName } from './provider-labels.js'
import { Button, Dialog, Field, Input, SecretInput, SelectField, StatusBadge, Textarea } from './ui-kit/index.js'
import styles from './llm-settings.module.css'

type ProviderSettingsView = HostApiResponse<'llmProviders'>
type ProviderView = ProviderSettingsView['providers'][number]
type DiscoveredModelView = HostApiResponse<'llmDiscoverModels'>['models'][number]

const requestHostApi = async <Output,>(
  contract: HostApiContract,
  responseSchema: { parse(input: unknown): Output },
  params: unknown,
  request: unknown,
): Promise<Output> => {
  const url = buildHostApiContractPath(contract, params)
  const requestBody = contract.parseRequest(request)
  const response = await fetch(url, {
    method: contract.method,
    headers: { 'content-type': 'application/json' },
    ...(contract.method === 'GET' || contract.method === 'DELETE' ? {} : { body: JSON.stringify(requestBody) }),
  })
  const responseBody: unknown = await response.json()
  if (!response.ok) {
    const parsedError = HostApiErrorSchema.safeParse(responseBody)
    throw new Error(parsedError.success ? parsedError.data.error.message : `请求失败（HTTP ${response.status}）`)
  }
  return responseSchema.parse(responseBody)
}

const modelLines = (models: readonly { readonly id: string }[]): string => models.map((model) => model.id).join('\n')

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
  const [settings, setSettings] = useState<ProviderSettingsView | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [customMode, setCustomMode] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [addCandidate, setAddCandidate] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [api, setApi] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState('')
  const [discovered, setDiscovered] = useState<readonly DiscoveredModelView[]>([])
  const [pending, setPending] = useState<'load' | 'save' | 'discover' | 'test' | null>('load')
  const [error, setError] = useState('')
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
  const parsedModels = models
    .split(/\r?\n/u)
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => ({ id }))
  const testModels = customEditor ? parsedModels : selected?.models.length ? selected.models : discovered
  const testModel = testModels[0]
  const testModelName = testModel && 'name' in testModel ? (testModel.name ?? testModel.id) : testModel?.id

  const load = async (): Promise<void> => {
    if (pending === 'load' && settings) return
    setPending('load')
    setError('')
    try {
      const next = await requestHostApi(
        HostApiContracts.llmProviders,
        HostApiContracts.llmProviders.response,
        {},
        undefined,
      )
      setSettings(next)
      setSelectedId((current) =>
        next.providers.some((provider) => provider.provider === current && provider.configured)
          ? current
          : (next.providers.find((provider) => provider.configured)?.provider ?? ''),
      )
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      if (settings) notify(`模型供应商刷新失败：${message}`, 'error', 'llm-provider-refresh')
    } finally {
      setPending(null)
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
    setModels(modelLines(selected.models))
    setApiKey('')
    setDiscovered([])
    setSubmitted(false)
  }, [customMode, selected])

  const enterCustomMode = (): void => {
    setCustomMode(true)
    setDisplayName('')
    setBaseURL('')
    setApi(settings?.protocols[0] ?? '')
    setModels('')
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
      const result = await requestHostApi(
        HostApiContracts.llmDiscoverModels,
        HostApiContracts.llmDiscoverModels.response,
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
      if (customEditor && result.models.length > 0) setModels(modelLines(result.models))
      notify(`已找到 ${result.models.length} 个可用模型。`, 'success', `llm-provider-discover:${providerId}`)
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
      (customEditor && (!displayName.trim() || !baseURL.trim() || !api || parsedModels.length === 0))
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
      const next = await requestHostApi(
        HostApiContracts.llmSaveProvider,
        HostApiContracts.llmSaveProvider.response,
        { provider: providerId },
        {
          expectedRevision: revision,
          ...(apiKey ? { apiKey } : {}),
          ...(baseURL.trim() ? { baseURL: baseURL.trim() } : {}),
          ...(customEditor ? { displayName: displayName.trim(), api, models: parsedModels } : {}),
        },
      )
      setSettings(next)
      setSelectedId(providerId)
      setCustomMode(false)
      setApiKey('')
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

  const testConnection = async (): Promise<void> => {
    if (!providerId || !testModel || pending) return
    setPending('test')
    setError('')
    try {
      await requestHostApi(
        HostApiContracts.llmTestProvider,
        HostApiContracts.llmTestProvider.response,
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
  const modelsError = submitted && customEditor && parsedModels.length === 0 ? '请至少填写一个模型。' : undefined
  const canSave =
    settings?.writable === true &&
    Boolean(providerId) &&
    (!customEditor || Boolean(displayName.trim() && baseURL.trim() && api && parsedModels.length > 0))
  const canTest =
    Boolean(providerId && testModel) && (!customEditor || Boolean(baseURL.trim() && api && parsedModels.length > 0))

  if (!settings && pending === 'load') {
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
          <h2>模型供应商</h2>
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
                <small>{provider.models.length} 个模型</small>
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
                selected?.credential?.configured
                  ? '留空会保留当前密钥。页面不会读取或回显已保存的密钥。'
                  : '保存后不会在页面中回显。'
              }
            >
              <SecretInput value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
            </Field>

            {selected?.models.length ? (
              <div className={styles.modelSection}>
                <div className={styles.fieldLabel}>可用模型</div>
                <div className={styles.modelList}>
                  {selected.models.map((model) => (
                    <span key={model.id}>{model.name}</span>
                  ))}
                </div>
              </div>
            ) : null}
            {discovered.length > 0 && !customEditor ? (
              <div className={styles.modelSection}>
                <div className={styles.fieldLabel}>刚刚获取</div>
                <div className={styles.modelList}>
                  {discovered.map((model) => (
                    <span key={model.id}>{model.name || '未命名模型'}</span>
                  ))}
                </div>
              </div>
            ) : null}

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
                ) : null}
                {customEditor ? (
                  <Field label="模型" hint="每行一个模型名；也可以先获取可用模型。" error={modelsError}>
                    <Textarea value={models} onChange={(event) => setModels(event.target.value)} />
                  </Field>
                ) : null}
              </div>
            </details>

            <div className={styles.actions}>
              <div className={styles.secondaryActions}>
                <Button
                  type="button"
                  onClick={() => void discover()}
                  loading={pending === 'discover'}
                  loadingLabel="获取中…"
                  disabled={!providerId || pending !== null}
                >
                  获取可用模型
                </Button>
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
  const [settings, setSettings] = useState<ProviderSettingsView | null>(null)
  const [providerId, setProviderId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [pending, setPending] = useState<'load' | 'save' | null>('load')
  const [error, setError] = useState('')

  const load = async (): Promise<void> => {
    setPending('load')
    setError('')
    try {
      const next = await requestHostApi(
        HostApiContracts.llmProviders,
        HostApiContracts.llmProviders.response,
        {},
        undefined,
      )
      setSettings(next)
      setProviderId((current) => {
        if (next.providers.some((provider) => provider.provider === current)) return current
        return next.providers.find((provider) => !provider.configured)?.provider ?? next.providers[0]?.provider ?? ''
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(null)
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
      await requestHostApi(
        HostApiContracts.llmSaveProvider,
        HostApiContracts.llmSaveProvider.response,
        { provider: selected.provider },
        {
          expectedRevision: selected.settingsRevision,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        },
      )
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

  if (!settings && pending === 'load') {
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
    return <EmptyState title="当前没有可配置的供应商" description="完整目录和自定义供应商仍在设置中管理。" />
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
      <Field label="API 密钥" hint="保存后不会在页面中回显。" error={error || undefined}>
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
