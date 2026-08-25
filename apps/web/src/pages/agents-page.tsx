import { ChevronDown, ChevronUp, PanelRightClose, PanelRightOpen, Plus, Save, ShieldAlert, Trash2 } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { promptDocumentFromText, type PromptDocumentV1 } from '@nekro-nxt/contracts'
import { NxtLink, useNxtNavigate } from '../shell/nxt-link.js'
import { notify } from '../components/notifications.js'
import { PromptReferenceEditor } from '../components/prompt-reference-editor.js'
import { EmptyState, InlineFeedback, PageHeader } from '../components/product-feedback.js'
import { AddModelProviderForm } from '../llm-settings.js'
import { WebSearchCredentialForm } from '../web-search-credential.js'
import { AgentWorkbenchExtensionSlots } from '../persistent-extension-client.js'
import {
  AGENT_ACCESS_LEVELS,
  agentAccessCapabilities,
  agentAccessLevelOption,
  agentAccessPresentation,
  agentAccessPreset,
  nearestAgentAccessLevel,
  type AgentAccessLevel,
} from '../agent-access-level.js'
import {
  connectionDisplayName,
  defaultImageUnderstandingPolicy,
  useProductStore,
  type AgentRuntimeState,
  type AgentSummary,
  type ImageUnderstandingPolicy,
  type LocalExtensionSummary,
  type ModelSummary,
} from '../product-store.js'
import {
  AgentStateRing,
  Button,
  ConfirmDialog,
  Disclosure,
  Field,
  IconButton,
  Input,
  RangeInput,
  ResizeHandle,
  SelectField,
  SidePane,
  StageCrossfade,
  StatusBadge,
  SwitchControl,
  SwitchField,
  type StatusTone,
} from '../ui-kit/index.js'
import { INSPECTOR_WIDTH, useUiPreferences } from '../ui-preferences.js'
import { useUnsavedDraft } from '../unsaved-drafts.js'
import { agentWorkbenchHref, listAgentBlockers } from './agent-workbench.js'
import { BindingTaskDialog, isTriggerPolicy, listBindingChannels, TRIGGER_POLICY_OPTIONS } from './binding-task.js'
import { agentModelKey, createAgentDraft } from './agent-create-draft.js'
import styles from './product-pages.module.css'

const agentTone = (state: AgentRuntimeState): StatusTone => {
  if (state === '空闲') return 'neutral'
  if (state === '思考中' || state === '使用工具') return 'info'
  if (state === '等待输入') return 'info'
  if (state === '不可用') return 'error'
  return 'neutral'
}

const modelKey = agentModelKey

const modelValueForAgent = (agent: AgentSummary): string =>
  agent.modelRef ? modelKey({ provider: agent.modelRef.provider, id: agent.modelRef.model }) : ''

const modelImageCapability = (model: ModelSummary | undefined): 'vision' | 'text' | 'unknown' => {
  if (model?.inputModalities === undefined) return 'unknown'
  return model.inputModalities.includes('image') ? 'vision' : 'text'
}

function ImagePolicyFields({
  policy,
  selectedModel,
  models,
  onChange,
}: {
  readonly policy: ImageUnderstandingPolicy
  readonly selectedModel: ModelSummary | undefined
  readonly models: readonly ModelSummary[]
  readonly onChange: (policy: ImageUnderstandingPolicy) => void
}) {
  const capability = modelImageCapability(selectedModel)
  const visionModels = models.filter((model) => model.inputModalities?.includes('image'))
  const auxiliaryValue =
    policy.textModel.mode === 'auxiliary'
      ? modelKey({ provider: policy.textModel.model.provider, id: policy.textModel.model.model })
      : 'disabled'
  const updateRestore = (field: 'recentMessages' | 'maxImages', raw: number): void => {
    const bounds = field === 'recentMessages' ? [1, 100] : [1, 50]
    const value = Math.min(bounds[1]!, Math.max(bounds[0]!, Number.isFinite(raw) ? Math.round(raw) : bounds[0]!))
    onChange({
      ...policy,
      history: {
        ...policy.history,
        restoreAfterCompaction: { ...policy.history.restoreAfterCompaction, [field]: value },
      },
    })
  }
  return (
    <div className={styles.formStack}>
      {capability === 'vision' ? (
        <InlineFeedback tone="success">
          当前模型支持图片输入。频道原图会按消息顺序进入上下文，重复内容只注入一次，并支持批量主动重看。
        </InlineFeedback>
      ) : capability === 'text' ? (
        <InlineFeedback tone={policy.textModel.mode === 'auxiliary' ? 'info' : 'warning'}>
          {policy.textModel.mode === 'auxiliary'
            ? '当前主模型仅接收文本；图片会由配置的辅助视觉模型批量理解。'
            : '图片会被保存，但当前智能体尚不能理解图片。请选择辅助视觉模型。'}
        </InlineFeedback>
      ) : (
        <InlineFeedback tone={policy.textModel.mode === 'auxiliary' ? 'info' : 'warning'}>
          当前模型没有声明图片输入能力，按文本模型处理。
        </InlineFeedback>
      )}
      {capability !== 'vision' ? (
        <SelectField
          label="辅助视觉模型"
          value={auxiliaryValue}
          onValueChange={(value) => {
            if (value === 'disabled') {
              onChange({ ...policy, textModel: { mode: 'disabled' } })
              return
            }
            const model = visionModels.find((candidate) => modelKey(candidate) === value)
            if (!model) return
            onChange({
              ...policy,
              textModel: {
                mode: 'auxiliary',
                model: { provider: model.provider, model: model.id },
                maxTokens: 2048,
              },
            })
          }}
          options={[
            { value: 'disabled', label: '不启用图片理解' },
            ...visionModels.map((model) => ({
              value: modelKey(model),
              label: `${model.providerName} · ${model.name}`,
            })),
          ]}
        />
      ) : null}
      <SelectField
        label="图片细节等级"
        value={policy.history.detail}
        onValueChange={(detail) => {
          if (detail !== 'low' && detail !== 'auto' && detail !== 'high') return
          onChange({ ...policy, history: { ...policy.history, detail } })
        }}
        options={[
          { value: 'low', label: '低（节省视觉 Token）' },
          { value: 'auto', label: '自动' },
          { value: 'high', label: '高（按模型最高可用等级）' },
        ]}
      />
      <Field label="压缩后回看消息数" hint="从最近频道事实中恢复原图，范围 1–100。">
        <Input
          type="number"
          min={1}
          max={100}
          value={policy.history.restoreAfterCompaction.recentMessages}
          onChange={(event) => updateRestore('recentMessages', event.currentTarget.valueAsNumber)}
        />
      </Field>
      <Field label="压缩后最多恢复图片" hint="按内容去重后选择最新图片，范围 1–50。">
        <Input
          type="number"
          min={1}
          max={50}
          value={policy.history.restoreAfterCompaction.maxImages}
          onChange={(event) => updateRestore('maxImages', event.currentTarget.valueAsNumber)}
        />
      </Field>
    </div>
  )
}

type AccessLevelStyle = CSSProperties & { '--access-progress': string }

function AccessLevelControl({
  capabilities,
  disabled = false,
  onPresetCommit,
  onCapabilityChange,
}: {
  readonly capabilities: AgentSummary['capabilities']
  readonly disabled?: boolean
  readonly onPresetCommit: (level: AgentAccessLevel) => void
  readonly onCapabilityChange: (
    capability: 'fileTools' | 'developmentShell' | 'unrestrictedFileAccess',
    enabled: boolean,
  ) => void
}) {
  const preset = agentAccessPreset(capabilities)
  const committedValue = preset === 'custom' ? 0 : preset
  const [position, setPosition] = useState<number>(committedValue)
  const [previewLevel, setPreviewLevel] = useState<AgentAccessLevel>(committedValue)
  const [customDraft, setCustomDraft] = useState(preset === 'custom')
  const [dragging, setDragging] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const positionRef = useRef<number>(committedValue)
  const committedRef = useRef(committedValue)
  const interactedRef = useRef(false)
  useEffect(() => {
    setPosition(committedValue)
    setPreviewLevel(committedValue)
    setCustomDraft(preset === 'custom')
    setDragging(false)
    positionRef.current = committedValue
    committedRef.current = committedValue
    interactedRef.current = false
  }, [committedValue, preset])
  const commit = (): void => {
    if (disabled || !interactedRef.current) return
    const next = nearestAgentAccessLevel(positionRef.current)
    interactedRef.current = false
    positionRef.current = next
    setPosition(next)
    setPreviewLevel(next)
    setDragging(false)
    if (!customDraft && next === committedRef.current) return
    committedRef.current = next
    setCustomDraft(false)
    onPresetCommit(next)
  }
  const cancelDrag = (): void => {
    positionRef.current = committedRef.current
    setPosition(committedRef.current)
    setPreviewLevel(committedRef.current)
    setCustomDraft(preset === 'custom')
    setDragging(false)
    interactedRef.current = false
  }
  const updatePosition = (nextPosition: number): void => {
    const next = Math.min(3, Math.max(0, nextPosition))
    const target = nearestAgentAccessLevel(next)
    positionRef.current = next
    setPosition(next)
    setPreviewLevel(target)
    setCustomDraft(false)
    interactedRef.current = true
  }
  const handleRangeKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    let next: AgentAccessLevel | undefined
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown' || event.key === 'PageDown') {
      next = nearestAgentAccessLevel(previewLevel - 1)
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'PageUp') {
      next = nearestAgentAccessLevel(previewLevel + 1)
    } else if (event.key === 'Home') {
      next = 0
    } else if (event.key === 'End') {
      next = 3
    }
    if (next === undefined) return
    event.preventDefault()
    updatePosition(next)
  }
  const option = customDraft ? agentAccessPresentation(capabilities) : agentAccessLevelOption(previewLevel)
  const accessLevelStyle: AccessLevelStyle = { '--access-progress': `${(position / 3) * 100}%` }
  return (
    <div
      className={styles.accessLevelControl}
      data-level={customDraft ? 'custom' : previewLevel}
      data-disabled={disabled ? '' : undefined}
      data-dragging={dragging ? '' : undefined}
      style={accessLevelStyle}
    >
      <div className={styles.accessLevelHeading}>
        <div>
          <strong>系统访问等级（Lv.0–Lv.3）</strong>
          <small>向右提高等级时，会依次包含左侧等级的权限。</small>
        </div>
        <StatusBadge tone={option.tone}>{option.risk}</StatusBadge>
      </div>
      <div className={styles.accessLevelSlider}>
        <div className={styles.accessLevelTrack} aria-hidden="true" />
        <div className={styles.accessLevelStops} aria-hidden="true">
          {AGENT_ACCESS_LEVELS.map((item) => (
            <span
              key={item.level}
              style={{ gridColumn: item.level + 2 }}
              data-access-level-stop={item.level}
              data-snap-target={!customDraft && item.level === previewLevel ? '' : undefined}
            />
          ))}
        </div>
        <RangeInput
          className={styles.accessLevelRange}
          min={0}
          max={3}
          step={0.001}
          value={position}
          disabled={disabled}
          aria-label="系统访问等级"
          aria-valuetext={`${dragging ? '预计吸附到' : ''}${option.label}（${option.code}）：${option.description}`}
          onPointerDown={() => {
            if (disabled) return
            interactedRef.current = true
            setDragging(true)
            setCustomDraft(false)
          }}
          onChange={(event) => updatePosition(event.currentTarget.valueAsNumber)}
          onPointerUp={commit}
          onPointerCancel={cancelDrag}
          onKeyDown={handleRangeKeyDown}
          onKeyUp={commit}
          onBlur={commit}
        />
        <div className={styles.accessLevelScale} aria-hidden="true">
          {AGENT_ACCESS_LEVELS.map((item) => (
            <span
              key={item.level}
              style={{ gridColumn: item.level + 2 }}
              data-access-level-label={item.level}
              data-active={!customDraft && item.level === previewLevel ? '' : undefined}
            >
              {item.label}（{item.code}）
            </span>
          ))}
        </div>
      </div>
      <p className={styles.accessLevelDescription}>
        <strong>
          {option.label}（{option.code}）
        </strong>
        <span>{option.description}</span>
      </p>
      <Button
        className={styles.accessLevelExpand}
        size="small"
        variant="ghost"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        {expanded ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
        {expanded ? '收起逐项设置' : '展开逐项设置'}
      </Button>
      <Disclosure open={expanded} className={styles.accessLevelGranularDisclosure}>
        <div className={styles.accessLevelGranular} data-access-granular>
          <SwitchField
            label="文件读写"
            description="读取文件，并在智能体工作区内写入文件。"
            checked={capabilities.fileTools}
            disabled={disabled}
            onCheckedChange={(enabled) => onCapabilityChange('fileTools', enabled)}
          />
          <SwitchField
            label="运行命令"
            description="在智能体工作区中运行命令。"
            checked={capabilities.developmentShell}
            disabled={disabled}
            onCheckedChange={(enabled) => onCapabilityChange('developmentShell', enabled)}
          />
          <SwitchField
            label="完整访问"
            description="扩大到宿主进程被允许访问的系统范围。"
            checked={capabilities.unrestrictedFileAccess}
            disabled={disabled}
            onCheckedChange={(enabled) => onCapabilityChange('unrestrictedFileAccess', enabled)}
          />
        </div>
      </Disclosure>
    </div>
  )
}

type AgentSettingsTab = 'profile' | 'channels' | 'capabilities' | 'extensions'

const isAgentSettingsTab = (value: string | null): value is AgentSettingsTab =>
  value === 'profile' || value === 'channels' || value === 'capabilities' || value === 'extensions'

export function AgentsPage() {
  const host = useProductStore((state) => state.host)
  const models = useProductStore((state) => state.models)
  const capabilityAvailability = useProductStore((state) => state.capabilityAvailability)
  const navigate = useNxtNavigate()
  const initialCreateDraft = createAgentDraft(models, capabilityAvailability.webSearch.available)
  const [newName, setNewName] = useState(initialCreateDraft.name)
  const [newPersona, setNewPersona] = useState(initialCreateDraft.persona)
  const [newPersonaDocument, setNewPersonaDocument] = useState<PromptDocumentV1>(() =>
    promptDocumentFromText(initialCreateDraft.persona),
  )
  const [selectedModelKey, setSelectedModelKey] = useState(initialCreateDraft.selectedModelKey)
  const [newCapabilities, setNewCapabilities] = useState<AgentSummary['capabilities']>(initialCreateDraft.capabilities)
  const [newImagePolicy, setNewImagePolicy] = useState<ImageUnderstandingPolicy>(defaultImageUnderstandingPolicy())
  const [createError, setCreateError] = useState('')
  const [createPending, setCreatePending] = useState(false)

  useEffect(() => {
    const firstModel = models[0]
    if (firstModel && !models.some((model) => modelKey(model) === selectedModelKey)) {
      setSelectedModelKey(modelKey(firstModel))
    }
  }, [models, selectedModelKey])

  useEffect(() => {
    setNewCapabilities((current) => ({
      ...current,
      webSearch: capabilityAvailability.webSearch.available,
    }))
  }, [capabilityAvailability.webSearch.available])

  const selectedModel = models.find((model) => modelKey(model) === selectedModelKey)
  const create = async (): Promise<void> => {
    const name = newName.trim()
    if (!name) {
      setCreateError('请输入智能体名称。')
      return
    }
    if (!selectedModel) {
      setCreateError('请先保存并选择一个模型供应商。')
      return
    }
    if (createPending) return
    setCreatePending(true)
    setCreateError('')
    try {
      const created = await useProductStore.getState().createAgent({
        name,
        persona: newPersona,
        personaDocument: newPersonaDocument,
        model: selectedModel,
        capabilities: newCapabilities,
        imagePolicy: newImagePolicy,
      })
      void navigate(`/work/channels/${created.channelId}`)
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error))
    } finally {
      setCreatePending(false)
    }
  }

  return (
    <div className={[styles.workbenchPage, styles.agentCreatePage].join(' ')}>
      <div className={styles.workbenchDoc}>
        <PageHeader
          title="创建智能体"
          meta={<StatusBadge tone="info">新智能体草稿</StatusBadge>}
          actions={
            <>
              <Button variant="ghost" disabled={createPending} onClick={() => void navigate('/work')}>
                取消创建
              </Button>
              <Button
                variant="primary"
                loading={createPending}
                loadingLabel="正在创建…"
                disabled={!newName.trim() || !selectedModel || host.status === 'initializing'}
                aria-describedby="agent-create-reason"
                onClick={() => void create()}
              >
                创建智能体
              </Button>
            </>
          }
        />
        <p className={styles.secondaryText} id="agent-create-reason">
          {!newName.trim()
            ? '请输入智能体名称。'
            : !selectedModel
              ? '请保存并选择模型。'
              : '创建会原子保存智能体、首个配置版本和内置频道。'}
        </p>
        {createError ? <InlineFeedback tone="error">{createError}</InlineFeedback> : null}

        <section className={styles.workbenchSection}>
          <div className={styles.section}>
            <div className={styles.sectionHeading}>人设与模型</div>
            <div className={styles.formStack}>
              <Field label="名称" error={!newName.trim() && createError ? '请输入智能体名称。' : undefined}>
                <Input value={newName} onChange={(event) => setNewName(event.target.value)} autoFocus />
              </Field>
              <PromptReferenceEditor
                value={newPersonaDocument}
                onChange={(document, plainText) => {
                  setNewPersonaDocument(document)
                  setNewPersona(plainText)
                }}
                description="描述它的身份、表达方式和工作边界。输入 @ 可引用用户、频道或扩展。"
              />
              {models.length > 0 ? (
                <SelectField
                  label="默认模型"
                  value={selectedModelKey}
                  onValueChange={setSelectedModelKey}
                  options={models.map((model) => ({
                    value: modelKey(model),
                    label: `${model.providerName} · ${model.name}`,
                  }))}
                  helper="自动创建的内置频道会使用这个模型开始对话。"
                />
              ) : (
                <InlineFeedback tone="warning">当前没有可用模型。请先保存一个供应商。</InlineFeedback>
              )}
              {models.length === 0 ? (
                <AddModelProviderForm
                  onSaved={() => {
                    const first = useProductStore.getState().models[0]
                    if (first) setSelectedModelKey(modelKey(first))
                  }}
                />
              ) : null}
              <div className={styles.sectionHeading}>图片理解</div>
              <ImagePolicyFields
                policy={newImagePolicy}
                selectedModel={selectedModel}
                models={models}
                onChange={setNewImagePolicy}
              />
            </div>
          </div>
        </section>

        <section className={styles.workbenchSection}>
          <div className={styles.section}>
            <div className={styles.sectionHeading}>初始授权</div>
            <div className={styles.capabilityChoices}>
              <AccessLevelControl
                capabilities={newCapabilities}
                onPresetCommit={(level) =>
                  setNewCapabilities((current) => ({ ...current, ...agentAccessCapabilities(level) }))
                }
                onCapabilityChange={(capability, enabled) =>
                  setNewCapabilities((current) => ({ ...current, [capability]: enabled }))
                }
              />
              <div className={styles.capabilitySubsection}>
                <div className={styles.capabilitySubsectionHeader}>
                  <div>
                    <strong>动态创造</strong>
                    <small>允许智能体根据对话需求创建并试用扩展。</small>
                  </div>
                  <SwitchControl
                    label="允许动态创造"
                    checked={newCapabilities.dynamicCreation}
                    onCheckedChange={(enabled) =>
                      setNewCapabilities((current) => ({ ...current, dynamicCreation: enabled }))
                    }
                  />
                </div>
              </div>
              <div className={styles.moreCapabilities}>
                <div>
                  <strong>更多能力</strong>
                  <small>这些能力互不依赖，可以分别开启。</small>
                </div>
                <SwitchField
                  label="子智能体"
                  description="允许把独立任务交给后台智能体处理。"
                  checked={newCapabilities.subagents}
                  onCheckedChange={(enabled) => setNewCapabilities((current) => ({ ...current, subagents: enabled }))}
                />
                <SwitchField
                  label="网页搜索"
                  description={
                    capabilityAvailability.webSearch.available
                      ? '允许查询公开网页；搜索可能产生额外费用。'
                      : '可先授权；保存搜索服务凭据后即可使用。'
                  }
                  checked={newCapabilities.webSearch}
                  onCheckedChange={(enabled) => setNewCapabilities((current) => ({ ...current, webSearch: enabled }))}
                />
              </div>
            </div>
          </div>
        </section>
      </div>

      <aside className={[styles.inspector, styles.workbenchInspector].join(' ')} aria-label="创建结果预览">
        <section>
          <h2>创建结果</h2>
          <div className={styles.createSummary}>
            <div>
              <span>智能体</span>
              <strong>{newName.trim() || '尚未命名'}</strong>
            </div>
            <div>
              <span>模型</span>
              <strong>{selectedModel ? `${selectedModel.providerName} · ${selectedModel.name}` : '尚未选择'}</strong>
            </div>
            <div>
              <span>内置频道</span>
              <strong>创建后自动建立</strong>
            </div>
          </div>
        </section>
        <section>
          <h2>初始授权</h2>
          <p className={styles.secondaryText}>{capabilitySummary(newCapabilities).join('、')}</p>
          <InlineFeedback tone="info">正式配置在点击“创建智能体”时写入。</InlineFeedback>
        </section>
      </aside>
    </div>
  )
}

type Capability = keyof AgentSummary['capabilities']

const moreCapabilityCopy: readonly {
  readonly key: Capability
  readonly label: string
  readonly description: string
  readonly risk: { readonly label: string; readonly tone: StatusTone }
}[] = [
  {
    key: 'subagents',
    label: '子智能体',
    description: '允许在后台委派独立任务，主智能体可同时处理频道消息。',
    risk: { label: '低风险', tone: 'info' },
  },
  {
    key: 'webSearch',
    label: '网页搜索',
    description: '允许查询公开网页；搜索结果来自外部服务，可能产生额外费用。',
    risk: { label: '外部服务', tone: 'warning' },
  },
]

const capabilitySummary = (capabilities: AgentSummary['capabilities']): string[] => [
  `${agentAccessPresentation(capabilities).label}（${agentAccessPresentation(capabilities).code}）`,
  ...(capabilities.dynamicCreation ? ['动态创造'] : []),
  ...moreCapabilityCopy.filter((item) => capabilities[item.key]).map((item) => item.label),
]

const capabilityLabel = (capability: Capability): string => {
  if (capability === 'fileTools') return '文件读写'
  if (capability === 'developmentShell') return '运行命令'
  if (capability === 'unrestrictedFileAccess') return '完整访问'
  if (capability === 'dynamicCreation') return '动态创造'
  return moreCapabilityCopy.find((item) => item.key === capability)?.label ?? '此项能力'
}

const dynamicRunLabel = (status: string): string => {
  if (status === 'running') return '正在运行'
  if (status === 'awaiting-approval') return '等待确认'
  if (status === 'failed') return '运行失败'
  if (status === 'stopped') return '已停止'
  return '状态待确认'
}

export function AgentManagePage() {
  const { agentId = '' } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNxtNavigate()
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
  const [personaDocument, setPersonaDocument] = useState<PromptDocumentV1>(
    agent?.personaDocument ?? promptDocumentFromText(agent?.persona ?? ''),
  )
  const [selectedModelKey, setSelectedModelKey] = useState(agent ? modelValueForAgent(agent) : '')
  const [imagePolicy, setImagePolicy] = useState<ImageUnderstandingPolicy>(
    agent?.imagePolicy ?? defaultImageUnderstandingPolicy(),
  )
  const [dynamicClientApprovalPolicy, setDynamicClientApprovalPolicy] = useState<'manual' | 'automatic'>(
    agent?.dynamicClientApprovalPolicy ?? 'manual',
  )
  const [savePending, setSavePending] = useState(false)
  const [capabilityPending, setCapabilityPending] = useState<Capability | 'accessLevel' | null>(null)
  const [bindingOpen, setBindingOpen] = useState(false)
  const [creatorChannelId, setCreatorChannelId] = useState('')
  const [triggerPendingId, setTriggerPendingId] = useState<string | null>(null)
  const [extensionPendingId, setExtensionPendingId] = useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteConfirmation, setDeleteConfirmation] = useState('')
  const [deleteAutoCreatedBuiltInChannels, setDeleteAutoCreatedBuiltInChannels] = useState(true)
  const savedInspectorWidth = useUiPreferences((state) => state.layout.inspectorWidth)
  const inspectorCollapsed = useUiPreferences((state) => state.layout.inspectorCollapsed)
  const inspectorPaneRef = useRef<HTMLDivElement>(null)
  const [inspectorWidth, setInspectorWidth] = useState(savedInspectorWidth)

  useEffect(() => {
    if (!agent) return
    setDisplayName(agent.name)
    setPersona(agent.persona ?? '')
    setPersonaDocument(agent.personaDocument)
    setSelectedModelKey(modelValueForAgent(agent))
    setImagePolicy(agent.imagePolicy)
    setDynamicClientApprovalPolicy(agent.dynamicClientApprovalPolicy)
  }, [agent])
  useEffect(() => setInspectorWidth(savedInspectorWidth), [savedInspectorWidth])
  useEffect(() => {
    const pane = inspectorPaneRef.current
    if (!pane) return
    if (inspectorCollapsed) pane.setAttribute('inert', '')
    else pane.removeAttribute('inert')
  }, [inspectorCollapsed])

  const selectedModel = models.find((model) => modelKey(model) === selectedModelKey)
  const boundChannels = useMemo(
    () => (agent ? channels.filter((channel) => channel.bindings.some((binding) => binding.agentId === agent.id)) : []),
    [agent, channels],
  )
  const activeDynamic = dynamic.find((item) => item.agentId === agent?.id)
  useEffect(() => {
    setCreatorChannelId((current) =>
      boundChannels.some((channel) => channel.id === current) ? current : (boundChannels[0]?.id ?? ''),
    )
  }, [boundChannels])
  const requestedTab = searchParams.get('tab')
  const activeTab: AgentSettingsTab = isAgentSettingsTab(requestedTab) ? requestedTab : 'profile'

  useLayoutEffect(() => {
    if (!agentId) return
    const target = document.getElementById(`agent-${activeTab}`)
    target?.scrollIntoView({ block: 'start' })
  }, [agentId, activeTab])

  const isDirty =
    agent !== undefined &&
    (displayName !== agent.name ||
      persona !== (agent.persona ?? '') ||
      JSON.stringify(personaDocument) !== JSON.stringify(agent.personaDocument) ||
      selectedModelKey !== modelValueForAgent(agent) ||
      JSON.stringify(imagePolicy) !== JSON.stringify(agent.imagePolicy) ||
      dynamicClientApprovalPolicy !== agent.dynamicClientApprovalPolicy)
  useUnsavedDraft(`agent-settings:${agentId}`, isDirty)

  if (!agent) {
    return (
      <div className={styles.page}>
        <EmptyState
          loading={host.status === 'initializing'}
          title={host.status === 'initializing' ? '正在读取智能体' : '找不到这个智能体'}
          description="它可能已被移除，或当前连接尚未同步完成。"
          action={<Button onClick={() => window.location.assign('/work')}>返回智能体</Button>}
        />
      </div>
    )
  }

  const reset = (): void => {
    setDisplayName(agent.name)
    setPersona(agent.persona ?? '')
    setPersonaDocument(agent.personaDocument)
    setSelectedModelKey(modelValueForAgent(agent))
    setImagePolicy(agent.imagePolicy)
    setDynamicClientApprovalPolicy(agent.dynamicClientApprovalPolicy)
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
        personaDocument,
        model: selectedModel,
        imagePolicy,
        dynamicClientApprovalPolicy,
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
        `${enabled ? '已开启' : '已关闭'}${capabilityLabel(capability)}。`,
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
  const updateAccessLevel = async (level: AgentAccessLevel): Promise<void> => {
    if (capabilityPending) return
    setCapabilityPending('accessLevel')
    try {
      await useProductStore.getState().setCapabilities(agent.id, agentAccessCapabilities(level))
      notify(`系统访问已调整为“${agentAccessLevelOption(level).label}”。`, 'success', `agent-access-level:${agent.id}`)
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error', `agent-access-level:${agent.id}`)
    } finally {
      setCapabilityPending(null)
    }
  }

  const blockers = listAgentBlockers({
    agent,
    models,
    channels,
    capabilityAvailability,
    dynamic,
  })
  const actionableBlockers = blockers.filter((blocker) => blocker.kind !== 'creation-running')
  const bindableChannels = listBindingChannels({ channels, excludeBoundToAgentId: agent.id })
  const undiscoveredConnections = connections.filter(
    (connection) => connection.adapterKey !== 'web' && connection.knownChannels.length === 0,
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
  const changeExtensionActivation = async (extension: LocalExtensionSummary, enabled: boolean): Promise<void> => {
    if (extensionPendingId) return
    setExtensionPendingId(extension.id)
    try {
      await useProductStore.getState().setExtensionActive(extension.id, agent.id, enabled)
      notify(
        `${enabled ? '已启用' : '已停用'}“${extension.name}”。`,
        'success',
        `agent-extension:${agent.id}:${extension.id}`,
      )
    } catch (error) {
      notify(
        error instanceof Error ? error.message : String(error),
        'error',
        `agent-extension:${agent.id}:${extension.id}`,
      )
    } finally {
      setExtensionPendingId(null)
    }
  }
  const deleteAgent = async (): Promise<boolean> => {
    if (!agent.currentRevisionId || deleteConfirmation !== agent.name) return false
    try {
      await useProductStore
        .getState()
        .deleteAgent(agent.id, agent.currentRevisionId, deleteConfirmation, deleteAutoCreatedBuiltInChannels)
      notify(
        deleteAutoCreatedBuiltInChannels ? '智能体及其自动创建的内置频道已删除。' : '智能体已删除；频道已解除绑定。',
        'success',
        `agent-delete:${agent.id}`,
      )
      void navigate('/work')
      return true
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error', `agent-delete:${agent.id}`)
      return false
    }
  }
  const workbenchStyle: CSSProperties & { '--nxt-inspector-width': string } = {
    '--nxt-inspector-width': `${inspectorWidth}px`,
  }
  const canConfirmDelete = deleteConfirmation === agent.name && Boolean(agent.currentRevisionId)
  const toggleInspector = (): void => {
    useUiPreferences.getState().setInspectorCollapsed(!inspectorCollapsed)
  }

  return (
    <StageCrossfade swapKey={agent.id}>
      <div className={styles.workbenchPage} style={workbenchStyle}>
        <div className={styles.workbenchDoc}>
          {inspectorCollapsed ? (
            <div className={styles.collapsedInspectorDock}>
              <IconButton label="展开智能体检查器" onClick={toggleInspector}>
                <PanelRightOpen size={15} aria-hidden="true" />
              </IconButton>
            </div>
          ) : null}
          <PageHeader
            title={agent.name}
            meta={
              <>
                {agent.state !== '空闲' ? <AgentStateRing state={agent.state} label={agent.state} /> : null}
                <StatusBadge tone={agentTone(agent.state)}>{agent.state}</StatusBadge>
              </>
            }
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
                  aria-describedby="agent-save-reason"
                  onClick={() => void save()}
                >
                  <Save size={15} aria-hidden="true" /> 保存新配置
                </Button>
              </>
            }
          />
          <p className={styles.secondaryText} id="agent-save-reason">
            {!displayName.trim()
              ? '请输入智能体名称。'
              : !selectedModel
                ? '请选择默认模型。'
                : !isDirty
                  ? '当前配置没有改动。'
                  : '保存会创建新的不可变配置版本。'}
          </p>

          <section className={styles.workbenchSection} id="agent-profile">
            <div className={styles.section}>
              <div className={styles.sectionHeading}>人设与模型</div>
              <div className={styles.formStack}>
                <Field label="名称" error={!displayName.trim() ? '请输入智能体名称。' : undefined}>
                  <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
                </Field>
                <PromptReferenceEditor
                  value={personaDocument}
                  currentAgentId={agent.id}
                  onChange={(document, plainText) => {
                    setPersonaDocument(document)
                    setPersona(plainText)
                  }}
                  description="描述它的身份、表达方式和工作边界。输入 @ 可引用用户、频道或扩展。"
                />
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
                <div className={styles.sectionHeading}>图片理解</div>
                <ImagePolicyFields
                  policy={imagePolicy}
                  selectedModel={selectedModel}
                  models={models}
                  onChange={setImagePolicy}
                />
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
                <EmptyState title="还没有绑定频道" description="绑定频道后，智能体可接收对应消息。" />
              ) : (
                <div className={styles.boundChannelList}>
                  {boundChannels.map((channel) => (
                    <div className={styles.boundChannelRow} key={channel.id}>
                      <NxtLink className={styles.boundChannelName} to={`/work/channels/${channel.id}`}>
                        <strong>{channel.name}</strong>
                        <small>{channel.connectionName}</small>
                      </NxtLink>
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
                  {connectionDisplayName(connection)}{' '}
                  尚未发现频道。请先向机器人账号发送一条消息；发现后即可绑定给这个智能体。
                </InlineFeedback>
              ))}
            </div>
          </section>

          <section className={styles.workbenchSection} id="agent-capabilities">
            <div className={styles.section}>
              <div className={styles.sectionBar}>
                <div>
                  <div className={styles.sectionHeading}>授权能力</div>
                  <div className={styles.secondaryText}>控制系统访问、扩展创造和可独立启用的附加能力。</div>
                </div>
                <ShieldAlert size={18} aria-hidden="true" />
              </div>
              <AccessLevelControl
                capabilities={agent.capabilities}
                disabled={capabilityPending !== null}
                onPresetCommit={(level) => void updateAccessLevel(level)}
                onCapabilityChange={(capability, enabled) => void updateCapability(capability, enabled)}
              />

              <div className={styles.capabilitySubsection} id="agent-creator">
                <div className={styles.capabilitySubsectionHeader}>
                  <div>
                    <strong>动态创造</strong>
                    <small>让智能体根据对话中的需求创建并试用扩展。</small>
                  </div>
                  <SwitchControl
                    label="允许动态创造"
                    checked={agent.capabilities.dynamicCreation}
                    disabled={capabilityPending !== null}
                    onCheckedChange={(enabled) => void updateCapability('dynamicCreation', enabled)}
                  />
                </div>
                {agent.capabilities.dynamicCreation ? (
                  <>
                    <SwitchField
                      label="自动允许扩展界面预览"
                      description="自动加载生成的界面到本机预览。扩展保存和启用需要单独确认。"
                      checked={dynamicClientApprovalPolicy === 'automatic'}
                      disabled={savePending}
                      onCheckedChange={(enabled) => setDynamicClientApprovalPolicy(enabled ? 'automatic' : 'manual')}
                    />
                    {activeDynamic ? (
                      <div className={styles.creatorLaunchPanel}>
                        <span>
                          <strong>{dynamicRunLabel(activeDynamic.status)}</strong>
                          <small>
                            当前有 {activeDynamic.packages.length} 个临时扩展，可在创造工作台查看进度和结果。
                          </small>
                        </span>
                        <Button variant="primary" onClick={() => void navigate(`/work/creator?agent=${agent.id}`)}>
                          查看创造进度
                        </Button>
                      </div>
                    ) : boundChannels.length > 0 ? (
                      <div className={styles.creatorStartPanel}>
                        <SelectField
                          label="沟通频道"
                          value={creatorChannelId}
                          onValueChange={setCreatorChannelId}
                          options={boundChannels.map((channel) => ({ value: channel.id, label: channel.name }))}
                          helper="选择频道并打开，与智能体讨论要新增的功能。"
                        />
                        <Button
                          variant="primary"
                          disabled={!creatorChannelId}
                          onClick={() => void navigate(`/work/channels/${creatorChannelId}`)}
                        >
                          前往频道提出需求
                        </Button>
                      </div>
                    ) : (
                      <InlineFeedback tone="warning">请先绑定频道，再与这个智能体讨论要新增的功能。</InlineFeedback>
                    )}
                  </>
                ) : null}
              </div>

              <div className={styles.moreCapabilities}>
                <div>
                  <strong>更多能力</strong>
                  <small>这些能力互不依赖，可以分别开启。</small>
                </div>
                {moreCapabilityCopy.map((item) => (
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
                {!capabilityAvailability.webSearch.available ? (
                  <div className={styles.webSearchSetup}>
                    <InlineFeedback tone={agent.capabilities.webSearch ? 'warning' : 'info'}>
                      {agent.capabilities.webSearch
                        ? '网页搜索已开启，保存搜索服务凭据后即可使用。'
                        : '需要网页搜索时，可先保存搜索服务凭据。'}
                    </InlineFeedback>
                    <WebSearchCredentialForm />
                    <NxtLink className={styles.secondaryText} to="/settings?tab=dsh-extensions">
                      打开搜索服务设置
                    </NxtLink>
                  </div>
                ) : null}
              </div>
            </div>
          </section>

          <section className={styles.workbenchSection} id="agent-extensions">
            <div className={styles.section}>
              <div className={styles.sectionBar}>
                <div>
                  <div className={styles.sectionHeading}>可用扩展</div>
                  <div className={styles.secondaryText}>选择这个智能体可以使用的扩展。</div>
                </div>
              </div>
              {extensions.length === 0 ? (
                <EmptyState title="还没有本地扩展" description="在创造工作台保存的本地扩展会出现在这里。" />
              ) : (
                <div className={styles.activationGrid} role="list" aria-label={`${agent.name}的可用扩展`}>
                  {extensions.map((extension) => {
                    const activation = extension.activations.find((candidate) => candidate.agentId === agent.id)
                    return (
                      <div
                        className={styles.activationCard}
                        data-active={activation ? '' : undefined}
                        key={extension.id}
                        role="listitem"
                      >
                        <span className={styles.activationGlyph} aria-hidden="true">
                          {extension.name.trim().slice(0, 1) || '扩'}
                        </span>
                        <span className={styles.activationCopy}>
                          <strong>{extension.name}</strong>
                          <small className={styles.activationDescription}>
                            {extension.description || '还没有补充说明。'}
                          </small>
                          <small className={styles.activationMeta}>
                            {activation
                              ? `正在使用 · 版本 ${activation.revision || extension.revision}`
                              : `尚未启用 · 可用版本 ${extension.revision}`}
                          </small>
                        </span>
                        <SwitchControl
                          label={`${activation ? '停用' : '启用'}“${extension.name}”`}
                          checked={activation !== undefined}
                          disabled={extensionPendingId !== null}
                          onCheckedChange={(enabled) => void changeExtensionActivation(extension, enabled)}
                        />
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </section>
          <section className={[styles.workbenchSection, styles.dangerSection].join(' ')}>
            <div className={styles.section}>
              <div className={styles.sectionBar}>
                <div>
                  <div className={styles.sectionHeading}>危险操作</div>
                  <div className={styles.secondaryText}>
                    删除智能体会停止所有频道运行。可同时删除创建智能体时自动生成的内置频道；其他频道将解除绑定。
                  </div>
                </div>
                <Button
                  variant="danger"
                  onClick={() => {
                    setDeleteConfirmation('')
                    setDeleteAutoCreatedBuiltInChannels(true)
                    setDeleteOpen(true)
                  }}
                >
                  <Trash2 size={14} aria-hidden="true" /> 删除智能体
                </Button>
              </div>
            </div>
          </section>
          <AgentWorkbenchExtensionSlots agentId={agent.id} displayName={agent.name} />
          <BindingTaskDialog
            open={bindingOpen}
            onOpenChange={setBindingOpen}
            agentId={agent.id}
            excludeBoundToAgentId={agent.id}
          />
          <ConfirmDialog
            open={deleteOpen}
            onOpenChange={(open) => {
              setDeleteOpen(open)
              if (!open) setDeleteConfirmation('')
            }}
            title={`删除“${agent.name}”？`}
            description="智能体将从列表中移除，所有频道中的当前生成和工具调用会立即中止。历史配置、消息和审计记录用于追溯；扩展、图片和工作区文件归原位置管理。"
            confirmLabel="删除智能体"
            confirmVariant="danger"
            confirmLoadingLabel="正在删除…"
            confirmDisabled={!canConfirmDelete}
            onConfirm={deleteAgent}
          >
            <div className={styles.formStack}>
              <Field label={`输入“${agent.name}”以确认`}>
                <Input
                  value={deleteConfirmation}
                  autoComplete="off"
                  onChange={(event) => setDeleteConfirmation(event.target.value)}
                />
              </Field>
              <SwitchField
                label="同时删除自动创建的内置频道"
                description="范围限于当前绑定给这个智能体、并在创建智能体时自动生成的内置频道；已换绑频道、手工创建的内置频道和外部频道不在此范围。"
                checked={deleteAutoCreatedBuiltInChannels}
                onCheckedChange={setDeleteAutoCreatedBuiltInChannels}
              />
              {deleteConfirmation && deleteConfirmation !== agent.name ? (
                <InlineFeedback tone="error">名称不匹配。</InlineFeedback>
              ) : null}
            </div>
          </ConfirmDialog>
        </div>

        <ResizeHandle
          className={styles.inspectorSplitter}
          label="调整检查器宽度"
          value={inspectorWidth}
          min={INSPECTOR_WIDTH.min}
          max={INSPECTOR_WIDTH.max}
          defaultValue={INSPECTOR_WIDTH.default}
          side="after"
          disabled={inspectorCollapsed}
          onChange={setInspectorWidth}
          onCommit={(value) => useUiPreferences.getState().setInspectorWidth(value)}
        />
        <SidePane collapsed={inspectorCollapsed} width={inspectorWidth} className={styles.inspectorPane}>
          <div ref={inspectorPaneRef} style={{ height: '100%', minHeight: 0 }}>
            <aside className={[styles.inspector, styles.workbenchInspector].join(' ')} aria-label="这个智能体">
              <header className={styles.inspectorChromeHeader}>
                <div>
                  <span>智能体检查器</span>
                  <strong>{agent.name}</strong>
                </div>
                <IconButton label="收起智能体检查器" onClick={toggleInspector}>
                  <PanelRightClose size={15} aria-hidden="true" />
                </IconButton>
              </header>
              <section>
                <h2>运行概况</h2>
                <div className={styles.workbenchStatus}>
                  <div>
                    <strong>{agent.state}</strong>
                    <small>
                      {agent.state === '空闲'
                        ? '当前没有正在执行的智能体任务。'
                        : '运行中的任务会在安全间隙使用兼容的新配置。'}
                    </small>
                  </div>
                </div>
              </section>
              <section>
                <h2>配置摘要</h2>
                <dl className={styles.inspectorFacts}>
                  <div>
                    <dt>默认模型</dt>
                    <dd>{selectedModel ? `${selectedModel.providerName} · ${selectedModel.name}` : '未配置'}</dd>
                  </div>
                  <div>
                    <dt>图片路由</dt>
                    <dd>
                      {agent.imageDiagnostics.route.mode === 'direct'
                        ? '主模型原生视觉'
                        : agent.imageDiagnostics.route.mode === 'delegated'
                          ? `辅助视觉模型 · ${agent.imageDiagnostics.route.provider}/${agent.imageDiagnostics.route.model}`
                          : '图片理解不可用'}
                    </dd>
                  </div>
                  <div>
                    <dt>视觉驻留</dt>
                    <dd>
                      {agent.imageDiagnostics.residentImages} 张，已跳过 {agent.imageDiagnostics.duplicateImagesSkipped}{' '}
                      次重复注入
                    </dd>
                  </div>
                  <div>
                    <dt>最近图片检查</dt>
                    <dd>
                      {agent.imageDiagnostics.lastInspection
                        ? `${agent.imageDiagnostics.lastInspection.mode === 'direct' ? '直接注入' : '辅助理解'} · ${agent.imageDiagnostics.lastInspection.imageCount} 张 · ${agent.imageDiagnostics.lastInspection.cacheHit ? '缓存命中' : '实时调用'}${agent.imageDiagnostics.lastInspection.usage ? ` · ${agent.imageDiagnostics.lastInspection.usage.inputTokens + agent.imageDiagnostics.lastInspection.usage.outputTokens} Token` : ''}`
                        : '暂无记录'}
                    </dd>
                  </div>
                  <div>
                    <dt>视觉恢复</dt>
                    <dd>
                      {agent.imageDiagnostics.lastRestoration
                        ? `${agent.imageDiagnostics.lastRestoration.compactionId} · 候选 ${agent.imageDiagnostics.lastRestoration.candidateCount} · 恢复 ${agent.imageDiagnostics.lastRestoration.restoredCount} · 跳过 ${agent.imageDiagnostics.lastRestoration.skippedCount}`
                        : `最近 ${agent.imagePolicy.history.restoreAfterCompaction.recentMessages} 条消息，最多 ${agent.imagePolicy.history.restoreAfterCompaction.maxImages} 张图`}
                    </dd>
                  </div>
                  <div>
                    <dt>系统访问</dt>
                    <dd>
                      {agentAccessPresentation(agent.capabilities).label}（
                      {agentAccessPresentation(agent.capabilities).code}）
                    </dd>
                  </div>
                  <div>
                    <dt>附加能力</dt>
                    <dd>
                      {
                        [
                          agent.capabilities.dynamicCreation,
                          agent.capabilities.subagents,
                          agent.capabilities.webSearch,
                        ].filter(Boolean).length
                      }{' '}
                      项
                    </dd>
                  </div>
                  <div>
                    <dt>已启用扩展</dt>
                    <dd>
                      {
                        extensions.filter((extension) =>
                          extension.activations.some((activation) => activation.agentId === agent.id),
                        ).length
                      }{' '}
                      个
                    </dd>
                  </div>
                </dl>
                {agent.imageDiagnostics.blockers.map((blocker) => (
                  <InlineFeedback key={blocker} tone="warning">
                    {blocker}
                  </InlineFeedback>
                ))}
              </section>
              <section>
                <h2>需要处理</h2>
                {actionableBlockers.length > 0 ? (
                  <div className={styles.agentBlockers}>
                    {actionableBlockers.map((blocker) => (
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
                  <p className={styles.secondaryText}>当前配置没有待处理项。</p>
                )}
              </section>
              {activeDynamic ? (
                <section>
                  <h2>创造运行</h2>
                  <p className={styles.secondaryText}>
                    {dynamicRunLabel(activeDynamic.status)} · {activeDynamic.packages.length} 个临时包
                  </p>
                  <Button size="small" variant="ghost" onClick={() => void navigate(`/work/creator?agent=${agent.id}`)}>
                    打开创造工作台
                  </Button>
                </section>
              ) : null}
            </aside>
          </div>
        </SidePane>
      </div>
    </StageCrossfade>
  )
}
