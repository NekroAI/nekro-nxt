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
const scanRoots = ['apps/web/src/app', 'apps/web/src/ui-kit/next']
const tokenFiles = new Set(['apps/web/src/ui-kit/next/tokens.css'])

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

export function inspectCss(relativePath, css) {
  const findings = []
  const tokensFile = tokenFiles.has(relativePath)
  for (const { property, value, line } of declarations(css)) {
    if (!tokensFile && (HEX.test(value) || COLOR_FUNCTION.test(value) || COLOR_KEYWORD.test(value))) {
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
  assert.deepEqual(inspectCss('apps/web/src/ui-kit/next/tokens.css', '.x { color: #000; }'), [])
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
    const summary = `CSS token check: ${findings.length} findings in ${new Set(findings.map((f) => f.file)).size} files (color ${byRule('color')}, spacing ${byRule('spacing')}).`
    if (strict) {
      console.error(['组件样式必须只使用 Token：', ...lines, summary].join('\n'))
      process.exitCode = 1
    } else {
      if (process.argv.includes('--list')) console.log(lines.join('\n'))
      console.log(`${summary} Report mode; run with --strict to enforce, --list for details.`)
    }
  }
}
