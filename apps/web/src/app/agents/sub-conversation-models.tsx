import { SUB_CONVERSATION_MAIN_MODEL, SUB_CONVERSATION_MODEL_LIMITS } from '@nekro-nxt/contracts'
import { Plus, Trash2 } from 'lucide-react'
import { Fragment } from 'react'
import { useProductStore, type SubConversationModelCandidate } from '../../product-runtime.js'
import { Button, Chip, IconButton, Input, PropertyRow, Select, Textarea } from '../../ui-kit/index.js'
import type { AgentDraft, DraftUpdate } from './agent-draft.js'
import { agentModelKey } from './agent-create-draft.js'
import { CompactionModelField } from './compaction-model.js'
import styles from './sub-conversation-models.module.css'

/** A name for a new candidate that no other candidate uses yet. */
const freshName = (taken: readonly string[]): string => {
  for (let index = taken.length + 1; ; index += 1) {
    const name = `模型 ${index}`
    if (!taken.includes(name)) return name
  }
}

/**
 * Models this agent may open sub-conversations with besides its main model, each with what it is good for. The agent
 * reads the names and guidance when it opens one; they are saved with the rest of the agent.
 */
export function SubConversationModelRows({
  draft,
  update,
}: {
  readonly draft: AgentDraft
  readonly update: DraftUpdate
}) {
  const models = useProductStore((state) => state.models)
  const policy = draft.subConversationModels
  const enabled = draft.capabilities.subagents
  const full = policy.candidates.length >= SUB_CONVERSATION_MODEL_LIMITS.candidates

  const setPolicy = (change: (current: AgentDraft['subConversationModels']) => AgentDraft['subConversationModels']) =>
    update((current) => ({ ...current, subConversationModels: change(current.subConversationModels) }))
  const setCandidate = (index: number, change: Partial<SubConversationModelCandidate>) =>
    setPolicy((current) => {
      const previous = current.candidates[index]
      if (previous === undefined) return current
      const next = { ...previous, ...change }
      return {
        candidates: current.candidates.map((candidate, at) => (at === index ? next : candidate)),
        // A renamed default stays the default.
        ...(current.default === undefined
          ? {}
          : { default: current.default === previous.name ? next.name : current.default }),
      }
    })
  const add = () => {
    const main = models.find((item) => agentModelKey(item) === draft.modelKey) ?? models[0]
    if (main === undefined) return
    setPolicy((current) => ({
      ...current,
      candidates: [
        ...current.candidates,
        {
          name: freshName(current.candidates.map((candidate) => candidate.name)),
          model: { provider: main.provider, model: main.id },
          guidance: '',
        },
      ],
    }))
  }
  const remove = (index: number) =>
    setPolicy((current) => {
      const removed = current.candidates[index]
      const candidates = current.candidates.filter((_, at) => at !== index)
      return current.default === undefined || current.default === removed?.name
        ? { candidates }
        : { candidates, default: current.default }
    })

  return (
    <>
      <PropertyRow
        label="子对话模型"
        tip="开子对话时，智能体可以从这些模型里挑一个，比如把翻记录、整理资料这类轻活交给更快、更便宜的模型。它会看到每个模型的名称和用途。"
        description={
          enabled ? (policy.candidates.length === 0 ? '子对话都用主模型' : undefined) : '先在「能力」中开启子对话'
        }
      >
        <Button size="small" variant="ghost" disabled={!enabled || full || models.length === 0} onClick={add}>
          <Plus aria-hidden />
          添加
        </Button>
      </PropertyRow>
      {policy.candidates.map((candidate, index) => {
        const available = models.some(
          (item) => item.provider === candidate.model.provider && item.id === candidate.model.model,
        )
        const label = candidate.name.trim() || '未命名'
        return (
          <Fragment key={index}>
            <PropertyRow
              depth={1}
              layout="stacked"
              label={label}
              badge={available ? undefined : <Chip tone="warn">模型已移除</Chip>}
            >
              <div className={styles.candidate}>
                <div className={styles.head}>
                  <Input
                    aria-label={`${label}的名称`}
                    className={styles.name}
                    value={candidate.name}
                    maxLength={SUB_CONVERSATION_MODEL_LIMITS.name}
                    disabled={!enabled}
                    onChange={(event) => setCandidate(index, { name: event.target.value })}
                  />
                  <IconButton label={`移除${label}`} disabled={!enabled} onClick={() => remove(index)}>
                    <Trash2 aria-hidden />
                  </IconButton>
                </div>
                <CompactionModelField
                  label={`${label}的模型`}
                  value={candidate.model}
                  disabled={!enabled}
                  onChange={(model) => {
                    if (model) setCandidate(index, { model })
                  }}
                />
                <Textarea
                  aria-label={`${label}的用途`}
                  rows={2}
                  placeholder="适合交给它做什么，不适合做什么"
                  value={candidate.guidance}
                  maxLength={SUB_CONVERSATION_MODEL_LIMITS.guidance}
                  disabled={!enabled}
                  onChange={(event) => setCandidate(index, { guidance: event.target.value })}
                />
              </div>
            </PropertyRow>
          </Fragment>
        )
      })}
      {policy.candidates.length > 0 ? (
        <PropertyRow depth={1} label="不指定时" width="sm" description="智能体开子对话时没有选模型，就用这个">
          <Select
            aria-label="不指定时的子对话模型"
            value={policy.default ?? ''}
            disabled={!enabled}
            options={[
              { value: '', label: SUB_CONVERSATION_MAIN_MODEL },
              ...policy.candidates
                .filter((candidate) => candidate.name.trim() !== '')
                .map((candidate) => ({ value: candidate.name, label: candidate.name })),
            ]}
            onValueChange={(value) =>
              setPolicy((current) =>
                value === '' ? { candidates: current.candidates } : { ...current, default: value },
              )
            }
          />
        </PropertyRow>
      ) : null}
    </>
  )
}

/** Why the candidates cannot be saved as they are, or undefined when they can. */
export const subConversationModelsProblem = (policy: AgentDraft['subConversationModels']): string | undefined => {
  const names = policy.candidates.map((candidate) => candidate.name.trim())
  if (names.some((name) => name === '')) return '子对话模型需要名称'
  if (names.some((name) => name === SUB_CONVERSATION_MAIN_MODEL)) return `「${SUB_CONVERSATION_MAIN_MODEL}」是保留名称`
  if (names.some((name) => /[\n,，、]/u.test(name))) return '子对话模型的名称不能含逗号或顿号'
  if (new Set(names).size !== names.length) return '子对话模型的名称不能重复'
  return undefined
}
