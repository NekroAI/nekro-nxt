import { Boxes, ExternalLink, Maximize2, MessagesSquare, Minimize2, Plus, Unplug } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { HostApiContracts, type PromptDocumentV1 } from '@nekro-nxt/contracts'
import { AGENT_ACCESS_LEVELS, agentAccessPreset, type AgentAccessLevel } from '../../agent-access-level.js'
import { PromptReferenceEditor } from '../../components/prompt-reference-editor.js'
import { PanelSlot, useExtensionActivation } from '../../extension-ui/index.js'
import { callHostApi } from '../../host-api-client.js'
import { connectionDisplayName, useProductStore, type AgentSummary, type ModelSummary } from '../../product-runtime.js'
import {
  Banner,
  Button,
  Chip,
  ConfirmDialog,
  DataTable,
  IconButton,
  Menu,
  PropertyGroup,
  PropertyList,
  PropertyRow,
  RiskLadder,
  SecretInput,
  Select,
  Switch,
  toast,
  type RiskStep,
} from '../../ui-kit/next/index.js'
import type { BindIntent } from '../channels/bind-dialog.js'
import { relativeTime } from '../channels/timeline-model.js'
import { isTriggerPolicy, triggerLabel } from '../model/identity.js'
import { useGo } from '../model/nav.js'
import { useProductApi } from '../model/store.js'
import { agentModelKey } from './agent-create-draft.js'
import { accessOfLevel, supportsImages, toggleAccess, type AccessCapability, type AgentDraft } from './agent-draft.js'
import { missingAgentModel, replacementModel } from './model-health.js'
import styles from './agents.module.css'

const failure = (error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
const modelLabel = (model: ModelSummary) => `${model.providerName} · ${model.name}`

export type DraftUpdate = (update: (draft: AgentDraft) => AgentDraft) => void

/** Main model and, when it cannot read images, a helper model that describes them. */
export function ModelSection({
  agent,
  draft,
  update,
}: {
  readonly agent: AgentSummary
  readonly draft: AgentDraft
  readonly update: DraftUpdate
}) {
  const models = useProductStore((state) => state.models)
  const go = useGo()
  const model = models.find((item) => agentModelKey(item) === draft.modelKey)
  const vision = models.find((item) => agentModelKey(item) === draft.visionKey)
  const missing = draft.modelKey && !model ? missingAgentModel(agent, models) : undefined
  const replacement = missing ? replacementModel(missing, models) : undefined
  const options = models.map((item) => ({ value: agentModelKey(item), label: modelLabel(item) }))
  return (
    <PropertyGroup id="profile-model" title="模型">
      {models.length === 0 ? (
        <Banner
          tone="bad"
          action={
            <Button size="small" onClick={() => go('/settings/models')}>
              添加模型
            </Button>
          }
        >
          还没有可用模型，{agent.name}现在无法回复
        </Banner>
      ) : missing ? (
        <Banner
          tone="warn"
          action={
            replacement ? (
              <Button
                size="small"
                onClick={() => update((current) => ({ ...current, modelKey: agentModelKey(replacement) }))}
              >
                改用 {replacement.name}
              </Button>
            ) : undefined
          }
        >
          默认模型 {missing.model} 已不在供应商的模型列表中，可能已停用；看图能力也无法确认
        </Banner>
      ) : null}
      <PropertyList>
        <PropertyRow
          label="主模型"
          description="负责理解消息、思考和回复"
          badge={
            model ? (
              <Chip tone={supportsImages(model) ? 'ok' : 'neutral'}>
                {supportsImages(model) ? '能看图' : '不能看图'}
              </Chip>
            ) : undefined
          }
        >
          <Select
            className={styles.modelSelect}
            aria-label="主模型"
            value={model ? draft.modelKey : ''}
            {...(model ? {} : { placeholder: '选择模型' })}
            options={options}
            onValueChange={(value) => update((current) => ({ ...current, modelKey: value }))}
          />
        </PropertyRow>
        {model && !supportsImages(model) ? (
          <PropertyRow
            label="看图模型"
            description={vision ? '图片先由它描述，再交给主模型' : '不设置时，群里的图片会被跳过'}
          >
            <Select
              className={styles.modelSelect}
              aria-label="看图模型"
              value={vision ? draft.visionKey : ''}
              options={[
                { value: '', label: '不使用' },
                ...models
                  .filter(supportsImages)
                  .map((item) => ({ value: agentModelKey(item), label: modelLabel(item) })),
              ]}
              onValueChange={(value) => update((current) => ({ ...current, visionKey: value }))}
            />
          </PropertyRow>
        ) : null}
      </PropertyList>
    </PropertyGroup>
  )
}

/** Channels this agent answers. Trigger changes and unbinding apply immediately. */
export function ChannelsSection({
  agent,
  onBind,
}: {
  readonly agent: AgentSummary
  readonly onBind: (intent: BindIntent) => void
}) {
  const api = useProductApi()
  const go = useGo()
  const channels = useProductStore((state) => state.channels)
  const connections = useProductStore((state) => state.connections)
  const agents = useProductStore((state) => state.agents)
  const owned = channels.filter((channel) => channel.agentId === agent.id)
  // Channels this agent could answer; taking one over from another agent goes through the same confirmation.
  const available = channels.filter((channel) => channel.agentId !== agent.id)
  const sourceOf = (channel: (typeof channels)[number]) => {
    const connection = connections.find((item) => item.id === channel.connectionId)
    return connection ? connectionDisplayName(connection) : channel.connectionName
  }
  const changeTrigger = async (channelId: string, triggerPolicy: Parameters<typeof isTriggerPolicy>[0]) => {
    if (!isTriggerPolicy(triggerPolicy)) return
    try {
      await api.getState().createBinding({ agentId: agent.id, channelId, triggerPolicy })
    } catch (error) {
      failure(error)
    }
  }
  return (
    <PropertyGroup
      id="profile-channels"
      title="频道"
      description="触发方式修改后立即生效"
      actions={
        <Menu
          label="添加频道"
          align="end"
          trigger={
            <Button size="small" icon={<Plus />} disabled={available.length === 0}>
              添加频道
            </Button>
          }
          items={available.map((channel) => {
            const current = agents.find((item) => item.id === channel.agentId)
            return {
              key: channel.id,
              label: `${channel.name} · ${sourceOf(channel)}${current ? `（${current.name}）` : ''}`,
              onSelect: () =>
                onBind({ kind: channel.agentId ? 'replace' : 'bind', channelId: channel.id, agentId: agent.id }),
            }
          })}
        />
      }
    >
      <DataTable
        label={`${agent.name}的频道`}
        rows={owned}
        rowKey={(channel) => channel.id}
        empty="还没有频道。添加一个频道，让它开始回复。"
        columns={[
          {
            key: 'name',
            header: '频道',
            width: 'minmax(180px, 2fr)',
            render: (channel) => (
              <span className={styles.cellStack}>
                <span className={styles.cellTitle}>{channel.name}</span>
                <span className={styles.cellSub}>{sourceOf(channel)}</span>
              </span>
            ),
          },
          {
            key: 'trigger',
            header: '触发方式',
            width: 'minmax(140px, 1fr)',
            render: (channel) => {
              const binding = channel.bindings[0]
              return binding ? (
                <Select
                  aria-label={`${channel.name} 的触发方式`}
                  value={binding.triggerPolicy}
                  options={(['mentioned-or-replied', 'always', 'command', 'observe-only'] as const).map((value) => ({
                    value,
                    label: triggerLabel[value] ?? value,
                  }))}
                  onValueChange={(value) => void changeTrigger(channel.id, value)}
                />
              ) : null
            },
          },
          {
            key: 'activity',
            header: '最近活动',
            width: '96px',
            priority: 3,
            render: (channel) => (
              <span className={styles.cellSub}>
                {channel.lastActivityAt ? relativeTime(channel.lastActivityAt) : '—'}
              </span>
            ),
          },
          {
            key: 'actions',
            header: <span className={styles.srOnly}>操作</span>,
            width: '72px',
            align: 'end',
            render: (channel) => (
              <>
                <IconButton label={`打开${channel.name}`} size="small" onClick={() => go(`/channels/${channel.id}`)}>
                  <MessagesSquare size={15} />
                </IconButton>
                <IconButton
                  label={`让${agent.name}不再响应${channel.name}`}
                  size="small"
                  onClick={() => onBind({ kind: 'unbind', channelId: channel.id })}
                >
                  <Unplug size={15} />
                </IconButton>
              </>
            ),
          },
        ]}
      />
    </PropertyGroup>
  )
}

const ACCESS_STEPS: readonly RiskStep[] = AGENT_ACCESS_LEVELS.map((level) => ({
  label: level.label,
  riskLabel: level.risk,
  risk: level.level,
  adds:
    level.level === 0
      ? '只能对话，不能读写文件或运行命令'
      : level.level === 1
        ? '文件读写'
        : level.level === 2
          ? '运行命令'
          : '访问工作区以外的系统文件',
}))

const ACCESS_SWITCHES: readonly {
  readonly key: AccessCapability
  readonly label: string
  readonly description: string
}[] = [
  { key: 'fileTools', label: '文件读写', description: '读取文件，并在自己的工作区里写入' },
  { key: 'developmentShell', label: '运行命令', description: '在工作区里运行命令，需要文件读写' },
  { key: 'unrestrictedFileAccess', label: '工作区以外的文件', description: '访问宿主进程允许的全部文件，需要文件读写' },
]

/** Web search runs through an external model service; its credential is saved right where the switch is. */
function WebSearchCredential() {
  const api = useProductApi()
  const availability = useProductStore((state) => state.capabilityAvailability.webSearch)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      await callHostApi(
        HostApiContracts.dshCredentialSet,
        { ref: availability.credentialReference },
        { value: value.trim() },
      )
      setValue('')
      await api.getState().refreshHost()
      toast('搜索凭据已保存')
    } catch (error) {
      failure(error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={styles.credential}>
      <SecretInput
        configured={availability.credentialConfigured}
        value={value}
        placeholder="DeepSeek API 密钥"
        aria-label="DeepSeek API 密钥"
        onChange={(event) => setValue(event.target.value)}
      />
      <Button size="small" busy={busy} disabled={!value.trim()} onClick={() => void save()}>
        保存
      </Button>
    </div>
  )
}

/**
 * System access on a risk ladder plus the other capabilities. Everything here joins the save bar; granting command
 * execution or full access asks first.
 */
export function CapabilitiesSection({
  agent,
  draft,
  update,
}: {
  readonly agent: AgentSummary
  readonly draft: AgentDraft
  readonly update: DraftUpdate
}) {
  const availability = useProductStore((state) => state.capabilityAvailability)
  const [pending, setPending] = useState<{
    readonly title: string
    readonly body: string
    readonly apply: () => void
  } | null>(null)
  const preset = agentAccessPreset(draft.capabilities)
  const caps = draft.capabilities
  const confirmIfRisky = (risky: boolean, title: string, body: string, apply: () => void) => {
    if (risky) setPending({ title, body, apply })
    else apply()
  }
  const selectLevel = (index: number) => {
    const level = AGENT_ACCESS_LEVELS[index]
    if (!level) return
    const apply = () =>
      update((current) => ({ ...current, capabilities: { ...current.capabilities, ...accessOfLevel(level.level) } }))
    const current = preset === 'custom' ? -1 : preset
    confirmIfRisky(
      level.level >= 2 && level.level > current,
      `允许${agent.name}${level.label}？`,
      level.description,
      apply,
    )
  }
  const setAccess = (key: AccessCapability, enabled: boolean) => {
    const apply = () =>
      update((current) => ({ ...current, capabilities: toggleAccess(current.capabilities, key, enabled) }))
    const item = ACCESS_SWITCHES.find((entry) => entry.key === key)
    confirmIfRisky(
      enabled && key !== 'fileTools',
      `允许${agent.name}${item?.label ?? ''}？`,
      item?.description ?? '',
      apply,
    )
  }
  const setCapability = (key: 'subagents' | 'webSearch' | 'dynamicCreation', enabled: boolean) =>
    update((current) => ({ ...current, capabilities: { ...current.capabilities, [key]: enabled } }))

  return (
    <PropertyGroup id="profile-capabilities" title="能力">
      <PropertyList>
        <PropertyRow label="系统访问" description="逐级递进，级别越高能做的事越多，风险也越高" layout="stacked">
          <RiskLadder
            label="系统访问"
            steps={ACCESS_STEPS}
            value={preset === 'custom' ? 'custom' : (preset satisfies AgentAccessLevel)}
            onSelect={selectLevel}
            manual={
              <PropertyList framed={false}>
                {ACCESS_SWITCHES.map((item) => (
                  <PropertyRow key={item.key} label={item.label} description={item.description}>
                    <Switch
                      label={item.label}
                      checked={caps[item.key]}
                      onCheckedChange={(checked) => setAccess(item.key, checked)}
                    />
                  </PropertyRow>
                ))}
              </PropertyList>
            }
          />
        </PropertyRow>
        <PropertyRow label="子智能体" description="把任务分给后台助手并行处理">
          <Switch
            label="子智能体"
            checked={caps.subagents}
            onCheckedChange={(checked) => setCapability('subagents', checked)}
          />
        </PropertyRow>
        <PropertyRow
          label="网页搜索"
          description={
            availability.webSearch.available
              ? '查询公开网页，结果来自外部服务'
              : '需要 DeepSeek API 密钥，每次搜索另计模型费用'
          }
          badge={caps.webSearch && !availability.webSearch.available ? <Chip tone="warn">待配置</Chip> : undefined}
        >
          <Switch
            label="网页搜索"
            checked={caps.webSearch}
            disabled={!availability.webSearch.available && !caps.webSearch}
            onCheckedChange={(checked) => setCapability('webSearch', checked)}
          />
        </PropertyRow>
        {availability.webSearch.available ? null : (
          <PropertyRow label="搜索凭据" description="保存后即可开启网页搜索">
            <WebSearchCredential />
          </PropertyRow>
        )}
        <PropertyRow label="动态创造" description="在频道里按需求制作新工具和界面">
          <Switch
            label="动态创造"
            checked={caps.dynamicCreation}
            onCheckedChange={(checked) => setCapability('dynamicCreation', checked)}
          />
        </PropertyRow>
      </PropertyList>
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={pending?.title ?? ''}
        confirmLabel="允许"
        danger
        onConfirm={() => {
          pending?.apply()
          setPending(null)
        }}
      >
        <p>{pending?.body}</p>
        <p className={styles.note}>确认后还需要保存才会生效。</p>
      </ConfirmDialog>
    </PropertyGroup>
  )
}

/** Agent extensions; switching one on or off applies immediately (with permission approval when needed). */
export function ExtensionsSection({ agent }: { readonly agent: AgentSummary }) {
  const activation = useExtensionActivation()
  const go = useGo()
  const extensions = useProductStore((state) => state.extensions)
  const agentExtensions = extensions.filter((extension) => extension.scope === 'agent')
  const toggle = async (extensionId: string, enabled: boolean, revisionId: string | undefined) => {
    try {
      const changed = await activation.setActive({
        extensionId,
        agentId: agent.id,
        enabled,
        ...(revisionId === undefined ? {} : { revisionId }),
      })
      if (changed) toast(enabled ? '已启用' : '已停用')
    } catch (error) {
      failure(error)
    }
  }
  return (
    <PropertyGroup
      id="profile-extensions"
      title="扩展"
      description="开关立即生效"
      actions={
        <Button size="small" variant="ghost" icon={<ExternalLink />} onClick={() => go('/workshop')}>
          浏览工坊
        </Button>
      }
    >
      {activation.dialog}
      {agentExtensions.length > 0 ? (
        <PropertyList>
          {agentExtensions.map((extension) => (
            <PropertyRow
              key={extension.id}
              label={
                <span className={styles.extensionLabel}>
                  <Boxes size={15} aria-hidden="true" />
                  {extension.name}
                </span>
              }
              description={extension.description || `由${extension.createdByAgent || '本地导入'}提供`}
            >
              <Switch
                label={`为${agent.name}启用${extension.name}`}
                checked={extension.activations.some((item) => item.agentId === agent.id)}
                onCheckedChange={(checked) => void toggle(extension.id, checked, extension.revisions[0]?.id)}
              />
            </PropertyRow>
          ))}
        </PropertyList>
      ) : (
        <p className={styles.note}>还没有可用的扩展。在频道里请智能体做一个新能力，或在工坊导入。</p>
      )}
      <PanelSlot anchor={{ kind: 'agent', id: agent.id }} density="full" />
    </PropertyGroup>
  )
}

/** The persona, folded to a short summary until the user expands or edits it. */
export function PersonaSection({
  agent,
  draft,
  update,
  editing,
  onEditingChange,
}: {
  readonly agent: AgentSummary
  readonly draft: AgentDraft
  readonly update: DraftUpdate
  readonly editing: boolean
  readonly onEditingChange: (editing: boolean) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const text = draft.personaText.trim()
  const setPersona = (persona: PromptDocumentV1, personaText: string) =>
    update((current) => ({ ...current, persona, personaText }))
  let body: ReactNode
  if (editing) {
    body = (
      <div className={[styles.personaEditor, fullscreen ? styles.personaFullscreen : ''].join(' ')}>
        <div className={styles.personaEditorBar}>
          <span className={styles.note}>输入 @ 可以引用成员、频道或扩展</span>
          <IconButton
            label={fullscreen ? '退出全屏' : '全屏编辑'}
            size="small"
            onClick={() => setFullscreen(!fullscreen)}
          >
            {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </IconButton>
        </div>
        <PromptReferenceEditor
          value={draft.persona}
          currentAgentId={agent.id}
          label="设定"
          description="她是谁、怎么说话、在群里负责什么"
          onChange={setPersona}
        />
        <div className={styles.personaEditorFoot}>
          <Button
            size="small"
            onClick={() => {
              setFullscreen(false)
              onEditingChange(false)
            }}
          >
            完成
          </Button>
        </div>
      </div>
    )
  } else {
    body = (
      <div className={styles.personaCard}>
        <p className={[styles.persona, expanded ? '' : styles.personaFolded].join(' ')}>{text || '还没有设定'}</p>
        <div className={styles.personaFoot}>
          <span className={styles.note}>{text ? `${[...text].length} 字` : '设定决定它的身份和说话方式'}</span>
          {text ? (
            <Button size="small" variant="ghost" onClick={() => setExpanded(!expanded)}>
              {expanded ? '收起' : '展开全文'}
            </Button>
          ) : null}
          <Button size="small" onClick={() => onEditingChange(true)}>
            编辑设定
          </Button>
        </div>
      </div>
    )
  }
  return (
    <PropertyGroup id="profile-persona" title="设定">
      {body}
    </PropertyGroup>
  )
}
