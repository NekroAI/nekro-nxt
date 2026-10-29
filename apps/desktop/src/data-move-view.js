/* global window, document */
/* The trusted preload exposes only the move's state and one allowlisted action. */
const bridge = window.nxtDataMove
const element = (id) => document.getElementById(id)
const stepTitles = {
  transferring: { move: '正在移动数据', copy: '正在复制数据' },
  verifying: { move: '正在移动数据', copy: '正在校验数据' },
  rewriting: { move: '正在更新路径', copy: '正在更新路径' },
  switching: { move: '正在切换到新目录', copy: '正在切换到新目录' },
}
const modeTitles = {
  undoing: '正在恢复原来的数据目录',
  failed: '数据目录没有更改',
  interrupted: '上次更改没有完成',
  switching: '正在切换到新目录',
}
const formatBytes = (bytes) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`
let latest
let actionPending = false
let received = false
function render(state) {
  latest = state
  document.documentElement.dataset.theme = state.theme
  document.documentElement.dataset.platform = state.platform
  const step = state.progress?.step ?? 'transferring'
  element('title').textContent =
    state.mode === 'moving' ? stepTitles[step][state.method] : (modeTitles[state.mode] ?? '正在准备')
  element('body').textContent =
    state.mode === 'moving' || state.mode === 'switching'
      ? `${state.source} → ${state.target}。完成后会自动打开 NekroNXT，请保持应用开启。`
      : state.mode === 'undoing'
        ? `正在把数据放回 ${state.source}，请保持应用开启。`
        : state.mode === 'failed'
          ? `数据仍在 ${state.source}，新目录里这次创建的文件已删除。`
          : `数据已回到 ${state.source}。可以在“设置 → 存储”里重新更改。`
  const progress = state.progress
  const active = state.mode === 'moving'
  element('progress-section').hidden = !active
  if (active && progress && progress.totalBytes > 0 && state.method === 'copy') {
    element('progress').max = progress.totalBytes
    element('progress').value = Math.min(progress.completedBytes, progress.totalBytes)
  } else {
    element('progress').removeAttribute('value')
  }
  element('progress-label').textContent =
    state.method === 'copy' && progress
      ? `${formatBytes(progress.completedBytes)} / ${formatBytes(progress.totalBytes)}`
      : (progress?.current ?? '')
  const failure = state.failure
  element('notice').hidden = !(state.mode === 'failed' && failure)
  element('notice').textContent = failure ? `${failure.file ? `${failure.file}：` : ''}${failure.message}` : ''
  element('diagnostics').textContent = state.diagnostics
  for (const button of document.querySelectorAll('[data-action]')) {
    button.hidden = !state.actions.includes(button.dataset.action)
    button.disabled = actionPending
  }
}
for (const button of document.querySelectorAll('[data-action]')) {
  button.addEventListener('click', async () => {
    if (actionPending) return
    actionPending = true
    element('action-error').hidden = true
    render(latest)
    try {
      await bridge.action(button.dataset.action)
    } catch {
      element('action-error').textContent = '操作未完成，请关闭后重新打开应用。'
      element('action-error').hidden = false
      actionPending = false
      render(latest)
    }
  })
}
bridge.subscribe((state) => {
  received = true
  render(state)
})
void bridge
  .snapshot()
  .then((state) => {
    if (!received) render(state)
  })
  .catch(() => {
    element('body').textContent = '无法读取迁移状态，请关闭并重新打开应用。'
  })
