/* global window, document, requestAnimationFrame */

/**
 * @typedef {{ displayName: string, address: string, managementKey: string }} AddRemoteDraft
 */

/**
 * @param {Partial<AddRemoteDraft>} [input]
 * @returns {AddRemoteDraft}
 */
export const createAddRemoteDraft = (input = {}) => ({
  displayName: typeof input.displayName === 'string' ? input.displayName : '',
  address: typeof input.address === 'string' ? input.address : '',
  managementKey: typeof input.managementKey === 'string' ? input.managementKey : '',
})

/**
 * @param {AddRemoteDraft} draft
 * @returns {{ displayName: string, address: string, managementKey?: string }}
 */
export const createAddRemotePayload = (draft) => ({
  displayName: draft.displayName,
  address: draft.address,
  ...(draft.managementKey.trim() === '' ? {} : { managementKey: draft.managementKey }),
})

/**
 * Normalize locally before any trusted-bridge call so explicit remote HTTP can
 * be confirmed without probing the address.
 * @param {string} input
 * @returns {{ origin: string, insecureRemoteHttp: boolean }}
 */
export const normalizeOverlayOrigin = (input) => {
  const trimmed = String(input).trim()
  if (trimmed === '') throw new Error('请输入服务器地址。')
  const address = trimmed.includes('://') ? trimmed : `https://${trimmed}`
  const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/iu.exec(address)?.[1]
  const hostPort = authority?.slice((authority.lastIndexOf('@') ?? -1) + 1)
  if (!authority || !hostPort || hostPort.endsWith(':')) {
    throw new Error('服务器地址格式无效，请输入主机名或 IP 与端口。')
  }
  const explicitlyPorted = /^\[[^\]]+\]:\d+$/u.test(hostPort) || /:\d+$/u.test(hostPort)
  let parsed
  try {
    parsed = new URL(address)
  } catch {
    throw new Error('服务器地址格式无效，请输入主机名或 IP 与端口。')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('服务器地址只支持 HTTPS 或 HTTP。')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('服务器地址不能包含账号、密码、查询参数或片段。')
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') throw new Error('服务器地址不能包含路径。')
  if (!explicitlyPorted && !parsed.port) parsed.port = '4960'
  const loopback =
    parsed.hostname === 'localhost' || parsed.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/u.test(parsed.hostname)
  return { origin: parsed.origin, insecureRemoteHttp: parsed.protocol === 'http:' && !loopback }
}

/**
 * @template {Record<string, string>} T
 * @param {T} draft
 * @param {string} field
 * @param {unknown} value
 * @returns {T}
 */
export const updateFormDraft = (draft, field, value) =>
  Object.hasOwn(draft, field) ? { ...draft, [field]: String(value) } : draft

/**
 * @template {Record<string, string>} T
 * @param {T} draft
 * @param {unknown} message
 * @returns {{ draft: T, busy: false, error: string }}
 */
export const retainDraftAfterFailure = (draft, message) => ({
  draft: { ...draft },
  busy: false,
  error: String(message),
})

const startOverlay = () => {
  const bridge = window.nxtInstances
  const root = document.querySelector('#app')
  let snapshot = { currentProfileId: 'local', profiles: [] }
  let mode = { kind: 'list' }
  let busy = false
  let error = ''
  let submissionGeneration = 0
  let activeSubmission

  const invalidateSubmission = () => {
    submissionGeneration += 1
    if (activeSubmission?.draft && Object.hasOwn(activeSubmission.draft, 'managementKey')) {
      activeSubmission.draft.managementKey = ''
    }
    if (activeSubmission?.payload && Object.hasOwn(activeSubmission.payload, 'managementKey')) {
      activeSubmission.payload.managementKey = ''
    }
    activeSubmission = undefined
    busy = false
    error = ''
  }

  const escapeHtml = (value) =>
    String(value).replace(
      /[&<>'"]/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char],
    )
  const statusText = (status) =>
    ({
      connecting: '正在连接',
      ready: '运行正常',
      unstable: '连接不稳定',
      offline: '无法连接',
      'authentication-required': '需要重新认证',
      incompatible: '版本不兼容',
    })[status] || '状态未知'

  const header = (title, back = false) =>
    `<header class="head"><div>${back ? '<button class="back" data-action="back" aria-label="返回">←</button>' : ''}<h1 style="display:inline">${escapeHtml(title)}</h1></div>${back ? '' : `<span class="count">${snapshot.profiles.length} 个</span>`}</header>`

  const renderList = () => {
    const rows = snapshot.profiles
      .map((profile) => {
        const current = profile.id === snapshot.currentProfileId
        const menuOpen = mode.kind === 'menu' && mode.profileId === profile.id
        return `<li class="instance-item">
        <div class="instance-row ${current ? 'current' : ''}">
        <button class="instance ${current ? 'current' : ''}" data-action="switch" data-id="${escapeHtml(profile.id)}" aria-current="${current ? 'true' : 'false'}">
          <span class="dot ${escapeHtml(profile.status)}"></span>
          <span class="copy"><span class="name">${escapeHtml(profile.displayName)}</span><span class="meta">${escapeHtml(profile.addressLabel)} · ${escapeHtml(statusText(profile.status))}</span></span>
          ${current ? '<span class="check" aria-label="当前实例">✓</span>' : '<span></span>'}
        </button>
        ${profile.kind === 'remote' ? `<button class="more" data-action="more" data-id="${escapeHtml(profile.id)}" aria-label="${escapeHtml(profile.displayName)}的更多操作" aria-haspopup="menu" aria-expanded="${menuOpen ? 'true' : 'false'}" aria-controls="instance-menu-${escapeHtml(profile.id)}">⋯</button>` : ''}
        </div>
        ${menuOpen ? renderMenu(profile) : ''}
      </li>`
      })
      .join('')
    root.innerHTML = `<section class="panel">${header('服务实例')}<ul class="list" aria-label="服务实例列表">${rows}</ul><footer class="foot"><button class="quiet wide" data-action="add">＋ 添加远程实例</button></footer></section>`
  }

  const renderMenu = (
    profile,
  ) => `<div class="menu" id="instance-menu-${escapeHtml(profile.id)}" role="menu" aria-label="${escapeHtml(profile.displayName)}的实例操作">
    <button role="menuitem" data-action="retry" data-id="${escapeHtml(profile.id)}">重新连接</button>
    <button role="menuitem" data-action="edit" data-id="${escapeHtml(profile.id)}">修改名称</button>
    <button role="menuitem" data-action="notifications" data-id="${escapeHtml(profile.id)}">系统通知：${profile.notificationsEnabled ? '已开启' : '已关闭'}</button>
    ${profile.requiresAuthentication ? `<button role="menuitem" data-action="reauth" data-id="${escapeHtml(profile.id)}">重新认证</button>` : ''}
    <button role="menuitem" class="danger" data-action="confirm-remove" data-id="${escapeHtml(profile.id)}">移除实例</button>
  </div>`

  const formShell = (title, body, primaryLabel) =>
    `<section class="panel">${header(title, true)}<form class="form" data-form="current">${body}${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}<div class="form-actions"><button type="button" class="quiet" data-action="back">取消</button><button class="primary" ${busy ? 'disabled' : ''}>${busy ? '正在连接…' : primaryLabel}</button></div></form><div></div></section>`

  const renderForm = () => {
    if (mode.pendingInsecureHttpOrigin) {
      const title = mode.kind === 'reauth' ? '确认重新认证风险' : '确认 HTTP 连接风险'
      root.innerHTML = `<section class="panel">${header(title, true)}<div class="risk-confirm" role="alert"><h2>连接未加密</h2><p>HTTP 连接未加密。管理密钥和设备凭据可能在传输途中被截获或篡改。</p><p class="risk-origin">${escapeHtml(mode.pendingInsecureHttpOrigin)}</p><p>仅在你信任当前网络和服务器时继续。</p><div class="form-actions"><button type="button" class="quiet" data-action="cancel-http-confirmation">返回检查</button><button type="button" class="danger" data-action="confirm-http">仍要继续</button></div></div><div></div></section>`
      return
    }
    if (mode.kind === 'add') {
      const draft = mode.draft
      root.innerHTML = formShell(
        '添加远程实例',
        `<div class="field"><label for="name">实例名称</label><input id="name" name="displayName" autocomplete="off" placeholder="我的云服务器" value="${escapeHtml(draft.displayName)}"></div><div class="field"><label for="address">服务器地址</label><input id="address" name="address" autocomplete="off" placeholder="server.example:4960" value="${escapeHtml(draft.address)}" required></div><div class="field"><label for="key">管理密钥（可选）</label><div class="secret-wrap"><input id="key" name="managementKey" type="${mode.revealKey ? 'text' : 'password'}" autocomplete="new-password" value="${escapeHtml(draft.managementKey)}"><button type="button" class="reveal" data-action="reveal" aria-label="${mode.revealKey ? '隐藏' : '显示'}管理密钥">👁</button></div><p class="field-hint">服务器配置了管理密钥时填写。</p></div>${busy ? '<p class="progress">正在验证服务器身份并建立设备会话…</p>' : ''}`,
        '连接并添加',
      )
      return
    }
    const profile = snapshot.profiles.find((item) => item.id === mode.profileId)
    if (!profile) {
      mode = { kind: 'list' }
      render()
      return
    }
    if (mode.kind === 'edit') {
      root.innerHTML = formShell(
        '修改实例名称',
        `<div class="field"><label for="name">实例名称</label><input id="name" name="displayName" value="${escapeHtml(mode.draft.displayName)}" required></div>`,
        '保存名称',
      )
      return
    }
    if (mode.kind === 'reauth') {
      root.innerHTML = formShell(
        '重新认证',
        `<p class="hint">${escapeHtml(profile.displayName)} · ${escapeHtml(profile.addressLabel)}</p>${profile.insecureHttp ? '<p class="risk-inline">此实例使用未加密 HTTP；重新认证前会再次确认传输风险。</p>' : ''}<div class="field"><label for="key">管理密钥</label><div class="secret-wrap"><input id="key" name="managementKey" type="${mode.revealKey ? 'text' : 'password'}" autocomplete="new-password" value="${escapeHtml(mode.draft.managementKey)}" required><button type="button" class="reveal" data-action="reveal" aria-label="${mode.revealKey ? '隐藏' : '显示'}管理密钥">👁</button></div></div>${busy ? '<p class="progress">正在验证原服务器身份并更新设备会话…</p>' : ''}`,
        '重新认证',
      )
      return
    }
    if (mode.kind === 'remove') {
      root.innerHTML = `<section class="panel">${header('移除服务实例', true)}<div class="confirm"><h2>${escapeHtml(profile.displayName)}</h2><p>此操作会清除此客户端保存的连接记录、浏览数据和设备凭据。服务器中的智能体、频道、消息和扩展不会被删除。</p>${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}<div class="form-actions"><button class="quiet" data-action="back">取消</button><button class="danger" data-action="remove" data-id="${profile.id}" ${busy ? 'disabled' : ''}>移除实例</button></div></div><div></div></section>`
    }
  }

  const render = () => (mode.kind === 'list' || mode.kind === 'menu' ? renderList() : renderForm())
  const focusControl = (action, id) =>
    requestAnimationFrame(() => {
      const control = [...root.querySelectorAll('[data-action]')].find(
        (item) => item.dataset.action === action && (id === undefined || item.dataset.id === id),
      )
      control?.focus()
    })
  const focusFirstMenuItem = () => root.querySelector('[role="menuitem"]')?.focus()
  const focusFirstField = () => root.querySelector('input, .confirm button')?.focus()
  const refresh = async () => {
    const active = document.activeElement
    const action = active?.dataset?.action
    const id = active?.dataset?.id
    snapshot = await bridge.list()
    render()
    if (action) focusControl(action, id)
  }

  root.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-action]')
    if (!target) return
    event.preventDefault()
    event.stopPropagation()
    const action = target.dataset.action
    const id = target.dataset.id
    error = ''
    if (action === 'back') {
      const profileId = mode.profileId
      invalidateSubmission()
      mode = profileId ? { kind: 'menu', profileId } : { kind: 'list' }
      render()
      focusControl(profileId ? 'more' : 'add', profileId)
      return
    }
    if (action === 'add') {
      mode = { kind: 'add', draft: createAddRemoteDraft(), revealKey: false }
      render()
      focusFirstField()
      return
    }
    if (action === 'more') {
      const opening = mode.kind !== 'menu' || mode.profileId !== id
      mode = opening ? { kind: 'menu', profileId: id } : { kind: 'list' }
      render()
      if (opening) focusFirstMenuItem()
      else focusControl('more', id)
      return
    }
    if (action === 'edit') {
      const profile = snapshot.profiles.find((item) => item.id === id)
      mode = { kind: 'edit', profileId: id, draft: { displayName: profile?.displayName || '' } }
      render()
      focusFirstField()
      return
    }
    if (action === 'reauth') {
      mode = { kind: 'reauth', profileId: id, draft: { managementKey: '' }, revealKey: false }
      render()
      focusFirstField()
      return
    }
    if (action === 'confirm-remove') {
      mode = { kind: 'remove', profileId: id }
      render()
      focusFirstField()
      return
    }
    if (action === 'cancel-http-confirmation') {
      mode = { ...mode, pendingInsecureHttpOrigin: undefined }
      render()
      focusFirstField()
      return
    }
    if (action === 'confirm-http') {
      const confirmedInsecureHttpOrigin = mode.pendingInsecureHttpOrigin
      mode = { ...mode, pendingInsecureHttpOrigin: undefined, confirmedInsecureHttpOrigin }
      render()
      root.querySelector('form')?.requestSubmit()
      return
    }
    if (action === 'reveal') {
      mode = { ...mode, revealKey: !mode.revealKey }
      render()
      focusControl('reveal')
      return
    }
    try {
      if (action === 'switch') await bridge.switchTo(id)
      if (action === 'retry') await bridge.retry(id)
      if (action === 'notifications') {
        const profile = snapshot.profiles.find((item) => item.id === id)
        await bridge.update({ profileId: id, notificationsEnabled: !profile.notificationsEnabled })
      }
      if (action === 'remove') {
        busy = true
        render()
        await bridge.remove(id)
        mode = { kind: 'list' }
        busy = false
      }
      await refresh()
    } catch (cause) {
      busy = false
      error = cause instanceof Error ? cause.message : String(cause)
      render()
    }
  })

  root.addEventListener('input', (event) => {
    const field = event.target
    if (!field?.name || mode.kind === 'list' || mode.kind === 'menu' || mode.kind === 'remove') return
    mode = {
      ...mode,
      draft: updateFormDraft(mode.draft, field.name, field.value),
      ...(field.name === 'address'
        ? { confirmedInsecureHttpOrigin: undefined, pendingInsecureHttpOrigin: undefined }
        : {}),
    }
  })

  root.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (busy) return
    for (const field of event.target.querySelectorAll('[name]')) {
      mode = { ...mode, draft: updateFormDraft(mode.draft, field.name, field.value) }
    }
    let operationPayload
    if (mode.kind === 'add') {
      let normalized
      try {
        normalized = normalizeOverlayOrigin(mode.draft.address)
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause)
        render()
        return
      }
      if (normalized.insecureRemoteHttp && mode.confirmedInsecureHttpOrigin !== normalized.origin) {
        mode = { ...mode, pendingInsecureHttpOrigin: normalized.origin }
        error = ''
        render()
        focusControl('cancel-http-confirmation')
        return
      }
      operationPayload = {
        ...createAddRemotePayload(mode.draft),
        address: normalized.origin,
        ...(normalized.insecureRemoteHttp ? { confirmedInsecureHttpOrigin: normalized.origin } : {}),
      }
    }
    if (mode.kind === 'reauth') {
      const profile = snapshot.profiles.find((item) => item.id === mode.profileId)
      if (profile?.insecureHttp && mode.confirmedInsecureHttpOrigin !== profile.origin) {
        mode = { ...mode, pendingInsecureHttpOrigin: profile.origin }
        error = ''
        render()
        focusControl('cancel-http-confirmation')
        return
      }
      operationPayload = {
        profileId: mode.profileId,
        managementKey: mode.draft.managementKey,
        ...(profile?.insecureHttp ? { confirmedInsecureHttpOrigin: profile.origin } : {}),
      }
    }
    const submittedMode = mode
    const generation = ++submissionGeneration
    activeSubmission = { generation, draft: submittedMode.draft, payload: operationPayload }
    busy = true
    error = ''
    render()
    try {
      if (mode.kind === 'add') await bridge.add(operationPayload)
      if (mode.kind === 'edit')
        await bridge.update({
          profileId: mode.profileId,
          displayName: submittedMode.draft.displayName,
        })
      if (mode.kind === 'reauth') await bridge.reauthenticate(operationPayload)
      if (generation !== submissionGeneration) return
      activeSubmission = undefined
      mode = { kind: 'list' }
      busy = false
      await refresh()
    } catch (cause) {
      if (generation !== submissionGeneration) return
      const failure = retainDraftAfterFailure(
        submittedMode.draft,
        cause instanceof Error ? cause.message : String(cause),
      )
      mode = { ...submittedMode, draft: failure.draft }
      activeSubmission = undefined
      busy = failure.busy
      error = failure.error
      render()
    }
  })

  document.addEventListener('keydown', (event) => {
    const menu = event.target.closest?.('[role="menu"]')
    if (menu && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      const items = [...menu.querySelectorAll('[role="menuitem"]')]
      const current = items.indexOf(document.activeElement)
      const offset = event.key === 'ArrowDown' ? 1 : -1
      const next = items[(Math.max(0, current) + offset + items.length) % items.length]
      if (next) {
        event.preventDefault()
        next.focus()
      }
      return
    }
    if (event.key === 'Escape') {
      if (mode.kind === 'list') {
        bridge.close()
      } else {
        const profileId = mode.profileId
        invalidateSubmission()
        mode = { kind: 'list' }
        render()
        focusControl(profileId ? 'more' : 'add', profileId)
      }
      return
    }
    if (mode.kind !== 'list' || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
    const rows = [...root.querySelectorAll('.instance')]
    const current = rows.indexOf(document.activeElement)
    const offset = event.key === 'ArrowDown' ? 1 : -1
    const next = rows[(Math.max(0, current) + offset + rows.length) % rows.length]
    if (next) {
      event.preventDefault()
      next.focus()
    }
  })
  bridge.subscribe((next) => {
    const active = document.activeElement
    const action = active?.dataset?.action
    const id = active?.dataset?.id
    snapshot = next
    render()
    if (action) focusControl(action, id)
  })
  refresh().then(() => requestAnimationFrame(() => root.querySelector('.instance.current, button')?.focus()))
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') startOverlay()
