import { describe, expect, it } from 'vitest'
import { docsHelpHref } from '../src/app/shell/docs-help.js'

describe('help button', () => {
  it('opens the page for the deepest matching route, in the documentation of this build', () => {
    expect(docsHelpHref('/settings/models', 'stable')).toBe('https://nxt.nekro.ai/docs/models/providers')
    expect(docsHelpHref('/wiring/connections/con_01', 'preview')).toBe(
      'https://nxt.nekro.ai/docs/preview/channels/wiring',
    )
    expect(docsHelpHref('/nowhere', 'development')).toBe('https://nxt.nekro.ai/docs/preview')
    expect(docsHelpHref('/settingsx', undefined)).toBe('https://nxt.nekro.ai/docs')
  })
})
