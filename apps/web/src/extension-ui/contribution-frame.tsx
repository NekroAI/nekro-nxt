import type { HostIconName, PanelDensity } from '@nekro-nxt/contracts'
import { ChevronDown, TriangleAlert } from 'lucide-react'
import { Component, useId, useState, type ReactNode } from 'react'
import { Disclosure, Pressable } from '../ui-kit/index.js'
import { HOST_ICONS } from './icons.js'
import styles from './contribution-frame.module.css'

interface BoundaryProps {
  readonly resetKey: string
  readonly onError: (error: unknown) => void
  readonly fallback: (retry: () => void) => ReactNode
  readonly children: ReactNode
}

/** Isolates one contribution: a render error replaces only that contribution, never its neighbours. */
export class ContributionBoundary extends Component<BoundaryProps, { readonly failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: unknown): void {
    this.props.onError(error)
  }

  override componentDidUpdate(previous: Readonly<BoundaryProps>): void {
    if (previous.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false })
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback(() => this.setState({ failed: false })) : this.props.children
  }
}

export interface ContributionFrameProps {
  readonly title: string
  readonly icon?: HostIconName | undefined
  /** Extension name, shown so the user can tell which extension drew this panel. */
  readonly source: string
  readonly density: PanelDensity
  /** CSS boundary of the owning build (`data-host-ui-owner`). */
  readonly styleScope: string
  readonly resetKey: string
  readonly onError: (error: unknown) => void
  readonly children: ReactNode
}

/**
 * Host-owned chrome around one panel: title, icon, collapse, failure fallback and entrance motion. The extension
 * only renders content inside it.
 */
export function ContributionFrame(props: ContributionFrameProps) {
  const [open, setOpen] = useState(true)
  const bodyId = useId()
  const Icon = props.icon ? HOST_ICONS[props.icon] : undefined
  return (
    <section className={styles.frame} data-density={props.density} data-contribution-frame="">
      <header className={styles.head}>
        <Pressable
          className={styles.toggle}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((value) => !value)}
        >
          {Icon ? <Icon size={15} aria-hidden="true" /> : null}
          <span className={styles.title}>{props.title}</span>
          <span className={styles.source}>{props.source}</span>
          <ChevronDown size={14} aria-hidden="true" className={styles.chevron} />
        </Pressable>
      </header>
      <Disclosure open={open} id={bodyId}>
        <div className={styles.content} data-host-ui-owner={props.styleScope}>
          <ContributionBoundary
            resetKey={props.resetKey}
            onError={props.onError}
            fallback={(retry) => (
              <div className={styles.failure} role="alert">
                <TriangleAlert size={15} aria-hidden="true" />
                <span>这个面板出错了</span>
                <Pressable className={styles.retry} onClick={retry}>
                  重试
                </Pressable>
              </div>
            )}
          >
            {props.children}
          </ContributionBoundary>
        </div>
      </Disclosure>
    </section>
  )
}
