/* global window, document, requestAnimationFrame */

/**
 * @typedef {{ displayName: string, address: string, managementKey: string }} ConnectionFormDraft
 */

/**
 * @param {Partial<ConnectionFormDraft>} [input]
 * @returns {ConnectionFormDraft}
 */
export const createAddRemoteDraft = (input = {}) => ({
  displayName: typeof input.displayName === 'string' ? input.displayName : '',
  address: typeof input.address === 'string' ? input.address : '',
  managementKey: typeof input.managementKey === 'string' ? input.managementKey : '',
})

/**
 * @param {ConnectionFormDraft} draft
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

const checkIcon =
  '<svg class="check-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>'
const revealIcon = (revealed) =>
  revealed
    ? '<svg class="reveal-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.88 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 8 10 8a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3.5 8 10 8a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>'
    : '<svg class="reveal-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>'

const startOverlay = () => {
  const bridge = window.nxtInstances
  const root = document.querySelector('#app')
  let snapshot = { revision: 0, currentProfileId: 'local', profiles: [] }
  let mode = { kind: 'list' }
  let busy = false
  let error = ''
  let pendingOpenIntent
  let submissionGeneration = 0
  let activeSubmission

  const invalidateSubmission = () => {
    submissionGeneration += 1
    if (mode?.draft && Object.hasOwn(mode.draft, 'managementKey')) mode.draft.managementKey = ''
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

  const mountPanel = (panel) => {
    const menuMarkup =
      mode.kind === 'menu' ? renderMenu(snapshot.profiles.find((item) => item.id === mode.profileId)) : ''
    root.innerHTML = `<div class="sheet-backdrop">${panel}</div>${menuMarkup}`
    if (menuMarkup !== '') anchorFloatingMenu(mode.profileId)
  }

  const header = (title, back = false) =>
    `<header class="head"><div>${back ? '<button class="back" data-action="back" aria-label="返回">←</button>' : ''}<span class="heading"><h1>${escapeHtml(title)}</h1><small>${back ? '完成后返回实例列表' : '选择 NekroNXT 工作区来源'}</small></span></div>${back ? '' : `<span class="count">${snapshot.profiles.length} 个</span>`}</header>`

  const renderList = () => {
    const rows = snapshot.profiles
      .map((profile) => {
        const current = profile.id === snapshot.currentProfileId
        const menuOpen = mode.kind === 'menu' && mode.profileId === profile.id
        return `<li class="instance-item" data-profile-id="${escapeHtml(profile.id)}">
        <div class="instance-row ${current ? 'current' : ''}">
          <button class="instance ${current ? 'current' : ''}" data-action="switch" data-id="${escapeHtml(profile.id)}" aria-current="${current ? 'true' : 'false'}">
            <span class="dot ${escapeHtml(profile.status)}" data-profile-status></span>
            <span class="copy"><span class="name" data-profile-name>${escapeHtml(profile.displayName)}</span><span class="meta" data-profile-meta>${escapeHtml(profile.addressLabel)} · ${escapeHtml(statusText(profile.status))}</span></span>
            <span data-current-check>${current ? `<span class="check" aria-label="当前实例">${checkIcon}</span>` : ''}</span>
          </button>
          ${profile.kind === 'remote' ? `<button class="more" data-action="more" data-id="${escapeHtml(profile.id)}" aria-label="${escapeHtml(profile.displayName)}的更多操作" aria-haspopup="menu" aria-expanded="${menuOpen ? 'true' : 'false'}" aria-controls="instance-menu-${escapeHtml(profile.id)}">⋯</button>` : ''}
        </div>
      </li>`
      })
      .join('')
    mountPanel(
      `<section class="panel" role="dialog" aria-modal="true" aria-label="服务实例" tabindex="-1">${header('服务实例')}<ul class="list" aria-label="服务实例列表">${rows}</ul><footer class="foot"><button class="quiet wide" data-action="add">＋ 添加远程实例</button></footer></section>`,
    )
  }

  const renderMenu = (profile) =>
    `<div class="menu" id="instance-menu-${escapeHtml(profile.id)}" role="menu" aria-label="${escapeHtml(profile.displayName)}的实例操作">
    <button role="menuitem" data-action="retry" data-id="${escapeHtml(profile.id)}">重新连接</button>
    <button role="menuitem" data-action="edit" data-id="${escapeHtml(profile.id)}">编辑连接</button>
    <button role="menuitem" data-action="notifications" data-id="${escapeHtml(profile.id)}">系统通知：${profile.notificationsEnabled ? '已开启' : '已关闭'}</button>
    <button role="menuitem" class="danger" data-action="confirm-remove" data-id="${escapeHtml(profile.id)}">移除实例</button>
  </div>`

  const anchorFloatingMenu = (profileId) => {
    const menu = root.querySelector('.menu')
    const anchor = root.querySelector(`[data-action="more"][data-id="${window.CSS.escape(profileId)}"]`)
    if (!menu || !(anchor instanceof window.HTMLElement)) return
    const rect = anchor.getBoundingClientRect()
    const menuHeight = menu.offsetHeight
    const menuWidth = menu.offsetWidth
    let top = rect.top
    const bottomLimit = window.innerHeight - 4
    if (top + menuHeight > bottomLimit) top = Math.max(4, rect.bottom - menuHeight)
    const rightSideLeft = rect.right + 6
    const fitsRight = rightSideLeft + menuWidth <= window.innerWidth - 4
    menu.dataset.side = fitsRight ? 'right' : 'left'
    menu.style.left = `${fitsRight ? rightSideLeft : Math.max(4, rect.left - menuWidth - 6)}px`
    menu.style.right = 'auto'
    menu.style.top = `${top}px`
  }

  const keyField = (draft) =>
    `<div class="field"><label for="key">管理密钥（可选）</label><div class="secret-wrap"><input id="key" name="managementKey" type="${mode.revealKey ? 'text' : 'password'}" autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true" value="${escapeHtml(draft.managementKey)}"><button type="button" class="reveal" data-action="reveal" aria-label="${mode.revealKey ? '隐藏' : '显示'}管理密钥">${revealIcon(mode.revealKey)}</button></div><p class="field-hint">服务器配置了管理密钥时填写。</p></div>`

  const formShell = ({ title, body, primaryLabel, busyLabel, progressText }) =>
    `<section class="panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">${header(title, true)}<form class="form" data-form="current">${body}<p class="progress" data-progress hidden>${escapeHtml(progressText)}</p><p class="error" data-error role="alert" hidden></p><div class="form-actions"><button type="button" class="quiet" data-action="back">取消</button><button type="submit" class="primary" data-submit data-idle-label="${escapeHtml(primaryLabel)}" data-busy-label="${escapeHtml(busyLabel)}">${escapeHtml(primaryLabel)}</button></div></form></section>`

  /**
   * Busy/error feedback updates in place so a submission start or failure never
   * replaces focused inputs, their caret/selection, or IME composition.
   */
  const patchFormState = (nextBusy, nextError) => {
    const form = root.querySelector('form[data-form="current"]')
    if (!form) return
    const progress = form.querySelector('[data-progress]')
    const alert = form.querySelector('[data-error]')
    const submit = form.querySelector('[data-submit]')
    if (progress instanceof window.HTMLElement) progress.hidden = !nextBusy
    if (alert instanceof window.HTMLElement) {
      alert.textContent = nextError
      alert.hidden = !nextError
    }
    if (submit instanceof window.HTMLButtonElement) {
      submit.disabled = nextBusy
      submit.textContent = nextBusy ? submit.dataset.busyLabel : submit.dataset.idleLabel
    }
  }

  const renderForm = () => {
    if (mode.pendingInsecureHttpOrigin) {
      const title = mode.kind === 'reauth' ? '确认重新认证风险' : '确认 HTTP 连接风险'
      mountPanel(
        `<section class="panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">${header(title, true)}<div class="risk-confirm" role="alert"><h2>连接未加密</h2><p>HTTP 连接未加密。管理密钥和设备凭据可能在传输途中被截获或篡改。</p><p class="risk-origin">${escapeHtml(mode.pendingInsecureHttpOrigin)}</p><p>仅在你信任当前网络和服务器时继续。</p><div class="form-actions"><button type="button" class="quiet" data-action="cancel-http-confirmation">返回检查</button><button type="button" class="danger" data-action="confirm-http">仍要继续</button></div></div></section>`,
      )
      return
    }
    if (mode.kind === 'add') {
      const draft = mode.draft
      mountPanel(
        formShell({
          title: '添加远程实例',
          body: `<div class="field"><label for="name">实例名称</label><input id="name" name="displayName" autocomplete="off" placeholder="我的云服务器" value="${escapeHtml(draft.displayName)}"></div><div class="field"><label for="address">服务器地址</label><input id="address" name="address" autocomplete="off" placeholder="server.example:4960" value="${escapeHtml(draft.address)}" required></div>${keyField(draft)}`,
          primaryLabel: '连接并添加',
          busyLabel: '正在连接…',
          progressText: '正在验证服务器身份并建立设备会话…',
        }),
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
      const draft = mode.draft
      mountPanel(
        formShell({
          title: '编辑连接',
          body: `<div class="field"><label for="name">实例名称</label><input id="name" name="displayName" autocomplete="off" value="${escapeHtml(draft.displayName)}"></div><div class="field"><label for="address">服务器地址</label><input id="address" name="address" autocomplete="off" value="${escapeHtml(draft.address)}" required></div>${keyField(draft)}`,
          primaryLabel: '保存更改',
          busyLabel: '正在保存…',
          progressText: '正在保存更改…',
        }),
      )
      return
    }
    if (mode.kind === 'reauth') {
      mountPanel(
        formShell({
          title: '重新认证',
          body: `<p class="hint">${escapeHtml(profile.displayName)} · ${escapeHtml(profile.addressLabel)}</p>${profile.insecureHttp ? '<p class="risk-inline">此实例使用未加密 HTTP；重新认证前会再次确认传输风险。</p>' : ''}<div class="field"><label for="key">管理密钥</label><div class="secret-wrap"><input id="key" name="managementKey" type="${mode.revealKey ? 'text' : 'password'}" autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true" value="${escapeHtml(mode.draft.managementKey)}" required><button type="button" class="reveal" data-action="reveal" aria-label="${mode.revealKey ? '隐藏' : '显示'}管理密钥">${revealIcon(mode.revealKey)}</button></div></div>`,
          primaryLabel: '重新认证',
          busyLabel: '正在验证…',
          progressText: '正在验证原服务器身份并更新设备会话…',
        }),
      )
      return
    }
    if (mode.kind === 'remove') {
      mountPanel(
        `<section class="panel" role="dialog" aria-modal="true" aria-label="移除服务实例">${header('移除服务实例', true)}<div class="confirm"><h2>${escapeHtml(profile.displayName)}</h2><p>此操作会清除此客户端保存的连接记录、浏览数据和设备凭据。服务器中的智能体、频道、消息和扩展不会被删除。</p>${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}<div class="form-actions"><button class="quiet" data-action="back">取消</button><button class="danger" data-action="remove" data-id="${profile.id}" ${busy ? 'disabled' : ''}>移除实例</button></div></div></section>`,
      )
    }
  }

  let focusScheduleGeneration = 0
  const cancelScheduledFocus = () => {
    focusScheduleGeneration += 1
  }
  const hasValidOverlayFocus = () => {
    const active = document.activeElement
    return (
      active instanceof window.HTMLElement &&
      active.isConnected &&
      root.contains(active) &&
      !active.hasAttribute('disabled')
    )
  }
  /**
   * @param {() => Element | null | undefined} findControl
   * @param {(control: HTMLElement) => void} [afterFocus]
   */
  const scheduleFocus = (findControl, afterFocus) => {
    const generation = ++focusScheduleGeneration
    requestAnimationFrame(() => {
      if (generation !== focusScheduleGeneration || hasValidOverlayFocus()) return
      const control = findControl()
      if (!(control instanceof window.HTMLElement) || !control.isConnected || !root.contains(control)) return
      control.focus()
      afterFocus?.(control)
    })
  }
  const render = () => {
    cancelScheduledFocus()
    return mode.kind === 'list' || mode.kind === 'menu' ? renderList() : renderForm()
  }
  const focusControl = (action, id) =>
    scheduleFocus(() =>
      [...root.querySelectorAll('[data-action]')].find(
        (item) => item.dataset.action === action && (id === undefined || item.dataset.id === id),
      ),
    )
  const focusFirstMenuItem = () => scheduleFocus(() => root.querySelector('[role="menuitem"]'))
  const focusFirstField = () => scheduleFocus(() => root.querySelector('input, .confirm button'))
  const focusPanel = () => scheduleFocus(() => root.querySelector('.panel'))

  const applyPendingOpenIntent = () => {
    if (!pendingOpenIntent) return
    if (pendingOpenIntent.kind === 'reauthenticate') {
      const profile = snapshot.profiles.find((item) => item.id === pendingOpenIntent.profileId)
      if (!profile) {
        if (snapshot.revision === 0 && snapshot.profiles.length === 0) return
        pendingOpenIntent = { kind: 'list' }
      } else if (profile.requiresAuthentication) {
        invalidateSubmission()
        mode = {
          kind: 'reauth',
          profileId: profile.id,
          draft: { managementKey: '' },
          revealKey: false,
        }
        pendingOpenIntent = undefined
        render()
        focusFirstField()
        return
      } else {
        pendingOpenIntent = { kind: 'list' }
      }
    }
    invalidateSubmission()
    mode = { kind: 'list' }
    pendingOpenIntent = undefined
    render()
    focusPanel()
  }

  const captureFocusedControl = () => {
    const active = document.activeElement
    if (!(active instanceof window.HTMLElement) || !root.contains(active)) return undefined
    return {
      panel: active.matches('.panel'),
      action: active.dataset.action,
      id: active.dataset.id,
      name: active.getAttribute('name'),
      selectionStart: 'selectionStart' in active ? active.selectionStart : undefined,
      selectionEnd: 'selectionEnd' in active ? active.selectionEnd : undefined,
      selectionDirection: 'selectionDirection' in active ? active.selectionDirection : undefined,
    }
  }

  const restoreFocusedControl = (focus) => {
    if (!focus) return
    if (focus.panel) {
      focusPanel()
      return
    }
    scheduleFocus(
      () =>
        [...root.querySelectorAll('button, input')].find(
          (item) =>
            (focus.action === undefined || item.dataset.action === focus.action) &&
            (focus.id === undefined || item.dataset.id === focus.id) &&
            (focus.name === null || item.getAttribute('name') === focus.name),
        ),
      (control) => {
        if (
          control instanceof window.HTMLInputElement &&
          typeof focus.selectionStart === 'number' &&
          typeof focus.selectionEnd === 'number'
        ) {
          control.setSelectionRange(focus.selectionStart, focus.selectionEnd, focus.selectionDirection || 'none')
        }
      },
    )
  }

  const renderPreservingFocus = () => {
    const focus = captureFocusedControl()
    render()
    restoreFocusedControl(focus)
  }

  const sameListStructure = (previous, next) =>
    previous.profiles.length === next.profiles.length &&
    previous.profiles.every((profile, index) => {
      const candidate = next.profiles[index]
      return (
        candidate?.id === profile.id &&
        candidate.kind === profile.kind &&
        candidate.requiresAuthentication === profile.requiresAuthentication
      )
    })

  const patchList = (next) => {
    if (!sameListStructure(snapshot, next)) return false
    const items = [...root.querySelectorAll('[data-profile-id]')]
    if (items.length !== next.profiles.length) return false
    root.querySelector('.count').textContent = `${next.profiles.length} 个`
    for (const profile of next.profiles) {
      const item = items.find((candidate) => candidate.dataset.profileId === profile.id)
      if (!item) return false
      const current = profile.id === next.currentProfileId
      const row = item.querySelector('.instance-row')
      const button = item.querySelector('.instance')
      row?.classList.toggle('current', current)
      button?.classList.toggle('current', current)
      button?.setAttribute('aria-current', current ? 'true' : 'false')
      const dot = item.querySelector('[data-profile-status]')
      if (dot) dot.className = `dot ${profile.status}`
      const name = item.querySelector('[data-profile-name]')
      const meta = item.querySelector('[data-profile-meta]')
      const check = item.querySelector('[data-current-check]')
      if (name) name.textContent = profile.displayName
      if (meta) meta.textContent = `${profile.addressLabel} · ${statusText(profile.status)}`
      if (check) check.innerHTML = current ? `<span class="check" aria-label="当前实例">${checkIcon}</span>` : ''
      const more = item.querySelector('[data-action="more"]')
      if (more) more.setAttribute('aria-label', `${profile.displayName}的更多操作`)
    }
    return true
  }

  const applySnapshot = (next) => {
    const nextRevision = Number.isSafeInteger(next?.revision) ? next.revision : 0
    if (nextRevision < snapshot.revision || (nextRevision === snapshot.revision && root.firstElementChild)) return
    if (mode.profileId && !next.profiles.some((profile) => profile.id === mode.profileId)) {
      invalidateSubmission()
      snapshot = next
      mode = { kind: 'list' }
      render()
      focusControl('add')
      return
    }
    if (mode.kind === 'list' || mode.kind === 'menu') {
      const patched = patchList(next)
      snapshot = next
      if (!patched) renderPreservingFocus()
      applyPendingOpenIntent()
      return
    }
    snapshot = next
    applyPendingOpenIntent()
  }

  const refresh = async () => {
    applySnapshot(await bridge.list())
  }

  root.addEventListener('click', async (event) => {
    const target = event.target instanceof window.Element ? event.target : undefined

    if (mode.kind === 'menu' && target?.closest('.menu, [data-action="more"]') === null) {
      event.preventDefault()
      mode = { kind: 'list' }
      render()
      focusPanel()
      return
    }

    if (target?.classList.contains('sheet-backdrop') === true) {
      event.preventDefault()
      if (mode.kind === 'list') bridge.close({ restoreControl: false })
      else {
        const profileId = mode.profileId
        invalidateSubmission()
        mode = { kind: 'list' }
        render()
        focusControl(profileId ? 'more' : 'add', profileId)
      }
      return
    }

    const actionTarget = target?.closest('[data-action]')
    if (!actionTarget) return
    event.preventDefault()
    event.stopPropagation()
    const action = actionTarget.dataset.action
    const id = actionTarget.dataset.id
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
      if (opening && lastInputWasKeyboard) focusFirstMenuItem()
      else if (!opening && lastInputWasKeyboard) focusControl('more', id)
      else focusPanel()
      return
    }
    if (action === 'edit') {
      const profile = snapshot.profiles.find((item) => item.id === id)
      if (!profile) return
      mode = {
        kind: 'edit',
        profileId: id,
        draft: {
          displayName: profile.displayName,
          address: profile.origin ?? '',
          managementKey: '',
        },
        revealKey: false,
        ...(profile.insecureHttp && profile.origin ? { confirmedInsecureHttpOrigin: profile.origin } : {}),
      }
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
      if (action === 'retry') {
        mode = { kind: 'list' }
        render()
        await bridge.retry(id)
      }
      if (action === 'notifications') {
        const profile = snapshot.profiles.find((item) => item.id === id)
        if (!profile) return
        mode = { kind: 'list' }
        render()
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
        patchFormState(false, error)
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
    if (mode.kind === 'edit') {
      let normalized
      try {
        normalized = normalizeOverlayOrigin(mode.draft.address)
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause)
        patchFormState(false, error)
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
        profileId: mode.profileId,
        displayName: mode.draft.displayName,
        address: normalized.origin,
        ...(mode.draft.managementKey.trim() === '' ? {} : { managementKey: mode.draft.managementKey }),
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
    patchFormState(true, '')
    try {
      let result
      if (mode.kind === 'add') result = await bridge.add(operationPayload)
      if (mode.kind === 'edit') result = await bridge.editConnection(operationPayload)
      if (mode.kind === 'reauth') result = await bridge.reauthenticate(operationPayload)
      if (generation !== submissionGeneration) return
      activeSubmission = undefined
      if (result !== null && typeof result === 'object' && result.saved === false) {
        // 产品存在未保存草稿且用户取消迁址/重认证：保留当前表单，不切回列表。
        busy = false
        patchFormState(false, '')
        return
      }
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
      patchFormState(false, failure.error)
    }
  })

  let lastInputWasKeyboard = false
  document.addEventListener('pointerdown', () => {
    lastInputWasKeyboard = false
  })
  document.addEventListener('keydown', (event) => {
    lastInputWasKeyboard = true
    if (event.key === 'Tab') {
      const focusable = [...root.querySelectorAll('button:not(:disabled), input:not(:disabled), a[href]')].filter(
        (item) => item.getClientRects().length > 0,
      )
      const first = focusable[0]
      const last = focusable.at(-1)
      if (first && last && (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      }
    }
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
        bridge.close({ restoreControl: true })
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
  bridge.subscribeVisibility((visibility) => {
    const state = typeof visibility === 'string' ? visibility : visibility?.state
    if (state === 'closing') {
      document.documentElement.dataset.visibility = 'closing'
      pendingOpenIntent = undefined
      invalidateSubmission()
      mode = { kind: 'list' }
      render()
      return
    }
    if (state !== 'open') return
    pendingOpenIntent =
      visibility?.intent?.kind === 'reauthenticate' && typeof visibility.intent.profileId === 'string'
        ? { kind: 'reauthenticate', profileId: visibility.intent.profileId }
        : { kind: 'list' }
    document.documentElement.dataset.visibility = 'closed'
    applyPendingOpenIntent()
    requestAnimationFrame(() => {
      document.documentElement.dataset.visibility = 'open'
    })
  })
  bridge.subscribe(applySnapshot)
  refresh().then(() => {
    if ((mode.kind === 'list' || mode.kind === 'menu') && !hasValidOverlayFocus()) focusPanel()
  })
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') startOverlay()
