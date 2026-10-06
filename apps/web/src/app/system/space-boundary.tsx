import { RotateCcw } from 'lucide-react'
import { Component, type ReactNode } from 'react'
import { Button, EmptyState } from '../../ui-kit/next/index.js'
import { useLocation } from 'react-router-dom'
import { SPACES } from '../shell/app-shell.js'
import { useCrumb } from '../shell/crumb.js'

/** Replaces the path of the space that failed, which never got to set its own. */
function FailedCrumb() {
  const segment = `/${useLocation().pathname.split('/')[1] ?? ''}`
  useCrumb(SPACES.find((space) => space.path === segment)?.label ?? '设置', '页面未加载')
  return null
}

interface State {
  readonly failed: boolean
  /** In-place retries already tried; a browser keeps a failed module import, so the next step reloads. */
  readonly retries: number
}

/**
 * Keeps a failing space (most often its code chunk could not load) inside the canvas: the shell, navigation and
 * drafts stay usable, and the user retries in place instead of reloading the page.
 */
export class SpaceBoundary extends Component<{ readonly onRetry: () => void; readonly children: ReactNode }, State> {
  override state: State = { failed: false, retries: 0 }

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true }
  }

  override componentDidCatch(error: unknown): void {
    console.warn('[nekro-nxt] 空间加载失败', error)
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100%', padding: 32 }} role="alert">
        <FailedCrumb />
        <EmptyState
          title="这个页面没能加载"
          action={
            <Button
              icon={<RotateCcw size={14} />}
              onClick={() => {
                if (this.state.retries > 0) {
                  // Channel drafts are kept in session storage and come back after the reload.
                  window.location.reload()
                  return
                }
                this.props.onRetry()
                this.setState((state) => ({ failed: false, retries: state.retries + 1 }))
              }}
            >
              {this.state.retries > 0 ? '重新加载页面' : '重试'}
            </Button>
          }
        >
          网络恢复后重试即可，正在编辑的内容不会丢失。
        </EmptyState>
      </div>
    )
  }
}
