import { atRule } from 'postcss'

/** Scope theme transitions to visual declarations without per-element state outside a theme change. */
export function themeTransitions() {
  return {
    postcssPlugin: 'nxt-theme-transitions',
    Once(root) {
      const file = root.source?.input.file?.replaceAll('\\', '/') ?? ''
      if (!file.includes('/apps/web/src/')) return
      const prefix = file.endsWith('.module.css') ? ':global(:root[data-theme-changing])' : ':root[data-theme-changing]'
      const theme = atRule({ name: 'media', params: '(--nxt-theme-transition)' })
      const rules = []
      root.walkRules((rule) => {
        rules.push(rule)
      })
      for (const rule of rules) {
        let parent = rule.parent
        let keyframes = false
        while (parent) {
          if (parent.type === 'atrule' && parent.name.endsWith('keyframes')) keyframes = true
          parent = parent.parent
        }
        if (keyframes || rule.selector.includes('data-theme-changing')) continue
        const visual = rule.nodes.some(
          (node) =>
            node.type === 'decl' &&
            /^(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|box-shadow|fill|stroke)$/u.test(
              node.prop,
            ) &&
            !['inherit', 'initial', 'unset', 'transparent', 'none'].includes(node.value),
        )
        if (!visual) continue
        const selectors = rule.selectors.map((selector) => {
          const pseudo = selector.match(/::(?:before|after)$/u)?.[0] ?? ''
          const base = pseudo ? selector.slice(0, -pseudo.length) || '*' : selector
          // :where keeps the previous theme rule specificity, so hover/focus rules
          // keep their cascade priority. Root context selectors remain inside it.
          return `${prefix} :where(${base})${pseudo}`
        })
        const next = rule.clone({ selector: selectors.join(',\n') })
        next.removeAll()
        next.append({ prop: 'transition', value: 'var(--nxt-theme-transition)' })
        let wrapped = next
        let ancestor = rule.parent
        while (ancestor && ancestor.type !== 'root') {
          const container = ancestor.clone()
          container.removeAll()
          container.append(wrapped)
          wrapped = container
          ancestor = ancestor.parent
        }
        theme.append(wrapped)
      }
      if (theme.nodes?.length) root.append(theme)
    },
  }
}
