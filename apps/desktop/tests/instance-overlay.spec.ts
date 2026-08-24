import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('Desktop instance overlay accessibility contract', () => {
  it('uses adjacent native controls with valid list and popup semantics', async () => {
    const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const source = await readFile(path.join(desktopRoot, 'src/instance-overlay.js'), 'utf8')

    expect(source).toContain('<ul class="list" aria-label="服务实例列表">')
    expect(source).toContain('<li class="instance-item">')
    expect(source).toContain('<button class="more"')
    expect(source).toContain('aria-haspopup="menu"')
    expect(source).toContain("aria-expanded=\"${menuOpen ? 'true' : 'false'}\"")
    expect(source).toContain('role="menu"')
    expect(source).toContain('role="menuitem"')
    expect(source).not.toContain('role="button"')
    expect(source).not.toContain('tabindex="0"')

    const instanceButton = source.match(/<button class="instance[\s\S]*?<\/button>/u)?.[0] ?? ''
    expect(instanceButton).not.toContain('class="more"')
    expect(instanceButton.match(/<button/gu)).toHaveLength(1)
  })

  it('keeps native Enter/Space activation and implements popup arrow/Escape focus restoration', async () => {
    const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const source = await readFile(path.join(desktopRoot, 'src/instance-overlay.js'), 'utf8')

    expect(source).toContain("event.key === 'ArrowDown' || event.key === 'ArrowUp'")
    expect(source).toContain('menu.querySelectorAll(\'[role="menuitem"]\')')
    expect(source).toContain("if (event.key === 'Escape')")
    expect(source).toContain("focusControl(profileId ? 'more' : 'add', profileId)")
    expect(source).not.toMatch(/event\.key === ['"](?:Enter| )['"]/u)
  })

  it('keeps address fields out of existing-Profile update and reauthentication IPC', async () => {
    const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const overlay = await readFile(path.join(desktopRoot, 'src/instance-overlay.js'), 'utf8')
    const manager = await readFile(path.join(desktopRoot, 'src/instance-manager.ts'), 'utf8')

    const reauthentication = overlay.match(/bridge\.reauthenticate\(\{[\s\S]*?\}\)/u)?.[0] ?? ''
    expect(reauthentication).not.toContain('address')
    expect(manager).toContain("if ('origin' in value)")
    expect(manager).toContain("if ('address' in value || 'origin' in value)")
  })
})
