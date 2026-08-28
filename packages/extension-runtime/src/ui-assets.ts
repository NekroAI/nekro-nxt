import postcss from 'postcss'

const textBytes = (value: string): number => new TextEncoder().encode(value).byteLength

export const validateHostUiCss = (source: string): void => {
  if (textBytes(source) > 128 * 1024) throw new Error('Host UI CSS 不能超过 128 KiB。')
  const banned = [
    { pattern: /:global\b/iu, message: 'CSS 不允许使用 :global。' },
    { pattern: /@import\b/iu, message: 'CSS 不允许使用 @import。' },
    { pattern: /@font-face\b/iu, message: 'CSS 不允许声明字体。' },
    { pattern: /url\s*\(/iu, message: 'CSS 不允许引用 URL。' },
    { pattern: /(^|[,{]\s*)(?:html|body|:root)(?=[\s.#:[,{>+~]|$)/imu, message: 'CSS 不允许选择产品根节点。' },
  ]
  for (const rule of banned) if (rule.pattern.test(source)) throw new Error(rule.message)
  let root
  try {
    root = postcss.parse(source)
  } catch (error) {
    throw new Error(`Host UI CSS 语法无效：${error instanceof Error ? error.message : String(error)}`)
  }
  root.walkAtRules((rule) => {
    if (!['media', 'supports', 'container'].includes(rule.name.toLowerCase())) {
      throw new Error(`CSS 不允许使用 @${rule.name}。`)
    }
  })
  root.walkRules((rule) => {
    for (const selector of rule.selectors) {
      const value = selector.trim()
      if (!value.startsWith('.') && !value.startsWith('#') && !value.startsWith(':local(')) {
        throw new Error(`CSS 选择器必须从本地 class 或 id 开始：${value}`)
      }
      if (/:root\b|(^|[\s>+~,])(?:html|body)(?=[\s.#:[>+~,]|$)/iu.test(value)) {
        throw new Error(`CSS 选择器不能触及产品根节点：${value}`)
      }
    }
  })
}

const SVG_ALLOWED_ELEMENTS = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon'])
const SVG_ALLOWED_ATTRIBUTES = new Set([
  'xmlns',
  'viewBox',
  'd',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'x',
  'y',
  'x1',
  'x2',
  'y1',
  'y2',
  'width',
  'height',
  'points',
  'fill',
  'fill-rule',
  'clip-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'transform',
  'opacity',
])

export const validateHostUiSvg = (source: string): void => {
  if (textBytes(source) > 32 * 1024) throw new Error('Host UI SVG 不能超过 32 KiB。')
  if (/<!|<\?|&[A-Za-z#]/u.test(source)) throw new Error('SVG 不允许声明实体、指令或文档类型。')
  const root = /^\s*<svg\b([^>]*)>[\s\S]*<\/svg>\s*$/u.exec(source)
  if (!root) throw new Error('SVG 必须包含一个完整的 svg 根节点。')
  const viewBox = /\bviewBox\s*=\s*(["'])(-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s+\d+(?:\.\d+)?)\1/u.exec(
    root[1] ?? '',
  )
  if (!viewBox) throw new Error('SVG 必须声明数值 viewBox。')
  const [, , viewBoxValue = ''] = viewBox
  const [, , width = 0, height = 0] = viewBoxValue.split(/\s+/u).map(Number)
  if (!(width > 0 && height > 0 && width <= 512 && height <= 512)) throw new Error('SVG viewBox 尺寸无效。')
  const tagPattern = /<\/?([A-Za-z][A-Za-z0-9:-]*)([^>]*)>/gu
  let match: RegExpExecArray | null
  while ((match = tagPattern.exec(source))) {
    const name = match[1]
    if (!name || !SVG_ALLOWED_ELEMENTS.has(name)) throw new Error(`SVG 不允许使用 ${name ?? '未知'} 元素。`)
    if (match[0].startsWith('</')) continue
    const attributes = match[2] ?? ''
    const attributePattern = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(["'])[^"']*\2/gu
    let attributeMatch: RegExpExecArray | null
    let consumed = attributes.replace(/\/\s*$/u, '')
    while ((attributeMatch = attributePattern.exec(attributes))) {
      const attribute = attributeMatch[1]
      if (!attribute || !SVG_ALLOWED_ATTRIBUTES.has(attribute)) {
        throw new Error(`SVG 不允许使用 ${attribute ?? '未知'} 属性。`)
      }
      consumed = consumed.replace(attributeMatch[0], '')
    }
    if (consumed.trim()) throw new Error('SVG 包含无法识别的属性。')
  }
}
