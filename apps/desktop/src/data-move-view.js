/* global window, document */
/* The trusted preload exposes only the move's state and the allowlisted actions. */
const bridge = window.nxtDataMove
const element = (id) => document.getElementById(id)
const stepTitles = {
  transferring: { move: '正在移动数据', copy: '正在复制数据' },
  verifying: { move: '正在移动数据', copy: '正在校验数据' },
  rewriting: { move: '正在更新路径', copy: '正在更新路径' },
  switching: { move: '正在切换到新目录', copy: '正在切换到新目录' },
}
const stepNames = {
  copy: [
    ['transferring', '复制数据'],
    ['verifying', '校验数据库'],
    ['rewriting', '更新路径记录'],
    ['switching', '切换到新目录'],
  ],
  move: [
    ['transferring', '移动数据'],
    ['rewriting', '更新路径记录'],
    ['switching', '切换到新目录'],
  ],
}
const modeTitles = {
  undoing: '正在恢复原来的数据目录',
  failed: '数据目录没有更改',
  interrupted: '上次更改没有完成',
  cancelled: '已取消更改',
  switching: '正在切换到新目录',
}
/** No new progress for this long gets a note explaining what is going on and what stopping would do. */
const STALL_MS = 2 * 60_000
const formatBytes = (bytes) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`
const formatDuration = (ms) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}
const formatClock = (at) => new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
let latest
let actionPending = false
let received = false
/** When the progress last changed, measured here so a quiet step is noticed even without new messages. */
let progressAt = Date.now()
let progressKey = ''

const currentStep = (state) => (state.mode === 'switching' ? 'switching' : (state.progress?.step ?? 'transferring'))
const stepName = (state, step) => stepNames[state.method].find(([key]) => key === step)?.[1] ?? step

function renderSteps(state, step) {
  const names = stepNames[state.method]
  const index = names.findIndex(([key]) => key === step)
  element('steps').replaceChildren(
    ...names.map(([, name], position) => {
      const item = document.createElement('li')
      item.textContent = name
      if (position < index) item.dataset.state = 'done'
      if (position === index) item.setAttribute('aria-current', 'step')
      return item
    }),
  )
}

function stallNote(state, quietFor) {
  const minutes = Math.floor(quietFor / 60_000)
  if (!state.actions.includes('cancel'))
    return `已经 ${minutes} 分钟没有新的进展。请保持应用开启，这一步结束后会自动打开 NekroNXT。如果一直没有变化，请展开“查看诊断”并把内容反馈给我们。`
  const undo =
    state.method === 'copy'
      ? '原目录里的数据没有改动；点“取消更改”会删除新目录里这次复制的文件，继续使用原目录。'
      : '点“取消更改”会把已经移动的文件放回原目录。'
  return `已经 ${minutes} 分钟没有新的进展。数据很多或数据库很大时，这一步需要较长时间，可以继续等待。${undo}`
}

function render(state) {
  latest = state
  const now = Date.now()
  document.documentElement.dataset.theme = state.theme
  document.documentElement.dataset.platform = state.platform
  const step = currentStep(state)
  element('title').textContent =
    state.mode === 'moving' ? stepTitles[step][state.method] : (modeTitles[state.mode] ?? '正在准备')
  element('body').textContent =
    state.mode === 'moving' || state.mode === 'switching'
      ? `${state.source} → ${state.target}。完成后会自动打开 NekroNXT，请保持应用开启。`
      : state.mode === 'undoing'
        ? `正在把数据放回 ${state.source}，请保持应用开启。`
        : state.mode === 'failed' || state.mode === 'cancelled'
          ? `数据仍在 ${state.source}，新目录里这次创建的文件已删除。`
          : `数据已回到 ${state.source}。可以在“设置 → 存储”里重新更改。`
  const progress = state.progress
  const active = state.mode === 'moving' || state.mode === 'switching'
  element('progress-section').hidden = !active
  if (active) renderSteps(state, step)
  if (active && progress && progress.totalBytes > 0 && state.method === 'copy') {
    element('progress').max = progress.totalBytes
    element('progress').value = Math.min(progress.completedBytes, progress.totalBytes)
  } else {
    element('progress').removeAttribute('value')
  }
  element('progress-label').textContent =
    step === 'verifying' && progress?.current
      ? `正在检查 ${progress.current}`
      : state.method === 'copy' && progress && step === 'transferring'
        ? `${formatBytes(progress.completedBytes)} / ${formatBytes(progress.totalBytes)}`
        : (progress?.current ?? '')
  const elapsed = state.startedAt ? formatDuration(now - state.startedAt) : undefined
  element('elapsed').textContent = elapsed ? `已用时 ${elapsed}` : ''
  const stalled = active && now - progressAt >= STALL_MS
  element('stall').hidden = !stalled
  element('stall').textContent = stalled ? stallNote(state, now - progressAt) : ''
  const failure = state.failure
  element('notice').hidden = !(state.mode === 'failed' && failure)
  element('notice').textContent = failure ? `${failure.file ? `${failure.file}：` : ''}${failure.message}` : ''
  const live = active
    ? [
        `当前步骤：${stepName(state, step)}${progress?.current ? `（${progress.current}）` : ''}`,
        ...(elapsed ? [`开始于：${formatClock(state.startedAt)}，已用时 ${elapsed}`] : []),
        `最后进展：${formatClock(progressAt)}`,
      ]
    : []
  element('diagnostics').textContent = [state.diagnostics, ...live].join('\n')
  for (const button of document.querySelectorAll('[data-action]')) {
    button.hidden = !state.actions.includes(button.dataset.action)
    button.disabled = actionPending
  }
}

function receive(state) {
  const key = [state.mode, state.progress?.step, state.progress?.current, state.progress?.completedBytes].join('|')
  if (key !== progressKey) {
    progressKey = key
    progressAt = Date.now()
  }
  // A cancel stays pending until the move stops; a stopped move takes its next action.
  if (state.actions.includes('open')) actionPending = false
  render(state)
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
window.setInterval(() => {
  if (latest && (latest.mode === 'moving' || latest.mode === 'switching')) render(latest)
}, 1000)
bridge.subscribe((state) => {
  received = true
  receive(state)
})
void bridge
  .snapshot()
  .then((state) => {
    if (!received) receive(state)
  })
  .catch(() => {
    element('body').textContent = '无法读取迁移状态，请关闭并重新打开应用。'
  })
