import { RotateCcw } from 'lucide-react'
import { Component, type ReactNode } from 'react'
import { Button, EmptyState } from '../../ui-kit/next/index.js'

interface State {
  readonly failed: boolean
}

/**
 * Keeps a failing space (most often its code chunk could not load) inside the canvas: the shell, navigation and
 * drafts stay usable, and the user retries in place instead of reloading the page.
 */
export class SpaceBoundary extends Component<{ readonly onRetry: () => void; readonly children: ReactNode }, State> {
  override state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  override componentDidCatch(error: unknown): void {
    console.warn('[nekro-nxt] 空间加载失败', error)
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100%', padding: 32 }} role="alert">
        <EmptyState
          title="这个页面没能加载"
          action={
            <Button
              icon={<RotateCcw size={14} />}
              onClick={() => {
                this.props.onRetry()
                this.setState({ failed: false })
              }}
            >
              重试
            </Button>
          }
        >
          网络恢复后重试即可，正在编辑的内容不会丢失。
        </EmptyState>
      </div>
    )
  }
}
