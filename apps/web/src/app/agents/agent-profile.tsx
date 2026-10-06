import { useGo } from '../model/nav.js'
import { Boxes, Cable, FolderCog, Globe, MessagesSquare, PencilLine, Sparkles, Trash2, Workflow } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'

import { promptDocumentPlainText, type PromptDocumentV1 } from '@nekro-nxt/contracts'
import { AGENT_ACCESS_LEVELS, agentAccessPreset, type AgentAccessLevel } from '../../agent-access-level.js'
import { PromptReferenceEditor } from '../../components/prompt-reference-editor.js'
import { agentModelKey } from '../../pages/agent-create-draft.js'
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
  Section,
  Segmented,
  Select,
  Switch,
  SwitchRow,
  toast,
  cssVars,
} from '../../ui-kit/next/index.js'
import { agentAccent, agentHue, agentPhase, isAgentWorking, isTriggerPolicy, triggerLabel } from '../model/identity.js'
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

function Skills({ agent }: { readonly agent: AgentSummary }) {
  const api = useProductApi()
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
      await api.getState().setExtensionActive(extensionId, agent.id, enabled, revisionId)
      toast(enabled ? '已启用' : '已停用')
    } catch (error) {
      failure(error)
    }
  }
  const level = AGENT_ACCESS_LEVELS.find((item) => item.level === pendingLevel)

  return (
    <div className={styles.skills}>
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
        description={availability.webSearch.available ? '查询公开网页，结果来自外部服务' : '先在设置里保存搜索服务凭据'}
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
      />
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
  const noVision = !noModel && agent.imageDiagnostics.route.mode === 'unavailable'

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
