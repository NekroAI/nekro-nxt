import { History, MessagesSquare, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useProductStore, type AgentSummary, type ModelSummary } from '../../product-runtime.js'
import {
  AgentAvatar,
  Button,
  Chip,
  ConfirmDialog,
  Field,
  IconButton,
  Input,
  MainContent,
  Menu,
  ObjectHeader,
  Pressable,
  SaveBar,
  SwitchRow,
  cssVars,
  toast,
} from '../../ui-kit/index.js'
import { BindDialog, type BindIntent } from '../channels/bind-dialog.js'
import { agentAccent, agentHue, agentPhase, isAgentWorking } from '../model/identity.js'
import { useGo } from '../model/nav.js'
import { useProductApi } from '../model/store.js'
import { CompatibilityNotices } from '../system/compatibility.js'
import { agentModelKey } from './agent-create-draft.js'
import {
  capabilityPatch,
  draftChanges,
  draftOf,
  identityChanged,
  imagePolicyFor,
  type AgentDraft,
} from './agent-draft.js'
import { RestoreDialog } from './agent-restore.js'
import {
  CapabilitiesSection,
  ChannelsSection,
  ExtensionsSection,
  ModelSection,
  PersonaSection,
  type DraftUpdate,
} from './agent-sections.js'
import { ScheduledTasksSection } from './scheduled-tasks-section.js'
import styles from './agents.module.css'

const SECTIONS = [
  { id: 'profile-model', label: '模型' },
  { id: 'profile-channels', label: '频道' },
  { id: 'profile-capabilities', label: '能力' },
  { id: 'profile-extensions', label: '扩展' },
  { id: 'profile-schedules', label: '定时任务' },
  { id: 'profile-persona', label: '设定' },
] as const

const modelLabel = (model: ModelSummary) => `${model.providerName} · ${model.name}`

/**
 * Unsaved edits of one agent. The draft follows the saved configuration while it is clean, and keeps the user's edits
 * when the Host refreshes underneath them.
 */
function useAgentDraft(agent: AgentSummary) {
  const base = useMemo(() => draftOf(agent), [agent])
  const [draft, setDraft] = useState<AgentDraft>(base)
  const previous = useRef(base)
  useEffect(() => {
    const before = previous.current
    previous.current = base
    setDraft((current) => (draftChanges(before, current).length === 0 ? base : current))
  }, [base])
  const update: DraftUpdate = (change) => setDraft((current) => change(current))
  return { base, draft, update, reset: () => setDraft(base) }
}

const scrollParent = (element: HTMLElement): HTMLElement | null => {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return node
  }
  return null
}

/**
 * Highlights the section being read in the sticky section bar: the last one whose top has passed a reading line
 * near the top of the scroll area. At the top that is always the first section, at the bottom the last one, so a
 * tall window never skips ahead to a section that merely fits on screen.
 */
function useActiveSection(): string {
  const [active, setActive] = useState<string>(SECTIONS[0].id)
  useEffect(() => {
    const first = document.getElementById(SECTIONS[0].id)
    const scroller = first ? scrollParent(first) : null
    if (!scroller) return
    let frame = 0
    const update = () => {
      frame = 0
      const elements = SECTIONS.flatMap((section) => {
        const element = document.getElementById(section.id)
        return element ? [element] : []
      })
      if (elements.length === 0) return
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2
      const line = scroller.getBoundingClientRect().top + Math.min(160, scroller.clientHeight * 0.3)
      const passed = elements.filter((element) => element.getBoundingClientRect().top <= line)
      const current = atBottom && scroller.scrollTop > 0 ? elements.at(-1) : (passed.at(-1) ?? elements[0])
      if (current) setActive(current.id)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    update()
    scroller.addEventListener('scroll', schedule, { passive: true })
    const observer = new ResizeObserver(schedule)
    observer.observe(scroller)
    return () => {
      scroller.removeEventListener('scroll', schedule)
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [])
  return active
}

export function AgentProfile({ agent }: { readonly agent: AgentSummary }) {
  const api = useProductApi()
  const navigate = useGo()
  const models = useProductStore((state) => state.models)
  const channels = useProductStore((state) => state.channels)
  const { base, draft, update, reset } = useAgentDraft(agent)
  const changes = draftChanges(base, draft)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [editingPersona, setEditingPersona] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmName, setConfirmName] = useState('')
  const [deleteBuiltIn, setDeleteBuiltIn] = useState(true)
  const [deleteWorkspace, setDeleteWorkspace] = useState(false)
  const [bindIntent, setBindIntent] = useState<BindIntent | null>(null)
  const active = useActiveSection()

  const phase = agentPhase[agent.state]
  const owned = channels.filter((channel) => channel.agentId === agent.id)
  const model = models.find((item) => agentModelKey(item) === base.modelKey)

  const save = async () => {
    const chosen = models.find((item) => agentModelKey(item) === draft.modelKey)
    const vision = models.find((item) => agentModelKey(item) === draft.visionKey)
    if (!draft.name.trim()) {
      setSaveError('名称不能为空')
      return
    }
    setSaving(true)
    setSaveError('')
    try {
      if (identityChanged(base, draft)) {
        if (!chosen) throw new Error('先选择一个可用的主模型')
        await api.getState().reviseAgent({
          agentId: agent.id,
          ...(agent.currentRevisionId ? { expectedCurrentRevisionId: agent.currentRevisionId } : {}),
          displayName: draft.name.trim(),
          persona: draft.personaText,
          personaDocument: draft.persona,
          model: chosen,
          ...(agent.modelRef?.reasoningEffort && draft.modelKey === base.modelKey
            ? { reasoningEffort: agent.modelRef.reasoningEffort }
            : {}),
          imagePolicy: imagePolicyFor(agent.imagePolicy, chosen, vision),
          dynamicClientApprovalPolicy: agent.dynamicClientApprovalPolicy,
        })
      }
      const patch = capabilityPatch(base, draft)
      if (Object.keys(patch).length > 0) await api.getState().setCapabilities(agent.id, patch)
      setEditingPersona(false)
      toast('已保存')
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <MainContent>
      <div className={styles.profile} style={cssVars({ '--agent-accent': agentAccent(agent) })}>
        <ObjectHeader
          visual={
            <AgentAvatar name={draft.name || agent.name} hue={agentHue(agent)} size="lg" live={isAgentWorking(agent)} />
          }
          title={
            renaming ? (
              <form
                className={styles.renameForm}
                onSubmit={(event) => {
                  event.preventDefault()
                  setRenaming(false)
                }}
              >
                <Input
                  aria-label="名称"
                  value={draft.name}
                  maxLength={40}
                  autoFocus
                  onChange={(event) => update((current) => ({ ...current, name: event.target.value }))}
                  onBlur={() => setRenaming(false)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      update((current) => ({ ...current, name: base.name }))
                      setRenaming(false)
                    }
                  }}
                />
              </form>
            ) : (
              draft.name || agent.name
            )
          }
          status={
            <>
              {renaming ? null : (
                <IconButton label="修改名称" size="small" onClick={() => setRenaming(true)}>
                  <Pencil size={14} />
                </IconButton>
              )}
              <Chip tone={phase.tone} dot>
                {phase.label}
              </Chip>
            </>
          }
          meta={
            <>
              <span>{model ? modelLabel(model) : agent.model || '未选择模型'}</span>
              <span>{owned.length} 个频道</span>
            </>
          }
          actions={
            <>
              <Button
                variant="primary"
                icon={<MessagesSquare />}
                disabled={!owned[0]}
                onClick={() => owned[0] && navigate(`/channels/${owned[0].id}`)}
              >
                在频道中对话
              </Button>
              <Menu
                label="更多操作"
                align="end"
                trigger={
                  <Button icon={<MoreHorizontal />} aria-label="更多操作">
                    更多
                  </Button>
                }
                items={[
                  {
                    key: 'restore',
                    label: '恢复之前的配置',
                    icon: <History size={15} />,
                    onSelect: () => setRestoreOpen(true),
                  },
                  'separator',
                  {
                    key: 'delete',
                    label: '删除智能体',
                    icon: <Trash2 size={15} />,
                    danger: true,
                    onSelect: () => setDeleting(true),
                  },
                ]}
              />
            </>
          }
        />

        <nav className={styles.sectionNav} aria-label="分节">
          {SECTIONS.map((section) => (
            <Pressable
              key={section.id}
              className={styles.sectionLink}
              aria-current={active === section.id ? 'true' : undefined}
              onClick={() => jump(section.id)}
            >
              {section.label}
            </Pressable>
          ))}
        </nav>

        <CompatibilityNotices agentId={agent.id} providerId={agent.modelRef?.provider} />

        <ModelSection agent={agent} draft={draft} update={update} />
        <ChannelsSection agent={agent} onBind={setBindIntent} />
        <CapabilitiesSection agent={agent} draft={draft} update={update} />
        <ExtensionsSection agent={agent} />
        <ScheduledTasksSection agent={agent} />
        <PersonaSection
          agent={agent}
          draft={draft}
          update={update}
          editing={editingPersona}
          onEditingChange={setEditingPersona}
        />

        <SaveBar
          changes={changes}
          busy={saving}
          error={saveError || undefined}
          onSave={() => void save()}
          onDiscard={() => {
            reset()
            setSaveError('')
            setEditingPersona(false)
          }}
        />
      </div>

      <BindDialog intent={bindIntent} onClose={() => setBindIntent(null)} />
      <RestoreDialog agent={agent} open={restoreOpen} onOpenChange={setRestoreOpen} blocked={changes.length > 0} />
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
    </MainContent>
  )
}
