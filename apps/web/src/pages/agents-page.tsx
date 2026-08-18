import { Activity, ArrowRight, Check, Clock3, MessageSquare, Plus, Save, ShieldAlert, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { notify } from '../components/notifications.js'
import { EmptyState, InlineFeedback, PageHeader } from '../components/product-feedback.js'
import { useProductStore, type AgentRuntimeState, type AgentSummary, type ModelSummary } from '../product-store.js'
import {
  Button,
  ConfirmDialog,
  Field,
  Input,
  SelectField,
  StatusBadge,
  SwitchField,
  Tabs,
  Textarea,
  type StatusTone,
} from '../ui-kit/index.js'
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

export function AgentsPage() {
  const host = useProductStore((state) => state.host)
  const agents = useProductStore((state) => state.agents)
  const models = useProductStore((state) => state.models)
  const capabilityAvailability = useProductStore((state) => state.capabilityAvailability)
  const channels = useProductStore((state) => state.channels)
  const messages = useProductStore((state) => state.messages)
  const navigate = useNavigate()
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
    if (models.length > 0 && !models.some((model) => modelKey(model) === selectedModelKey)) {
      setSelectedModelKey(modelKey(models[0]!))
    }
  }, [models, selectedModelKey])

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
  const openCreate = (): void => {
    resetCreate()
    setCreateOpen(true)
  }
  const activeAgents = agents.filter((agent) => agent.state !== '空闲').length
  const latestForAgent = (agent: AgentSummary) => {
    const channelIds = new Set(agent.channels)
    return [...messages].reverse().find((message) => channelIds.has(message.channelId))
  }
  const channelName = (channelId: string): string =>
    channels.find((channel) => channel.id === channelId)?.name ?? '频道'
  const wizardSteps = ['身份', '模型', '工作方式', '确认'] as const

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
      ) : (
        <div className={styles.agentOverview}>
          <div className={styles.agentCardGrid} role="list">
            {agents.map((agent) => {
              const latest = latestForAgent(agent)
              const recentChannelId = latest?.channelId ?? agent.channels[0]
              return (
                <article className={styles.agentCard} role="listitem" key={agent.id}>
                  <div className={styles.agentCardHeader}>
                    <div className={styles.avatarLarge}>{agent.name.slice(0, 1)}</div>
                    <div className={styles.agentCardIdentity}>
                      <div className={styles.agentCardTitle}>
                        <h2>{agent.name}</h2>
                        <StatusBadge tone={agentTone(agent.state)}>{agent.state}</StatusBadge>
                      </div>
                      <p>{agent.persona?.trim() || '尚未设置人设，可以在配置中补充它的身份和工作边界。'}</p>
                    </div>
                  </div>
                  <div className={styles.agentActivity}>
                    <Activity size={15} aria-hidden="true" />
                    <span>
                      <strong>{agent.state === '空闲' ? '最近活动' : '当前正在处理'}</strong>
                      <small>
                        {agent.state === '空闲'
                          ? latest
                            ? `${channelName(latest.channelId)} · ${latest.time}`
                            : '还没有对话记录'
                          : `状态：${agent.state}`}
                      </small>
                    </span>
                  </div>
                  <div className={styles.agentCardMeta}>
                    <span>
                      <MessageSquare size={14} aria-hidden="true" /> {agent.channels.length} 个频道
                    </span>
                    <span>
                      <Sparkles size={14} aria-hidden="true" /> {agent.extensionCount} 个扩展
                    </span>
                    <span className={styles.agentModel}>{agent.model}</span>
                  </div>
                  <div className={styles.agentCardActions}>
                    <Button size="small" variant="ghost" onClick={() => void navigate(`/agents/${agent.id}`)}>
                      管理智能体
                    </Button>
                    {recentChannelId ? (
                      <Button
                        size="small"
                        variant="primary"
                        onClick={() => void navigate(`/channels/${recentChannelId}`)}
                      >
                        继续使用 <ArrowRight size={14} aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                </article>
              )
            })}
          </div>
          <aside className={styles.overviewSummary}>
            <div className={styles.sectionHeading}>当前概览</div>
            <dl className={styles.overviewFacts}>
              <div>
                <dt>智能体</dt>
                <dd>{agents.length}</dd>
              </div>
              <div>
                <dt>监听中的频道</dt>
                <dd>{channels.length}</dd>
              </div>
              <div>
                <dt>正在处理</dt>
                <dd>{activeAgents}</dd>
              </div>
            </dl>
            <div className={styles.overviewHint}>
              <Clock3 size={15} aria-hidden="true" />
              <span>“继续使用”会打开这个智能体最近活动的频道。</span>
            </div>
          </aside>
        </div>
      )}

      <ConfirmDialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open)
          if (!open) resetCreate()
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
            setCreateError('当前没有可用模型，请先在设置中配置模型供应商。')
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
              <InlineFeedback tone="warning">当前没有可用模型，请先在设置中配置模型供应商。</InlineFeedback>
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
                    : '需要先在模型设置中配置 DeepSeek API 凭据；每次搜索会产生额外模型费用。'
                }
                checked={newCapabilities.webSearch}
                disabled={!capabilityAvailability.webSearch.available}
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
  const [displayName, setDisplayName] = useState(agent?.name ?? '')
  const [persona, setPersona] = useState(agent?.persona ?? '')
  const [selectedModelKey, setSelectedModelKey] = useState(agent ? modelValueForAgent(agent) : '')
  const [savePending, setSavePending] = useState(false)
  const [capabilityPending, setCapabilityPending] = useState<Capability | null>(null)
  const [bindingOpen, setBindingOpen] = useState(false)
  const [bindingChannelId, setBindingChannelId] = useState('')
  const [bindingTriggerPolicy, setBindingTriggerPolicy] = useState<
    'always' | 'mentioned-or-replied' | 'command' | 'observe-only'
  >('mentioned-or-replied')
  const [bindingError, setBindingError] = useState('')

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
  const bindingCandidates = useMemo(
    () =>
      agent ? channels.filter((channel) => !channel.bindings.some((binding) => binding.agentId === agent.id)) : [],
    [agent, channels],
  )

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
  const undiscoveredConnections = connections.filter(
    (connection) => connection.adapterKey !== 'web' && connection.knownChannels.length === 0,
  )
  const requestedTab = searchParams.get('tab')
  const activeTab = ['profile', 'channels', 'capabilities', 'extensions'].includes(requestedTab ?? '')
    ? requestedTab!
    : 'profile'

  return (
    <div className={styles.page}>
      <PageHeader
        title={agent.name}
        meta={<StatusBadge tone={agentTone(agent.state)}>{agent.state}</StatusBadge>}
        actions={
          activeTab === 'profile' ? (
            <>
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
          ) : undefined
        }
      />

      <div className={styles.revisionNotice}>
        <span>
          <strong>当前配置已发布</strong>
          <small>人设与模型保存后会创建新配置；能力授权每次修改都会独立保存。</small>
        </span>
        <span>运行中的任务会在安全间隙使用兼容的新配置</span>
      </div>

      <Tabs.Root
        value={activeTab}
        onValueChange={(value) => {
          const next = new URLSearchParams(searchParams)
          if (value === 'profile') next.delete('tab')
          else next.set('tab', value)
          setSearchParams(next, { replace: true })
        }}
      >
        <Tabs.List aria-label="智能体配置">
          <Tabs.Trigger value="profile">人设与模型</Tabs.Trigger>
          <Tabs.Trigger value="channels">频道</Tabs.Trigger>
          <Tabs.Trigger value="capabilities">能力</Tabs.Trigger>
          <Tabs.Trigger value="extensions">扩展</Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="profile">
          <div className={styles.formLayout}>
            <section className={styles.section}>
              <div className={styles.sectionHeading}>基本信息</div>
              <div className={styles.formStack}>
                <Field label="名称" error={!displayName.trim() ? '请输入智能体名称。' : undefined}>
                  <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
                </Field>
                <Field label="人设" hint="描述它的身份、表达方式和工作边界。">
                  <Textarea value={persona} onChange={(event) => setPersona(event.target.value)} />
                </Field>
              </div>
            </section>
            <section className={styles.section}>
              <div className={styles.sectionHeading}>模型</div>
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
                <InlineFeedback tone="warning">当前没有可用模型，请先配置模型供应商。</InlineFeedback>
              )}
            </section>
          </div>
        </Tabs.Content>

        <Tabs.Content value="channels">
          <section className={styles.section}>
            <div className={styles.sectionBar}>
              <div>
                <div className={styles.sectionHeading}>已绑定频道</div>
                <div className={styles.secondaryText}>每个频道保留独立的消息记录。</div>
              </div>
              <Button
                onClick={() => {
                  setBindingChannelId(bindingCandidates[0]?.id ?? '')
                  setBindingTriggerPolicy('mentioned-or-replied')
                  setBindingError('')
                  setBindingOpen(true)
                }}
              >
                <Plus size={14} aria-hidden="true" /> 绑定频道
              </Button>
            </div>
            {boundChannels.length === 0 ? (
              <EmptyState title="还没有绑定频道" description="绑定频道后，这个智能体才能接收对应消息。" />
            ) : (
              <div className={styles.compactList}>
                {boundChannels.map((channel) => (
                  <Link className={styles.linkRow} to={`/channels/${channel.id}`} key={channel.id}>
                    <span>
                      <strong>{channel.name}</strong>
                      <small>{channel.connectionName}</small>
                    </span>
                    <span>{channel.trigger}</span>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </Tabs.Content>

        <Tabs.Content value="capabilities">
          <section className={styles.section}>
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
              <InlineFeedback tone="info">
                网页搜索当前不可用。请先在设置中配置 DeepSeek API 凭据；搜索会产生额外模型费用。
              </InlineFeedback>
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
                  disabled={
                    capabilityPending !== null ||
                    (item.key === 'webSearch' &&
                      !capabilityAvailability.webSearch.available &&
                      !agent.capabilities.webSearch)
                  }
                  onCheckedChange={(enabled) => void updateCapability(item.key, enabled)}
                />
              ))}
            </div>
            {agent.capabilities.dynamicCreation ? (
              <div className={styles.sectionActionRow}>
                <span>
                  <strong>动态创造已授权</strong>
                  <small>在频道中描述需求后，可查看真实运行和保存结果。</small>
                </span>
                <Button onClick={() => void navigate('/creator')}>查看创造运行</Button>
              </div>
            ) : null}
          </section>
        </Tabs.Content>

        <Tabs.Content value="extensions">
          <section className={styles.section}>
            <div className={styles.sectionHeading}>已关联扩展</div>
            {agentExtensions.length === 0 ? (
              <EmptyState title="没有关联扩展" description="可在扩展页面查看已保存的扩展和启用状态。" />
            ) : (
              <div className={styles.compactList}>
                {agentExtensions.map((extension) => (
                  <div className={styles.staticRow} key={extension.id}>
                    <span>
                      <strong>{extension.name}</strong>
                      <small>{extension.description}</small>
                    </span>
                    <span>{extension.activation === '已激活' ? '已启用' : extension.activation}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </Tabs.Content>
      </Tabs.Root>

      <ConfirmDialog
        open={bindingOpen}
        onOpenChange={(open) => {
          setBindingOpen(open)
          if (!open) setBindingError('')
        }}
        title="新增频道绑定"
        description="一个智能体可以绑定多个频道；如果所选频道已绑定其他智能体，保存后该频道将改由当前智能体负责。"
        confirmLabel="绑定频道"
        onConfirm={async () => {
          if (!bindingChannelId) {
            setBindingError('当前没有可绑定的频道。')
            return false
          }
          setBindingError('')
          try {
            await useProductStore.getState().createBinding({
              agentId: agent.id,
              channelId: bindingChannelId,
              triggerPolicy: bindingTriggerPolicy,
            })
            notify('频道已绑定。', 'success', `agent-binding:${agent.id}`)
            return true
          } catch (error) {
            notify(error instanceof Error ? error.message : String(error), 'error', `agent-binding:${agent.id}`)
            return false
          }
        }}
      >
        <div className={styles.formStack}>
          {bindingCandidates.length > 0 ? (
            <>
              <SelectField
                label="频道"
                value={bindingChannelId}
                onValueChange={setBindingChannelId}
                options={bindingCandidates.map((channel) => ({
                  value: channel.id,
                  label: `${channel.connectionName} · ${channel.name}`,
                }))}
              />
              <SelectField
                label="响应方式"
                value={bindingTriggerPolicy}
                onValueChange={(value) =>
                  setBindingTriggerPolicy(value as 'always' | 'mentioned-or-replied' | 'command' | 'observe-only')
                }
                options={[
                  { value: 'mentioned-or-replied', label: '被提及或回复时' },
                  { value: 'always', label: '每条消息' },
                  { value: 'command', label: '收到命令时' },
                  { value: 'observe-only', label: '仅观察' },
                ]}
              />
            </>
          ) : (
            <InlineFeedback tone="warning">当前没有可绑定的频道。</InlineFeedback>
          )}
          {undiscoveredConnections.map((connection) => (
            <InlineFeedback key={connection.id} tone="info">
              {connection.name} 尚未发现频道。请先向机器人账号发送一条消息。
            </InlineFeedback>
          ))}
          {bindingError ? <InlineFeedback tone="error">{bindingError}</InlineFeedback> : null}
        </div>
      </ConfirmDialog>
    </div>
  )
}
