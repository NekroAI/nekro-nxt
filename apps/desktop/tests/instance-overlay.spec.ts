import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import {
  InstanceOperationError,
  invokeTrustedInstanceOperation,
  toTrustedInstanceError,
  trustedInstanceFailure,
} from '../src/instance-operation-error.ts'
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
it('serializes concise trusted errors without leaking Electron IPC wrapper details', async () => {
  const wrapped = new Error("Error invoking remote method 'nxt:instances:add': Error: connect ECONNREFUSED")
  const fallback = trustedInstanceFailure(wrapped)
  const rejected = toTrustedInstanceError(
    new InstanceOperationError('management-key-rejected', '管理密钥不正确，请检查后重试。'),
  )

  expect(fallback).toEqual({
    ok: false,
    error: { code: 'operation-failed', message: '无法完成实例操作，请稍后重试。' },
  })
  expect(rejected).toEqual({ code: 'management-key-rejected', message: '管理密钥不正确，请检查后重试。' })
  expect(JSON.stringify([fallback, rejected])).not.toContain('nxt:instances:add')
  expect(JSON.stringify([fallback, rejected])).not.toContain('Error:')

  const boundaryError = await invokeTrustedInstanceOperation(() => Promise.reject(wrapped), 'add', {
    address: 'https://nxt.example.test',
  }).catch((error: unknown) => error)
  expect(boundaryError).toBeInstanceOf(Error)
  if (!(boundaryError instanceof Error)) throw new Error('trusted boundary 应返回 Error。')
  expect(boundaryError.message).toBe('无法完成实例操作，请稍后重试。')
  expect(boundaryError.message).not.toContain('nxt:instances:add')
  expect(boundaryError.message).not.toContain('Error:')
})
it('uses adjacent native controls with valid list and popup semantics', async () => {
  const source = await readFile(path.join(desktopRoot, 'src/instance-overlay.js'), 'utf8')

  expect(source).toContain('<ul class="list" aria-label="服务实例列表">')
  expect(source).toContain('<li class="instance-item" data-profile-id=')
  expect(source).toContain('<button class="more"')
  expect(source).toContain('aria-haspopup="menu"')
  expect(source).toContain("aria-expanded=\"${menuOpen ? 'true' : 'false'}\"")
  expect(source).toContain('class="menu"')
  expect(source).toContain('role="menu"')
  expect(source).toContain('role="menuitem"')
  expect(source).toContain('data-action="retry"')
  expect(source).toContain('data-action="edit"')
  expect(source).toContain('data-action="notifications"')
  expect(source).toContain('data-action="confirm-remove"')
  expect(source).not.toContain('role="button"')
  expect(source).not.toContain('tabindex="0"')

  const instanceButton = source.match(/<button class="instance[\s\S]*?<\/button>/u)?.[0] ?? ''
  expect(instanceButton).not.toContain('class="more"')
  expect(instanceButton.match(/<button/gu)).toHaveLength(1)
})
it('uses a bidirectional trigger-aligned transition, ui-kit tokens, and reduced-motion fallback', async () => {
  const [script, stylesheet, markup] = await Promise.all([
    readFile(path.join(desktopRoot, 'src/instance-overlay.js'), 'utf8'),
    readFile(path.join(desktopRoot, 'src/instance-overlay.css'), 'utf8'),
    readFile(path.join(desktopRoot, 'src/instance-overlay.html'), 'utf8'),
  ])
  expect(markup).toContain('data-visibility="closed"')
  expect(script).toContain('bridge.subscribeVisibility')
  expect(script).toContain("dataset.visibility = 'closing'")
  expect(stylesheet).toContain('transform-origin: left bottom')
  expect(stylesheet).toContain('transform-origin: top right')
  expect(stylesheet).toContain('--motion-enter: 160ms')
  expect(stylesheet).toContain('--motion-exit: 100ms')
  expect(stylesheet).toContain('@media (prefers-reduced-motion: reduce)')
  expect(stylesheet).not.toContain('linear-gradient')
  expect(stylesheet).not.toContain('.panel::before')
  expect(stylesheet).toContain('--nxt-bg-surface: #fffdf9')
  expect(stylesheet).toContain('--nxt-bg-elevated: #29425f')
})
it('keeps native Enter/Space activation and implements popup arrow/Escape focus restoration', async () => {
  const source = await readFile(path.join(desktopRoot, 'src/instance-overlay.js'), 'utf8')

  expect(source).toContain("event.key === 'ArrowDown' || event.key === 'ArrowUp'")
  expect(source).toContain('menu.querySelectorAll(\'[role="menuitem"]\')')
  expect(source).toContain("if (event.key === 'Escape')")
  expect(source).toContain("focusControl(profileId ? 'more' : 'add', profileId)")
  expect(source).not.toMatch(/event\.key === ['"](?:Enter| )['"]/u)
})
it('routes address and optional key through editConnection and keeps reauthentication address-free', async () => {
  const overlay = await readFile(path.join(desktopRoot, 'src/instance-overlay.js'), 'utf8')
  const preload = await readFile(path.join(desktopRoot, 'src/overlay-preload.ts'), 'utf8')

  expect(preload).toContain("editConnection: (input: unknown) => invoke('editConnection', input)")
  expect(preload).toContain("close: (input?: unknown) => invoke('close', input)")
  expect(overlay).toContain("if (mode.kind === 'edit') result = await bridge.editConnection(operationPayload)")
  expect(overlay).toContain('bridge.update({ profileId: id, notificationsEnabled: !profile.notificationsEnabled })')

  for (const fragment of [
    'profileId: mode.profileId,',
    'displayName: mode.draft.displayName,',
    'address: normalized.origin,',
    "mode.draft.managementKey.trim() === '' ? {} : { managementKey: mode.draft.managementKey }",
    '...(normalized.insecureRemoteHttp ? { confirmedInsecureHttpOrigin: normalized.origin } : {}),',
  ]) {
    expect(overlay, 'edit payload 应包含 ' + fragment).toContain(fragment)
  }

  const reauthPayload =
    overlay.match(/profileId: mode\.profileId,\n\s+managementKey: mode\.draft\.managementKey[\s\S]{0,120}/u)?.[0] ?? ''
  expect(reauthPayload).not.toContain('address')
  expect(reauthPayload).not.toContain('displayName')
  expect(overlay).toContain('result.saved === false')
  expect(overlay).toContain('bridge.close({ restoreControl: true })')
  expect(overlay).toContain('bridge.close({ restoreControl: false })')
})
