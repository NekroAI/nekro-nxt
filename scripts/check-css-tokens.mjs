import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Decision 2026-10-06 §9: component styles may only reference design Tokens.
 * - colors (hex, rgb/hsl, named colors) belong in tokens.css;
 * - margin / padding / gap take 0, auto, a keyword or Tokens (var(--…), optionally inside calc()).
 * Runs in report mode by default; `--strict` turns findings into a failure.
 */

const root = process.cwd()
const scanRoots = ['apps/web/src']
const tokenFiles = new Set(['apps/web/src/ui-kit/tokens.css'])

const COLOR_KEYWORDS = [
  'white',
  'black',
  'red',
  'green',
  'blue',
  'gray',
  'grey',
  'orange',
  'yellow',
  'purple',
  'pink',
  'silver',
  'navy',
]
const HEX = /#[0-9a-f]{3,8}\b/iu
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/iu
/** Identity colours are computed per object from its hue variable (`--h`); the lightness still comes from Tokens. */
const IDENTITY_COLOR = /^(?:[^()]*\s)?hsla?\(var\(--h\)(?:[^()]|\([^()]*\))*\)$/u
const COLOR_KEYWORD = new RegExp(`(?<![\\w-])(?:${COLOR_KEYWORDS.join('|')})(?![\\w-])`, 'iu')
const SPACING_PROPERTY =
  /^(?:margin|padding|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left|block|inline|block-start|block-end|inline-start|inline-end))?$/u
const SPACING_KEYWORDS = new Set(['0', 'auto', 'inherit', 'initial', 'unset', 'revert', 'normal'])

/** Strips comments, keeping newlines so reported lines stay accurate. */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, ' '))

/** Every `property: value` declaration with its 1-based line. */
function declarations(css) {
  const source = stripComments(css)
  const output = []
  const pattern = /(?<=[{;]\s*)([a-z-]+)\s*:\s*([^;{}]+?)\s*(?=;|\})/gu
  for (const match of source.matchAll(pattern)) {
    const property = match[1] ?? ''
    if (property.startsWith('--')) continue
    const line = source.slice(0, match.index).split('\n').length
    output.push({ property, value: (match[2] ?? '').replace(/\s+/gu, ' '), line })
  }
  return output
}

/** Splits a spacing shorthand into components, keeping functions such as var() and calc() whole. */
function components(value) {
  const parts = []
  let depth = 0
  let current = ''
  for (const char of value) {
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (char === ' ' && depth === 0) {
      if (current) parts.push(current)
      current = ''
    } else current += char
  }
  if (current) parts.push(current)
  return parts
}

/** A spacing component is valid when it is a keyword, a Token, or arithmetic over Tokens and unitless numbers. */
function validSpacing(part) {
  if (SPACING_KEYWORDS.has(part) || /^-?0(?:\.0+)?(?:px|rem|em|%)?$/u.test(part)) return true
  if (/^var\(--[\w-]+(?:,\s*[^)]*)?\)$/u.test(part)) return true
  const calc = /^calc\((.*)\)$/u.exec(part)
  if (calc?.[1]) {
    const residue = (calc[1] ?? '').replace(/var\(--[\w-]+\)/gu, '').replace(/[\s*+/()-]/gu, '')
    return /^[\d.]*$/u.test(residue)
  }
  return false
}

/** Top-level comma parts of a selector list, keeping `:is(a, b)` and `:where(a, b)` whole. */
function selectorParts(selector) {
  const parts = []
  let depth = 0
  let current = ''
  for (const char of selector) {
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else current += char
  }
  parts.push(current)
  return parts
}

/**
 * CSS Modules scope class names only. A selector part without a class (`[data-align='end']`, `button`) matches
 * every element in the document, including Radix portals, so each part must name a module class.
 */
function unscopedSelectors(css) {
  const source = stripComments(css).replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/gu, (block) =>
    block.replace(/[^\n]/gu, ' '),
  )
  const output = []
  for (const match of source.matchAll(/([^{};]+)\{/gu)) {
    const selector = (match[1] ?? '').trim()
    if (!selector || selector.startsWith('@')) continue
    const line = source.slice(0, (match.index ?? 0) + (match[1] ?? '').indexOf(selector)).split('\n').length
    for (const part of selectorParts(selector)) {
      const trimmed = part.trim()
      if (trimmed && !/\.[\w-]/u.test(trimmed) && !trimmed.includes(':global')) output.push({ line, text: trimmed })
    }
  }
  return output
}

export function inspectCss(relativePath, css) {
  const findings = []
  if (relativePath.endsWith('.module.css'))
    for (const { line, text } of unscopedSelectors(css))
      findings.push({ file: relativePath, line, rule: 'scope', text: `${text} 没有限定到本模块的类名` })
  const tokensFile = tokenFiles.has(relativePath)
  for (const { property, value, line } of declarations(css)) {
    const identity = IDENTITY_COLOR.test(value) && !HEX.test(value)
    if (!tokensFile && !identity && (HEX.test(value) || COLOR_FUNCTION.test(value) || COLOR_KEYWORD.test(value))) {
      if (!(property === 'white-space' || property === 'content'))
        findings.push({ file: relativePath, line, rule: 'color', text: `${property}: ${value}` })
    }
    if (SPACING_PROPERTY.test(property)) {
      const invalid = components(value).filter((part) => !validSpacing(part))
      if (invalid.length > 0)
        findings.push({ file: relativePath, line, rule: 'spacing', text: `${property}: ${value}` })
    }
  }
  return findings
}

async function cssFilesUnder(relativeDirectory) {
  const entries = await readdir(path.join(root, relativeDirectory), { withFileTypes: true })
  const output = []
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name)
    if (entry.isDirectory()) output.push(...(await cssFilesUnder(relativePath)))
    else if (entry.name.endsWith('.module.css')) output.push(relativePath)
  }
  return output
}

function runSelfTest() {
  const fixture = `
.a { color: #fff; background: var(--surface); }
.b { padding: 12px 16px; margin: 0 auto; }
.c { gap: var(--s-2); margin-top: calc(var(--s-2) * -1); }
.d { border: 1px solid rgb(0 0 0 / 0.1); white-space: nowrap; }
/* .e { color: white; } */
.f { box-shadow: 0 0 0 1px white; padding: var(--s-1) var(--s-3); }
.g { column-gap: 6px; --local: #000; }
`
  assert.deepEqual(
    inspectCss('apps/web/src/app/fixture.module.css', fixture).map(({ line, rule }) => [line, rule]),
    [
      [2, 'color'],
      [3, 'spacing'],
      [5, 'color'],
      [7, 'color'],
      [8, 'spacing'],
    ],
  )
  assert.deepEqual(inspectCss('apps/web/src/ui-kit/tokens.css', '.x { color: #000; }'), [])
  assert.deepEqual(
    inspectCss(
      'apps/web/src/ui-kit/data.module.css',
      `[data-align='end'] { gap: 0; }\n.cell[data-align='end'] { gap: 0; }\n.a :where(h1, h2) { gap: 0; }\n@media (max-width: 9px) { button { gap: 0; } }\n@keyframes k { from { opacity: 0; } }`,
    ).map(({ line, rule }) => [line, rule]),
    [
      [1, 'scope'],
      [4, 'scope'],
    ],
  )
  assert.deepEqual(
    inspectCss('apps/web/src/ui-kit/avatar.module.css', '.m { color: hsl(var(--h) 38% var(--mem-fg)); }'),
    [],
  )
  assert.equal(validSpacing('calc(var(--s-4) + 2px)'), false)
  assert.equal(validSpacing('calc(var(--s-4) * 2)'), true)
  console.log('CSS token self-test passed (colors, spacing shorthands, calc over Tokens, comments and tokens.css).')
}

if (process.argv.includes('--self-test')) {
  runSelfTest()
} else {
  const strict = process.argv.includes('--strict')
  const files = (await Promise.all(scanRoots.map(cssFilesUnder))).flat().sort()
  const findings = []
  for (const file of files) findings.push(...inspectCss(file, await readFile(path.join(root, file), 'utf8')))
  const byRule = (rule) => findings.filter((finding) => finding.rule === rule).length
  if (findings.length === 0) {
    console.log(`CSS token check passed (${files.length} CSS Module files).`)
  } else {
    const lines = findings.map(({ file, line, rule, text }) => `${file}:${line} [${rule}] ${text}`)
    const summary = `CSS token check: ${findings.length} findings in ${new Set(findings.map((f) => f.file)).size} files (color ${byRule('color')}, spacing ${byRule('spacing')}, scope ${byRule('scope')}).`
    if (strict) {
      console.error(['组件样式必须只使用 Token：', ...lines, summary].join('\n'))
      process.exitCode = 1
    } else {
      if (process.argv.includes('--list')) console.log(lines.join('\n'))
      console.log(`${summary} Report mode; run with --strict to enforce, --list for details.`)
    }
  }
}
