export interface DisposableViewHost<View> {
  isDestroyed(): boolean
  readonly contentView: {
    readonly children: readonly View[]
    removeChildView(view: View): void
  }
}

export interface DisposableWebContentsView {
  readonly webContents: {
    isDestroyed(): boolean
    close(): void
  }
}

/** Electron may destroy a Window and its child WebContents in either order. */
export const detachAndCloseView = <HostView, View extends HostView & DisposableWebContentsView>(
  window: DisposableViewHost<HostView>,
  view: View | undefined,
): void => {
  if (view === undefined) return
  try {
    if (!window.isDestroyed() && window.contentView.children.includes(view)) window.contentView.removeChildView(view)
  } catch {
    // Window teardown may race the closed callback; detaching is already complete in that case.
  }
  try {
    if (!view.webContents.isDestroyed()) view.webContents.close()
  } catch {
    // Closing a WebContents is idempotent from the product lifecycle's perspective.
  }
}
