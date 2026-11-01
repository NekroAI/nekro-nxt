import { requiredExtensionAddons, type ExtensionCapabilities } from '@nekro-nxt/contracts'
import { useNavigate } from 'react-router-dom'
import { addonStateLabel, addonUsable } from '../addon-status.js'
import { useProductStore } from '../product-runtime.js'
import { Button } from '../ui-kit/index.js'
import styles from './activation.module.css'

/**
 * 需要附加功能 (附加功能 F13): the add-ons the declared capabilities rely on, each with its state when it cannot be
 * used yet and the way to its page. `onLeave` runs before going there, e.g. to close the dialog this sits in.
 */
export function RequiredAddons({
  capabilities,
  onLeave,
}: {
  readonly capabilities: readonly (ExtensionCapabilities | undefined)[]
  readonly onLeave?: (() => void) | undefined
}) {
  const addons = useProductStore((state) => state.addons)
  const navigate = useNavigate()
  const needed = requiredExtensionAddons(...capabilities).flatMap((id) => {
    const addon = addons.find((candidate) => candidate.id === id)
    return addon === undefined ? [] : [addon]
  })
  if (needed.length === 0) return null
  return (
    <ul className={styles.addons}>
      {needed.map((addon) => {
        const usable = addonUsable(addon.state)
        return (
          <li key={addon.id} className={styles.addon}>
            <span>
              需要附加功能：{addon.title}
              {usable ? '' : `（${addonStateLabel(addon.state, addon.progress).label}）`}
            </span>
            <Button
              size="small"
              variant="ghost"
              onClick={() => {
                onLeave?.()
                void navigate(`/settings/addons/${addon.id}`)
              }}
            >
              {usable || addon.state === 'unsupported' ? '查看' : '去安装'}
            </Button>
          </li>
        )
      })}
    </ul>
  )
}
