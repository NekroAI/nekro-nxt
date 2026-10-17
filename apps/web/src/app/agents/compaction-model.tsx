import { useProductStore } from '../../product-runtime.js'
import { Select } from '../../ui-kit/index.js'
import type { ModelSummary } from '../../product-runtime.js'
import { agentModelKey } from './agent-create-draft.js'
import { EffortSlider } from './effort-slider.js'
import styles from './compaction-model.module.css'

const modelLabel = (model: ModelSummary) => `${model.providerName} · ${model.name}`

/** A model chosen for compaction, with the thinking level it is asked to write at. */
export interface CompactionModel {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string | undefined
}

/**
 * Follow a default, or pick a model from the live catalog. A picked model that offers thinking levels shows the same
 * stepped scale as the main model.
 */
export function CompactionModelField({
  label,
  followLabel,
  value,
  onChange,
  disabled = false,
}: {
  readonly label: string
  /** What following means here, for example the main model or the host's default. */
  readonly followLabel: string
  /** Undefined follows the default. */
  readonly value: CompactionModel | undefined
  readonly onChange: (value: CompactionModel | undefined) => void
  readonly disabled?: boolean
}) {
  const models = useProductStore((state) => state.models)
  const key = value === undefined ? '' : agentModelKey({ provider: value.provider, id: value.model })
  const chosen = models.find((model) => agentModelKey(model) === key)
  return (
    <div className={styles.field}>
      <Select
        aria-label={label}
        className={styles.select}
        value={chosen ? key : ''}
        disabled={disabled}
        options={[
          { value: '', label: followLabel },
          ...models.map((model) => ({ value: agentModelKey(model), label: modelLabel(model) })),
        ]}
        onValueChange={(next) => {
          const model = models.find((item) => agentModelKey(item) === next)
          onChange(model === undefined ? undefined : { provider: model.provider, model: model.id })
        }}
      />
      {chosen?.reasoning && value ? (
        <EffortSlider
          efforts={chosen.reasoning.efforts}
          defaultEffort={chosen.reasoning.defaultEffort}
          value={
            chosen.reasoning.efforts.some((effort) => effort.id === value.reasoningEffort)
              ? (value.reasoningEffort ?? '')
              : ''
          }
          disabled={disabled}
          onChange={(effort) =>
            onChange({ provider: value.provider, model: value.model, ...(effort ? { reasoningEffort: effort } : {}) })
          }
        />
      ) : null}
    </div>
  )
}
