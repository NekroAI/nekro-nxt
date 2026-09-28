/* global window, document */
/* The trusted preload exposes only startup state and four allowlisted actions. */
const bridge = window.nxtStartup
const element = (id) => document.getElementById(id)
const titles = {
  idle: '正在启动',
  preflight: '正在检查升级条件',
  backup: '正在备份本地数据',
  migrating: '正在升级本地数据',
  checking: '正在检查运行环境',
  activating: '正在恢复本地服务',
  ready: '正在打开工作区',
  recovery: '升级需要处理',
}
const bodies = {
  starting: '请保持应用开启。完成检查后将自动打开工作区。',
  cancelling: '已请求停止，正在等待当前数据操作安全结束。完成前请保持应用开启。',
  failed: '本地服务尚未启动。可以查看诊断后重试，或恢复升级前的备份。',
  restoring: '正在恢复升级前的数据。完成后请使用与备份匹配的旧版程序。',
  restored: '升级前的数据已恢复。请退出当前版本，使用与备份匹配的旧版程序打开。',
}
const modeTitles = {
  cancelling: '正在安全停止',
  failed: '本地服务未能启动',
  restoring: '正在恢复备份',
  restored: '备份已恢复',
}
let latest
let actionPending = false
let received = false
const formatAmount = (amount, unit) => (unit === 'bytes' ? `${(amount / (1024 * 1024)).toFixed(1)} MB` : `${amount} 项`)
function render(state) {
  latest = state
  document.documentElement.dataset.theme = state.theme
  document.documentElement.dataset.platform = state.platform
  const status = state.observation?.progress?.status
  element('eyebrow').textContent =
    state.mode === 'restoring' || state.mode === 'restored' ? '恢复本地数据' : '准备工作区'
  element('title').textContent = modeTitles[state.mode] ?? titles[status?.phase ?? 'idle']
  element('body').textContent = state.mode === 'failed' && state.errorSummary ? state.errorSummary : bodies[state.mode]
  const progress = status?.progress
  const active = state.mode === 'starting'
  element('progress-section').hidden = !active || !status || status.phase === 'idle'
  if (progress?.total > 0) {
    element('progress').max = progress.total
    element('progress').value = progress.completed
  } else {
    element('progress').removeAttribute('value')
  }
  element('progress-label').textContent = progress
    ? `${formatAmount(progress.completed, progress.unit)}${progress.total === undefined ? '' : ` / ${formatAmount(progress.total, progress.unit)}`}`
    : '正在处理，请稍候'
  const stalled = active && state.observation?.stalled
  const canRestore = state.mode === 'failed' && state.actions.includes('restore')
  element('notice').hidden = !stalled && !canRestore
  element('notice').textContent = stalled
    ? '服务仍有心跳，但较长时间没有新的进度。可以查看诊断，或安全取消后重试。'
    : '恢复会将本地数据还原到升级前的备份，当前现场会先保留。恢复后请退出，并使用与备份匹配的旧版程序。'
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
      element('action-error').textContent = '操作未完成，请查看诊断后重试。'
      element('action-error').hidden = false
    } finally {
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
    element('body').textContent = '无法读取启动状态，请关闭并重新打开应用。'
  })
