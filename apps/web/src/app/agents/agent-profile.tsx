import { useGo } from '../model/nav.js'
import { CompatibilityNotices } from '../system/compatibility.js'
import { PanelSlot } from '../../extension-ui/index.js'
import { Boxes, Cable, FolderCog, Globe, MessagesSquare, PencilLine, Sparkles, Trash2, Workflow } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'

import {
  HostApiContracts,
  promptDocumentPlainText,
  type AgentRevisionHistory,
  type PromptDocumentV1,
} from '@nekro-nxt/contracts'
import { callHostApi, workspaceApi } from '../../host-api-client.js'
import { relativeTime } from '../channels/timeline-model.js'
import { AGENT_ACCESS_LEVELS, agentAccessPreset, type AgentAccessLevel } from '../../agent-access-level.js'
import { PromptReferenceEditor } from '../../components/prompt-reference-editor.js'
import { agentModelKey } from './agent-create-draft.js'
import {
  connectionDisplayName,
  useProductStore,
  type AgentSummary,
  type ImageUnderstandingPolicy,
  type ModelSummary,
} from '../../product-runtime.js'
import {
  AgentAvatar,
  Banner,
  Button,
  Chip,
  ConfirmDialog,
  Field,
  Input,
  Panel,
  SecretInput,
  Section,
  Segmented,
  Select,
  Switch,
  SwitchRow,
  toast,
  cssVars,
} from '../../ui-kit/next/index.js'
import { agentAccent, agentHue, agentPhase, isAgentWorking, isTriggerPolicy, triggerLabel } from '../model/identity.js'
import { useExtensionActivation } from '../../extension-ui/index.js'
import { useProductApi } from '../model/store.js'
import styles from './agents.module.css'

const failure = (error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })

const modelLabel = (model: ModelSummary) => `${model.providerName} · ${model.name}`
const supportsImages = (model: ModelSummary | undefined) => model?.inputModalities?.includes('image') ?? false

interface Draft {
  readonly name: string
  readonly persona: PromptDocumentV1
  readonly personaText: string
  readonly modelKey: string
  readonly visionKey: string
}

const draftOf = (agent: AgentSummary): Draft => ({
  name: agent.name,
  persona: agent.personaDocument,
  personaText: promptDocumentPlainText(agent.personaDocument),
  modelKey: agent.modelRef ? agentModelKey({ provider: agent.modelRef.provider, id: agent.modelRef.model }) : '',
  visionKey:
    agent.imagePolicy.textModel.mode === 'auxiliary'
      ? agentModelKey({
          provider: agent.imagePolicy.textModel.model.provider,
          id: agent.imagePolicy.textModel.model.model,
        })
      : '',
})

function lineDiff(before: string, after: string): readonly { readonly kind: 'add' | 'del'; readonly text: string }[] {
  const left = before.split('\n')
  const right = after.split('\n')
  return [
    ...left.filter((line) => line.trim() && !right.includes(line)).map((text) => ({ kind: 'del' as const, text })),
    ...right.filter((line) => line.trim() && !left.includes(line)).map((text) => ({ kind: 'add' as const, text })),
  ]
}

function Editor({ agent, onDone }: { readonly agent: AgentSummary; readonly onDone: () => void }) {
  const api = useProductApi()
  const models = useProductStore((state) => state.models)
  const [draft, setDraft] = useState<Draft>(() => draftOf(agent))
  const [saving, setSaving] = useState(false)
  const original = useMemo(() => draftOf(agent), [agent])
  const model = models.find((item) => agentModelKey(item) === draft.modelKey)
  const vision = models.find((item) => agentModelKey(item) === draft.visionKey)
  const personaChanges = lineDiff(original.personaText, draft.personaText)
  const changes = [
    draft.name.trim() !== original.name ? `名称：${original.name} → ${draft.name.trim()}` : '',
    draft.modelKey !== original.modelKey ? `模型：${model ? modelLabel(model) : '未选择'}` : '',
    draft.visionKey !== original.visionKey ? `看图：${vision ? modelLabel(vision) : '不使用'}` : '',
  ].filter(Boolean)
  const dirty =
    changes.length > 0 ||
    personaChanges.length > 0 ||
    JSON.stringify(draft.persona) !== JSON.stringify(original.persona)
  const visionOptions = models.filter((item) => supportsImages(item))

  const publish = async () => {
    if (!model) {
      toast('先选择一个模型', { tone: 'bad' })
      return
    }
    setSaving(true)
    try {
      const imagePolicy: ImageUnderstandingPolicy =
        supportsImages(model) || !vision
          ? { ...agent.imagePolicy, textModel: { mode: 'disabled' } }
          : {
              ...agent.imagePolicy,
              textModel: {
                mode: 'auxiliary',
                model: { provider: vision.provider, model: vision.id },
                maxTokens:
                  agent.imagePolicy.textModel.mode === 'auxiliary' ? agent.imagePolicy.textModel.maxTokens : 1024,
              },
            }
      await api.getState().reviseAgent({
        agentId: agent.id,
        ...(agent.currentRevisionId ? { expectedCurrentRevisionId: agent.currentRevisionId } : {}),
        displayName: draft.name.trim(),
        persona: draft.personaText,
        personaDocument: draft.persona,
        model,
        ...(agent.modelRef?.reasoningEffort && agentModelKey(model) === original.modelKey
          ? { reasoningEffort: agent.modelRef.reasoningEffort }
          : {}),
        imagePolicy,
        dynamicClientApprovalPolicy: agent.dynamicClientApprovalPolicy,
      })
      toast('已发布新版本')
      onDone()
    } catch (error) {
      failure(error)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={styles.editor}>
      <Field label="名称">
        <Input
          value={draft.name}
          maxLength={40}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </Field>
      <PromptReferenceEditor
        value={draft.persona}
        currentAgentId={agent.id}
        label="设定"
        description="输入 @ 可以引用成员、频道或扩展。"
        onChange={(persona, personaText) => setDraft((current) => ({ ...current, persona, personaText }))}
      />
      <div className={styles.editorRow}>
        <Field label="模型">
          <Select
            value={draft.modelKey}
            {...(draft.modelKey ? {} : { placeholder: '选择模型' })}
            options={models.map((item) => ({ value: agentModelKey(item), label: modelLabel(item) }))}
            onChange={(event) => setDraft({ ...draft, modelKey: event.target.value })}
          />
        </Field>
        {model && !supportsImages(model) ? (
          <Field label="看图">
            <Select
              value={draft.visionKey}
              options={[
                { value: '', label: '不使用' },
                ...visionOptions.map((item) => ({ value: agentModelKey(item), label: modelLabel(item) })),
              ]}
              onChange={(event) => setDraft({ ...draft, visionKey: event.target.value })}
            />
          </Field>
        ) : null}
      </div>
      {dirty ? (
        <Panel className={styles.diff}>
          {changes.map((change) => (
            <div key={change} className={styles.diffField}>
              {change}
            </div>
          ))}
          {personaChanges.map((line, index) => (
            <div key={`${line.kind}:${index}`} className={line.kind === 'add' ? styles.diffAdd : styles.diffDel}>
              {line.kind === 'add' ? '+ ' : '− '}
              {line.text}
            </div>
          ))}
        </Panel>
      ) : null}
      <div className={styles.saveBar}>
        <span>{dirty ? '发布后，进行中的对话在下一个安全时机使用新设定' : '未修改'}</span>
        <Button variant="ghost" onClick={onDone} disabled={saving}>
          取消
        </Button>
        <Button
          variant="primary"
          onClick={() => void publish()}
          busy={saving}
          disabled={!dirty || !draft.name.trim() || !model}
        >
          发布新版本
        </Button>
      </div>
    </div>
  )
}

function SkillRow({
  icon,
  title,
  description,
  badge,
  control,
  children,
}: {
  readonly icon: ReactNode
  readonly title: string
  readonly description: string
  readonly badge?: ReactNode
  readonly control?: ReactNode
  readonly children?: ReactNode
}) {
  return (
    <div className={styles.skill}>
      <span className={styles.skillIcon}>{icon}</span>
      <div className={styles.skillText}>
        <span className={styles.skillTitle}>
          {title}
          {badge}
        </span>
        <span className={styles.skillDesc}>{description}</span>
      </div>
      {control}
      {children ? <div className={styles.accessRow}>{children}</div> : null}
    </div>
  )
}

/** Web search runs through an external model service; its credential can be saved right where the skill is. */
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
    <>
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
    </>
  )
}

const CHANGED_FIELD_LABEL: Record<AgentRevisionHistory['revisions'][number]['changedFields'][number], string> = {
  name: '名称',
  persona: '设定',
  model: '模型',
  capabilities: '技能',
  imagePolicy: '图片理解',
  approvalPolicy: '运行确认',
}

const VISIBLE_VERSIONS = 5

/** Immutable revision history, newest first; any earlier revision can become current again. */
function Versions({ agent }: { readonly agent: AgentSummary }) {
  const api = useProductApi()
  const [history, setHistory] = useState<AgentRevisionHistory>()
  const [expanded, setExpanded] = useState(false)
  const [restoring, setRestoring] = useState<AgentRevisionHistory['revisions'][number]>()
  useEffect(() => {
    let live = true
    workspaceApi
      .listAgentRevisions(agent.id)
      .then((next) => live && setHistory(next))
      .catch(() => live && setHistory(undefined))
    return () => {
      live = false
    }
  }, [agent.id, agent.currentRevisionId])

  if (!history) return <Panel className={styles.versionsEmpty}>正在读取版本…</Panel>
  const rows = expanded ? history.revisions : history.revisions.slice(0, VISIBLE_VERSIONS)
  return (
    <>
      <Panel className={styles.table}>
        {rows.map((revision) => (
          <div key={revision.id} className={styles.versionRow} data-current={revision.current}>
            <b className={styles.versionKey}>r{revision.revision}</b>
            <span className={styles.versionChanges}>
              {revision.changedFields.length > 0 ? (
                revision.changedFields.map((field) => <Chip key={field}>{CHANGED_FIELD_LABEL[field]}</Chip>)
              ) : (
                <span className={styles.cellSub}>{revision.revision === 1 ? '创建' : '无变化'}</span>
              )}
            </span>
            <span className={styles.cellSub}>{relativeTime(revision.createdAt)}</span>
            {revision.current ? (
              <Chip tone="accent">当前</Chip>
            ) : (
              <Button size="small" variant="ghost" onClick={() => setRestoring(revision)}>
                恢复
              </Button>
            )}
          </div>
        ))}
      </Panel>
      {history.revisions.length > VISIBLE_VERSIONS ? (
        <Button size="small" variant="ghost" onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起' : `显示全部 ${history.revisions.length} 个版本`}
        </Button>
      ) : null}
      <ConfirmDialog
        open={restoring !== undefined}
        onOpenChange={(open) => !open && setRestoring(undefined)}
        title={`恢复到 r${restoring?.revision ?? ''}？`}
        confirmLabel="恢复"
        onConfirm={async () => {
          if (!restoring) return
          await workspaceApi.restoreAgentRevision(agent.id, restoring.id, history.currentRevisionId)
          await api.getState().refreshHost()
          toast(`${agent.name}已恢复到 r${restoring.revision}`)
        }}
      >
        正在进行的工作结束后，各频道开始使用这个版本。当前版本仍保留在历史中。
      </ConfirmDialog>
    </>
  )
}

function Skills({ agent }: { readonly agent: AgentSummary }) {
  const api = useProductApi()
  const activation = useExtensionActivation()
  const availability = useProductStore((state) => state.capabilityAvailability)
  const extensions = useProductStore((state) => state.extensions)
  const [pendingLevel, setPendingLevel] = useState<AgentAccessLevel | null>(null)
  const preset = agentAccessPreset(agent.capabilities)
  const agentExtensions = extensions.filter((extension) => extension.scope === 'agent')

  const set = async (patch: Partial<AgentSummary['capabilities']>) => {
    try {
      await api.getState().setCapabilities(agent.id, patch)
    } catch (error) {
      failure(error)
    }
  }
  const applyLevel = (level: AgentAccessLevel) =>
    set({ fileTools: level >= 1, developmentShell: level >= 2, unrestrictedFileAccess: level >= 3 })
  const toggleExtension = async (extensionId: string, enabled: boolean, revisionId: string | undefined) => {
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
  const level = AGENT_ACCESS_LEVELS.find((item) => item.level === pendingLevel)

  return (
    <div className={styles.skills}>
      {activation.dialog}
      <SkillRow
        icon={<FolderCog />}
        title="系统访问"
        description={
          preset === 'custom'
            ? '自定义组合'
            : (AGENT_ACCESS_LEVELS.find((item) => item.level === preset)?.description ?? '')
        }
      >
        <Segmented
          label="系统访问"
          value={preset === 'custom' ? 'custom' : String(preset)}
          onChange={(value) => {
            if (value === 'custom') return
            const next = AGENT_ACCESS_LEVELS.find((option) => String(option.level) === value)?.level
            if (next === undefined) return
            if (next >= 2) setPendingLevel(next)
            else void applyLevel(next)
          }}
          options={[
            ...AGENT_ACCESS_LEVELS.map((item) => ({ value: String(item.level), label: item.label })),
            ...(preset === 'custom' ? [{ value: 'custom', label: '自定义' }] : []),
          ]}
        />
      </SkillRow>
      <SkillRow
        icon={<Workflow />}
        title="子智能体"
        description="把任务分给后台助手并行处理"
        control={
          <Switch
            label="子智能体"
            checked={agent.capabilities.subagents}
            onCheckedChange={(checked) => void set({ subagents: checked })}
          />
        }
      />
      <SkillRow
        icon={<Globe />}
        title="网页搜索"
        description={
          availability.webSearch.available
            ? '查询公开网页，结果来自外部服务'
            : '需要 DeepSeek API 密钥，每次搜索另计模型费用'
        }
        badge={
          agent.capabilities.webSearch && !availability.webSearch.available ? (
            <Chip tone="warn">待配置</Chip>
          ) : undefined
        }
        control={
          <Switch
            label="网页搜索"
            checked={agent.capabilities.webSearch}
            disabled={!availability.webSearch.available && !agent.capabilities.webSearch}
            onCheckedChange={(checked) => void set({ webSearch: checked })}
          />
        }
      >
        {availability.webSearch.available ? null : <WebSearchCredential />}
      </SkillRow>
      <SkillRow
        icon={<Sparkles />}
        title="动态创造"
        description="在频道里按需求制作新工具和界面"
        control={
          <Switch
            label="动态创造"
            checked={agent.capabilities.dynamicCreation}
            onCheckedChange={(checked) => void set({ dynamicCreation: checked })}
          />
        }
      />
      {agentExtensions.length ? <h3 className={styles.subTitle}>扩展</h3> : null}
      {agentExtensions.map((extension) => {
        const activation = extension.activations.find((item) => item.agentId === agent.id)
        return (
          <SkillRow
            key={extension.id}
            icon={<Boxes />}
            title={extension.name}
            description={extension.description || `来自${extension.createdByAgent || '本地'}`}
            badge={activation ? <Chip>{`r${activation.revision}`}</Chip> : undefined}
            control={
              <Switch
                label={`为${agent.name}启用${extension.name}`}
                checked={Boolean(activation)}
                onCheckedChange={(checked) => void toggleExtension(extension.id, checked, extension.revisions[0]?.id)}
              />
            }
          />
        )
      })}
      <ConfirmDialog
        open={pendingLevel !== null}
        onOpenChange={(open) => !open && setPendingLevel(null)}
        title={`允许${agent.name}${level?.label ?? ''}？`}
        confirmLabel="允许"
        danger
        onConfirm={() => (pendingLevel === null ? undefined : applyLevel(pendingLevel))}
      >
        <p>{level?.description}</p>
      </ConfirmDialog>
    </div>
  )
}

export function AgentProfile({ agent }: { readonly agent: AgentSummary }) {
  const api = useProductApi()
  const navigate = useGo()
  const models = useProductStore((state) => state.models)
  const channels = useProductStore((state) => state.channels)
  const connections = useProductStore((state) => state.connections)
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmName, setConfirmName] = useState('')
  const [deleteBuiltIn, setDeleteBuiltIn] = useState(true)
  const [deleteWorkspace, setDeleteWorkspace] = useState(false)
  useEffect(() => setEditing(false), [agent.id])

  const phase = agentPhase[agent.state]
  const owned = channels.filter((channel) => channel.agentId === agent.id)
  const model = agent.modelRef
    ? models.find((item) => item.provider === agent.modelRef?.provider && item.id === agent.modelRef?.model)
    : undefined
  const noModel = !agent.modelRef || models.length === 0
  // The saved model can disappear from its provider's list (retired upstream); the agent may still try to run it.
  const missingModel =
    !noModel &&
    agent.modelRef !== undefined &&
    !models.some((model) => model.provider === agent.modelRef?.provider && model.id === agent.modelRef.model)
      ? agent.modelRef.model
      : undefined
  const noVision = !noModel && !missingModel && agent.imageDiagnostics.route.mode === 'unavailable'

  const changeTrigger = async (
    channelId: string,
    triggerPolicy: 'always' | 'mentioned-or-replied' | 'command' | 'observe-only',
  ) => {
    try {
      await api.getState().createBinding({ agentId: agent.id, channelId, triggerPolicy })
    } catch (error) {
      failure(error)
    }
  }

  return (
    <div className={styles.profile} style={cssVars({ '--agent-accent': agentAccent(agent) })}>
      <header className={styles.hero}>
        <div className={styles.heroInner}>
          <AgentAvatar name={agent.name} hue={agentHue(agent)} size="lg" live={isAgentWorking(agent)} />
          <div className={styles.heroText}>
            <h1 className={styles.name}>
              {agent.name}
              <Chip tone={phase.tone} dot>
                {phase.label}
              </Chip>
            </h1>
            {agent.description ? <div className={styles.tagline}>{agent.description}</div> : null}
            <div className={styles.metaChips}>
              <span>{model ? modelLabel(model) : agent.model || '未选择模型'}</span>
              <span>{owned.length} 个频道</span>
            </div>
          </div>
          <div className={styles.heroActions}>
            {editing ? null : (
              <Button variant="primary" icon={<PencilLine />} onClick={() => setEditing(true)}>
                编辑
              </Button>
            )}
          </div>
        </div>
      </header>
      <div className={[styles.body, styles.enter].join(' ')} key={agent.id}>
        <CompatibilityNotices agentId={agent.id} providerId={agent.modelRef?.provider} />
        {noModel ? (
          <Banner
            tone="bad"
            action={
              <Button size="small" onClick={() => setEditing(true)}>
                选择模型
              </Button>
            }
          >
            没有可用模型，{agent.name}现在无法回复
          </Banner>
        ) : missingModel ? (
          <Banner
            tone="warn"
            action={
              <Button size="small" onClick={() => setEditing(true)}>
                更换模型
              </Button>
            }
          >
            默认模型 {missingModel} 已不在供应商的模型列表中，可能已停用；看图能力也无法确认
          </Banner>
        ) : noVision ? (
          <Banner
            tone="info"
            action={
              <Button size="small" onClick={() => setEditing(true)}>
                添加看图模型
              </Button>
            }
          >
            主模型看不懂图片，群里的图片会被跳过
          </Banner>
        ) : null}

        <Section title="设定">
          {editing ? (
            <Editor agent={agent} onDone={() => setEditing(false)} />
          ) : (
            <Panel>
              <p className={styles.persona}>{promptDocumentPlainText(agent.personaDocument) || '还没有设定'}</p>
            </Panel>
          )}
        </Section>

        <Section
          title="频道"
          actions={
            <Button size="small" icon={<Cable />} onClick={() => navigate('/wiring')}>
              接线
            </Button>
          }
        >
          <Panel className={styles.table}>
            {owned.length === 0 ? (
              <div className={styles.tableRow}>
                <span className={styles.cellSub}>还没有频道</span>
              </div>
            ) : (
              owned.map((channel) => {
                const connection = connections.find((item) => item.id === channel.connectionId)
                const binding = channel.bindings[0]
                return (
                  <div key={channel.id} className={styles.tableRow}>
                    <div style={{ minWidth: 0 }}>
                      <div className={styles.cellTitle}>{channel.name}</div>
                      <div className={styles.cellSub}>
                        {connection ? connectionDisplayName(connection) : channel.connectionName}
                      </div>
                    </div>
                    {binding ? (
                      <Select
                        aria-label={`${channel.name} 的触发方式`}
                        value={binding.triggerPolicy}
                        options={(['mentioned-or-replied', 'always', 'command', 'observe-only'] as const).map(
                          (value) => ({ value, label: triggerLabel[value] ?? value }),
                        )}
                        onChange={(event) =>
                          isTriggerPolicy(event.target.value) && void changeTrigger(channel.id, event.target.value)
                        }
                      />
                    ) : (
                      <span />
                    )}
                    <Button
                      size="small"
                      variant="ghost"
                      icon={<MessagesSquare />}
                      onClick={() => navigate(`/channels/${channel.id}`)}
                    >
                      打开
                    </Button>
                  </div>
                )
              })
            )}
          </Panel>
        </Section>

        <Section title="技能">
          <Skills agent={agent} />
        </Section>

        <PanelSlot anchor={{ kind: 'agent', id: agent.id }} density="full" />

        <Section title="版本">
          <Versions agent={agent} />
        </Section>

        <div className={styles.danger}>
          <Button size="small" variant="danger" icon={<Trash2 />} onClick={() => setDeleting(true)}>
            删除智能体
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={deleting}
        onOpenChange={(open) => {
          setDeleting(open)
          if (!open) setConfirmName('')
        }}
        title={`删除${agent.name}？`}
        confirmLabel="删除"
        danger
        onConfirm={async () => {
          if (confirmName.trim() !== agent.name) throw new Error('输入的名称不一致。')
          await api
            .getState()
            .deleteAgent(agent.id, agent.currentRevisionId ?? '', confirmName.trim(), deleteBuiltIn, deleteWorkspace)
          toast(`${agent.name}已删除`)
          navigate('/agents')
        }}
      >
        <p>
          {agent.name}会停止所有频道的工作。聊天记录与已保存的扩展保留
          {deleteWorkspace ? '。' : '，工作区文件也保留。'}
        </p>
        <SwitchRow title="同时删除它的内置频道" checked={deleteBuiltIn} onCheckedChange={setDeleteBuiltIn} />
        <SwitchRow
          title="同时删除工作区"
          description="永久删除它的文件、开发产物和未保存的创造候选"
          checked={deleteWorkspace}
          onCheckedChange={setDeleteWorkspace}
        />
        <Field label={`输入“${agent.name}”确认`}>
          <Input value={confirmName} onChange={(event) => setConfirmName(event.target.value)} autoComplete="off" />
        </Field>
      </ConfirmDialog>
    </div>
  )
}
