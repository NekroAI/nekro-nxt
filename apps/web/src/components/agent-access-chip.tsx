import { agentAccessPresentation } from '../agent-access-level.js'
import type { AgentSummary } from '../product-store.js'
import { Tooltip } from '../ui-kit/index.js'
import styles from './agent-access-chip.module.css'

export function AgentAccessChip({ capabilities }: { readonly capabilities: AgentSummary['capabilities'] }) {
  const option = agentAccessPresentation(capabilities)
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <span
          className={styles.chip}
          data-level={option.level}
          aria-label={`系统访问：${option.code}，${option.label}`}
        >
          <i aria-hidden="true" />
          {option.code}
        </span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side="top" sideOffset={7} collisionPadding={10}>
          <span className={styles.tooltipCopy}>
            <strong>
              {option.code} · {option.label}
            </strong>
            <span>{option.description}</span>
          </span>
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}
