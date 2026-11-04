import { Pencil } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { defaultImageUnderstandingPolicy, useProductStore } from '../../product-runtime.js'
import {
  AgentAvatar,
  CreateBar,
  IconButton,
  Input,
  MainContent,
  ObjectHeader,
  SectionNav,
  toast,
} from '../../ui-kit/index.js'
import { agentHue } from '../model/identity.js'
import { useGo } from '../model/nav.js'
import { useProductApi } from '../model/store.js'
import { agentModelKey } from './agent-create-draft.js'
import {
  imagePolicyFor,
  newAgentDraft,
  savedAliases,
  savedSubConversationModels,
  withImageRestore,
  type AgentDraft,
  type DraftUpdate,
} from './agent-draft.js'
import { modelLabel, useActiveSection, type ProfileSection } from './agent-profile.js'
import { CapabilitiesSection, ModelSection, PersonaSection } from './agent-sections.js'
import { fallbackModelsProblem } from './fallback-models.js'
import { subConversationModelsProblem } from './sub-conversation-models.js'
import styles from './agents.module.css'

/** Channels, extensions and scheduled tasks need the agent to exist, so they are set up on its profile afterwards. */
const SECTIONS: readonly ProfileSection[] = [
  { id: 'profile-model', label: '模型' },
  { id: 'profile-capabilities', label: '能力' },
  { id: 'profile-persona', label: '设定' },
]

/** A fixed placeholder identity until the Host assigns the new agent its own. */
const NEW_AGENT_HUE = agentHue({ id: 'new-agent' })

/**
 * The draft of the agent being created. The model and capabilities follow their starting values until the user
 * changes them, since models and web-search availability may arrive after the page opens.
 */
function useNewAgentDraft() {
  const models = useProductStore((state) => state.models)
  const webSearch = useProductStore((state) => state.capabilityAvailability.webSearch.available)
  const start = useMemo(() => newAgentDraft(models, webSearch), [models, webSearch])
  const [draft, setDraft] = useState<AgentDraft>(start)
  const previous = useRef(start)
  useEffect(() => {
    const before = previous.current
    previous.current = start
    setDraft((current) => ({
      ...current,
      modelKey: models.some((item) => agentModelKey(item) === current.modelKey) ? current.modelKey : start.modelKey,
      capabilities: current.capabilities === before.capabilities ? start.capabilities : current.capabilities,
    }))
  }, [start, models])
  const update: DraftUpdate = (change) => setDraft((current) => change(current))
  return { draft, update }
}

/**
 * The agent profile before the agent exists: the same header and sections as editing one, with everything sent in
 * a single create call.
 */
export function AgentCreate() {
  const api = useProductApi()
  const navigate = useGo()
  const models = useProductStore((state) => state.models)
  const { draft, update } = useNewAgentDraft()
  const [renaming, setRenaming] = useState(true)
  const [editingPersona, setEditingPersona] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [active, pinSection] = useActiveSection(SECTIONS)
  const model = models.find((item) => agentModelKey(item) === draft.modelKey)
  const name = draft.name.trim()

  const create = async () => {
    if (!name || !model) return
    const vision = models.find((item) => agentModelKey(item) === draft.visionKey)
    const problem = subConversationModelsProblem(draft.subConversationModels) ?? fallbackModelsProblem(draft)
    if (problem !== undefined) {
      setError(problem)
      return
    }
    setCreating(true)
    setError('')
    try {
      const created = await api.getState().createAgent({
        name,
        persona: draft.personaText,
        personaDocument: draft.persona,
        model,
        ...(draft.effort && model.reasoning?.efforts.some((effort) => effort.id === draft.effort)
          ? { reasoningEffort: draft.effort }
          : {}),
        capabilities: draft.capabilities,
        imagePolicy: withImageRestore(
          imagePolicyFor(defaultImageUnderstandingPolicy(), model, vision),
          draft.imageRestore,
        ),
        compaction: draft.compaction,
        subConversationModels: savedSubConversationModels(draft.subConversationModels),
        fallbackModels: draft.fallbackModels,
        aliases: savedAliases(draft.aliases),
      })
      toast(`${name}已创建`)
      navigate(`/channels/${created.channelId}`)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      setCreating(false)
    }
  }

  const jump = (id: string) => {
    pinSection(id)
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <MainContent>
      <div className={styles.profile}>
        <ObjectHeader
          visual={<AgentAvatar name={name || '新'} hue={NEW_AGENT_HUE} size="lg" />}
          title={
            renaming ? (
              <form
                className={styles.renameForm}
                onSubmit={(event) => {
                  event.preventDefault()
                  if (name) setRenaming(false)
                }}
              >
                <Input
                  aria-label="名称"
                  value={draft.name}
                  maxLength={40}
                  placeholder="给它起个名字，比如：小奈"
                  autoFocus
                  onChange={(event) => update((current) => ({ ...current, name: event.target.value }))}
                  onBlur={() => setRenaming(!name)}
                />
              </form>
            ) : (
              name
            )
          }
          status={
            renaming ? null : (
              <IconButton label="修改名称" size="small" onClick={() => setRenaming(true)}>
                <Pencil size={14} />
              </IconButton>
            )
          }
          meta={
            <>
              <span>{model ? modelLabel(model) : '未选择模型'}</span>
              <span>创建后可以绑定频道、安装扩展</span>
            </>
          }
        />

        <div className={styles.sectionNav}>
          <SectionNav
            label="分节"
            options={SECTIONS.map((section) => ({ value: section.id, label: section.label }))}
            active={active}
            onJump={jump}
          />
        </div>

        <ModelSection agent={undefined} draft={draft} update={update} />
        <CapabilitiesSection agent={undefined} draft={draft} update={update} />
        <PersonaSection
          agent={undefined}
          draft={draft}
          update={update}
          editing={editingPersona}
          onEditingChange={setEditingPersona}
        />

        <CreateBar
          title="新建智能体"
          detail={!name ? '先给它起个名字' : !model ? '先选择一个主模型' : undefined}
          error={error || undefined}
          busy={creating}
          disabled={!name || !model}
          createLabel="创建并开始对话"
          onCancel={() => window.history.back()}
          onCreate={() => void create()}
        />
      </div>
    </MainContent>
  )
}
