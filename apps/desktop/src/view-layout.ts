export const DESKTOP_TITLE_BAR_HEIGHT = 48
export const INSTANCE_PANEL_WIDTH = 344
export const INSTANCE_PANEL_MAX_HEIGHT = 480
export const INSTANCE_PANEL_RAIL_OFFSET = 64
export const INSTANCE_PANEL_MARGIN = 12

export interface ViewRectangle {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export const desktopViewBounds = (
  width: number,
  height: number,
): { readonly product: ViewRectangle; readonly fallback: ViewRectangle; readonly overlay: ViewRectangle } => {
  const normalizedWidth = Math.max(0, width)
  const normalizedHeight = Math.max(0, height)
  const full = { x: 0, y: 0, width: normalizedWidth, height: normalizedHeight }
  return {
    product: full,
    fallback: full,
    overlay: {
      x: 0,
      y: Math.min(DESKTOP_TITLE_BAR_HEIGHT, normalizedHeight),
      width: normalizedWidth,
      height: Math.max(0, normalizedHeight - DESKTOP_TITLE_BAR_HEIGHT),
    },
  }
}

export interface ChildViewContainer<View> {
  readonly children: readonly View[]
  addChildView(view: View): void
  removeChildView(view: View): void
}

/** Reuses the same production remove/add sequence that makes a visible child the top-most view. */
export const bringChildViewToFront = <View>(container: ChildViewContainer<View>, view: View): boolean => {
  if (!container.children.includes(view)) return false
  container.removeChildView(view)
  container.addChildView(view)
  return true
}
