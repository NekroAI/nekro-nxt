import { Maximize2, MessagesSquare, Minimize2, MoreHorizontal, Plus, Unplug } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { HostApiContracts, type PromptDocumentV1 } from '@nekro-nxt/contracts'
import { AGENT_ACCESS_LEVELS, agentAccessPreset, type AgentAccessLevel } from '../../agent-access-level.js'
import { PromptReferenceEditor } from '../../components/prompt-reference-editor.js'
import { PanelSlot, useExtensionActivation } from '../../extension-ui/index.js'
import { callHostApi } from '../../host-api-client.js'
import { useFeedbackSummary } from '../community/feedback-model.js'
import {
  connectionDisplayName,
  useProductRuntime,
  useProductStore,
  type AgentSummary,
  type LocalExtensionSummary,
  type ModelSummary,
} from '../../product-runtime.js'
import {
  Banner,
  Button,
  Chip,
  ConfirmDialog,
  DataTable,
  ExtensionIcon,
  IconButton,
  Menu,
  Overlay,
  PropertyGroup,
  PropertyList,
  PropertyRow,
  RiskLadder,
  SecretInput,
  Segmented,
  Select,
  Switch,
  toast,
  type RiskStep,
} from '../../ui-kit/index.js'
import type { BindIntent } from '../channels/bind-dialog.js'
import { relativeTime } from '../channels/timeline-model.js'
import { useGo } from '../model/nav.js'
import { useProductApi } from '../model/store.js'
import { TriggerSelect } from '../channels/binding-fields.js'
import { agentModelKey } from './agent-create-draft.js'
import {
  accessOfLevel,
  supportsImages,
  toggleAccess,
  type AccessCapability,
  type AgentDraft,
  type DraftUpdate,
} from './agent-draft.js'
import { CommandAccountRows } from './command-accounts.js'
import { CommandCredentialRows } from './command-credentials.js'
import { CodeRunNodeDownload, CodeRunNodeRemove } from './runtime-download.js'
import { missingAgentModel, replacementModel } from './model-health.js'
import { hasAgentLayer } from '../workshop/workshop-model.js'
import styles from './agents.module.css'
import { EffortSlider } from './effort-slider.js'
import { CompactionModelField, type CompactionModel } from './compaction-model.js'
import { SubConversationModelRows } from './sub-conversation-models.js'
import { FallbackModelRows } from './fallback-models.js'

/** What each extension autonomy level lets the agent do without opening the console. */
const EXTENSION_AUTONOMY_HINT: Record<'manual' | 'confirm' | 'autonomous', string> = {
  manual: '只开发和试运行；保存、启用等操作都由你在工坊里完成。',
  confirm:
    '保存、启用、切换等每一步都在频道里发出请求，管理员发送 /ext approve 编号 同意后完成。高风险权限仍要在后台批准。',
  autonomous:
    '只影响它自己的普通操作直接完成，并在频道里留下记录和撤销方法；影响其他智能体、需要提升级权限、发布到社区和迁移数据仍要管理员确认，高风险权限仍要在后台批准。',
}

const failure = (error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
const modelLabel = (model: ModelSummary) => `${model.providerName} · ${model.name}`

/** Whether a compaction model asks exactly what the conversation does, which is what the provider caches. */
const sameAsMain = (chosen: CompactionModel, main: ModelSummary | undefined, effort: string): boolean =>
  main !== undefined &&
  chosen.provider === main.provider &&
  chosen.model === main.id &&
  (chosen.reasoningEffort ?? '') === effort

export type { DraftUpdate } from './agent-draft.js'

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
          默认模型 {missing.model} 已不在供应商的模型列表里，可能已下线
        </Banner>
      ) : null}
      <PropertyList>
        <PropertyRow
          label="主模型"
          tip="负责理解消息、思考和回复"
          badge={
            model ? (
              <Chip tone={supportsImages(model) ? 'ok' : 'neutral'}>
                {supportsImages(model) ? '支持视觉' : '不支持视觉'}
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
            onValueChange={(value) =>
              update((current) => {
                // A level the newly chosen model does not offer falls back to that model's default.
                const next = models.find((item) => agentModelKey(item) === value)
                const kept = next?.reasoning?.efforts.some((effort) => effort.id === current.effort) === true
                return { ...current, modelKey: value, effort: kept ? current.effort : '' }
              })
            }
          />
        </PropertyRow>
        {model?.reasoning ? (
          <PropertyRow label="思考强度" layout="stacked" tip="越高，处理复杂问题越可靠，回答也越慢、用量越多">
            <EffortSlider
              efforts={model.reasoning.efforts}
              defaultEffort={model.reasoning.defaultEffort}
              value={model.reasoning.efforts.some((effort) => effort.id === draft.effort) ? draft.effort : ''}
              onChange={(effort) => update((current) => ({ ...current, effort }))}
            />
          </PropertyRow>
        ) : null}
        <FallbackModelRows draft={draft} update={update} />
        {model && !supportsImages(model) ? (
          <PropertyRow
            label="视觉模型"
            description={vision ? '图片先由它描述，再交给主模型' : '不设置时，群里的图片会被跳过'}
          >
            <Select
              className={styles.modelSelect}
              aria-label="视觉模型"
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
        <PropertyRow
          label="会话内压缩"
          layout="stacked"
          tip="上下文快满时，在当前会话里整理更早的内容。跟随主模型时能用上模型的缓存，更快也更省。"
          description={
            draft.compaction.inSession.mode === 'custom' &&
            !sameAsMain(draft.compaction.inSession.model, model, draft.effort)
              ? '和主模型或思考强度不同时，用不上模型的缓存。'
              : undefined
          }
        >
          <CompactionModelField
            label="会话内压缩"
            followLabel="跟随主模型"
            value={draft.compaction.inSession.mode === 'custom' ? draft.compaction.inSession.model : undefined}
            onChange={(chosen) =>
              update((current) => ({
                ...current,
                compaction: {
                  ...current.compaction,
                  inSession: chosen ? { mode: 'custom', model: chosen } : { mode: 'follow' },
                },
              }))
            }
          />
        </PropertyRow>
        <PropertyRow
          label="开新会话时压缩"
          layout="stacked"
          tip="开新会话需要摘要时，使用此模型整理上一段对话。选择更快的模型可缩短等待时间。"
        >
          <CompactionModelField
            label="开新会话时压缩"
            followLabel="跟随默认（设置 → 聊天）"
            value={draft.compaction.newSession.mode === 'custom' ? draft.compaction.newSession.model : undefined}
            onChange={(chosen) =>
              update((current) => ({
                ...current,
                compaction: {
                  ...current.compaction,
                  newSession: chosen ? { mode: 'custom', model: chosen } : { mode: 'follow' },
                },
              }))
            }
          />
        </PropertyRow>
        <SubConversationModelRows draft={draft} update={update} />
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

  return (
    <PropertyGroup
      id="profile-channels"
      title="频道"
      tip="触发方式修改后立即生效"
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
            width: 'minmax(120px, 2fr)',
            render: (channel) => (
              <span className={styles.cellStack}>
                <span className={styles.cellTitle}>{channel.name}</span>
                <span className={styles.cellSub}>{sourceOf(channel)}</span>
              </span>
            ),
          },
          {
            key: 'trigger',
            header: '何时回复',
            width: 'minmax(128px, 1fr)',
            render: (channel) => <TriggerSelect channel={channel} />,
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
            width: '40px',
            align: 'end',
            render: (channel) => (
              <Menu
                label={`${channel.name} 的操作`}
                trigger={
                  <IconButton label={`${channel.name} 的更多操作`} size="small">
                    <MoreHorizontal size={15} />
                  </IconButton>
                }
                items={[
                  {
                    key: 'open',
                    label: '打开频道',
                    icon: <MessagesSquare size={14} />,
                    onSelect: () => go(`/channels/${channel.id}`),
                  },
                  {
                    key: 'unbind',
                    label: '不再响应这个频道',
                    icon: <Unplug size={14} />,
                    danger: true,
                    onSelect: () => onBind({ kind: 'unbind', channelId: channel.id }),
                  },
                ]}
              />
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
        ? '工作区读写'
        : level.level === 2
          ? '运行命令'
          : '访问工作区以外的系统文件',
}))

const ACCESS_SWITCHES: readonly {
  readonly key: AccessCapability
  readonly label: string
  readonly description: string
}[] = [
  { key: 'fileTools', label: '工作区读写', description: '读写自己工作区里的文件' },
  { key: 'developmentShell', label: '运行命令', description: '在工作区里运行命令，需要工作区读写' },
  {
    key: 'unrestrictedFileAccess',
    label: '工作区以外的文件',
    description: '读写工作区以外的文件，需要先开启工作区读写',
  },
]

/**
 * Network for commands, shown once commands are allowed. Full access and hosts that cannot cut the network keep it
 * on, so the switch shows that and stays fixed.
 */
function CommandNetworkRow({
  caps,
  update,
}: {
  readonly caps: AgentDraft['capabilities']
  readonly update: DraftUpdate
}) {
  const confinement = useProductStore((state) => state.capabilityAvailability.commandConfinement)
  const fixed = caps.unrestrictedFileAccess
    ? '完整访问下，命令始终可以联网'
    : confinement?.networkControl
      ? undefined
      : '这台设备无法限制命令联网，命令始终可以联网'
  return (
    <>
      <PropertyRow
        depth={1}
        label="命令联网"
        description={fixed ?? '运行命令和编排程序时访问网络，例如下载数据、安装依赖'}
      >
        <Switch
          label="命令联网"
          checked={fixed === undefined ? caps.commandNetwork : true}
          disabled={fixed !== undefined}
          onCheckedChange={(checked) =>
            update((current) => ({ ...current, capabilities: { ...current.capabilities, commandNetwork: checked } }))
          }
        />
      </PropertyRow>
      {!caps.unrestrictedFileAccess && confinement !== undefined && !confinement.readScope ? (
        <PropertyRow depth={1} label="读取范围" description="这台设备上，命令仍能读取工作区以外的文件" />
      ) : null}
    </>
  )
}

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
  const feedback = useFeedbackSummary()
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
  const setCapability = (key: 'subagents' | 'webSearch' | 'dynamicCreation' | 'scheduledTasks', enabled: boolean) =>
    update((current) => ({ ...current, capabilities: { ...current.capabilities, [key]: enabled } }))

  return (
    <PropertyGroup id="profile-capabilities" title="能力">
      <PropertyList>
        <PropertyRow label="系统访问" layout="stacked">
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
        {caps.developmentShell ? <CommandNetworkRow caps={caps} update={update} /> : null}
        {caps.developmentShell && !caps.unrestrictedFileAccess ? (
          <CommandAccountRows agent={agent} caps={caps} update={update} />
        ) : null}
        {caps.developmentShell ? <CommandCredentialRows agentId={agent.id} /> : null}
        {caps.developmentShell ? (
          <PropertyRow
            depth={1}
            label="编排模式（PTC）"
            description="把多个步骤写成一段程序一次做完，适合翻大量记录、批量处理文件。开启后，智能体的所有操作都通过程序完成。"
            badge={caps.codeRun && !availability.codeRun?.available ? <Chip tone="warn">待配置</Chip> : undefined}
          >
            <Switch
              label="编排模式（PTC）"
              checked={caps.codeRun}
              disabled={!availability.codeRun?.available && !caps.codeRun}
              onCheckedChange={(checked) =>
                update((current) => ({ ...current, capabilities: { ...current.capabilities, codeRun: checked } }))
              }
            />
          </PropertyRow>
        ) : null}
        {caps.developmentShell && availability.codeRun !== undefined ? (
          availability.codeRun.available ? (
            availability.codeRun.source === 'downloaded' ? (
              <PropertyRow
                depth={2}
                label="编排运行环境"
                description={`Node ${availability.codeRun.version ?? ''}，由 NXT 下载`}
              >
                <CodeRunNodeRemove availability={availability.codeRun} />
              </PropertyRow>
            ) : null
          ) : availability.codeRun.download !== undefined ? (
            <PropertyRow depth={2} label="编排运行环境" description="这台设备没有可用的 Node，下载后即可开启">
              <CodeRunNodeDownload availability={availability.codeRun} />
            </PropertyRow>
          ) : null
        ) : null}
        <PropertyRow label="子对话" tip="把需要单独处理的事交给子对话去做，进行中的子对话显示在频道下">
          <Switch
            label="子对话"
            checked={caps.subagents}
            onCheckedChange={(checked) => setCapability('subagents', checked)}
          />
        </PropertyRow>
        <PropertyRow
          label="网页搜索"
          description={
            availability.webSearch.unavailableReason ??
            (availability.webSearch.available ? undefined : '需要 DeepSeek API 密钥，每次搜索另计模型费用')
          }
          tip={availability.webSearch.available ? '查询公开网页，结果来自外部服务' : undefined}
          badge={
            caps.webSearch && !availability.webSearch.available ? (
              <Chip tone="warn">{availability.webSearch.unavailableReason ? '暂不可用' : '待配置'}</Chip>
            ) : undefined
          }
        >
          <Switch
            label="网页搜索"
            checked={caps.webSearch}
            disabled={!availability.webSearch.available && !caps.webSearch}
            onCheckedChange={(checked) => setCapability('webSearch', checked)}
          />
        </PropertyRow>
        {availability.webSearch.available || availability.webSearch.unavailableReason ? null : (
          <PropertyRow depth={1} label="搜索凭据" tip="保存后即可开启网页搜索">
            <WebSearchCredential />
          </PropertyRow>
        )}
        <PropertyRow label="动态创造" tip="在频道里按需求制作新工具和界面">
          <Switch
            label="动态创造"
            checked={caps.dynamicCreation}
            onCheckedChange={(checked) => setCapability('dynamicCreation', checked)}
          />
        </PropertyRow>
        {caps.dynamicCreation ? (
          <>
            <PropertyRow
              depth={1}
              label="扩展自主权"
              layout="stacked"
              width="md"
              description={EXTENSION_AUTONOMY_HINT[caps.extensionAutonomy]}
            >
              <Segmented
                label="扩展自主权"
                value={caps.extensionAutonomy}
                onChange={(value) =>
                  update((current) => ({
                    ...current,
                    capabilities: { ...current.capabilities, extensionAutonomy: value },
                  }))
                }
                options={[
                  { value: 'manual', label: '手动' },
                  { value: 'confirm', label: '管理员确认' },
                  { value: 'autonomous', label: '自主' },
                ]}
              />
            </PropertyRow>
            <PropertyRow
              depth={1}
              label="谁可以让它做扩展"
              tip="只听管理员时，其他人请它开发或修改扩展会被婉拒；聊天和使用已有扩展不受影响"
            >
              <Select
                aria-label="谁可以让它做扩展"
                value={caps.extensionRequesters}
                onValueChange={(value) =>
                  update((current) => ({
                    ...current,
                    capabilities: {
                      ...current.capabilities,
                      extensionRequesters: value === 'admins' ? 'admins' : 'everyone',
                    },
                  }))
                }
                options={[
                  { value: 'everyone', label: '频道里的所有人' },
                  { value: 'admins', label: '只有管理员' },
                ]}
              />
            </PropertyRow>
            <PropertyRow
              depth={1}
              label="谁可以让它改配置"
              tip="选所有人时，其他人只能让它改自己的普通配置项；本机配置、访问地址和凭据仍只听管理员"
            >
              <Select
                aria-label="谁可以让它改配置"
                value={caps.extensionConfigRequesters}
                onValueChange={(value) =>
                  update((current) => ({
                    ...current,
                    capabilities: {
                      ...current.capabilities,
                      extensionConfigRequesters: value === 'everyone' ? 'everyone' : 'admins',
                    },
                  }))
                }
                options={[
                  { value: 'everyone', label: '频道里的所有人' },
                  { value: 'admins', label: '只有管理员' },
                ]}
              />
            </PropertyRow>
          </>
        ) : null}
        <PropertyRow label="定时任务" tip="频道成员可以请它设置提醒和周期任务">
          <Switch
            label="定时任务"
            checked={caps.scheduledTasks}
            onCheckedChange={(checked) => setCapability('scheduledTasks', checked)}
          />
        </PropertyRow>
        {feedback.enabled ? (
          <PropertyRow
            label="免确认提交反馈"
            tip="只在你从客户端发出的消息触发的轮次中生效，不附带对话摘录，每天最多 5 条"
          >
            <Switch
              label="免确认提交反馈"
              checked={caps.communityFeedbackAuto}
              onCheckedChange={(enabled) =>
                confirmIfRisky(
                  enabled,
                  `允许${agent.name}免确认提交反馈？`,
                  '反馈会直接发送到社区。只对你从客户端发出的消息触发的轮次生效，不附带对话摘录，每天最多 5 条。',
                  () =>
                    update((current) => ({
                      ...current,
                      capabilities: { ...current.capabilities, communityFeedbackAuto: enabled },
                    })),
                )
              }
            />
          </PropertyRow>
        ) : null}
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

/** A request waiting for the agent's current reply to end shows its target position and stays busy until it lands. */
const activationSwitchState = (
  extension: LocalExtensionSummary,
  agentId: string,
): { readonly checked: boolean; readonly pending: boolean } => {
  const transition = extension.activationTransitions?.find((item) => item.agentId === agentId)
  return transition?.state === 'waiting'
    ? { checked: transition.target === 'enabled', pending: true }
    : { checked: extension.activations.some((item) => item.agentId === agentId), pending: false }
}

/** Agent extensions; switching one on or off applies immediately (with permission approval when needed). */
export function ExtensionsSection({ agent }: { readonly agent: AgentSummary }) {
  const activation = useExtensionActivation()
  const product = useProductRuntime()
  const go = useGo()
  const extensions = useProductStore((state) => state.extensions)
  const agentExtensions = extensions.filter(hasAgentLayer)
  const toggle = async (extensionId: string, enabled: boolean, revisionId: string | undefined) => {
    try {
      const changed = await activation.setActive({
        extensionId,
        agentId: agent.id,
        enabled,
        ...(revisionId === undefined ? {} : { revisionId }),
      })
      if (!changed) return
      const transition = product.store
        .getState()
        .extensions.find((extension) => extension.id === extensionId)
        ?.activationTransitions?.find((item) => item.agentId === agent.id)
      if (transition?.state === 'failed') {
        failure(new Error(transition.message ?? (enabled ? '启用失败。' : '停用失败。')))
        return
      }
      const action = enabled ? '启用' : '停用'
      toast(transition?.state === 'waiting' ? `${agent.name}正在回复，结束后${action}` : `已${action}`)
    } catch (error) {
      failure(error)
    }
  }
  return (
    <PropertyGroup
      id="profile-extensions"
      title="扩展"
      tip="开关立即生效"
      actions={
        <Button size="small" variant="ghost" onClick={() => go('/workshop')}>
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
                  <ExtensionIcon id={extension.id} name={extension.name} iconUrl={extension.iconUrl} size="sm" />
                  {extension.name}
                </span>
              }
              description={
                <span className={styles.oneLine} title={extension.description || undefined}>
                  {extension.description || `由${extension.createdByAgent || '本地导入'}提供`}
                </span>
              }
            >
              <Switch
                label={`为${agent.name}启用${extension.name}`}
                {...activationSwitchState(extension, agent.id)}
                onCheckedChange={(checked) => toggle(extension.id, checked, undefined)}
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
    const editor = (
      <PromptReferenceEditor
        value={draft.persona}
        currentAgentId={agent.id}
        label="设定"
        labelHidden
        description="它是谁、怎么说话、在群里负责什么"
        onChange={setPersona}
      />
    )
    body = (
      <div className={styles.personaEditor}>
        <div className={styles.personaEditorBar}>
          <span className={styles.note}>输入 @ 可以引用成员、频道或扩展</span>
          <IconButton label="全屏编辑" size="small" onClick={() => setFullscreen(true)}>
            <Maximize2 size={15} />
          </IconButton>
        </div>
        {fullscreen ? <p className={styles.note}>正在全屏编辑设定。</p> : editor}
        <div className={styles.personaEditorFoot}>
          <Button size="small" onClick={() => onEditingChange(false)}>
            完成
          </Button>
        </div>
        <Overlay
          open={fullscreen}
          onOpenChange={setFullscreen}
          label="全屏编辑设定"
          className={styles.personaOverlay}
          onEscapeKeyDown={(event) => {
            // An open @ menu closes first; the next Escape leaves full screen.
            if (document.querySelector('[data-reference-menu-placement]')) event.preventDefault()
          }}
        >
          <div className={styles.personaEditorBar}>
            <span className={styles.note}>输入 @ 可以引用成员、频道或扩展</span>
            <IconButton label="退出全屏" size="small" onClick={() => setFullscreen(false)}>
              <Minimize2 size={15} />
            </IconButton>
          </div>
          <PromptReferenceEditor
            value={draft.persona}
            currentAgentId={agent.id}
            label="设定"
            description="它是谁、怎么说话、在群里负责什么"
            fill
            onChange={setPersona}
          />
        </Overlay>
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
