import { Plus, Save } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
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
  const navigate = useNavigate()
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [selectedModelKey, setSelectedModelKey] = useState('')
  const [createError, setCreateError] = useState('')

  useEffect(() => {
    if (models.length > 0 && !models.some((model) => modelKey(model) === selectedModelKey)) {
      setSelectedModelKey(modelKey(models[0]!))
    }
  }, [models, selectedModelKey])

  const selectedModel = models.find((model) => modelKey(model) === selectedModelKey)
  const openCreate = (): void => {
    setCreateError('')
    setCreateOpen(true)
  }

  return (
    <div className={styles.page}>
      <PageHeader
        title="智能体"
        meta={agents.length > 0 ? `${agents.length} 个智能体` : undefined}
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
        <div className={styles.objectList} role="list">
          <div className={styles.listHeader} aria-hidden="true">
            <span>智能体</span>
            <span>模型</span>
            <span>使用范围</span>
            <span>状态</span>
            <span />
          </div>
          {agents.map((agent) => (
            <div className={styles.agentRow} role="listitem" key={agent.id}>
              <div className={styles.identityCell}>
                <div className={styles.avatar}>{agent.name.slice(0, 1)}</div>
                <div className={styles.truncate}>
                  <div className={styles.objectName}>{agent.name}</div>
                  {agent.description ? <div className={styles.secondaryText}>{agent.description}</div> : null}
                </div>
              </div>
              <div className={styles.secondaryText}>{agent.model}</div>
              <div className={styles.secondaryText}>
                {agent.channels.length} 个频道 · {agent.extensionCount} 个扩展
              </div>
              <StatusBadge tone={agentTone(agent.state)}>{agent.state}</StatusBadge>
              <div className={styles.rowActions}>
                {agent.channels[0] ? (
                  <Button size="small" onClick={() => void navigate(`/channels/${agent.channels[0]}`)}>
                    打开频道
                  </Button>
                ) : null}
                <Button size="small" variant="ghost" onClick={() => void navigate(`/agents/${agent.id}`)}>
                  配置
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open)
          if (!open) setCreateError('')
        }}
        title="创建智能体"
        description="填写名称并选择模型。创建后会同时建立网页聊天频道。"
        confirmLabel="创建智能体"
        onConfirm={async () => {
          const name = newName.trim()
          if (!name || !selectedModel) {
            setCreateError(!name ? '请输入智能体名称。' : '当前没有可用模型，请先在设置中配置模型供应商。')
            return false
          }
          setCreateError('')
          try {
            await useProductStore.getState().createAgent({ name, model: selectedModel })
            setNewName('')
            return true
          } catch (error) {
            setCreateError(error instanceof Error ? error.message : String(error))
            return false
          }
        }}
      >
        <div className={styles.formStack}>
          <Field label="名称" error={!newName.trim() && createError ? '请输入智能体名称。' : undefined}>
            <Input value={newName} onChange={(event) => setNewName(event.target.value)} autoFocus />
          </Field>
          {models.length > 0 ? (
            <SelectField
              label="模型"
              value={selectedModelKey}
              onValueChange={setSelectedModelKey}
              options={models.map((model) => ({
                value: modelKey(model),
                label: `${model.providerName} · ${model.name}`,
              }))}
            />
          ) : (
            <InlineFeedback tone="warning">当前没有可用模型，请先在设置中配置模型供应商。</InlineFeedback>
          )}
          {createError && newName.trim() ? <InlineFeedback tone="error">{createError}</InlineFeedback> : null}
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
}[] = [
  {
    key: 'dynamicCreation',
    label: '动态创造',
    description: '允许这个智能体创建并试运行临时扩展。',
  },
  {
    key: 'developmentShell',
    label: '开发命令',
    description: '允许在明确授权的开发工作区中运行命令。',
  },
  {
    key: 'fullFileAccess',
    label: '完整文件访问',
    description: '扩大已授权文件能力的可访问范围，不会自动开启开发命令。',
  },
]

export function AgentManagePage() {
  const { agentId = '' } = useParams()
  const host = useProductStore((state) => state.host)
  const agent = useProductStore((state) => state.agents.find((candidate) => candidate.id === agentId))
  const models = useProductStore((state) => state.models)
  const channels = useProductStore((state) => state.channels)
  const connections = useProductStore((state) => state.connections)
  const extensions = useProductStore((state) => state.extensions)
  const [displayName, setDisplayName] = useState(agent?.name ?? '')
  const [persona, setPersona] = useState(agent?.persona ?? '')
  const [selectedModelKey, setSelectedModelKey] = useState(agent ? modelValueForAgent(agent) : '')
  const [savePending, setSavePending] = useState(false)
  const [saveFeedback, setSaveFeedback] = useState<{ tone: 'error' | 'success'; message: string } | null>(null)
  const [capabilityPending, setCapabilityPending] = useState<Capability | null>(null)
  const [capabilityFeedback, setCapabilityFeedback] = useState<{
    tone: 'error' | 'success'
    message: string
  } | null>(null)
  const [bindingOpen, setBindingOpen] = useState(false)
  const [bindingChannelId, setBindingChannelId] = useState('')
  const [bindingTriggerPolicy, setBindingTriggerPolicy] = useState<
    'always' | 'mentioned-or-replied' | 'command' | 'observe-only'
  >('mentioned-or-replied')
  const [bindingError, setBindingError] = useState('')
  const [bindingNote, setBindingNote] = useState('')

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
    setSaveFeedback(null)
  }
  const save = async (): Promise<void> => {
    if (!displayName.trim() || !selectedModel || savePending) return
    setSavePending(true)
    setSaveFeedback(null)
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
      setSaveFeedback({ tone: 'success', message: '智能体配置已保存。新消息会使用最新配置。' })
    } catch (error) {
      setSaveFeedback({ tone: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setSavePending(false)
    }
  }
  const updateCapability = async (capability: Capability, enabled: boolean): Promise<void> => {
    if (capabilityPending) return
    setCapabilityPending(capability)
    setCapabilityFeedback(null)
    try {
      await useProductStore.getState().setCapability(agent.id, capability, enabled)
      setCapabilityFeedback({
        tone: 'success',
        message: `${enabled ? '已开启' : '已关闭'}${capabilityCopy.find((item) => item.key === capability)?.label ?? '此能力'}。`,
      })
    } catch (error) {
      setCapabilityFeedback({ tone: 'error', message: error instanceof Error ? error.message : String(error) })
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

  return (
    <div className={styles.page}>
      <PageHeader
        title={agent.name}
        meta={<StatusBadge tone={agentTone(agent.state)}>{agent.state}</StatusBadge>}
        actions={
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
              <Save size={15} aria-hidden="true" /> 保存配置
            </Button>
          </>
        }
      />

      <Tabs.Root defaultValue="profile">
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
              {saveFeedback ? <InlineFeedback tone={saveFeedback.tone}>{saveFeedback.message}</InlineFeedback> : null}
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
            {bindingNote ? <InlineFeedback tone="success">{bindingNote}</InlineFeedback> : null}
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
            <div className={styles.sectionHeading}>授权能力</div>
            <div className={styles.switchList}>
              {capabilityCopy.map((item) => (
                <SwitchField
                  key={item.key}
                  label={item.label}
                  description={item.description}
                  checked={agent.capabilities[item.key]}
                  disabled={capabilityPending !== null}
                  onCheckedChange={(enabled) => void updateCapability(item.key, enabled)}
                />
              ))}
            </div>
            {capabilityFeedback ? (
              <InlineFeedback tone={capabilityFeedback.tone}>{capabilityFeedback.message}</InlineFeedback>
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
        title="绑定频道"
        description="选择频道和响应方式。"
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
            setBindingNote('频道已绑定。')
            return true
          } catch (error) {
            setBindingError(error instanceof Error ? error.message : String(error))
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
