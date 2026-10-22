import { FALLBACK_MODEL_LIMIT } from '@nekro-nxt/contracts'
import { ArrowUp, Plus, Trash2 } from 'lucide-react'
import { useProductStore, type AgentFallbackModel, type ModelSummary } from '../../product-runtime.js'
import { Button, Chip, IconButton, PropertyRow } from '../../ui-kit/index.js'
import type { AgentDraft, DraftUpdate } from './agent-draft.js'
import { agentModelKey } from './agent-create-draft.js'
import { CompactionModelField } from './compaction-model.js'
import styles from './fallback-models.module.css'

const readsImages = (model: ModelSummary | undefined) => model?.inputModalities?.includes('image') ?? false
const keyOf = (model: AgentFallbackModel) => agentModelKey({ provider: model.provider, id: model.model })

/**
 * Models the agent switches to, in order, when its main model has used up its quota or keeps failing. They are saved
 * with the rest of the agent; how long a failed model is passed over is set in 设置 → 模型.
 */
export function FallbackModelRows({ draft, update }: { readonly draft: AgentDraft; readonly update: DraftUpdate }) {
  const models = useProductStore((state) => state.models)
  const main = models.find((item) => agentModelKey(item) === draft.modelKey)
  const fallbacks = draft.fallbackModels
  const taken = new Set([draft.modelKey, ...fallbacks.map(keyOf)])
  const next = models.find((item) => !taken.has(agentModelKey(item)))

  const setFallbacks = (change: (current: readonly AgentFallbackModel[]) => AgentFallbackModel[]) =>
    update((current) => ({ ...current, fallbackModels: change(current.fallbackModels) }))

  return (
    <>
      <PropertyRow
        label="备用模型"
        tip="主模型额度用完，或持续限流、出错时，按顺序改用这些模型；之后收到新消息时，主模型恢复了就换回去。多久后再试主模型在「设置 → 模型」中调整。"
        description={fallbacks.length === 0 ? '主模型出错时照常报错' : undefined}
      >
        <Button
          size="small"
          variant="ghost"
          aria-label="添加备用模型"
          disabled={fallbacks.length >= FALLBACK_MODEL_LIMIT || next === undefined}
          onClick={() => {
            if (next !== undefined) setFallbacks((current) => [...current, { provider: next.provider, model: next.id }])
          }}
        >
          <Plus aria-hidden />
          添加
        </Button>
      </PropertyRow>
      {fallbacks.map((fallback, index) => {
        const chosen = models.find((item) => agentModelKey(item) === keyOf(fallback))
        const label = `备用 ${index + 1}`
        return (
          <PropertyRow
            key={index}
            depth={1}
            layout="stacked"
            label={label}
            badge={chosen === undefined ? <Chip tone="warn">模型已移除</Chip> : undefined}
            description={readsImages(main) && chosen !== undefined && !readsImages(chosen) ? '它看不了图片' : undefined}
          >
            <div className={styles.row}>
              <CompactionModelField
                label={`${label}的模型`}
                value={fallback}
                onChange={(model) => {
                  if (model) setFallbacks((current) => current.map((item, at) => (at === index ? model : item)))
                }}
              />
              <div className={styles.actions}>
                <IconButton
                  label={`上移${label}`}
                  disabled={index === 0}
                  onClick={() =>
                    setFallbacks((current) => {
                      const moved = [...current]
                      const [item] = moved.splice(index, 1)
                      if (item !== undefined) moved.splice(index - 1, 0, item)
                      return moved
                    })
                  }
                >
                  <ArrowUp aria-hidden />
                </IconButton>
                <IconButton
                  label={`移除${label}`}
                  onClick={() => setFallbacks((current) => current.filter((_, at) => at !== index))}
                >
                  <Trash2 aria-hidden />
                </IconButton>
              </div>
            </div>
          </PropertyRow>
        )
      })}
    </>
  )
}

/** Why the fallback models cannot be saved as they are, or undefined when they can. */
export const fallbackModelsProblem = (draft: AgentDraft): string | undefined => {
  const keys = draft.fallbackModels.map(keyOf)
  if (keys.includes(draft.modelKey)) return '备用模型不能和主模型相同'
  if (new Set(keys).size !== keys.length) return '备用模型不能重复'
  return undefined
}
