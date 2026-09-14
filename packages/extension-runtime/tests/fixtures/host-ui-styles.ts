import { createHash } from 'node:crypto'

export const stylesPage = {
  kind: 'host-page' as const,
  entryId: 'styles-probe',
  title: '样式回归页面',
  icon: { kind: 'host-icon' as const, name: 'layout-dashboard' as const },
  objectPane: 'hidden' as const,
  startPath: '',
}

export const stylesCss = '.stylesProbe { padding: 23px; border-radius: 17px; }'

// Keep this as a dynamic Client body: no hand-written persistent factory can hide
// a missing lexical binding in the materializer.
export const stylesClientCode = `return {
  inject: ['pages', 'ui'],
  apply(ctx) {
    ctx.pages.declarePermissions({ permissions: [], networkOrigins: [] })
    return ctx.pages.register({ page: ${JSON.stringify(stylesPage)} }, () => {
      const [state, setState] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      React.useEffect(() => {
        let active = true
        host.call('state.get', { key: 'counter' }).then((stored) => {
          if (active) setState({ revision: stored.revision, value: stored.value ?? 0 })
        }).catch((failure) => {
          if (active) setError(failure.message)
        })
        return () => { active = false }
      }, [])
      const increment = async () => {
        if (!state || busy) return
        setBusy(true)
        try {
          const value = state.value + 1
          const saved = await host.call('state.set', { key: 'counter', expectedRevision: state.revision, value })
          setState({ revision: saved.revision, value })
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(false)
        }
      }
      return React.createElement('section', { className: 'stylesProbe', 'data-styles-probe': '' },
        React.createElement('h1', { className: styles.sectionHeading }, '样式回归页面'),
        React.createElement('p', { className: styles.secondaryText }, '保存后样式正常'),
        React.createElement('output', { 'data-styles-counter': '' }, state ? String(state.value) : '读取中'),
        React.createElement('button', { className: styles.button, disabled: !state || busy, onClick: increment }, '增加计数'),
        error ? React.createElement('p', { role: 'alert' }, error) : null
      )
    })
  }
}`

export const stylesSnapshot = {
  name: '样式回归页面',
  purpose: '验证动态页面物化后仍能使用 styles 和声明的 CSS 资源。',
  clientCode: stylesClientCode,
  clientCss: {
    path: 'assets/probe.module.css',
    sha256: createHash('sha256').update(stylesCss).digest('hex'),
  },
  resources: { 'assets/probe.module.css': stylesCss },
  permissions: { permissions: [], networkOrigins: [] },
  contributions: [stylesPage],
}
