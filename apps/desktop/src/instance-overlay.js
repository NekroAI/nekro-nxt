/* global window, document, FormData, requestAnimationFrame */
;(() => {
  const bridge = window.nxtInstances
  const root = document.querySelector('#app')
  let snapshot = { currentProfileId: 'local', profiles: [] }
  let mode = { kind: 'list' }
  let busy = false
  let error = ''

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
        return `<div>
        <button class="instance ${current ? 'current' : ''}" data-action="switch" data-id="${escapeHtml(profile.id)}" aria-current="${current ? 'true' : 'false'}">
          <span class="dot ${escapeHtml(profile.status)}"></span>
          <span class="copy"><span class="name">${escapeHtml(profile.displayName)}</span><span class="meta">${escapeHtml(profile.addressLabel)} · ${escapeHtml(statusText(profile.status))}</span></span>
          <span class="row-actions">${current ? '<span class="check" aria-label="当前实例">✓</span>' : ''}${profile.kind === 'remote' ? `<span class="more" role="button" tabindex="0" data-action="more" data-id="${escapeHtml(profile.id)}" aria-label="更多操作">⋯</span>` : ''}</span>
        </button>
        ${mode.kind === 'menu' && mode.profileId === profile.id ? renderMenu(profile) : ''}
      </div>`
      })
      .join('')
    root.innerHTML = `<section class="panel">${header('服务实例')}<div class="list" role="listbox">${rows}</div><footer class="foot"><button class="quiet wide" data-action="add">＋ 添加远程实例</button></footer></section>`
  }

  const renderMenu = (profile) => `<div class="menu">
    <button data-action="retry" data-id="${profile.id}">重新连接</button>
    <button data-action="edit" data-id="${profile.id}">修改名称或地址</button>
    <button data-action="notifications" data-id="${profile.id}">系统通知：${profile.notificationsEnabled ? '已开启' : '已关闭'}</button>
    <button data-action="reauth" data-id="${profile.id}">重新认证</button>
    <button class="danger" data-action="confirm-remove" data-id="${profile.id}">移除实例</button>
  </div>`

  const formShell = (title, body, primaryLabel) =>
    `<section class="panel">${header(title, true)}<form class="form" data-form="current">${body}${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}<div class="form-actions"><button type="button" class="quiet" data-action="back">取消</button><button class="primary" ${busy ? 'disabled' : ''}>${busy ? '正在连接…' : primaryLabel}</button></div></form><div></div></section>`

  const renderForm = () => {
    if (mode.kind === 'add') {
      root.innerHTML = formShell(
        '添加远程实例',
        `<div class="field"><label for="name">实例名称</label><input id="name" name="displayName" autocomplete="off" placeholder="我的云服务器"></div><div class="field"><label for="address">服务器地址</label><input id="address" name="address" autocomplete="off" placeholder="server.example:4960" required></div><div class="field"><label for="key">管理密钥</label><div class="secret-wrap"><input id="key" name="managementKey" type="password" autocomplete="new-password" required><button type="button" class="reveal" data-action="reveal" aria-label="显示管理密钥">👁</button></div></div>${busy ? '<p class="progress">正在验证服务器身份并建立设备会话…</p>' : ''}`,
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
        '修改服务实例',
        `<div class="field"><label for="name">实例名称</label><input id="name" name="displayName" value="${escapeHtml(profile.displayName)}" required></div><div class="field"><label for="address">服务器地址</label><input id="address" name="address" value="${escapeHtml(profile.origin)}" required></div>`,
        '保存修改',
      )
      return
    }
    if (mode.kind === 'reauth') {
      root.innerHTML = formShell(
        '重新认证',
        `<p class="hint">${escapeHtml(profile.displayName)}</p><div class="field"><label for="key">管理密钥</label><div class="secret-wrap"><input id="key" name="managementKey" type="password" autocomplete="new-password" required><button type="button" class="reveal" data-action="reveal" aria-label="显示管理密钥">👁</button></div></div>`,
        '重新认证',
      )
      return
    }
    if (mode.kind === 'remove') {
      root.innerHTML = `<section class="panel">${header('移除服务实例', true)}<div class="confirm"><h2>${escapeHtml(profile.displayName)}</h2><p>此操作会清除此客户端保存的连接记录、浏览数据和设备凭据。服务器中的智能体、频道、消息和扩展不会被删除。</p>${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}<div class="form-actions"><button class="quiet" data-action="back">取消</button><button class="danger" data-action="remove" data-id="${profile.id}" ${busy ? 'disabled' : ''}>移除实例</button></div></div><div></div></section>`
    }
  }

  const render = () => (mode.kind === 'list' || mode.kind === 'menu' ? renderList() : renderForm())
  const refresh = async () => {
    snapshot = await bridge.list()
    render()
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
      mode = { kind: 'list' }
      render()
      return
    }
    if (action === 'add') {
      mode = { kind: 'add' }
      render()
      return
    }
    if (action === 'more') {
      mode = mode.kind === 'menu' && mode.profileId === id ? { kind: 'list' } : { kind: 'menu', profileId: id }
      render()
      return
    }
    if (action === 'edit') {
      mode = { kind: 'edit', profileId: id }
      render()
      return
    }
    if (action === 'reauth') {
      mode = { kind: 'reauth', profileId: id }
      render()
      return
    }
    if (action === 'confirm-remove') {
      mode = { kind: 'remove', profileId: id }
      render()
      return
    }
    if (action === 'reveal') {
      const field = root.querySelector('#key')
      field.type = field.type === 'password' ? 'text' : 'password'
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

  root.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (busy) return
    const data = new FormData(event.target)
    busy = true
    error = ''
    render()
    try {
      if (mode.kind === 'add')
        await bridge.add({
          displayName: data.get('displayName'),
          address: data.get('address'),
          managementKey: data.get('managementKey'),
        })
      if (mode.kind === 'edit')
        await bridge.update({
          profileId: mode.profileId,
          displayName: data.get('displayName'),
          origin: data.get('address'),
        })
      if (mode.kind === 'reauth')
        await bridge.reauthenticate({ profileId: mode.profileId, managementKey: data.get('managementKey') })
      mode = { kind: 'list' }
      busy = false
      await refresh()
    } catch (cause) {
      busy = false
      error = cause instanceof Error ? cause.message : String(cause)
      render()
    }
  })

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (mode.kind === 'list') bridge.close()
      else {
        mode = { kind: 'list' }
        render()
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
    snapshot = next
    render()
  })
  refresh().then(() => requestAnimationFrame(() => root.querySelector('.instance.current, button')?.focus()))
})()
