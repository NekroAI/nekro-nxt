import { Check, Plus, Save, ShieldAlert } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { notify } from '../components/notifications.js'
import { EmptyState, InlineFeedback, PageHeader } from '../components/product-feedback.js'
import { AddModelProviderForm } from '../llm-settings.js'
import { WebSearchCredentialForm } from '../web-search-credential.js'
import {
  useProductStore,
  type AgentRuntimeState,
  type AgentSummary,
  type LocalExtensionSummary,
  type ModelSummary,
} from '../product-store.js'
import {
  Button,
  ConfirmDialog,
  Field,
  Input,
  SelectField,
  StatusBadge,
  SwitchField,
  Textarea,
  type StatusTone,
} from '../ui-kit/index.js'
import { agentWorkbenchHref, listAgentBlockers } from './agent-workbench.js'
import { workHomePath } from '../shell/last-channel.js'
import { BindingTaskDialog, isTriggerPolicy, listBindingChannels, TRIGGER_POLICY_OPTIONS } from './binding-task.js'
import styles from './product-pages.module.css'

const agentTone = (state: AgentRuntimeState): StatusTone => {
  if (state === '空闲') return 'neutral'
  if (state === '思考中' || state === '使用工具') return 'info'
  if (state === '等待输入') return 'warning'
  if (state === '不可用') return 'error'
  return 'neutral'
}

const modelKey = (model: Pick<ModelSummary, 'provider' | 'id'>): string =>
  `${encodeURIComponent(model.provider)}/${encodeURIComponent(model.id)}`

const modelValueForAgent = (agent: AgentSummary): string =>
  agent.modelRef ? modelKey({ provider: agent.modelRef.provider, id: agent.modelRef.model }) : ''

type AgentSettingsTab = 'profile' | 'channels' | 'capabilities' | 'extensions'

const isAgentSettingsTab = (value: string | null): value is AgentSettingsTab =>
  value === 'profile' || value === 'channels' || value === 'capabilities' || value === 'extensions'

export function AgentsPage() {
  const host = useProductStore((state) => state.host)
  const agents = useProductStore((state) => state.agents)
  const models = useProductStore((state) => state.models)
  const capabilityAvailability = useProductStore((state) => state.capabilityAvailability)
  const channels = useProductStore((state) => state.channels)
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const creating = searchParams.get('create') === '1'
  const [createOpen, setCreateOpen] = useState(false)
  const [createStep, setCreateStep] = useState(0)
  const [newName, setNewName] = useState('')
  const [newPersona, setNewPersona] = useState('')
  const [selectedModelKey, setSelectedModelKey] = useState('')
  const [newCapabilities, setNewCapabilities] = useState<AgentSummary['capabilities']>({
    subagents: true,
    fileTools: false,
    webSearch: false,
    dynamicCreation: false,
    developmentShell: false,
    unrestrictedFileAccess: false,
  })
  const [createError, setCreateError] = useState('')

  useEffect(() => {
    const firstModel = models[0]
    if (firstModel && !models.some((model) => modelKey(model) === selectedModelKey)) {
      setSelectedModelKey(modelKey(firstModel))
    }
  }, [models, selectedModelKey])

  useEffect(() => {
    if (creating) setCreateOpen(true)
  }, [creating])

  const selectedModel = models.find((model) => modelKey(model) === selectedModelKey)
  const resetCreate = (): void => {
    setCreateStep(0)
    setNewName('')
    setNewPersona('')
    setNewCapabilities({
      subagents: true,
      fileTools: false,
      webSearch: capabilityAvailability.webSearch.available,
      dynamicCreation: false,
      developmentShell: false,
      unrestrictedFileAccess: false,
    })
    setCreateError('')
  }
  const closeCreate = (): void => {
    setCreateOpen(false)
    resetCreate()
    if (searchParams.get('create') === '1') {
      void navigate(agents.length > 0 ? workHomePath({ channels, agents }) : '/agents', { replace: true })
    }
  }
  const openCreate = (): void => {
    resetCreate()
    setCreateOpen(true)
  }
  const wizardSteps = ['身份', '模型', '工作方式', '确认']

  if (agents.length > 0 && !creating && !createOpen) {
    return <Navigate to={workHomePath({ channels, agents })} replace />
  }

  return (
    <div className={styles.page}>
      <PageHeader
        title="智能体"
        meta={agents.length > 0 ? '查看当前工作，或从最近使用的频道继续。' : undefined}
        actions={
          <Button variant="primary" onClick={openCreate}>
            <Plus size={15} aria-hidden="true" /> 创建智能体
          </Button>
        }
      />

      {agents.length === 0 ? (
        <EmptyState
          loading={host.status === 'initializing'}
          title={host.status === 'initializing' ? '正在读取智能体' : '还没有智能体'}
          description={
            host.status === 'initializing'
              ? '连接完成后会显示已保存的智能体。'
              : host.status === 'error'
                ? '当前无法读取智能体，请重新连接后再试。'
                : '创建一个智能体并选择模型，随后可在网页频道中开始对话。'
          }
          action={host.status === 'ready' ? <Button onClick={openCreate}>创建第一个智能体</Button> : undefined}
        />
      ) : null}

      <ConfirmDialog
        open={createOpen}
        onOpenChange={(open) => {
          if (open) setCreateOpen(true)
          else closeCreate()
        }}
        title="创建智能体"
        description="分步确定身份、模型和初始工作方式，最后一次性创建。"
        confirmLabel={createStep === wizardSteps.length - 1 ? '创建并打开频道' : '下一步'}
        backLabel={createStep > 0 ? '上一步' : undefined}
        onBack={
          createStep > 0
            ? () => {
                setCreateStep((step) => step - 1)
                setCreateError('')
              }
            : undefined
        }
        onConfirm={async () => {
          const name = newName.trim()
          if (createStep === 0 && !name) {
            setCreateError('请输入智能体名称。')
            return false
          }
          if (createStep === 1 && !selectedModel) {
            setCreateError('请先保存一个模型供应商，再继续创建。')
            return false
          }
          if (createStep < wizardSteps.length - 1) {
            setCreateStep((step) => step + 1)
            setCreateError('')
            return false
          }
          if (!selectedModel) return false
          setCreateError('')
          try {
            const created = await useProductStore.getState().createAgent({
              name,
              persona: newPersona,
              model: selectedModel,
              capabilities: newCapabilities,
            })
            void navigate(`/channels/${created.channelId}`)
            return true
          } catch (error) {
            setCreateError(error instanceof Error ? error.message : String(error))
            return false
          }
        }}
      >
        <div className={styles.wizardBody}>
          <ol className={styles.wizardSteps} aria-label="创建进度">
            {wizardSteps.map((step, index) => (
              <li
                className={
                  index === createStep ? styles.wizardStepActive : index < createStep ? styles.wizardStepDone : ''
                }
                key={step}
              >
                <span>{index < createStep ? <Check size={13} aria-hidden="true" /> : index + 1}</span>
                {step}
              </li>
            ))}
          </ol>
          {createStep === 0 ? (
            <div className={styles.formStack}>
              <Field label="名称" error={!newName.trim() && createError ? '请输入智能体名称。' : undefined}>
                <Input value={newName} onChange={(event) => setNewName(event.target.value)} autoFocus />
              </Field>
              <Field label="人设" hint="描述它的身份、表达方式和工作边界，之后仍可修改。">
                <Textarea value={newPersona} onChange={(event) => setNewPersona(event.target.value)} />
              </Field>
            </div>
          ) : null}
          {createStep === 1 ? (
            models.length > 0 ? (
              <SelectField
                label="默认模型"
                value={selectedModelKey}
                onValueChange={setSelectedModelKey}
                options={models.map((model) => ({
                  value: modelKey(model),
                  label: `${model.providerName} · ${model.name}`,
                }))}
                helper="新频道会使用这个模型开始对话。"
              />
            ) : (
              <div className={styles.formStack}>
                <InlineFeedback tone="warning">当前没有可用模型。保存一个供应商后即可继续创建。</InlineFeedback>
                <AddModelProviderForm
                  onSaved={() => {
                    const first = useProductStore.getState().models[0]
                    if (first) setSelectedModelKey(modelKey(first))
                  }}
                />
              </div>
            )
          ) : null}
          {createStep === 2 ? (
            <div className={styles.capabilityChoices}>
              <InlineFeedback tone="info">
                默认开启子智能体；文件与开发能力由你明确授权，高风险能力不会因频道类型被强制关闭。
              </InlineFeedback>
              <SwitchField
                label="子智能体"
                description="允许在后台委派独立任务；主智能体仍可继续接收和回应频道消息。"
                checked={newCapabilities.subagents}
                onCheckedChange={(enabled) => setNewCapabilities((current) => ({ ...current, subagents: enabled }))}
              />
              <SwitchField
                label="网页搜索"
                description={
                  capabilityAvailability.webSearch.available
                    ? '通过 DeepSeek 官方搜索扩展信息范围；每次搜索会产生额外模型费用。'
                    : '可以先授权；配置 DeepSeek API 凭据后自动可用，每次搜索会产生额外模型费用。'
                }
                checked={newCapabilities.webSearch}
                onCheckedChange={(enabled) => setNewCapabilities((current) => ({ ...current, webSearch: enabled }))}
              />
              <SwitchField
                label="动态创造"
                description="允许创建和试运行临时扩展。"
                checked={newCapabilities.dynamicCreation}
                onCheckedChange={(enabled) =>
                  setNewCapabilities((current) => ({ ...current, dynamicCreation: enabled }))
                }
              />
              <SwitchField
                label="文件工具"
                description="允许读取文件，并在智能体开发工作区中写入文件。读取范围取决于宿主进程权限。"
                checked={newCapabilities.fileTools}
                onCheckedChange={(enabled) => setNewCapabilities((current) => ({ ...current, fileTools: enabled }))}
              />
              <SwitchField
                label="开发命令"
                description="允许在这个智能体的独立开发工作区中运行命令。"
                checked={newCapabilities.developmentShell}
                onCheckedChange={(enabled) =>
                  setNewCapabilities((current) => ({ ...current, developmentShell: enabled }))
                }
              />
              <SwitchField
                label={
                  <span className={styles.riskLabel}>
                    完整文件访问 <StatusBadge tone="error">高风险</StatusBadge>
                  </span>
                }
                description="扩大文件访问范围；不会自动开启开发命令。"
                checked={newCapabilities.unrestrictedFileAccess}
                onCheckedChange={(enabled) =>
                  setNewCapabilities((current) => ({ ...current, unrestrictedFileAccess: enabled }))
                }
              />
            </div>
          ) : null}
          {createStep === 3 ? (
            <div className={styles.createSummary}>
              <div>
                <span>智能体</span>
                <strong>{newName.trim()}</strong>
              </div>
              <div>
                <span>人设</span>
                <strong>{newPersona.trim() || '稍后设置'}</strong>
              </div>
              <div>
                <span>模型</span>
                <strong>{selectedModel ? `${selectedModel.providerName} · ${selectedModel.name}` : '未选择'}</strong>
              </div>
              <div>
                <span>初始能力</span>
                <strong>
                  {[
                    newCapabilities.subagents ? '子智能体' : '',
                    newCapabilities.webSearch ? '网页搜索' : '',
                    newCapabilities.dynamicCreation ? '动态创造' : '',
                    newCapabilities.fileTools ? '文件工具' : '',
                    newCapabilities.developmentShell ? '开发命令' : '',
                    newCapabilities.unrestrictedFileAccess ? '完整文件访问' : '',
                  ]
                    .filter(Boolean)
                    .join('、') || '不授予开发能力'}
                </strong>
              </div>
              <InlineFeedback tone="success">创建后会自动建立网页聊天频道，并直接打开它。</InlineFeedback>
            </div>
          ) : null}
          {createError && (createStep !== 0 || newName.trim()) ? (
            <InlineFeedback tone="error">{createError}</InlineFeedback>
          ) : null}
        </div>
      </ConfirmDialog>
    </div>
  )
}

type Capability = keyof AgentSummary['capabilities']

const capabilityCopy: readonly {
  readonly key: Capability
  readonly label: string
  readonly description: string
  readonly risk: { readonly label: string; readonly tone: StatusTone }
}[] = [
  {
    key: 'subagents',
    label: '子智能体',
    description: '允许在后台委派独立任务，主智能体可同时继续处理频道消息。',
    risk: { label: '低风险', tone: 'info' },
  },
  {
    key: 'webSearch',
    label: '网页搜索',
    description: '通过已配置的 DeepSeek Web Provider 搜索外部信息；搜索内容不可信且会产生额外费用。',
    risk: { label: '外部服务', tone: 'warning' },
  },
  {
    key: 'dynamicCreation',
    label: '动态创造',
    description: '允许这个智能体创建并试运行临时扩展。',
    risk: { label: '中风险', tone: 'warning' },
  },
  {
    key: 'fileTools',
    label: '文件工具',
    description: '允许读取文件，并在智能体开发工作区中写入文件；读取范围取决于宿主进程权限。',
    risk: { label: '高风险', tone: 'warning' },
  },
  {
    key: 'developmentShell',
    label: '开发命令',
    description: '允许在明确授权的开发工作区中运行命令。',
    risk: { label: '高风险', tone: 'warning' },
  },
  {
    key: 'unrestrictedFileAccess',
    label: '完整文件访问',
    description: '扩大已授权文件能力的可访问范围，不会自动开启开发命令。',
    risk: { label: '极高风险', tone: 'error' },
  },
]

export function AgentManagePage() {
  const { agentId = '' } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const host = useProductStore((state) => state.host)
  const capabilityAvailability = useProductStore((state) => state.capabilityAvailability)
  const agent = useProductStore((state) => state.agents.find((candidate) => candidate.id === agentId))
  const models = useProductStore((state) => state.models)
  const channels = useProductStore((state) => state.channels)
  const connections = useProductStore((state) => state.connections)
  const extensions = useProductStore((state) => state.extensions)
  const dynamic = useProductStore((state) => state.dynamic)
  const [displayName, setDisplayName] = useState(agent?.name ?? '')
  const [persona, setPersona] = useState(agent?.persona ?? '')
  const [selectedModelKey, setSelectedModelKey] = useState(agent ? modelValueForAgent(agent) : '')
  const [savePending, setSavePending] = useState(false)
  const [capabilityPending, setCapabilityPending] = useState<Capability | null>(null)
  const [bindingOpen, setBindingOpen] = useState(false)
  const [triggerPendingId, setTriggerPendingId] = useState<string | null>(null)
  const [extensionPendingId, setExtensionPendingId] = useState<string | null>(null)

  useEffect(() => {
    if (!agent) return
    setDisplayName(agent.name)
    setPersona(agent.persona ?? '')
    setSelectedModelKey(modelValueForAgent(agent))
  }, [agent])

  const selectedModel = models.find((model) => modelKey(model) === selectedModelKey)
  const boundChannels = useMemo(
    () => (agent ? channels.filter((channel) => channel.bindings.some((binding) => binding.agentId === agent.id)) : []),
    [agent, channels],
  )
  const requestedTab = searchParams.get('tab')
  const activeTab: AgentSettingsTab = isAgentSettingsTab(requestedTab) ? requestedTab : 'profile'

  useLayoutEffect(() => {
    if (!agentId) return
    const target = document.getElementById(`agent-${activeTab}`)
    target?.scrollIntoView({ block: 'start' })
  }, [agentId, activeTab])

  if (!agent) {
    return (
      <div className={styles.page}>
        <EmptyState
          loading={host.status === 'initializing'}
          title={host.status === 'initializing' ? '正在读取智能体' : '找不到这个智能体'}
          description="它可能已被移除，或当前连接尚未同步完成。"
          action={<Button onClick={() => window.location.assign('/agents')}>返回智能体</Button>}
        />
      </div>
    )
  }

  const isDirty =
    displayName !== agent.name || persona !== (agent.persona ?? '') || selectedModelKey !== modelValueForAgent(agent)
  const reset = (): void => {
    setDisplayName(agent.name)
    setPersona(agent.persona ?? '')
    setSelectedModelKey(modelValueForAgent(agent))
  }
  const save = async (): Promise<void> => {
    if (!displayName.trim() || !selectedModel || savePending) return
    setSavePending(true)
    try {
      await useProductStore.getState().reviseAgent({
        agentId: agent.id,
        ...(agent.currentRevisionId ? { expectedCurrentRevisionId: agent.currentRevisionId } : {}),
        displayName: displayName.trim(),
        persona,
        model: selectedModel,
        ...(agent.modelRef?.provider === selectedModel.provider && agent.modelRef.model === selectedModel.id
          ? { reasoningEffort: agent.modelRef.reasoningEffort }
          : {}),
      })
      notify('智能体配置已保存。新消息会使用最新配置。', 'success', `agent-revision:${agent.id}`)
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error', `agent-revision:${agent.id}`)
    } finally {
      setSavePending(false)
    }
  }
  const updateCapability = async (capability: Capability, enabled: boolean): Promise<void> => {
    if (capabilityPending) return
    setCapabilityPending(capability)
    try {
      await useProductStore.getState().setCapability(agent.id, capability, enabled)
      notify(
        `${enabled ? '已开启' : '已关闭'}${capabilityCopy.find((item) => item.key === capability)?.label ?? '此能力'}。`,
        'success',
        `agent-capability:${agent.id}:${capability}`,
      )
    } catch (error) {
      notify(
        error instanceof Error ? error.message : String(error),
        'error',
        `agent-capability:${agent.id}:${capability}`,
      )
    } finally {
      setCapabilityPending(null)
    }
  }

  const agentExtensions = extensions.filter(
    (extension) => extension.agentId === agent.id || extension.targetAgent === agent.name,
  )
  const blockers = listAgentBlockers({
    agent,
    models,
    channels,
    capabilityAvailability,
    dynamic,
  })
  const recentChannel = boundChannels[0]
  const bindableChannels = listBindingChannels({ channels, excludeBoundToAgentId: agent.id })
  const undiscoveredConnections = connections.filter(
    (connection) => connection.adapterKey !== 'web' && connection.knownChannels.length === 0,
  )
  const untestedConnections = connections.filter(
    (connection) =>
      connection.adapterKey !== 'web' &&
      connection.knownChannels.length > 0 &&
      (connection.receiveTest !== '通过' || connection.sendTest !== '通过'),
  )
  const openTab = (tab: AgentSettingsTab): void => {
    const next = new URLSearchParams(searchParams)
    if (tab === 'profile') next.delete('tab')
    else next.set('tab', tab)
    setSearchParams(next, { replace: true })
  }
  const updateTrigger = async (
    channelId: string,
    triggerPolicy: (typeof TRIGGER_POLICY_OPTIONS)[number]['value'],
  ): Promise<void> => {
    if (triggerPendingId) return
    setTriggerPendingId(channelId)
    try {
      await useProductStore.getState().createBinding({
        agentId: agent.id,
        channelId,
        triggerPolicy,
      })
      notify('响应方式已更新。', 'success', `agent-trigger:${channelId}`)
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error', `agent-trigger:${channelId}`)
    } finally {
      setTriggerPendingId(null)
    }
  }
  const changeExtensionActivation = async (extension: LocalExtensionSummary): Promise<void> => {
    if (extensionPendingId) return
    const enable = extension.activation !== '已激活'
    setExtensionPendingId(extension.id)
    try {
      await useProductStore.getState().setExtensionActive(extension.id, enable)
      notify(`${extension.name}${enable ? '已启用' : '已停用'}。`, 'success', `agent-extension:${extension.id}`)
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error', `agent-extension:${extension.id}`)
    } finally {
      setExtensionPendingId(null)
    }
  }

  return (
    <div className={styles.workbenchPage}>
      <div className={styles.workbenchDoc}>
        <PageHeader
          title={agent.name}
          meta={<StatusBadge tone={agentTone(agent.state)}>{agent.state}</StatusBadge>}
          actions={
            <>
              {recentChannel ? (
                <Button variant="ghost" onClick={() => void navigate(`/channels/${recentChannel.id}`)}>
                  打开最近频道
                </Button>
              ) : null}
              {isDirty ? (
                <Button variant="ghost" disabled={savePending} onClick={reset}>
                  放弃更改
                </Button>
              ) : null}
              <Button
                variant="primary"
                loading={savePending}
                loadingLabel="正在保存…"
                disabled={!isDirty || !displayName.trim() || !selectedModel}
                onClick={() => void save()}
              >
                <Save size={15} aria-hidden="true" /> 保存新配置
              </Button>
            </>
          }
        />

        <section className={styles.workbenchSection} id="agent-profile">
          <div className={styles.formLayout}>
            <div className={styles.section}>
              <div className={styles.sectionHeading}>人设与模型</div>
              <div className={styles.formStack}>
                <Field label="名称" error={!displayName.trim() ? '请输入智能体名称。' : undefined}>
                  <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
                </Field>
                <Field label="人设" hint="描述它的身份、表达方式和工作边界。">
                  <Textarea value={persona} onChange={(event) => setPersona(event.target.value)} />
                </Field>
                {models.length > 0 ? (
                  <SelectField
                    label="默认模型"
                    value={selectedModelKey}
                    onValueChange={setSelectedModelKey}
                    options={models.map((model) => ({
                      value: modelKey(model),
                      label: `${model.providerName} · ${model.name}`,
                    }))}
                  />
                ) : (
                  <>
                    <InlineFeedback tone="warning">当前没有可用模型。保存一个供应商后即可选择默认模型。</InlineFeedback>
                    <AddModelProviderForm
                      onSaved={() => {
                        const first = useProductStore.getState().models[0]
                        if (first) setSelectedModelKey(modelKey(first))
                      }}
                    />
                  </>
                )}
              </div>
            </div>
          </div>
        </section>

        <section className={styles.workbenchSection} id="agent-channels">
          <div className={styles.section}>
            <div className={styles.sectionBar}>
              <div>
                <div className={styles.sectionHeading}>已绑定频道</div>
                <div className={styles.secondaryText}>每个频道保留独立的消息记录。</div>
              </div>
              <Button onClick={() => setBindingOpen(true)}>
                <Plus size={14} aria-hidden="true" /> 绑定频道
              </Button>
            </div>
            {boundChannels.length === 0 ? (
              <EmptyState title="还没有绑定频道" description="绑定频道后，这个智能体才能接收对应消息。" />
            ) : (
              <div className={styles.boundChannelList}>
                {boundChannels.map((channel) => (
                  <div className={styles.boundChannelRow} key={channel.id}>
                    <Link className={styles.boundChannelName} to={`/channels/${channel.id}`}>
                      <strong>{channel.name}</strong>
                      <small>{channel.connectionName}</small>
                    </Link>
                    <SelectField
                      label="响应方式"
                      value={
                        channel.bindings.find((binding) => binding.agentId === agent.id)?.triggerPolicy ??
                        'mentioned-or-replied'
                      }
                      disabled={triggerPendingId !== null}
                      onValueChange={(value) => {
                        if (isTriggerPolicy(value)) void updateTrigger(channel.id, value)
                      }}
                      options={TRIGGER_POLICY_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                    />
                  </div>
                ))}
              </div>
            )}
            {bindableChannels.length > 0 ? (
              <InlineFeedback tone="info">还有 {bindableChannels.length} 个频道可以绑定给这个智能体。</InlineFeedback>
            ) : null}
            {undiscoveredConnections.map((connection) => (
              <InlineFeedback key={connection.id} tone="info">
                {connection.name} 尚未发现频道。请先向机器人账号发送一条消息，发现后可在本页绑定。
              </InlineFeedback>
            ))}
            {untestedConnections.map((connection) => (
              <InlineFeedback key={`${connection.id}-test`} tone="info">
                {connection.name} 尚未完成收发测试。可以先绑定，测试仍可稍后进行。
              </InlineFeedback>
            ))}
          </div>
        </section>

        <section className={styles.workbenchSection} id="agent-capabilities">
          <div className={styles.section}>
            <div className={styles.sectionBar}>
              <div>
                <div className={styles.sectionHeading}>授权能力</div>
                <div className={styles.secondaryText}>每个开关都是一次立即保存的授权变更。</div>
              </div>
              <ShieldAlert size={18} aria-hidden="true" />
            </div>
            <InlineFeedback tone="warning">
              文件工具可读取 Server
              进程有权读取的宿主文件；开发命令与不受限文件访问不会因频道类型被强制关闭，请按实际用途授权。
            </InlineFeedback>
            {!capabilityAvailability.webSearch.available ? (
              <div className={styles.formStack}>
                <InlineFeedback tone="warning">
                  {agent.capabilities.webSearch
                    ? '网页搜索已授权，还需要保存凭据后才能使用。'
                    : '可以先保存凭据，再打开网页搜索。'}
                </InlineFeedback>
                <WebSearchCredentialForm />
                <Link className={styles.secondaryText} to="/settings?tab=dsh-extensions">
                  打开完整扩展设置
                </Link>
              </div>
            ) : null}
            <div className={styles.switchList}>
              {capabilityCopy.map((item) => (
                <SwitchField
                  key={item.key}
                  label={
                    <span className={styles.riskLabel}>
                      {item.label} <StatusBadge tone={item.risk.tone}>{item.risk.label}</StatusBadge>
                    </span>
                  }
                  description={item.description}
                  checked={agent.capabilities[item.key]}
                  disabled={capabilityPending !== null}
                  onCheckedChange={(enabled) => void updateCapability(item.key, enabled)}
                />
              ))}
            </div>
            {agent.capabilities.dynamicCreation ? (
              <div className={styles.sectionActionRow}>
                <span>
                  <strong>动态创造已授权</strong>
                  <small>
                    {recentChannel
                      ? '在这个智能体的频道里描述需求；保存和启用仍是独立动作。'
                      : '绑定频道后，才能在对话中描述需求。'}
                  </small>
                </span>
                <span className={styles.rowActions}>
                  <Button
                    variant="primary"
                    disabled={!recentChannel}
                    onClick={() => recentChannel && void navigate(`/channels/${recentChannel.id}`)}
                  >
                    打开频道去描述需求
                  </Button>
                  <Button variant="ghost" onClick={() => void navigate(`/creator?agent=${agent.id}`)}>
                    查看创造运行
                  </Button>
                </span>
              </div>
            ) : null}
          </div>
        </section>

        <section className={styles.workbenchSection} id="agent-extensions">
          <div className={styles.section}>
            <div className={styles.sectionHeading}>已关联扩展</div>
            {agentExtensions.length === 0 ? (
              <EmptyState
                title={extensions.length === 0 ? '还没有本地扩展' : '还没有给这个智能体启用扩展'}
                description={
                  extensions.length === 0
                    ? '在创造工作台保存后，扩展会出现在这里。动态运行中的内容不会自动保存。'
                    : '已有保存版本。启用后，这个智能体才能使用对应能力。'
                }
              />
            ) : (
              <div className={styles.compactList}>
                {agentExtensions.map((extension) => (
                  <div className={styles.staticRow} key={extension.id}>
                    <span>
                      <strong>{extension.name}</strong>
                      <small>{extension.description || '没有补充说明。'}</small>
                    </span>
                    <Button
                      size="small"
                      variant={extension.activation === '已激活' ? 'danger' : 'primary'}
                      loading={extensionPendingId === extension.id}
                      loadingLabel="处理中…"
                      disabled={extensionPendingId !== null}
                      onClick={() => void changeExtensionActivation(extension)}
                    >
                      {extension.activation === '已激活' ? '停用扩展' : '启用给智能体'}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
        <BindingTaskDialog
          open={bindingOpen}
          onOpenChange={setBindingOpen}
          agentId={agent.id}
          excludeBoundToAgentId={agent.id}
        />
      </div>

      <aside className={[styles.inspector, styles.workbenchInspector].join(' ')} aria-label="这个智能体">
        <section>
          <h2>这个智能体</h2>
          <div className={styles.workbenchStatus}>
            <div>
              <strong>{recentChannel ? `最近频道：${recentChannel.name}` : '还没有最近使用的频道'}</strong>
              <small>人设与模型保存后会创建新配置；能力授权每次修改都会独立保存。</small>
            </div>
          </div>
          {blockers.length > 0 ? (
            <div className={styles.agentBlockers}>
              {blockers.map((blocker) => (
                <Button
                  key={blocker.kind}
                  size="small"
                  variant="ghost"
                  onClick={() => {
                    if (blocker.tab === 'creator') void navigate(agentWorkbenchHref(agent.id, blocker.tab))
                    else openTab(blocker.tab)
                  }}
                >
                  {blocker.label}
                </Button>
              ))}
            </div>
          ) : (
            <p className={styles.secondaryText}>运行中的任务会在安全间隙使用兼容的新配置。</p>
          )}
        </section>
        <section>
          <h2>频道</h2>
          {boundChannels.length > 0 ? (
            <div className={styles.compactList}>
              {boundChannels.map((channel) => (
                <Link className={styles.boundChannelName} key={channel.id} to={`/channels/${channel.id}`}>
                  <strong>{channel.name}</strong>
                  <small>{channel.trigger}</small>
                </Link>
              ))}
            </div>
          ) : (
            <p className={styles.secondaryText}>绑定后才会出现在工作树里。</p>
          )}
        </section>
      </aside>
    </div>
  )
}
