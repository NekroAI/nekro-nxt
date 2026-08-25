interface ShortcutEvent {
  preventDefault(): void
}

interface ShortcutInput {
  readonly type: string
  readonly key: string
  readonly isAutoRepeat: boolean
}

interface DevToolsContents {
  on(event: 'before-input-event', listener: (event: ShortcutEvent, input: ShortcutInput) => void): unknown
  toggleDevTools(): void
}

/** Makes renderer diagnostics available in every Desktop distribution. */
export const installF12DevToolsShortcut = (contents: DevToolsContents): void => {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'F12' || input.isAutoRepeat) return
    event.preventDefault()
    contents.toggleDevTools()
  })
}
