import postcss from 'postcss'
import selectorParser from 'postcss-selector-parser'

export function cssModuleDeclaration(source) {
  const names = new Set()
  postcss.parse(source).walkRules((rule) => {
    selectorParser((selectors) =>
      selectors.walkClasses((node) => {
        let parent = node.parent
        while (parent) {
          if (parent.type === 'pseudo' && parent.value === ':global') return
          parent = parent.parent
        }
        names.add(node.value)
      }),
    ).processSync(rule.selector)
  })
  const properties = [...names]
    .sort()
    .map((name) => `  readonly ${/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name) ? name : JSON.stringify(name)}: string`)
    .join('\n')
  return `declare const styles: {\n${properties}\n}\n\nexport default styles\n`
}
